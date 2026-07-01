'use strict';
// Network server — runs on the machine whose physical keyboard & mouse are being
// shared. It accepts client connections over TCP (reliable control + key/click
// events) and pushes high-frequency mouse motion over UDP.
//
// Every packet is sealed with AES-256-GCM (see crypto.js); a client that doesn't
// hold the shared passphrase cannot connect or inject anything.

const net = require('net');
const dgram = require('dgram');
const EventEmitter = require('events');
const crypto = require('./crypto');
const proto = require('./protocol');
const netbind = require('./netbind');
const { FrameReader, frame } = require('./frame');

class NetServer extends EventEmitter {
  /**
   * @param {{key:Buffer, tcpPort:number, udpPort:number, name:string, localId:string}} opts
   */
  constructor(opts) {
    super();
    this.key = opts.key;
    this.tcpPort = opts.tcpPort;
    this.udpPort = opts.udpPort;
    this.name = opts.name;
    this.localId = opts.localId;
    this.bindIf = opts.bindIf || null; // NIC to pin sockets to (VPN bypass), or null
    /** @type {Map<string, any>} */
    this.peers = new Map();
    this._tcp = null;
    this._udp = null;
    this._motionSeq = 0;
  }

  start() {
    this._udp = dgram.createSocket('udp4');
    this._udp.on('message', (msg, rinfo) => this._onUdp(msg, rinfo));
    this._udp.on('error', (e) => this.emit('error', e));
    this._udp.bind(this.udpPort, () => this._scope(this._udp));

    this._tcp = net.createServer((sock) => this._onConn(sock));
    this._tcp.on('error', (e) => this.emit('error', e));
    this._tcp.listen(this.tcpPort, () => {
      this._scope(this._tcp);
      this.emit('listening', this.tcpPort);
    });
  }

  // Pin a socket/server to the configured NIC so its LAN traffic bypasses a VPN.
  _scope(sock) {
    if (this.bindIf) netbind.bindSocketToInterface(sock, this.bindIf);
  }

  stop() {
    for (const p of this.peers.values()) {
      try {
        this._sendTcp(p, proto.encodeJson(proto.T.BYE, { reason: 'server-stop' }));
        p.socket.destroy();
      } catch {}
    }
    this.peers.clear();
    if (this._tcp) try { this._tcp.close(); } catch {}
    if (this._udp) try { this._udp.close(); } catch {}
    this._tcp = this._udp = null;
  }

  _onConn(sock) {
    sock.setNoDelay(true);
    this._scope(sock); // scope this connection's egress to the pinned NIC too
    const peer = {
      id: null,
      name: null,
      socket: sock,
      reader: new FrameReader(),
      ip: sock.remoteAddress ? sock.remoteAddress.replace(/^::ffff:/, '') : null,
      udpPort: this.udpPort,
      originX: 0,
      originY: 0,
      width: 1920,
      height: 1080,
      alive: true,
    };

    sock.on('data', (chunk) => {
      let blobs;
      try {
        blobs = peer.reader.push(chunk);
      } catch (e) {
        this.emit('error', e);
        sock.destroy();
        return;
      }
      for (const blob of blobs) {
        let pkt;
        try {
          pkt = proto.decode(crypto.open(this.key, blob));
        } catch (e) {
          // Bad key / corrupt frame — drop the connection (likely an impostor).
          this.emit('warn', 'failed to open frame: ' + e.message);
          sock.destroy();
          return;
        }
        this._handle(peer, pkt);
      }
    });

    sock.on('error', () => {});
    sock.on('close', () => {
      if (peer.id && this.peers.get(peer.id) === peer) {
        this.peers.delete(peer.id);
        this.emit('peer-disconnected', peer.id);
      }
    });
  }

