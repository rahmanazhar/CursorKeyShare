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
