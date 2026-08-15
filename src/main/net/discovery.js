'use strict';
// Peer discovery over IPv6 link-local multicast.
//
// Discovery exists because link-local addresses cannot be configured by hand:
// they are derived from the interface, they change with MAC randomisation, and
// the zone suffix is spelled differently on each platform, so an address that
// works on the machine that produced it is meaningless anywhere else. The peer
// therefore has to announce itself and be located by the receiver.
//
// Two properties make this safe and simple:
//
//  * A beacon is sealed with the group key, so opening one IS authenticating
//    it. A beacon we cannot open is not ours and is dropped without comment —
//    discovery and authentication are the same step.
//
//  * A beacon never carries an address. `rinfo.address` already arrives with
//    the correct local zone attached (verified: "fe80::…%en1" on macOS,
//    "fe80::…%12" on Windows), so the receiver derives a usable address from
//    the packet itself and ignores anything the sender might claim.
//
// The group is ff02::1 (all-nodes). RFC 4541 §3 gives no flooding guarantee to
// any other IPv6 multicast group, so a conformant MLD-snooping switch may
// legitimately prune a custom group — all-nodes is the one that always works.

const dgram = require('dgram');
const EventEmitter = require('events');
const crypto = require('./crypto');
const netinfo = require('../netinfo');

const GROUP = 'ff02::1';
const MAX_SKEW_MS = 30000; // reject stale/replayed beacons

class Discovery extends EventEmitter {
  /**
   * @param {{key:Buffer, localId:string, name:string, tcpPort:number,
   *          udpPort:number, port?:number, intervalMs?:number}} opts
   */
  constructor(opts) {
    super();
    this.key = opts.key;
    this.localId = opts.localId;
    this.name = opts.name;
    this.tcpPort = opts.tcpPort;
    this.udpPort = opts.udpPort;
    this.port = opts.port || 24802;
    this.intervalMs = opts.intervalMs || 1000;
    this._sock = null;
    this._timer = null;
    this._ifaces = [];
    /** @type {Map<string, number>} peer id -> last seen ms */
    this.seen = new Map();
  }

  start() {
    this._ifaces = netinfo.linkLocalInterfaces();
    if (!this._ifaces.length) {
      this.emit('warn', 'no link-local IPv6 interface found — discovery disabled');
      return;
    }

    const sock = dgram.createSocket({ type: 'udp6', reuseAddr: true });
    this._sock = sock;
    sock.on('error', (e) => this.emit('warn', 'discovery socket: ' + e.message));
    sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));

    sock.bind(this.port, () => {
      for (const nic of this._ifaces) {
        try {
          sock.addMembership(GROUP, `::%${nic.zone}`);
        } catch (e) {
          this.emit('warn', `join ${GROUP} on ${nic.name} failed: ${e.message}`);
        }
      }
      // Our own beacons come back to us; _onMessage drops them by localId. Keep
      // loopback on so a single machine can still be diagnosed in isolation.
      try { sock.setMulticastLoopback(true); } catch {}
      this.emit('listening', { port: this.port, interfaces: this._ifaces.map((n) => n.name) });
      this._announce();
      this._timer = setInterval(() => this._announce(), this.intervalMs);
    });
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._sock) try { this._sock.close(); } catch {}
    this._sock = null;
    this.seen.clear();
  }

  /** Announce ourselves on every physical link-local interface. */
  _announce() {
    if (!this._sock) return;
    // Deliberately no address field — see the header comment.
    const blob = crypto.seal(
      this.key,
      Buffer.from(
        JSON.stringify({
          v: 1,
          id: this.localId,
          name: this.name,
          tcpPort: this.tcpPort,
          udpPort: this.udpPort,
          t: Date.now(),
        }),
        'utf8'
      )
    );
    for (const nic of this._ifaces) {
      try {
        this._sock.setMulticastInterface(`::%${nic.zone}`);
      } catch {
        continue;
      }
      this._sock.send(blob, this.port, `${GROUP}%${nic.zone}`, (e) => {
        if (e) this.emit('warn', `announce via ${nic.name} failed: ${e.message}`);
      });
    }
  }

  _onMessage(msg, rinfo) {
    let pkt;
    try {
      pkt = JSON.parse(crypto.open(this.key, msg).toString('utf8'));
    } catch {
      return; // not sealed with our group key — not ours, and not worth a log line
    }
    if (!pkt || pkt.v !== 1 || !pkt.id) return;
    // Multicast loops back, so we hear ourselves. Drop by identity rather than
    // by address, so it still works when we are multi-homed.
    if (pkt.id === this.localId) return;
    // Cheap replay guard: a captured beacon stops being useful after 30s.
    if (typeof pkt.t !== 'number' || Math.abs(Date.now() - pkt.t) > MAX_SKEW_MS) return;

    // rinfo.address already carries this machine's own zone for the interface
    // the packet arrived on, which is exactly what we need to talk back.
    const address = rinfo.address;
    const first = !this.seen.has(pkt.id);
    this.seen.set(pkt.id, Date.now());

    this.emit('peer', {
      id: pkt.id,
      name: pkt.name || pkt.id,
      tcpPort: pkt.tcpPort,
      udpPort: pkt.udpPort,
      address,
      first,
    });
  }
}

module.exports = { Discovery, GROUP, MAX_SKEW_MS };