  _handle(peer, pkt) {
    switch (pkt.type) {
      case proto.T.HELLO: {
        peer.id = pkt.id || pkt.localId;
        peer.name = pkt.name || peer.ip || 'client';
        if (pkt.udpPort) peer.udpPort = pkt.udpPort;
        // Client reports its combined desktop bounds.
        if (pkt.bounds) {
          peer.originX = pkt.bounds.originX | 0;
          peer.originY = pkt.bounds.originY | 0;
          peer.width = pkt.bounds.width | 0;
          peer.height = pkt.bounds.height | 0;
        }
        this.peers.set(peer.id, peer);
        this._sendTcp(
          peer,
          proto.encodeJson(proto.T.WELCOME, {
            id: this.localId,
            name: this.name,
          })
        );
        this.emit('peer-connected', this._peerInfo(peer));
        break;
      }
      case proto.T.SCREENS: {
        if (pkt.bounds) {
          peer.originX = pkt.bounds.originX | 0;
          peer.originY = pkt.bounds.originY | 0;
          peer.width = pkt.bounds.width | 0;
          peer.height = pkt.bounds.height | 0;
          this.emit('peer-screens', this._peerInfo(peer));
        }
        break;
      }
      case proto.T.PING:
        this._sendTcp(peer, proto.encodeJson(proto.T.PONG, { t: pkt.t }));
        break;
      case proto.T.PONG:
        this.emit('pong', { id: peer.id, t: pkt.t });
        break;
      case proto.T.CLIPBOARD:
        this.emit('clipboard', { from: peer.id, format: pkt.format, data: pkt.data });
        break;
      case proto.T.BYE:
        peer.socket.destroy();
        break;
    }
  }

  _onUdp(msg, rinfo) {
    let pkt;
    try {
      pkt = proto.decode(crypto.open(this.key, msg));
    } catch {
      return; // ignore unauthenticated datagrams
    }
    // Clients may register their UDP endpoint with a PING so we learn the port.
    if (pkt.type === proto.T.PING && pkt.id) {
      const peer = this.peers.get(pkt.id);
      if (peer) {
        peer.ip = rinfo.address.replace(/^::ffff:/, '');
        peer.udpPort = rinfo.port;
      }
    }
  }

  _peerInfo(peer) {
    return {
      id: peer.id,
      name: peer.name,
      originX: peer.originX,
      originY: peer.originY,
      width: peer.width,
      height: peer.height,
      ip: peer.ip,
    };
  }

  // ---- sending -------------------------------------------------------------

  _sendTcp(peer, plaintext) {
    if (!peer || !peer.socket || peer.socket.destroyed) return;
    try {
      peer.socket.write(frame(crypto.seal(this.key, plaintext)));
    } catch (e) {
      this.emit('warn', 'tcp send failed: ' + e.message);
    }
  }

  _sendUdp(peer, plaintext) {
    if (!peer || !this._udp || !peer.ip) return;
    const blob = crypto.seal(this.key, plaintext);
    this._udp.send(blob, peer.udpPort, peer.ip, (e) => {
      if (e) this.emit('warn', 'udp send failed: ' + e.message);
    });
  }

  // Public per-peer senders ---------------------------------------------------

  sendMouseMove(peerId, localX, localY) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this._motionSeq = (this._motionSeq + 1) >>> 0;
    this._sendUdp(peer, proto.encodeMouseMove(this._motionSeq, localX, localY));
  }

  sendMouseButton(peerId, button, down) {
    const peer = this.peers.get(peerId);
    if (peer) this._sendTcp(peer, proto.encodeMouseButton(button, down));
  }

  sendWheel(peerId, dx, dy) {
    const peer = this.peers.get(peerId);
    if (peer) this._sendTcp(peer, proto.encodeMouseWheel(dx, dy));
  }

  sendKey(peerId, down, canon, rawcode, modifiers) {
    const peer = this.peers.get(peerId);
    if (peer) this._sendTcp(peer, proto.encodeKey(down, canon, rawcode, modifiers));
  }

  sendEnter(peerId, localX, localY) {
    const peer = this.peers.get(peerId);
    if (peer) this._sendTcp(peer, proto.encodeEnter(localX, localY));
  }

  sendLeave(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) this._sendTcp(peer, proto.encodeLeave());
  }

  sendClipboard(peerId, format, data) {
    const peer = this.peers.get(peerId);
    if (peer) this._sendTcp(peer, proto.encodeJson(proto.T.CLIPBOARD, { format, data }));
  }

  broadcastClipboard(format, data, exceptId) {
    for (const id of this.peers.keys()) {
      if (id !== exceptId) this.sendClipboard(id, format, data);
    }
  }
}

module.exports = { NetServer };
