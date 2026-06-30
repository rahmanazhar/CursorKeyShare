'use strict';
// Regression test for server-side edge crossing (ServerCore + Layout).
//
// Guards against the "cursor enters the client then immediately bounces back to
// the server" oscillation: every crossing must land the virtual cursor a margin
// INSIDE the destination (hysteresis), and a debounce-suppressed crossing must
// not let the virtual cursor drift off the screen it is still controlling.
//
// Pure logic, no Electron — run with: `npm test` (or `node test/edge-crossing.js`).

const { Layout } = require('../src/main/layout');
const { ServerCore } = require('../src/main/core');
const EventEmitter = require('events');

class MockBackend extends EventEmitter {
  constructor() { super(); this.suppress = false; this.cursor = { x: 0, y: 0 }; }
  startCapture() {} stopCapture() {}
  setSuppress(on) { this.suppress = !!on; }
  warpCursor(x, y) { this.cursor = { x, y }; }
  getCursorPos() { return this.cursor; }
}
class MockServer {
  sendEnter() {} sendLeave() {} sendMouseMove() {} sendMouseButton() {} sendWheel() {} sendKey() {}
}

// iMac (local) on the RIGHT at global x:[0,2048); AUROS (client) on the LEFT.
function buildHorizontal(edgeGuardMs) {
  const layout = new Layout();
  layout.setLocal('mac');
  layout.upsert({ id: 'mac', name: 'iMac', width: 2048, height: 1152, originX: 0, originY: 0, layoutX: 0, layoutY: 0, isLocal: true, online: true });
  layout.upsert({ id: 'auros', name: 'AUROS', width: 1920, height: 1080, originX: 0, originY: 0, layoutX: -1920, layoutY: 0, online: true });
  return wire(layout, edgeGuardMs);
}
function wire(layout, edgeGuardMs) {
  const backend = new MockBackend();
  const core = new ServerCore({ layout, backend, server: new MockServer(), config: { edgeGuardMs, switchToClipboard: false } });
  const switches = [];
  core.on('active-changed', (e) => switches.push(e.local ? 'LOCAL' : 'REMOTE:' + e.id));
  core.start();
  return { core, backend, switches };
}
const moveAbs = (b, x, y, dx) => b.emit('mousemove', { x, y, dx: dx || 0, dy: 0 });
const moveRel = (b, dx, dy) => b.emit('mousemove', { dx, dy: dy || 0 });

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + detail));
  if (!cond) failures++;
}

// 1: enter the client, then small hand jitter — must NOT bounce back.
{
  const { core, backend, switches } = buildHorizontal(0);
  moveAbs(backend, 1000, 600, -20);
  moveAbs(backend, 1, 600, -20);   // cross to AUROS
  moveRel(backend, 3, 0); moveRel(backend, -2, 0); moveRel(backend, 2, 0);
  check('enter + jitter does not bounce', switches.join('>') === 'REMOTE:auros', 'got ' + switches.join('>'));
  check('still controlling auros', core.mode === 'remote' && core.activeId === 'auros', 'mode=' + core.mode);
  check('vx stays inside AUROS', core.vx >= -1920 && core.vx < 0, 'vx=' + core.vx);
}
// 2: deliberate return crosses exactly once and parks off the edge.
{
  const { core, backend, switches } = buildHorizontal(0);
  moveAbs(backend, 1, 600, -20);
  moveRel(backend, -100, 0);
  moveRel(backend, 200, 0);        // back into iMac
  check('one enter + one return', switches.join('>') === 'REMOTE:auros>LOCAL', 'got ' + switches.join('>'));
  check('parked off the trigger edge', backend.cursor.x > 2, 'cursor.x=' + backend.cursor.x);
}
// 3: under the real 80ms guard, a fast reverse burst must not desync.
{
  const { core, backend } = buildHorizontal(80);
  moveAbs(backend, 1, 600, -20);
  moveRel(backend, 5, 0); moveRel(backend, 5, 0); moveRel(backend, 5, 0); moveRel(backend, 5, 0);
  check('no desync under guard', core.activeId !== 'auros' || (core.vx >= -1920 && core.vx < 0), 'active=' + core.activeId + ' vx=' + core.vx);
}
// 4: round trip — hysteresis must still allow a legitimate second crossing.
{
  const { switches, backend } = buildHorizontal(0);
  moveAbs(backend, 1, 600, -20);
  moveRel(backend, -50, 0);
  moveRel(backend, 80, 0);
  moveAbs(backend, 1, 600, -20);
  check('round trip enter>return>enter', switches.join('>') === 'REMOTE:auros>LOCAL>REMOTE:auros', 'got ' + switches.join('>'));
}
// 5: vertical layout (client below) — inset works on the Y axis too.
{
  const layout = new Layout();
  layout.setLocal('mac');
  layout.upsert({ id: 'mac', name: 'iMac', width: 2048, height: 1152, originX: 0, originY: 0, layoutX: 0, layoutY: 0, isLocal: true, online: true });
  layout.upsert({ id: 'auros', name: 'AUROS', width: 1920, height: 1080, originX: 0, originY: 0, layoutX: 0, layoutY: 1152, online: true });
  const { core, backend, switches } = wire(layout, 0);
  backend.emit('mousemove', { x: 1000, y: 1151, dx: 0, dy: 20 });
  backend.emit('mousemove', { dx: 0, dy: -3 });
  backend.emit('mousemove', { dx: 0, dy: 2 });
  check('vertical: no bounce on jitter', switches.join('>') === 'REMOTE:auros', 'got ' + switches.join('>'));
  check('vertical: vy stays inside AUROS', core.vy >= 1152 && core.vy < 2232, 'vy=' + core.vy);
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
