'use strict';
// Core orchestration.
//
// ServerCore runs on the machine with the physical keyboard & mouse. It follows
// the classic software-KVM model:
//
//   - While the cursor is on THIS machine ("local" mode) we do NOT capture or
//     suppress anything. We just watch the real cursor's absolute position and
//     wait for it to hit a screen EDGE that has another machine placed across it.
//   - When it does, we switch to "remote" mode: suppress local input, park the
//     local cursor, and from then on translate relative mouse deltas into the
//     active remote machine's coordinates. When the (virtual) cursor crosses back
//     over the shared edge into this machine, we return to local mode and warp
//     the real cursor to the matching spot.
//
// This avoids the failure mode where a virtual cursor, moved purely by
// accumulated deltas, desyncs from the real cursor (or a mis-placed/overlapping
// layout) and hijacks input the instant sharing starts.
//
// ClientCore runs on a controlled machine: it injects whatever input arrives.

const EventEmitter = require('events');

const EDGE = 2; // px tolerance for "cursor is against a screen edge"

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

class ServerCore extends EventEmitter {
  constructor({ layout, backend, server, config }) {
    super();
    this.layout = layout;
    this.backend = backend;
    this.server = server;
    this.config = config;

    this.mode = 'local'; // 'local' | 'remote'
    this.activeId = layout.localId;
    this.remoteId = null; // the machine we're currently controlling (mode==='remote')
    const localNode = layout.get(layout.localId);
    const c = localNode ? layout.center(localNode) : { x: 0, y: 0 };
    this.vx = c.x; // virtual cursor in GLOBAL coords (meaningful in remote mode)
    this.vy = c.y;
    this._lastSwitch = 0;
  }

  start() {
    const b = this.backend;
    b.on('mousemove', (e) => this._onMove(e));
    b.on('mousedown', (e) => this._onButton(e, true));
    b.on('mouseup', (e) => this._onButton(e, false));
    b.on('wheel', (e) => this._onWheel(e));
    b.on('keydown', (e) => this._onKey(e, true));
    b.on('keyup', (e) => this._onKey(e, false));
    b.startCapture();
    this.emit('status', { active: this.activeId });
  }

  stop() {
    try {
      this.backend.setSuppress(false);
      this.backend.stopCapture();
    } catch {}
  }

  get controllingRemote() {
    return this.mode === 'remote';
  }

  _localNode() {
    return this.layout.get(this.layout.localId);
  }

  _localCenter() {
    const n = this._localNode();
    if (!n) return { x: 0, y: 0 };
    return { x: n.originX + Math.floor(n.width / 2), y: n.originY + Math.floor(n.height / 2) };
  }

  // ---- mouse ---------------------------------------------------------------

  _onMove(e) {
    if (this.mode === 'local') this._onMoveLocal(e);
    else this._onMoveRemote(e);
  }

  // On our own screen: watch absolute position, cross only at a real edge.
  _onMoveLocal(e) {
    const local = this._localNode();
    if (!local) return;
    // Native/JS backends report absolute local-screen coords in e.x/e.y.
    const g = this.layout.toGlobal(local, e.x, e.y);
    this.vx = g.x;
    this.vy = g.y;

    const target = this._edgeTarget(local, e.x, e.y, g);
    if (target) this._enterRemote(target.node, target.entry);
  }

  // Is the real cursor pressed against an edge that has a machine across it?
  _edgeTarget(local, lx, ly, g) {
    const atLeft = lx <= local.originX + EDGE;
    const atRight = lx >= local.originX + local.width - 1 - EDGE;
    const atTop = ly <= local.originY + EDGE;
    const atBottom = ly >= local.originY + local.height - 1 - EDGE;

    let probe = null;
    if (atRight) probe = { x: local.layoutX + local.width + 1, y: g.y };
    else if (atLeft) probe = { x: local.layoutX - 1, y: g.y };
    else if (atBottom) probe = { x: g.x, y: local.layoutY + local.height + 1 };
    else if (atTop) probe = { x: g.x, y: local.layoutY - 1 };
    if (!probe) return null;

    const node = this.layout.nodeAt(probe.x, probe.y);
    if (!node || node.id === this.layout.localId) return null;
    const entry = {
      x: clamp(probe.x, node.layoutX, node.layoutX + node.width - 1),
      y: clamp(probe.y, node.layoutY, node.layoutY + node.height - 1),
    };
    return { node, entry };
  }

