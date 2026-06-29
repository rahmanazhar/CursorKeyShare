'use strict';
// Native input backend. Wraps the compiled `cursorkeyshare-native` addon which
// installs true low-level hooks (Windows SetWindowsHookEx, macOS CGEventTap) and
// can SWALLOW local events while you control a remote machine.
//
// The addon speaks raw OS key codes; we translate to/from canonical codes here.

const EventEmitter = require('events');
const { BUTTON } = require('./net/protocol');
const keymapOs = require('./keymap_os');

function loadAddon() {
  const candidates = [
    '../../build/Release/cursorkeyshare-native.node',
    '../../build/Debug/cursorkeyshare-native.node',
  ];
  for (const rel of candidates) {
    try {
      return require(require('path').join(__dirname, rel));
    } catch {}
  }
  return null;
}

class NativeBackend extends EventEmitter {
  constructor(addon) {
    super();
    this._n = addon;
    this.suppressable = true;
    this._capturing = false;
  }

  available() {
    return { capture: true, inject: true };
  }
  async init() {
    return this.available();
  }

  startCapture() {
    if (this._capturing) return;
    this._capturing = true;
    // The addon invokes this for every input event on a libuv thread-safe fn.
    this._n.startCapture((ev) => this._dispatch(ev));
  }

  stopCapture() {
    if (!this._capturing) return;
    this._capturing = false;
    try {
      this._n.stopCapture();
    } catch {}
  }

  _dispatch(ev) {
    switch (ev.type) {
      case 'mousemove':
        this.emit('mousemove', { dx: ev.dx, dy: ev.dy, x: ev.x, y: ev.y });
        break;
      case 'mousedown':
        this.emit('mousedown', { button: mapBtn(ev.button), x: ev.x, y: ev.y });
        break;
      case 'mouseup':
        this.emit('mouseup', { button: mapBtn(ev.button), x: ev.x, y: ev.y });
        break;
      case 'wheel':
        this.emit('wheel', { dx: ev.dx || 0, dy: ev.dy || 0 });
        break;
      case 'keydown':
      case 'keyup':
        this.emit(ev.type, {
          canon: keymapOs.fromOs(ev.keycode),
          rawcode: ev.keycode,
          modifiers: ev.modifiers || 0,
        });
        break;
    }
  }

  setSuppress(on) {
    try {
      this._n.setSuppress(!!on);
      return true;
    } catch {
      return false;
    }
  }

  injectMouseMoveAbs(x, y) {
    this._n.injectMouseMove(Math.round(x), Math.round(y));
  }
  injectMouseButton(button, down) {
    this._n.injectMouseButton(toNativeBtn(button), !!down);
  }
  injectWheel(dx, dy) {
    this._n.injectWheel(dx | 0, dy | 0);
  }
  injectKey(down, canon) {
    const os = keymapOs.toOs(canon);
    if (os >= 0) this._n.injectKey(!!down, os);
  }
  warpCursor(x, y) {
    this._n.warpCursor(Math.round(x), Math.round(y));
  }
  async getCursorPos() {
    try {
      return this._n.getCursorPos();
    } catch {
      return { x: 0, y: 0 };
    }
  }
}

// addon button ids: 1=left,2=right,3=middle (matches our BUTTON enum directly)
function mapBtn(b) {
  return b;
}
function toNativeBtn(b) {
  return b;
}

module.exports = { NativeBackend, loadAddon };
