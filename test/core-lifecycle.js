'use strict';
// The input backend is a process-wide singleton (src/main/input.js), so any
// listener ServerCore leaves attached accumulates across engine restarts and
// every input event then fires N times.

const EventEmitter = require('events');
const { ServerCore } = require('../src/main/core');
const { Layout } = require('../src/main/layout');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

// Minimal stand-in for the native/JS backend: an EventEmitter with the methods
// ServerCore calls. Mirrors the real singleton by being reused across cycles.
class FakeBackend extends EventEmitter {
  startCapture() {}
  stopCapture() {}
  setSuppress() {}
  warpCursor() {}
  setCursorVisible() {}
}

const EVENTS = ['mousemove', 'mousedown', 'mouseup', 'wheel', 'keydown', 'keyup'];
const backend = new FakeBackend();

const makeLayout = () => {
  const l = new Layout();
  l.setLocal('local');
  l.upsert({ id: 'local', name: 'local', originX: 0, originY: 0, width: 1920, height: 1080, isLocal: true, online: true, layoutX: 0, layoutY: 0 });
  return l;
};
const fakeServer = { sendMouseMove() {}, sendMouseButton() {}, sendWheel() {}, sendKey() {}, sendEnter() {}, sendLeave() {} };

// Three full start/stop cycles on the SAME backend instance.
for (let i = 0; i < 3; i++) {
  const core = new ServerCore({ layout: makeLayout(), backend, server: fakeServer, config: { edgeGuardMs: 80 } });
  core.start();
  const during = EVENTS.map((e) => backend.listenerCount(e));
  ck(`cycle ${i}: exactly one listener per event while started`,
     during.every((c) => c === 1), 'counts=' + during.join(','));
  core.stop();
  const after = EVENTS.map((e) => backend.listenerCount(e));
  ck(`cycle ${i}: zero listeners per event after stop`,
     after.every((c) => c === 0), 'counts=' + after.join(','));
}

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
