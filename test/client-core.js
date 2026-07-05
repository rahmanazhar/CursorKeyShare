'use strict';
// Tests for ClientCore stuck-input release and the server's Cmd->Ctrl remap.
// Run with: `npm test` (or `node test/client-core.js`).

const EventEmitter = require('events');
const { ServerCore, ClientCore } = require('../src/main/core');
const { Layout } = require('../src/main/layout');
const keymap = require('../src/main/keymap');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

// ---- ClientCore: release held keys AND buttons on leave/disconnect ---------
{
  const injected = [];
  const backend = {
    injectMouseMoveAbs() {}, injectWheel() {}, warpCursor() {},
    injectKey(down, canon) { injected.push(['key', canon, down]); },
    injectMouseButton(button, down) { injected.push(['btn', button, down]); },
  };
  const client = new EventEmitter();
  client.start = () => {};
  const core = new ClientCore({ backend, client });
  core.start();

  const CTRL = keymap.nameToCanon('ControlLeft');
  client.emit('key', { down: true, canon: CTRL });   // Ctrl held
  client.emit('mousebutton', { button: 1, down: true }); // drag started
  injected.length = 0;
  client.emit('leave', {});
  ck('leave releases the held key', injected.some(([t, c, d]) => t === 'key' && c === CTRL && d === false), JSON.stringify(injected));
  ck('leave releases the held button', injected.some(([t, b, d]) => t === 'btn' && b === 1 && d === false), JSON.stringify(injected));

  injected.length = 0;
  client.emit('leave', {});
  ck('second leave releases nothing (sets cleared)', injected.length === 0, JSON.stringify(injected));

  client.emit('key', { down: true, canon: CTRL });
  injected.length = 0;
  client.emit('disconnected');
  ck('disconnect also releases held input', injected.some(([t, c, d]) => t === 'key' && c === CTRL && d === false), JSON.stringify(injected));
}

// ---- ServerCore: Cmd forwarded as Ctrl by default, 1:1 when disabled --------
function serverWith(cfg) {
  const layout = new Layout();
  layout.setLocal('mac');
  layout.upsert({ id: 'mac', name: 'mac', width: 100, height: 100, originX: 0, originY: 0, layoutX: 0, layoutY: 0, isLocal: true, online: true });
  layout.upsert({ id: 'win', name: 'win', width: 100, height: 100, originX: 0, originY: 0, layoutX: -100, layoutY: 0, online: true });
  const sent = [];
  const server = { sendKey(id, down, canon) { sent.push(canon); }, sendEnter() {}, sendLeave() {}, sendMouseMove() {}, sendMouseButton() {}, sendWheel() {} };
  const backend = new EventEmitter();
  backend.startCapture = () => {}; backend.stopCapture = () => {};
  backend.setSuppress = () => {}; backend.warpCursor = () => {};
  const core = new ServerCore({ layout, backend, server, config: { edgeGuardMs: 0, ...cfg } });
  core.mode = 'remote'; core.activeId = 'win'; core.remoteId = 'win'; // controlling the client
  return { core, sent };
}
{
  const METAL = keymap.nameToCanon('MetaLeft');
  const CTRLL = keymap.nameToCanon('ControlLeft');
  const on = serverWith({}); // default (cmdSendsCtrl undefined -> on)
  on.core._onKey({ canon: METAL }, true);
  ck('Cmd forwards as Ctrl by default', on.sent[0] === CTRLL, 'sent ' + on.sent[0] + ' expected ' + CTRLL);

  const off = serverWith({ cmdSendsCtrl: false });
  off.core._onKey({ canon: METAL }, true);
  ck('Cmd forwards 1:1 when disabled', off.sent[0] === METAL, 'sent ' + off.sent[0] + ' expected ' + METAL);

  const plain = serverWith({});
  plain.core._onKey({ canon: CTRLL }, true);
  ck('Ctrl itself is untouched', plain.sent[0] === CTRLL, 'sent ' + plain.sent[0]);
}

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
