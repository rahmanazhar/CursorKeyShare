'use strict';
// Backend selector. Prefers the native addon (true suppression + raw deltas);
// falls back to the JS backend (uiohook + nut.js) when the addon isn't built.

const { NativeBackend, loadAddon } = require('./input_native');
const { JsBackend } = require('./input_js');

let _backend = null;

function getBackend() {
  if (_backend) return _backend;
  const addon = loadAddon();
  if (addon) {
    console.log('[input] using NATIVE backend (suppression enabled)');
    _backend = new NativeBackend(addon);
  } else {
    console.log('[input] using JS backend (uiohook + nut.js, soft suppression)');
    _backend = new JsBackend();
  }
  return _backend;
}

module.exports = { getBackend };
