# Phase 1 Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix seven verified defects in the connection/input lifecycle that cause cursor jitter today and that would be amplified into hard failures by the Phase 2 transport work.

**Architecture:** No new features, no new dependencies, no config schema changes. Each task is a localised fix to existing code plus a regression test. Tests are plain Node scripts under `test/`, run by a new discovery-based runner so a failure in one file no longer hides the rest.

**Tech Stack:** Node.js (Electron 31 bundles Node 20), CommonJS, no test framework — `test/*.js` are standalone scripts that print `PASS`/`FAIL` and exit non-zero on failure.

**Spec:** `docs/superpowers/specs/2026-08-15-vpn-resilient-transport-design.md` (Phase 1 section)

## Global Constraints

- No new runtime dependencies. `package.json` `dependencies` stays `node-addon-api` + `uiohook-napi`.
- CommonJS only (`require`/`module.exports`), `'use strict';` at the top of every file.
- Tests are standalone scripts: no framework, no assertions library. Use the existing `ck(name, cond, detail)` helper pattern from `test/net-liveness.js`.
- A test file MUST `process.exit(1)` on any failure and `process.exit(0)` otherwise.
- Match the surrounding comment style: explain *why*, not *what*.
- Tasks 2 and 3 must land in the same commit — Task 2 alone causes a permanent motion freeze.

---

### Task 1: Test runner and CI wiring

Currently `npm test` chains five files with `&&`, so a failure in the first silently skips the other four, and CI never runs tests at all (`.gitlab-ci.yml` declares only `stages: [build]`, gated on `$CI_COMMIT_TAG`). Every later task in this plan adds tests; without this task those tests would not run in CI.

