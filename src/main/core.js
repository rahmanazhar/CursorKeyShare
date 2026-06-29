'use strict';
// Core orchestration.
//
// ServerCore runs on the machine with the physical keyboard & mouse. It owns the
// virtual cursor, walks it across the global layout as the mouse moves, decides
// which machine is "active", and either lets input pass through locally or
// suppresses it and forwards it to the active remote machine.
//
// ClientCore runs on a controlled machine: it injects whatever input arrives.

const EventEmitter = require('events');

class ServerCore extends EventEmitter {
  constructor({ layout, backend, server, config }) {
    super();
    this.layout = layout;
    this.backend = backend;
    this.server = server;
    this.config = config;

    this.activeId = layout.localId;
    const localNode = layout.get(layout.localId);
    const c = localNode ? layout.center(localNode) : { x: 0, y: 0 };
    this.vx = c.x;
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
    return this.activeId !== this.layout.localId;
  }

  _localParkPoint() {
    const n = this.layout.get(this.layout.localId);
    if (!n) return { x: 0, y: 0 };
    return { x: n.originX + Math.floor(n.width / 2), y: n.originY + Math.floor(n.height / 2) };
  }

  _onMove(e) {
    const from = this.layout.get(this.activeId);
    const r = this.layout.applyDelta(from, this.vx, this.vy, e.dx, e.dy);
    this.vx = r.x;
    this.vy = r.y;

    if (r.switched && r.node) {
      this._switchTo(r.node, r.from);
    }

    if (this.controllingRemote) {
      const node = this.layout.get(this.activeId);
      if (node) {
        const loc = this.layout.toLocal(node, this.vx, this.vy);
        this.server.sendMouseMove(this.activeId, loc.x, loc.y);
      }
    }
  }

  _switchTo(node, fromNode) {
    const now = Date.now();
    // Debounce to avoid flicker at the seam between two screens.
    if (now - this._lastSwitch < (this.config.edgeGuardMs || 0)) {
      return;
    }
    this._lastSwitch = now;
    this.activeId = node.id;
    const goingLocal = node.id === this.layout.localId;

    if (goingLocal) {
      // Returning home: stop suppressing and place the real cursor where the
      // virtual cursor is.
      this.backend.setSuppress(false);
      const loc = this.layout.toLocal(node, this.vx, this.vy);
      this.backend.warpCursor(loc.x, loc.y);
      if (fromNode && fromNode.id !== this.layout.localId) {
        this.server.sendLeave(fromNode.id);
      }
    } else {
      // Entering a remote machine: suppress local input, park the local cursor,
      // and tell the remote where the cursor entered.
      this.backend.setSuppress(true, this._localParkPoint());
      const loc = this.layout.toLocal(node, this.vx, this.vy);
      this.server.sendEnter(node.id, loc.x, loc.y);
      if (fromNode && fromNode.id !== this.layout.localId && fromNode.id !== node.id) {
        this.server.sendLeave(fromNode.id);
      }
    }
    this.emit('active-changed', { id: this.activeId, local: goingLocal });
  }

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

  /** Force control back to the local machine (e.g. panic hotkey). */
  releaseToLocal() {
    const local = this.layout.get(this.layout.localId);
    if (local) {
      const c = this.layout.center(local);
      this.vx = c.x;
      this.vy = c.y;
      this._switchTo(local, this.layout.get(this.activeId));
    }
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
