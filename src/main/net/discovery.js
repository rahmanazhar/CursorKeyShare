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
const { isLinkLocal, stripZone } = require('./zone');

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
    this.role = opts.role || 'server';
    this.tcpPort = opts.tcpPort;
    this.udpPort = opts.udpPort;
    this.port = opts.port || 24802;
    this.intervalMs = opts.intervalMs || 1000;
    this._sock = null;
    this._timer = null;
    this._rescanTimer = null;
    this._ifaces = [];
    /** @type {Map<string, {address:string, at:number}>} peer id -> last sighting */
    this.seen = new Map();
  }

  start() {
    this._ifaces = netinfo.linkLocalInterfaces();
    // Rescan even when we found nothing: on a laptop resuming from sleep, or on
    // a slow-associating Wi-Fi adapter, the NIC can appear seconds after start.
    // Returning here without a rescan would leave discovery dead for the whole
    // session.
    this._rescanTimer = setInterval(() => this._rescan(), 5000);
    if (!this._ifaces.length) {
      this.emit('warn', 'no link-local IPv6 interface yet — will keep looking');
      return;
    }
    this._open();
  }

  /** Re-read the interface list; (re)join and (re)open as the set changes. */
  _rescan() {
    const now = netinfo.linkLocalInterfaces();
    const before = this._ifaces.map((n) => n.zone).sort().join(',');
    const after = now.map((n) => n.zone).sort().join(',');
    if (before === after) return;
    this._ifaces = now;
    if (!now.length) {
      this.emit('warn', 'link-local interfaces disappeared');
      return;
    }
    if (!this._sock) { this._open(); return; }
    for (const nic of now) {
      try { this._sock.addMembership(GROUP, `::%${nic.zone}`); } catch {}
    }
    this.emit('warn', `link-local interfaces changed -> ${now.map((n) => n.name).join(', ')}`);
  }

  _open() {
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
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(() => this._announce(), this.intervalMs);
    });
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._rescanTimer) clearInterval(this._rescanTimer);
    this._rescanTimer = null;
    if (this._sock) try { this._sock.close(); } catch {}
    this._sock = null;
    this.seen.clear();
  }

  /** Announce ourselves on every physical link-local interface. */
  _announce() {
    if (!this._sock) return;
    // Sealed PER INTERFACE, because each carries the zone-stripped address it is
    // sent from. crypto.open authenticates the blob, not the datagram carrying
    // it, so without this an attacker who simply captures a beacon off ff02::1
    // — no key needed, all-nodes is joined by every device — can replay it from
    // their own address and permanently redirect a client. Binding the two
    // means a replay can only ever claim the address it was minted for.
    //
    // The zone cannot travel between machines, but the bare fe80:: part is
    // identical on both sides, so this is the portion safe to compare.
    for (const nic of this._ifaces) {
      const blob = crypto.seal(
        this.key,
        Buffer.from(
          JSON.stringify({
            v: 1,
            id: this.localId,
            name: this.name,
            a: nic.address, // zone-stripped; bound to the source on receipt
            // Without a role every node dials every other node: two clients on
            // the same LAN would each discover the other and try to connect.
            role: this.role,
            tcpPort: this.tcpPort,
            udpPort: this.udpPort,
            t: Date.now(),
          }),
          'utf8'
        )
      );
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
    // The socket is dual-stack on ::, so it would otherwise accept beacons from
    // any reachable address. Discovery is a link-local protocol by definition;
    // anything arriving off-link is not a candidate.
    if (!isLinkLocal(rinfo.address)) return;

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
    // Both machines' wall clocks must agree within this window.
    if (typeof pkt.t !== 'number' || Math.abs(Date.now() - pkt.t) > MAX_SKEW_MS) {
      this._warnSkew(pkt.id, pkt.t);
      return;
    }
    // Bind the beacon to its sender — REQUIRED, not optional. Accepting a
    // beacon that merely omits the field would leave the replay path wide open,
    // which is the whole point of the check.
    if (typeof pkt.a !== 'string') {
      this._warnLegacy(pkt.id);
      return;
    }
    if (stripZone(pkt.a).toLowerCase() !== stripZone(rinfo.address).toLowerCase()) return;

    // rinfo.address already carries this machine's own zone for the interface
    // the packet arrived on, which is exactly what we need to talk back.
    const address = rinfo.address;
    const prev = this.seen.get(pkt.id);
    // "changed" covers both a first sighting and a peer whose link-local address
    // moved (MAC randomisation, NIC change). Keying purely on first-sighting
    // would strand the client on a dead address for the rest of the session.
    const changed = !prev || prev.address !== address;
    this.seen.set(pkt.id, { address, at: Date.now() });

    this.emit('peer', {
      id: pkt.id,
      name: pkt.name || pkt.id,
      role: pkt.role || 'server',
      tcpPort: pkt.tcpPort,
      udpPort: pkt.udpPort,
      address,
      first: changed,
      changed,
    });
  }

  // A beacon from an older build carries no address field. Dropping it is
  // correct, but doing so silently looks identical to "nobody is there" — so
  // say why. Rate-limited; only reachable for beacons that already decrypted,
  // so it cannot be triggered by an outsider.
  _warnLegacy(id) {
    const now = Date.now();
    if (this._lastLegacyWarn && now - this._lastLegacyWarn < 30000) return;
    this._lastLegacyWarn = now;
    this.emit('warn',
      `ignoring beacon from ${id}: no source address field — that peer is running ` +
      `an older build; update both machines`);
  }

  // A clock-skew drop is silent and looks exactly like "nobody is there", so
  // surface it — rate-limited, and only for beacons that already authenticated.
  _warnSkew(id, t) {
    const now = Date.now();
    if (this._lastSkewWarn && now - this._lastSkewWarn < 30000) return;
    this._lastSkewWarn = now;
    const off = typeof t === 'number' ? Math.round((now - t) / 1000) : null;
    this.emit('warn',
      `ignoring beacon from ${id}: timestamp ${off === null ? 'missing' : off + 's off'} ` +
      `(clocks must agree within ${MAX_SKEW_MS / 1000}s)`);
  }
}

module.exports = { Discovery, GROUP, MAX_SKEW_MS };
