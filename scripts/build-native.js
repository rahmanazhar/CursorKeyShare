// Best-effort native addon build. If it fails (no toolchain, unsupported OS),
// the app falls back to the JS input backend (uiohook-napi + nut.js).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const hasBinding = fs.existsSync(path.join(root, 'binding.gyp'));
if (!hasBinding) process.exit(0);

if (process.env.CKS_SKIP_NATIVE === '1') {
  console.log('[build-native] skipped (CKS_SKIP_NATIVE=1)');
  process.exit(0);
}

console.log('[build-native] attempting node-gyp rebuild (optional)...');
const res = spawnSync('node-gyp', ['rebuild'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});

if (res.status !== 0) {
  console.warn(
    '\n[build-native] Native addon build failed or skipped.\n' +
      '  Cursorkeyshare will run using the JS input backend (uiohook-napi + nut.js).\n' +
      '  For true input suppression, install build tools and run: npm run rebuild\n'
  );
}
// Never fail the install over the optional addon.
process.exit(0);
