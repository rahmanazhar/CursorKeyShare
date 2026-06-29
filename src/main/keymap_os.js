'use strict';
// OS virtual-key <-> canonical translation, used only by the native backend
// (the native addon emits/accepts raw OS key codes). The JS backend uses
// keymap.js instead (uiohook <-> canonical).
//
// Maps are keyed by canonical NAME and resolved to canonical codes via keymap.

const keymap = require('./keymap');

// Windows virtual-key codes (VK_*).
const WIN = {
  // letters / digits
  A: 0x41, B: 0x42, C: 0x43, D: 0x44, E: 0x45, F: 0x46, G: 0x47, H: 0x48,
  I: 0x49, J: 0x4a, K: 0x4b, L: 0x4c, M: 0x4d, N: 0x4e, O: 0x4f, P: 0x50,
  Q: 0x51, R: 0x52, S: 0x53, T: 0x54, U: 0x55, V: 0x56, W: 0x57, X: 0x58,
  Y: 0x59, Z: 0x5a,
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  Enter: 0x0d, Escape: 0x1b, Backspace: 0x08, Tab: 0x09, Space: 0x20,
  Minus: 0xbd, Equal: 0xbb, BracketLeft: 0xdb, BracketRight: 0xdd,
  Backslash: 0xdc, Semicolon: 0xba, Quote: 0xde, Backquote: 0xc0,
  Comma: 0xbc, Period: 0xbe, Slash: 0xbf, CapsLock: 0x14,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76,
  F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b, F13: 0x7c, F14: 0x7d,
  F15: 0x7e, F16: 0x7f, F17: 0x80, F18: 0x81, F19: 0x82, F20: 0x83,
  PrintScreen: 0x2c, ScrollLock: 0x91, Pause: 0x13,
  Insert: 0x2d, Home: 0x24, PageUp: 0x21, Delete: 0x2e, End: 0x23, PageDown: 0x22,
  ArrowRight: 0x27, ArrowLeft: 0x25, ArrowDown: 0x28, ArrowUp: 0x26,
  NumLock: 0x90, NumpadDivide: 0x6f, NumpadMultiply: 0x6a, NumpadSubtract: 0x6d,
  NumpadAdd: 0x6b, NumpadDecimal: 0x6e,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
  Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  ControlLeft: 0xa2, ControlRight: 0xa3, ShiftLeft: 0xa0, ShiftRight: 0xa1,
  AltLeft: 0xa4, AltRight: 0xa5, MetaLeft: 0x5b, MetaRight: 0x5c,
};

// macOS CGKeyCode (ANSI layout).
const MAC = {
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12,
  W: 13, E: 14, R: 15, Y: 16, T: 17,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23,
  Equal: 24, Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29,
  BracketRight: 30, O: 31, U: 32, BracketLeft: 33, I: 34, P: 35, Enter: 36,
  L: 37, J: 38, Quote: 39, K: 40, Semicolon: 41, Backslash: 42, Comma: 43,
  Slash: 44, N: 45, M: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50,
  Backspace: 51, Escape: 53, MetaLeft: 55, ShiftLeft: 56, CapsLock: 57,
  AltLeft: 58, ControlLeft: 59, ShiftRight: 60, AltRight: 61, ControlRight: 62,
  F17: 64, NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumLock: 71,
  NumpadDivide: 75, NumpadEnter: 76, NumpadSubtract: 78, F18: 79, F19: 80,
  Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86, Numpad5: 87,
  Numpad6: 88, Numpad7: 89, Numpad8: 91, Numpad9: 92,
  F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101, F11: 103, F13: 105,
  F16: 106, F14: 107, F10: 109, F12: 111, F15: 113, Home: 115, PageUp: 116,
  Delete: 117, F4: 118, End: 119, F2: 120, PageDown: 121, F1: 122,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
};

function buildReverse(table) {
  // os code -> canon code
  const m = new Map();
  for (const [name, osCode] of Object.entries(table)) {
    const canon = keymap.nameToCanon(name);
    if (canon >= 0) m.set(osCode, canon);
  }
  return m;
}

function buildForward(table) {
  // canon code -> os code
  const m = new Map();
  for (const [name, osCode] of Object.entries(table)) {
    const canon = keymap.nameToCanon(name);
    if (canon >= 0) m.set(canon, osCode);
  }
  return m;
}

const isMac = process.platform === 'darwin';
const TABLE = isMac ? MAC : WIN;
const osToCanon = buildReverse(TABLE);
const canonToOs = buildForward(TABLE);

function fromOs(osKeycode) {
  const c = osToCanon.get(osKeycode);
  return c === undefined ? -1 : c;
}
function toOs(canonCode) {
  const v = canonToOs.get(canonCode);
  return v === undefined ? -1 : v;
}

module.exports = { fromOs, toOs, WIN, MAC };
