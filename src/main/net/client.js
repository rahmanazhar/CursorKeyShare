'use strict';
// Network client — runs on a machine being controlled. It connects to the
// server over TCP, announces its desktop bounds, listens for input events, and
// emits them for the input backend to inject. Mouse motion arrives over UDP.

const net = require('net');
const dgram = require('dgram');
const EventEmitter = require('events');
const crypto = require('./crypto');
const proto = require('./protocol');
const netbind = require('./netbind');
const { FrameReader, frame } = require('./frame');

class NetClient extends EventEmitter {
  /**
   * @param {{key:Buffer, host:string, tcpPort:number, udpPort:number,
   *          serverUdpPort:number, name:string, localId:string, bounds:object}} opts
   */
  constructor(opts) {
    super();
    this.key = opts.key;
    this.host = opts.host;
    this.tcpPort = opts.tcpPort;
    this.udpPort = opts.udpPort; // local port we listen on for motion
    this.serverUdpPort = opts.serverUdpPort || opts.udpPort; // server's UDP port
    this.name = opts.name;
    this.localId = opts.localId;
    this.bindIf = opts.bindIf || null; // NIC to pin sockets to (VPN bypass), or null
    this.bounds = opts.bounds || { originX: 0, originY: 0, width: 1920, height: 1080 };

    this._sock = null;
    this._udp = null;
    this._reader = new FrameReader();
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._lastMoveSeq = 0;
    this._stopped = false;
    this.connected = false;
  }

  start() {
    this._stopped = false;
    this._udp = dgram.createSocket('udp4');
    this._udp.on('message', (msg) => this._onUdp(msg));
    this._udp.on('error', (e) => this.emit('error', e));
    this._udp.bind(this.udpPort, () => {
      if (this.bindIf) netbind.bindSocketToInterface(this._udp, this.bindIf);
    });
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._sock) try { this._sock.destroy(); } catch {}
    if (this._udp) try { this._udp.close(); } catch {}
    this._sock = this._udp = null;
    this.connected = false;
  }

  async _connect() {
    if (this._stopped) return;

    // When pinned to a NIC, connect natively so the socket is interface-scoped
    // BEFORE the SYN goes out — the only reliable way under a full-tunnel VPN.
    // If that fails (e.g. the peer isn't reachable on that NIC) fall back to a
    // normal connection, so pinning never regresses a non-VPN setup.
    if (this.bindIf && netbind.available()) {
      try {
        const sock = await netbind.connectBoundTcp(this.host, this.tcpPort, this.bindIf, 4000);
        if (this._stopped) { try { sock.destroy(); } catch {} return; }
        this._sock = sock;
        this._wire(sock);
        this._onConnected(); // the native connect already completed
        return;
      } catch (e) {
        this.emit('warn', `pinned connect via ${this.bindIf} failed (${e.message}); trying default route`);
        if (this._stopped) return;
      }
    }

    const sock = net.createConnection({ host: this.host, port: this.tcpPort }, () => this._onConnected());
    this._sock = sock;
    this._wire(sock);
  }

  // Runs once the TCP connection is established (either connect path).
  _onConnected() {
    const sock = this._sock;
    if (!sock) return;
    sock.setNoDelay(true);
    this.connected = true;
    this._reader = new FrameReader();
    this.emit('connected', { host: this.host, port: this.tcpPort });
    // Announce ourselves.
    this._sendTcp(
      proto.encodeJson(proto.T.HELLO, {
        id: this.localId,
        name: this.name,
        udpPort: this.udpPort,
        bounds: this.bounds,
      })
    );
    // Register our UDP endpoint and start keepalive.
    this._registerUdp();
    this._pingTimer = setInterval(() => {
      this._sendTcp(proto.encodeJson(proto.T.PING, { t: Date.now() }));
      this._registerUdp();
    }, 2000);
  }

  // Attach data/error/close handlers to a connected socket.
  _wire(sock) {
    sock.on('data', (chunk) => {
      let blobs;
      try {
        blobs = this._reader.push(chunk);
      } catch (e) {
        this.emit('error', e);
        sock.destroy();
        return;
      }
      for (const blob of blobs) {
        try {
          this._handle(proto.decode(crypto.open(this.key, blob)));
        } catch (e) {
          this.emit('warn', 'failed to open frame: ' + e.message);
          sock.destroy();
          return;
        }
      }
    });

    sock.on('error', (e) => this.emit('warn', 'socket: ' + e.message));
    sock.on('close', () => {
      this.connected = false;
      if (this._pingTimer) clearInterval(this._pingTimer);
      this.emit('disconnected');
      if (!this._stopped) {
        this._reconnectTimer = setTimeout(() => this._connect(), 1500);
      }
    });
  }

  // Tell the server our UDP source endpoint so it can route motion to us.
  _registerUdp() {
    if (!this._udp) return;
    const blob = crypto.seal(
      this.key,
      proto.encodeJson(proto.T.PING, { id: this.localId, t: Date.now() })
    );
    this._udp.send(blob, this.serverUdpPort, this.host, () => {});
  }

  _handle(pkt) {
    switch (pkt.type) {
      case proto.T.WELCOME:
        this.emit('welcome', { id: pkt.id, name: pkt.name });
        break;
      case proto.T.MOUSE_BUTTON:
        this.emit('mousebutton', { button: pkt.button, down: pkt.down });
        break;
      case proto.T.MOUSE_WHEEL:
        this.emit('wheel', { dx: pkt.dx, dy: pkt.dy });
        break;
      case proto.T.KEY:
        this.emit('key', {
          down: pkt.down,
          canon: pkt.keycode,
          rawcode: pkt.rawcode,
          modifiers: pkt.modifiers,
        });
        break;
      case proto.T.ENTER:
        this.emit('enter', { x: pkt.x, y: pkt.y });
        break;
      case proto.T.LEAVE:
        this.emit('leave', {});
        break;
      case proto.T.PING:
        this._sendTcp(proto.encodeJson(proto.T.PONG, { t: pkt.t }));
        break;
      case proto.T.PONG:
        this.emit('latency', { rtt: Date.now() - (pkt.t || Date.now()) });
        break;
      case proto.T.CLIPBOARD:
        this.emit('clipboard', { format: pkt.format, data: pkt.data });
        break;
      case proto.T.BYE:
        this.emit('warn', 'server said bye: ' + (pkt.reason || ''));
        break;
    }
  }

  _onUdp(msg) {
    let pkt;
    try {
      pkt = proto.decode(crypto.open(this.key, msg));
    } catch {
      return;
    }
    if (pkt.type === proto.T.MOUSE_MOVE) {
      // Drop stale/out-of-order datagrams.
      if (seqNewer(pkt.seq, this._lastMoveSeq)) {
        this._lastMoveSeq = pkt.seq;
        this.emit('mousemove', { x: pkt.x, y: pkt.y });
      }
    }
  }

  _sendTcp(plaintext) {
    if (!this._sock || this._sock.destroyed) return;
    try {
      this._sock.write(frame(crypto.seal(this.key, plaintext)));
    } catch (e) {
      this.emit('warn', 'tcp send failed: ' + e.message);
    }
  }

  sendClipboard(format, data) {
    this._sendTcp(proto.encodeJson(proto.T.CLIPBOARD, { format, data }));
  }

  updateBounds(bounds) {
    this.bounds = bounds;
    this._sendTcp(proto.encodeJson(proto.T.SCREENS, { bounds }));
  }
}

// 32-bit wrap-around aware "a is newer than b".
function seqNewer(a, b) {
  return ((a - b) & 0xffffffff) < 0x80000000 && a !== b;
}

module.exports = { NetClient };
