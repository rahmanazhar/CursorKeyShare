'use strict';
// JS input backend: uiohook-napi for global capture, nut.js for injection.
//
// LIMITATION: uiohook is a passive listener — it cannot SWALLOW events. So on a
// machine using this backend, local input is not truly suppressed while you are
// controlling a remote screen. We approximate suppression for the mouse by
// continuously re-centering ("parking") the local cursor so it doesn't drift,
// but keystrokes and clicks still reach local apps. For true suppression build
// the native addon (see input_native.js / native/). This backend is the
// always-available fallback and is perfect for the receiving (client) side.

const EventEmitter = require('events');
const { BUTTON } = require('./net/protocol');
const keymap = require('./keymap');

function lazy(name, alt) {
  try {
    return require(name);
  } catch {
    if (alt) {
      try {
        return require(alt);
      } catch {}
    }
    return null;
  }
}

class JsBackend extends EventEmitter {
  constructor() {
    super();
    this.suppressable = false; // soft-only
    this._suppress = false;
    this._capturing = false;
    this._last = null; // last cursor pos for delta calc
    this._parkAt = null; // {x,y} center to park at while suppressed
    this._queue = Promise.resolve();

    this._uiohookMod = lazy('uiohook-napi');
    this._nut = lazy('@nut-tree-fork/nut-js', '@nut-tree/nut-js');

    this._uio = this._uiohookMod ? this._uiohookMod.uIOhook : null;
    if (this._nut) {
      this._mouse = this._nut.mouse;
      this._keyboard = this._nut.keyboard;
      this._Button = this._nut.Button;
      this._Point = this._nut.Point;
      try {
        this._mouse.config.autoDelayMs = 0;
        this._keyboard.config.autoDelayMs = 0;
      } catch {}
    }
  }

  available() {
    return { capture: !!this._uio, inject: !!this._nut };
  }

  async init() {
    return this.available();
  }

  // ---- capture -------------------------------------------------------------

  startCapture() {
    if (!this._uio || this._capturing) return;
    this._capturing = true;

    this._uio.on('mousemove', (e) => this._onMove(e));
    this._uio.on('mousedrag', (e) => this._onMove(e));
    this._uio.on('mousedown', (e) =>
      this.emit('mousedown', { button: mapUioButton(e.button), x: e.x, y: e.y })
    );
    this._uio.on('mouseup', (e) =>
      this.emit('mouseup', { button: mapUioButton(e.button), x: e.x, y: e.y })
    );
    this._uio.on('wheel', (e) => {
      // uiohook: rotation>0 typically scroll up; direction 3=vertical,4=horizontal
      const amt = e.rotation || 0;
      if (e.direction === 4) this.emit('wheel', { dx: amt, dy: 0 });
      else this.emit('wheel', { dx: 0, dy: amt });
    });
    this._uio.on('keydown', (e) => this._onKey(true, e));
    this._uio.on('keyup', (e) => this._onKey(false, e));

    this._uio.start();
  }

  stopCapture() {
    if (!this._uio || !this._capturing) return;
    this._capturing = false;
    try {
      this._uio.stop();
      this._uio.removeAllListeners();
    } catch {}
  }

  _onMove(e) {
    let dx = 0;
    let dy = 0;
    if (this._last) {
      dx = e.x - this._last.x;
      dy = e.y - this._last.y;
    }
    this._last = { x: e.x, y: e.y };
    this.emit('mousemove', { dx, dy, x: e.x, y: e.y });

    // Soft parking: while suppressed, keep yanking the local cursor back to the
    // park point so the local pointer doesn't wander while you drive a remote.
    if (this._suppress && this._parkAt) {
      if (e.x !== this._parkAt.x || e.y !== this._parkAt.y) {
        this._last = { ...this._parkAt };
        this.warpCursor(this._parkAt.x, this._parkAt.y);
      }
    }
  }

  _onKey(down, e) {
    const canon = keymap.fromUiohook(e.keycode);
    const modifiers =
      (e.shiftKey ? keymap.MOD.SHIFT : 0) |
      (e.ctrlKey ? keymap.MOD.CTRL : 0) |
      (e.altKey ? keymap.MOD.ALT : 0) |
      (e.metaKey ? keymap.MOD.META : 0);
    this.emit(down ? 'keydown' : 'keyup', { canon, rawcode: e.rawcode || 0, modifiers });
  }

  // ---- suppression (soft) --------------------------------------------------

  setSuppress(on, parkAt) {
    this._suppress = !!on;
    this._parkAt = on ? parkAt || this._parkAt : null;
    if (on && this._parkAt) {
      this._last = { ...this._parkAt };
      this.warpCursor(this._parkAt.x, this._parkAt.y);
    }
    return false; // soft suppression only
  }

  // ---- injection -----------------------------------------------------------

  _enqueue(fn) {
    this._queue = this._queue.then(fn).catch((e) =>
      console.error('[input_js] inject error:', e && e.message)
    );
    return this._queue;
  }

  injectMouseMoveAbs(x, y) {
    if (!this._nut) return;
    this._enqueue(() => this._mouse.setPosition(new this._Point(Math.round(x), Math.round(y))));
  }

  injectMouseButton(button, down) {
    if (!this._nut) return;
    const b = mapToNutButton(this._Button, button);
    if (b === undefined) return;
    this._enqueue(() => (down ? this._mouse.pressButton(b) : this._mouse.releaseButton(b)));
  }

  injectWheel(dx, dy) {
    if (!this._nut) return;
    this._enqueue(async () => {
      if (dy > 0) await this._mouse.scrollUp(Math.abs(dy));
      else if (dy < 0) await this._mouse.scrollDown(Math.abs(dy));
      if (dx > 0) await this._mouse.scrollRight(Math.abs(dx));
      else if (dx < 0) await this._mouse.scrollLeft(Math.abs(dx));
    });
  }

  injectKey(down, canon /*, rawcode, modifiers */) {
    if (!this._nut) return;
    const k = keymap.toNut(canon);
    if (k === undefined) return;
    this._enqueue(() => (down ? this._keyboard.pressKey(k) : this._keyboard.releaseKey(k)));
  }

  // ---- cursor helpers ------------------------------------------------------

  warpCursor(x, y) {
    if (!this._nut) return;
    this._enqueue(() => this._mouse.setPosition(new this._Point(Math.round(x), Math.round(y))));
  }

  async getCursorPos() {
    if (this._last) return { ...this._last };
    if (this._nut) {
      try {
        const p = await this._mouse.getPosition();
        return { x: p.x, y: p.y };
      } catch {}
    }
    return { x: 0, y: 0 };
  }
}

function mapUioButton(b) {
  // uiohook: 1=left, 2=right, 3=middle
  if (b === 1) return BUTTON.LEFT;
  if (b === 2) return BUTTON.RIGHT;
  if (b === 3) return BUTTON.MIDDLE;
  return BUTTON.LEFT;
}

function mapToNutButton(Button, b) {
  if (!Button) return undefined;
  if (b === BUTTON.LEFT) return Button.LEFT;
  if (b === BUTTON.RIGHT) return Button.RIGHT;
  if (b === BUTTON.MIDDLE) return Button.MIDDLE;
  return undefined;
}

module.exports = { JsBackend };