**Files:**
- Create: `scripts/run-tests.js`
- Modify: `package.json:9` (the `test` script)
- Modify: `.gitlab-ci.yml:15` (stages) and add a `test` job

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` discovers and runs every `test/*.js` in its own process, reports a summary, exits 1 if any file failed. Later tasks add files to `test/` and get run automatically with no further wiring.

- [ ] **Step 1: Write the failing test**

Create `test/runner-selftest.js`:

```js
'use strict';
// Guards the test runner itself: a failing test file must not prevent later
// files from running (the old `&&` chain silently skipped them).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cks-runner-'));
fs.writeFileSync(path.join(dir, 'a-fails.js'), 'console.log("ran A"); process.exit(1);');
fs.writeFileSync(path.join(dir, 'b-passes.js'), 'console.log("ran B"); process.exit(0);');

const runner = path.join(__dirname, '..', 'scripts', 'run-tests.js');
const r = spawnSync(process.execPath, [runner], {
  encoding: 'utf8',
  env: { ...process.env, CKS_TEST_DIR: dir },
});
const out = (r.stdout || '') + (r.stderr || '');

ck('runs the file that fails', /ran A/.test(out), out.slice(0, 300));
ck('still runs the later file', /ran B/.test(out), out.slice(0, 300));
ck('exits non-zero overall', r.status === 1, 'status=' + r.status);
ck('names the failing file', /a-fails\.js/.test(out), out.slice(0, 300));

fs.rmSync(dir, { recursive: true, force: true });
console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/runner-selftest.js`
Expected: FAIL — `Cannot find module '.../scripts/run-tests.js'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/run-tests.js`:

```js
'use strict';
// Runs every test/*.js in its own process. Unlike the previous `&&` chain, one
// failing file does not hide the ones after it — each runs and the summary
// names every failure. CKS_TEST_DIR overrides the directory (used by the
// runner's own self-test).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = process.env.CKS_TEST_DIR || path.join(__dirname, '..', 'test');
const self = path.basename(__filename);
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.js') && f !== self)
  .sort();

const failed = [];
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}

console.log('\n' + '='.repeat(52));
console.log(`${files.length - failed.length}/${files.length} test files passed`);
if (failed.length) {
  console.log('FAILED: ' + failed.join(', '));
  process.exit(1);
}
process.exit(0);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/runner-selftest.js`
Expected: PASS on all four checks, `ALL PASS`

- [ ] **Step 5: Point npm test at the runner**

In `package.json`, replace the `test` script:

```json
"test": "node scripts/run-tests.js"
```

Run: `npm test`
Expected: all six files run (five existing + `runner-selftest.js`), summary `6/6 test files passed`

- [ ] **Step 6: Add a CI test job**

In `.gitlab-ci.yml`, change line 15 to:

```yaml
stages: [test, build]
```

and add this job immediately after the `variables:` block (before `build:mac:`):

```yaml
# Tests run on every branch and MR on a cheap Linux runner. The suite does not
# need the native addon — netbind degrades to no-ops without it — so skip the
# node-gyp build with --ignore-scripts to keep this job fast.
test:
  stage: test
  image: node:20
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH'
    - if: '$CI_COMMIT_TAG'
  before_script:
    - npm ci --ignore-scripts
  script:
    - npm test
```

- [ ] **Step 7: Verify the suite passes without the native addon**

Run: `CKS_FORCE_JS=1 npm test` (and confirm nothing depends on `build/Release/*.node` being present — if a test fails only because the addon is missing, fix that test to skip rather than fail)
Expected: `6/6 test files passed`

- [ ] **Step 8: Commit**

```bash
git add scripts/run-tests.js test/runner-selftest.js package.json .gitlab-ci.yml
git commit -m "test: run every test file independently and wire up CI

The && chain meant a failure in the first file silently skipped the other
four, and CI only ever ran the tag-gated macOS build job. Tests now run on
every branch and MR."
```

---

### Task 2: Fix seqNewer and reset the motion sequence on reconnect

`seqNewer()` uses `& 0xffffffff`, which coerces to **signed** int32, so the comparison is always true and the stale-datagram drop has never worked — every out-of-order motion packet is applied. This is live cursor jitter.

Fixing it alone is not safe: the server's `_motionSeq` resets to 0 in the `NetServer` constructor (`server.js:34`) and `main.js:159` builds a fresh `NetServer` on every `startEngine()`, while the client's `_lastMoveSeq` is set only in the `NetClient` constructor and never reset on reconnect. With a working stale-drop, every post-restart datagram would compare as stale and motion would freeze permanently. **Both fixes land in one commit.**

**Files:**
- Modify: `src/main/net/client.js:244-246` (`seqNewer`), `src/main/net/client.js:248` (exports), `src/main/net/client.js:96-98` (`_onConnected`)
- Create: `test/client-seq.js`

**Interfaces:**
- Consumes: the runner from Task 1
- Produces: `seqNewer(a, b)` exported from `src/main/net/client.js` as a named export alongside `NetClient`

- [ ] **Step 1: Write the failing test**

Create `test/client-seq.js`:

```js
'use strict';
// Unit tests for the UDP motion sequence comparison. The original used
// `& 0xffffffff`, which coerces to a SIGNED int32 and so returned true for
// every input — the stale-drop in _onUdp never dropped anything.

const { seqNewer } = require('../src/main/net/client');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

ck('rejects a slightly older seq', seqNewer(100, 105) === false, 'got ' + seqNewer(100, 105));
ck('rejects a much older seq', seqNewer(1, 50000) === false, 'got ' + seqNewer(1, 50000));
ck('accepts a newer seq', seqNewer(105, 100) === true, 'got ' + seqNewer(105, 100));
ck('rejects an equal seq', seqNewer(100, 100) === false, 'got ' + seqNewer(100, 100));
ck('accepts across 32-bit wrap', seqNewer(5, 0xfffffffb) === true, 'got ' + seqNewer(5, 0xfffffffb));
ck('rejects reverse of a wrap', seqNewer(0xfffffffb, 5) === false, 'got ' + seqNewer(0xfffffffb, 5));
ck('accepts the first packet after reset', seqNewer(1, 0) === true, 'got ' + seqNewer(1, 0));

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/client-seq.js`
Expected: FAIL — `seqNewer is not a function` (not yet exported)

- [ ] **Step 3: Fix seqNewer and export it**

In `src/main/net/client.js`, replace the function at line 244:

```js
// 32-bit wrap-around aware "a is newer than b".
// NOTE: must be `>>> 0` (unsigned), not `& 0xffffffff` — the latter coerces to
// a SIGNED int32, making every comparison true and disabling the stale-drop.
function seqNewer(a, b) {
  return ((a - b) >>> 0) < 0x80000000 && a !== b;
}
```

and line 248:

```js
module.exports = { NetClient, seqNewer };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/client-seq.js`
Expected: PASS on all seven checks

- [ ] **Step 5: Reset the high-water mark on every connection**

In `src/main/net/client.js`, inside `_onConnected()`, next to the existing `this._reader = new FrameReader();` (line 97), add:

```js
    this._reader = new FrameReader();
    // The server's _motionSeq restarts at 0 with each NetServer instance (one
    // per startEngine), so a stale high-water mark from the previous session
    // would reject every new datagram and freeze motion permanently.
    this._lastMoveSeq = 0;
```

- [ ] **Step 6: Add a reconnect-motion regression test**

Append to `test/net-liveness.js`, inside the `try` block after the existing check `ck('server re-registers the peer', ...)` on line 64:

```js
    // 4) Motion still flows after a reconnect. The server's _motionSeq restarts
    //    at 0 for a new NetServer; if the client kept its old high-water mark
    //    the (now working) stale-drop would reject everything forever.
    client._lastMoveSeq = 50000; // simulate a long previous session
    client.stop();
    client.start();
    await waitFor(() => client.connected, 6000);
    ck('lastMoveSeq reset on reconnect', client._lastMoveSeq === 0,
       'lastMoveSeq=' + client._lastMoveSeq);

    const moved = [];
    client.on('mousemove', (m) => moved.push(m));
    await waitFor(() => server.peers.size === 1, 3000);
    const p2 = [...server.peers.values()][0];
    server.sendMouseMove(p2.id, 111, 222);
    await waitFor(() => moved.length > 0, 3000);
    ck('motion delivered after reconnect', moved.length > 0, 'moved=' + moved.length);
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all files pass, including the two new checks in `net-liveness.js`

- [ ] **Step 8: Commit**

```bash
git add src/main/net/client.js test/client-seq.js test/net-liveness.js
git commit -m "fix(net): make seqNewer wrap-aware and reset motion seq on reconnect

seqNewer used & 0xffffffff, which coerces to a signed int32, so it returned
true for every input and the stale-datagram drop never dropped anything —
every out-of-order motion packet was applied, causing cursor jitter.

Fixing that alone would freeze motion permanently after any reconnect: the
server's _motionSeq resets with each NetServer while the client's high-water
mark did not. Both fixes belong in one commit."
```

---

### Task 3: Detach input-backend listeners on stop

`getBackend()` memoises a process-wide singleton (`input.js:8-11`). `ServerCore.start()` attaches six anonymous arrow listeners (`core.js:66-71`) and `stop()` never removes them (`core.js:79-85`). `startEngine()` calls `stopEngine()` then `getBackend()`, so every restart leaks a full set and each input event is delivered once per past session.

**Files:**
- Modify: `src/main/core.js:46-62` (constructor), `:64-77` (`start`), `:79-85` (`stop`)
- Create: `test/core-lifecycle.js`

**Interfaces:**
- Consumes: `seqNewer` export is unrelated; nothing from Task 2
- Produces: `ServerCore` gains a private `this._handlers` field (`null` when stopped, an object of six named handlers when started)

- [ ] **Step 1: Write the failing test**

Create `test/core-lifecycle.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/core-lifecycle.js`
Expected: FAIL — cycle 0 leaves 1 listener per event after stop; cycle 1 shows 2 during, etc.

- [ ] **Step 3: Store bound handlers and detach them**

In `src/main/core.js`, add to the `ServerCore` constructor after `this._lastSwitch = 0;` (line 61):

```js
    this._handlers = null; // set while started; see start()/stop()
```

Replace the listener block in `start()` (lines 65-71) with:

```js
    const b = this.backend;
    // Keep the bound references so stop() can detach them. The backend is a
    // process-wide singleton (input.js), so anything left attached accumulates
    // across engine restarts and every event fires once per past session.
    this._handlers = {
      mousemove: (e) => this._onMove(e),
      mousedown: (e) => this._onButton(e, true),
      mouseup: (e) => this._onButton(e, false),
      wheel: (e) => this._onWheel(e),
      keydown: (e) => this._onKey(e, true),
      keyup: (e) => this._onKey(e, false),
    };
    for (const [ev, fn] of Object.entries(this._handlers)) b.on(ev, fn);
```

Replace `stop()` (lines 79-85) with:

```js
  stop() {
    this._setCursorVisible(true);
    if (this._handlers) {
      for (const [ev, fn] of Object.entries(this._handlers)) {
        try { this.backend.removeListener(ev, fn); } catch {}
      }
      this._handlers = null;
    }
    try {
      this.backend.setSuppress(false);
      this.backend.stopCapture();
    } catch {}
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/core-lifecycle.js`
Expected: PASS on all six checks (3 cycles × 2 assertions)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all files pass — confirms `edge-crossing.js` and `client-core.js` still work against the refactored `start()`

- [ ] **Step 6: Commit**

```bash
git add src/main/core.js test/core-lifecycle.js
git commit -m "fix(core): detach input listeners on stop

The backend is a process-wide singleton, so the six anonymous listeners
ServerCore.start() attached were never removed — every engine restart leaked
a full set and duplicated every input event. Phase 2's netwatch restarts the
engine on VPN up/down, which would have made this fire several times per
VPN connect."
```

---

### Task 4: Emit peer-disconnected on server stop and mark nodes offline

`server.stop()` destroys sockets then calls `this.peers.clear()` synchronously (`server.js:73-79`). The sockets' `close` handlers fire later and their identity check `this.peers.get(peer.id) === peer` (`server.js:132`) now fails, so `peer-disconnected` never emits. Layout nodes stay `online: true` and the cursor can cross into a machine that is gone.

**Files:**
- Modify: `src/main/net/server.js:72-85` (`stop`)
- Modify: `src/main/main.js:230-241` (`stopEngine`)
- Create: `test/server-stop.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `NetServer.stop()` emits one `peer-disconnected` event per registered peer, synchronously, before clearing the map

- [ ] **Step 1: Write the failing test**

Create `test/server-stop.js`:

```js
'use strict';
// server.stop() cleared this.peers synchronously, before the sockets' async
// 'close' fired — so the close handler's identity check missed and
// peer-disconnected never emitted, leaving layout nodes stuck online.

const crypto = require('../src/main/net/crypto');
const { NetServer } = require('../src/main/net/server');
const { NetClient } = require('../src/main/net/client');

const TCP = 34911, SUDP = 34912, CUDP1 = 34913, CUDP2 = 34914;

function waitFor(cond, ms = 6000, step = 40) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = cond(); } catch {}
      if (ok) { clearInterval(iv); res(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
    }, step);
  });
}

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

(async () => {
  const key = crypto.deriveKey('testpass', 'testgroup');
  const server = new NetServer({ key, tcpPort: TCP, udpPort: SUDP, name: 'srv', localId: 'srv' });
  server.on('error', () => {});
  server.on('warn', () => {});
  const disconnected = [];
  server.on('peer-disconnected', (id) => disconnected.push(id));
  server.start();

  const mk = (id, uport) => new NetClient({
    key, host: '127.0.0.1', tcpPort: TCP, udpPort: uport, serverUdpPort: SUDP,
    name: id, localId: id, bounds: { originX: 0, originY: 0, width: 1920, height: 1080 },
  });
  const c1 = mk('cli1', CUDP1), c2 = mk('cli2', CUDP2);
  for (const c of [c1, c2]) { c.on('warn', () => {}); c.on('error', () => {}); c.start(); }

  try {
    await waitFor(() => server.peers.size === 2);
    ck('two peers registered', server.peers.size === 2);

    server.stop();
    ck('emits one peer-disconnected per peer', disconnected.length === 2,
       'got ' + disconnected.length + ' [' + disconnected.join(',') + ']');
    ck('emits for both ids', disconnected.includes('cli1') && disconnected.includes('cli2'),
       disconnected.join(','));
    ck('peer map cleared', server.peers.size === 0, 'size=' + server.peers.size);
  } catch (e) {
    ck('no timeout', false, e.message);
  } finally {
    try { c1.stop(); } catch {}
    try { c2.stop(); } catch {}
    try { server.stop(); } catch {}
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/server-stop.js`
Expected: FAIL — `emits one peer-disconnected per peer  -> got 0 []`

- [ ] **Step 3: Emit before clearing**

In `src/main/net/server.js`, replace the loop in `stop()` (lines 73-79):

```js
  stop() {
    for (const p of this.peers.values()) {
      try {
        this._sendTcp(p, proto.encodeJson(proto.T.BYE, { reason: 'server-stop' }));
        p.socket.destroy();
      } catch {}
      // Emit synchronously. peers.clear() below runs before the sockets' async
      // 'close' fires, at which point the close handler's identity check would
      // no longer match — so this is the only place the event can come from.
      if (p.id) this.emit('peer-disconnected', p.id);
    }
    this.peers.clear();
```

(the rest of `stop()` is unchanged)

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/server-stop.js`
Expected: PASS on all four checks

- [ ] **Step 5: Mark layout nodes offline in stopEngine**

In `src/main/main.js`, in `stopEngine()`, after `state.running = false;` (line 235):

```js
  // Nothing is connected any more. A node left `online` lets the cursor cross
  // into a machine that is no longer there.
  if (state.layout && state.cfg) {
    for (const n of state.layout.list()) {
      if (n.id !== state.cfg.localId) state.layout.setOnline(n.id, false);
    }
    pushLayout();
  }
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all files pass

- [ ] **Step 7: Commit**

```bash
git add src/main/net/server.js src/main/main.js test/server-stop.js
git commit -m "fix(net): emit peer-disconnected on server stop, mark nodes offline

peers.clear() ran before the sockets' async close, so the close handler's
identity check missed and peer-disconnected never fired. Layout nodes stayed
online and the cursor could cross into a machine that was gone."
```

---

### Task 5: Reject duplicate peer ids instead of evicting

`server.js:142` takes the peer id from the client-asserted HELLO and `:152` does `this.peers.set(peer.id, peer)` with no collision check. A second client with the same `localId` (cloned config, restored backup, imaged VM) silently evicts the first with no disconnect event, leaving both sockets open. Phase 2's discovery makes this the normal case rather than an exotic one.

**Files:**
- Modify: `src/main/net/server.js:139-162` (the `HELLO` case)
- Create: `test/server-dup-id.js`

**Interfaces:**
- Consumes: `peer-disconnected` behaviour from Task 4 (the test asserts the first peer is *not* disconnected)
- Produces: a `BYE` with `reason: 'duplicate-id'` sent to the second client before its socket is destroyed

- [ ] **Step 1: Write the failing test**

Create `test/server-dup-id.js`:

```js
'use strict';
// Two machines sharing a localId (cloned config / restored backup) used to
// silently evict each other: peers.size stayed 1, the first peer got no
// disconnect event, and both sockets were left open.

const crypto = require('../src/main/net/crypto');
const { NetServer } = require('../src/main/net/server');
const { NetClient } = require('../src/main/net/client');

const TCP = 34921, SUDP = 34922, CUDP1 = 34923, CUDP2 = 34924;

function waitFor(cond, ms = 6000, step = 40) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = cond(); } catch {}
      if (ok) { clearInterval(iv); res(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
    }, step);
  });
}

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

(async () => {
  const key = crypto.deriveKey('testpass', 'testgroup');
  const server = new NetServer({ key, tcpPort: TCP, udpPort: SUDP, name: 'srv', localId: 'srv' });
  server.on('error', () => {});
  server.on('warn', () => {});
  const disconnected = [];
  server.on('peer-disconnected', (id) => disconnected.push(id));
  server.start();

  const mk = (uport) => new NetClient({
    key, host: '127.0.0.1', tcpPort: TCP, udpPort: uport, serverUdpPort: SUDP,
    name: 'clone', localId: 'same-id', bounds: { originX: 0, originY: 0, width: 1920, height: 1080 },
  });

  const c1 = mk(CUDP1);
  c1.on('warn', () => {}); c1.on('error', () => {});
  c1.start();

  try {
    await waitFor(() => server.peers.size === 1);
    const first = [...server.peers.values()][0];
    ck('first client registered', server.peers.size === 1);

    const c2 = mk(CUDP2);
    let byeReason = null;
    c2.on('warn', (m) => { if (/duplicate-id/.test(String(m))) byeReason = 'duplicate-id'; });
    c2.on('error', () => {});
    c2.start();

    await waitFor(() => byeReason !== null, 6000);
    ck('second client told duplicate-id', byeReason === 'duplicate-id', 'reason=' + byeReason);
    ck('still exactly one peer', server.peers.size === 1, 'size=' + server.peers.size);
    ck('the surviving peer is the FIRST one', [...server.peers.values()][0] === first);
    ck('first peer not disconnected', disconnected.length === 0, 'disconnected=' + disconnected.join(','));
    ck('first peer socket still open', first.socket.destroyed === false);

    try { c2.stop(); } catch {}
  } catch (e) {
    ck('no timeout', false, e.message);
  } finally {
    try { c1.stop(); } catch {}
    try { server.stop(); } catch {}
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/server-dup-id.js`
Expected: FAIL — the second client is never told `duplicate-id` (times out), and the surviving peer is the second, not the first

- [ ] **Step 3: Reject the duplicate**

In `src/main/net/server.js`, replace the opening of the `HELLO` case (lines 141-144):

```js
      case proto.T.HELLO: {
        const id = pkt.id || pkt.localId;
        const existing = this.peers.get(id);
        if (existing && existing !== peer && !existing.socket.destroyed) {
          // Two machines sharing a localId (cloned config, restored backup,
          // imaged VM). Silently evicting the first loses its session with no
          // disconnect event and leaves both sockets open — refuse instead.
          this.emit('warn', `rejecting client with duplicate id ${id}`);
          this._sendTcp(peer, proto.encodeJson(proto.T.BYE, { reason: 'duplicate-id' }));
          peer.socket.destroy();
          return;
        }
        peer.id = id;
        peer.name = pkt.name || peer.ip || 'client';
        if (pkt.udpPort) peer.udpPort = pkt.udpPort;
```

(the remainder of the `HELLO` case — the `pkt.bounds` block onwards — is unchanged)

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/server-dup-id.js`
Expected: PASS on all six checks

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all files pass

- [ ] **Step 6: Commit**

```bash
git add src/main/net/server.js test/server-dup-id.js
git commit -m "fix(net): reject duplicate peer ids instead of silently evicting

A second client asserting an existing localId evicted the first with no
disconnect event and left both sockets open. The first connection now wins
and the duplicate is refused with BYE duplicate-id."
```

---

### Task 6: Make reconnect idempotent

Every wired socket's `close` handler does `this._reconnectTimer = setTimeout(...)` (`client.js:153`). The assignment overwrites the field but the previous timer is still armed and still fires; `stop()` clears exactly one. Sockets from superseded attempts therefore each schedule their own reconnect.

**Files:**
- Modify: `src/main/net/client.js:30-40` (constructor), `:53-61` (`stop`), `:63-87` (`_connect`), `:148-155` (close handler)
- Create: `test/client-reconnect.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `NetClient` gains `this._attemptId` (integer epoch, incremented on every `_connect()` and on `stop()`); socket callbacks from superseded attempts become no-ops

- [ ] **Step 1: Write the failing test**

Create `test/client-reconnect.js`:

```js
'use strict';
// Each socket's close handler armed its own reconnect timer while only one
// handle was tracked, so N close events produced N reconnects (and stop()
// cleared only the last one).

const { NetClient } = require('../src/main/net/client');
const crypto = require('../src/main/net/crypto');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

const key = crypto.deriveKey('testpass', 'testgroup');
// Port 1 is never listening, so _connect() always fails — we are testing the
// scheduling logic, not a real session.
const client = new NetClient({
  key, host: '127.0.0.1', tcpPort: 1, udpPort: 34931, serverUdpPort: 1,
  name: 'cli', localId: 'cli', bounds: { originX: 0, originY: 0, width: 1, height: 1 },
});
client.on('warn', () => {});
client.on('error', () => {});

let connects = 0;
const realConnect = client._connect.bind(client);
client._connect = function () { connects++; return realConnect(); };

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  client.start();
  await sleep(200);
  const afterStart = connects;
  ck('one connect attempt on start', afterStart === 1, 'connects=' + afterStart);

  // Fire several close events as if from superseded sockets of one attempt.
  const fakeClose = () => {
    if (client._sock) client._sock.emit('close');
  };
  fakeClose(); fakeClose(); fakeClose();
  ck('exactly one reconnect timer armed', client._reconnectTimer != null);

  await sleep(2200);
  ck('three closes produced ONE reconnect', connects === afterStart + 1,
     'connects=' + connects + ' (expected ' + (afterStart + 1) + ')');

  client.stop();
  const afterStop = connects;
  await sleep(2200);
  ck('no reconnect fires after stop', connects === afterStop, 'connects=' + connects);
  ck('reconnect timer cleared by stop', client._reconnectTimer == null);

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/client-reconnect.js`
Expected: FAIL — `three closes produced ONE reconnect  -> connects=4 (expected 2)`

- [ ] **Step 3: Add the attempt epoch**

In `src/main/net/client.js`, add to the constructor after `this._stopped = false;` (line 38):

```js
    this._attemptId = 0; // epoch; bumped per connect attempt and on stop so
                         // callbacks from superseded sockets become no-ops
```

At the top of `_connect()`, immediately after the `if (this._stopped) return;` guard (line 64):

```js
    this._attemptId++;
```

In `stop()`, after `this._stopped = true;` (line 54):

```js
    this._attemptId++;
```

and after `if (this._reconnectTimer) clearTimeout(this._reconnectTimer);` (line 55) add:

```js
    this._reconnectTimer = null;
```

- [ ] **Step 4: Make the close handler idempotent**

In `_wire(sock)`, capture the epoch at the top of the function (before `sock.on('data', ...)`):

```js
  _wire(sock) {
    const epoch = this._attemptId;
```

and replace the `close` handler (lines 148-155) with:

```js
    sock.on('close', () => {
      // A socket from a superseded attempt (a cancelled racer, an old session)
      // must not touch current state or schedule its own reconnect.
      if (epoch !== this._attemptId) return;
      this.connected = false;
      if (this._pingTimer) clearInterval(this._pingTimer);
      this._pingTimer = null;
      this.emit('disconnected');
      if (this._stopped) return;
      if (this._reconnectTimer) return; // already armed — reconnect is idempotent
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._connect();
      }, 1500);
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node test/client-reconnect.js`
Expected: PASS on all five checks

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all files pass — `net-liveness.js` in particular still proves a real reconnect happens after a reaper drop

- [ ] **Step 7: Commit**

```bash
git add src/main/net/client.js test/client-reconnect.js
git commit -m "fix(net): make reconnect idempotent

Every socket's close handler armed its own 1500ms reconnect while only one
timer handle was tracked, so superseded sockets each scheduled a reconnect
and stop() cleared only the last. Adds an attempt epoch so callbacks from
superseded sockets are no-ops."
```

---

### Task 7: Cache the derived key across engine restarts

`deriveKey()` runs a ~49 ms blocking `scryptSync` (`crypto.js:29-35`) on every `startEngine()` (`main.js:137`) — on the Electron main thread, the same thread native input events marshal onto via the ThreadSafeFunction. Phase 2's netwatch restarts the engine on VPN up/down, turning this into repeated input stalls.

**Files:**
- Modify: `src/main/main.js:105-109` (`deriveKey`)
- Create: `test/key-cache.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `main.js` gains a module-level `_keyCache` and an exported-for-test `deriveKeyCached(passphrase, group)` helper in `src/main/net/crypto.js`

Putting the cache in `crypto.js` rather than `main.js` keeps it testable without loading Electron.

- [ ] **Step 1: Write the failing test**

Create `test/key-cache.js`:

```js
'use strict';
// Key derivation is a ~49ms blocking scryptSync on the Electron main thread,
// run on every startEngine(). Phase 2's netwatch restarts the engine on VPN
// up/down, so an uncached derive becomes a repeated input stall.

const crypto = require('../src/main/net/crypto');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

const t = (fn) => { const t0 = process.hrtime.bigint(); const v = fn(); return { v, ms: Number(process.hrtime.bigint() - t0) / 1e6 }; };

const a = t(() => crypto.deriveKeyCached('pass1', 'group1'));
ck('first derive returns a 32-byte key', Buffer.isBuffer(a.v) && a.v.length === 32, 'len=' + (a.v && a.v.length));
ck('first derive is slow (real scrypt)', a.ms > 5, 'ms=' + a.ms.toFixed(1));

const b = t(() => crypto.deriveKeyCached('pass1', 'group1'));
ck('second derive is cached (fast)', b.ms < 2, 'ms=' + b.ms.toFixed(1));
ck('cached key equals the first', b.v.equals(a.v));

const c = t(() => crypto.deriveKeyCached('pass1', 'group2'));
ck('different group re-derives', c.ms > 5, 'ms=' + c.ms.toFixed(1));
ck('different group gives a different key', !c.v.equals(a.v));

const d = t(() => crypto.deriveKeyCached('pass2', 'group1'));
ck('different passphrase re-derives', d.ms > 5, 'ms=' + d.ms.toFixed(1));
ck('different passphrase gives a different key', !d.v.equals(a.v));

ck('matches uncached deriveKey', crypto.deriveKeyCached('pass1', 'group1').equals(crypto.deriveKey('pass1', 'group1')));

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/key-cache.js`
Expected: FAIL — `crypto.deriveKeyCached is not a function`

- [ ] **Step 3: Add the cache**

In `src/main/net/crypto.js`, after `deriveKey` (line 35):

```js
// Single-entry memo for deriveKey. scrypt at N=2^14 costs ~49ms and blocks the
// Electron main thread — the same thread native input events marshal onto — so
// re-deriving on every engine restart is a visible input stall. Credentials
// rarely change, so one entry is enough.
let _cache = null; // { passphrase, salt, key }

function deriveKeyCached(passphrase, salt) {
  const s = String(salt || 'cursorkeyshare');
  if (_cache && _cache.passphrase === passphrase && _cache.salt === s) return _cache.key;
  const key = deriveKey(passphrase, s);
  _cache = { passphrase, salt: s, key };
  return key;
}
```

and extend the exports (line 74):

```js
module.exports = { deriveKey, deriveKeyCached, seal, open, randomId, IV_LEN, TAG_LEN, KEY_LEN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/key-cache.js`
Expected: PASS on all nine checks

- [ ] **Step 5: Use the cache in startEngine**

In `src/main/main.js`, change `deriveKey` (lines 105-109):

```js
function deriveKey(cfg) {
  const pass = configMod.getPassphrase(cfg);
  if (!pass) return null;
  // Cached: startEngine() runs on every config change and (in Phase 2) on every
  // network change, and an uncached scrypt blocks the main thread for ~49ms.
  return crypto.deriveKeyCached(pass, cfg.group);
}
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all files pass

- [ ] **Step 7: Commit**

```bash
git add src/main/net/crypto.js src/main/main.js test/key-cache.js
git commit -m "perf(net): cache the derived key across engine restarts

deriveKey ran a ~49ms blocking scryptSync on the Electron main thread on
every startEngine() — the same thread native input events marshal onto."
```

---

## Self-Review

**Spec coverage.** Phase 1 of the spec lists eight items, 1.1-1.8. Mapping: 1.1 and 1.2 → Task 2 (deliberately one commit, per the spec's note); 1.3 → Task 3; 1.4 → Task 4; 1.5 → Task 5; 1.6 → Task 6; 1.7 → Task 7; 1.8 → Task 1. All eight covered.

**Placeholder scan.** No TBD/TODO. Every code step contains the actual code. Every test step contains the actual test.

**Type consistency.** `seqNewer(a, b)` is named identically in Task 2's implementation, export and test. `this._handlers` is the same field name in Task 3's constructor, `start()` and `stop()`. `this._attemptId` is consistent across Task 6's constructor, `_connect()`, `stop()` and `_wire()`. `deriveKeyCached(passphrase, salt)` matches between Task 7's implementation, export, test and `main.js` call site. `layout.list()` and `layout.setOnline(id, online)` in Task 4 match `src/main/layout.js:102,114`.

**Ordering.** Task 1 comes first so every subsequent task's tests are picked up by `npm test` and CI with no extra wiring. Tasks 3-7 are mutually independent and may be reordered; Task 2 should stay early because it fixes a live user-visible bug.

**Known gap.** These tests exercise loopback IPv4 only. They do not and cannot cover the cross-machine behaviour Phase 2 depends on — that is what the two-machine probe is for.
