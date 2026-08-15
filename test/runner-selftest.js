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