  // Controlling a remote: move the virtual cursor by deltas, forward, and detect
  // crossing back into our own screen.
  _onMoveRemote(e) {
    const from = this.layout.get(this.activeId) || this._localNode();
    const r = this.layout.applyDelta(from, this.vx, this.vy, e.dx, e.dy);
    this.vx = r.x;
    this.vy = r.y;

    if (r.node && r.node.id === this.layout.localId) {
      this._returnLocal(r.node);
      return;
    }
    if (r.node && r.node.id !== this.activeId) {
      this._switchRemote(r.node); // moved directly between two remote screens
    }
    const node = this.layout.get(this.activeId);
    if (node) {
      const loc = this.layout.toLocal(node, this.vx, this.vy);
      this.server.sendMouseMove(this.activeId, loc.x, loc.y);
    }
  }

  _enterRemote(node, entryGlobal) {
    const now = Date.now();
    if (now - this._lastSwitch < (this.config.edgeGuardMs || 0)) return;
    this._lastSwitch = now;

    this.mode = 'remote';
    this.activeId = node.id;
    this.remoteId = node.id;
    this.vx = entryGlobal.x;
    this.vy = entryGlobal.y;

    // Park the local cursor first, THEN suppress — so the backend's delta
    // baseline is the park point (avoids a bogus first delta).
    const park = this._localCenter();
    try { this.backend.warpCursor(park.x, park.y); } catch {}
    this.backend.setSuppress(true, park);

    const loc = this.layout.toLocal(node, this.vx, this.vy);
    this.server.sendEnter(node.id, loc.x, loc.y);
    this.emit('active-changed', { id: node.id, local: false });
  }

  _switchRemote(node) {
    if (this.remoteId && this.remoteId !== node.id) this.server.sendLeave(this.remoteId);
    this.activeId = node.id;
    this.remoteId = node.id;
    const loc = this.layout.toLocal(node, this.vx, this.vy);
    this.server.sendEnter(node.id, loc.x, loc.y);
    this.emit('active-changed', { id: node.id, local: false });
  }

  _returnLocal(localNode) {
    const now = Date.now();
    if (now - this._lastSwitch < (this.config.edgeGuardMs || 0)) return;
    this._lastSwitch = now;

    this.mode = 'local';
    this.activeId = this.layout.localId;
    this.backend.setSuppress(false);

    const loc = this.layout.toLocal(localNode, this.vx, this.vy);
    try { this.backend.warpCursor(loc.x, loc.y); } catch {}
    if (this.remoteId) this.server.sendLeave(this.remoteId);
    this.remoteId = null;
    this.emit('active-changed', { id: this.activeId, local: true });
  }

  // ---- buttons / wheel / keys ---------------------------------------------

  _onButton(e, down) {
    if (this.controllingRemote) this.server.sendMouseButton(this.activeId, e.button, down);
  }

  _onWheel(e) {
    if (this.controllingRemote) this.server.sendWheel(this.activeId, e.dx || 0, e.dy || 0);
  }

  _onKey(e, down) {
    if (this.controllingRemote && e.canon >= 0) {
      this.server.sendKey(this.activeId, down, e.canon, e.rawcode || 0, e.modifiers || 0);
    }
  }

  /** Force control back to the local machine (panic hotkey). */
  releaseToLocal() {
    if (this.mode === 'local') return;
    const local = this._localNode();
    this.mode = 'local';
    this.activeId = this.layout.localId;
    try { this.backend.setSuppress(false); } catch {}
    if (local) {
      const c = this._localCenter();
      try { this.backend.warpCursor(c.x, c.y); } catch {}
    }
    if (this.remoteId) this.server.sendLeave(this.remoteId);
    this.remoteId = null;
    this._lastSwitch = Date.now();
    this.emit('active-changed', { id: this.activeId, local: true });
  }
}

class ClientCore extends EventEmitter {
  constructor({ backend, client }) {
    super();
    this.backend = backend;
    this.client = client;
  }

  start() {
    const c = this.client;
    c.on('mousemove', ({ x, y }) => this.backend.injectMouseMoveAbs(x, y));
    c.on('mousebutton', ({ button, down }) => this.backend.injectMouseButton(button, down));
    c.on('wheel', ({ dx, dy }) => this.backend.injectWheel(dx, dy));
    c.on('key', ({ down, canon }) => this.backend.injectKey(down, canon));
    c.on('enter', ({ x, y }) => this.backend.warpCursor(x, y));
    c.start();
  }

  stop() {
    try {
      this.client.stop();
    } catch {}
  }
}

module.exports = { ServerCore, ClientCore };
