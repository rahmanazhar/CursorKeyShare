'use strict';
// Cross-platform key translation.
//
// A Mac and a Windows box do not share keycodes, so we never put OS-specific
// codes on the wire. Instead every key is translated to a CANONICAL code on
// capture and translated back to the local representation on injection.
//
// The table below lines up three names for each key:
//   [ canonicalName, uiohook-napi name, nut.js name ]
// Canonical codes are just the row index (stable as long as rows are appended,
// not reordered). Lookups are built from whatever constants the installed
// library versions actually expose, so a missing name degrades gracefully
// instead of throwing.

let UiohookKey = null;
let NutKey = null;
try {
  ({ UiohookKey } = require('uiohook-napi'));
} catch {}
try {
  ({ Key: NutKey } = require('@nut-tree-fork/nut-js'));
} catch {
  try {
    ({ Key: NutKey } = require('@nut-tree/nut-js'));
  } catch {}
}

// canonical, uiohook, nut
const TABLE = [
  ['A', 'A', 'A'], ['B', 'B', 'B'], ['C', 'C', 'C'], ['D', 'D', 'D'],
  ['E', 'E', 'E'], ['F', 'F', 'F'], ['G', 'G', 'G'], ['H', 'H', 'H'],
  ['I', 'I', 'I'], ['J', 'J', 'J'], ['K', 'K', 'K'], ['L', 'L', 'L'],
  ['M', 'M', 'M'], ['N', 'N', 'N'], ['O', 'O', 'O'], ['P', 'P', 'P'],
  ['Q', 'Q', 'Q'], ['R', 'R', 'R'], ['S', 'S', 'S'], ['T', 'T', 'T'],
  ['U', 'U', 'U'], ['V', 'V', 'V'], ['W', 'W', 'W'], ['X', 'X', 'X'],
  ['Y', 'Y', 'Y'], ['Z', 'Z', 'Z'],

  ['Digit0', '0', 'Num0'], ['Digit1', '1', 'Num1'], ['Digit2', '2', 'Num2'],
  ['Digit3', '3', 'Num3'], ['Digit4', '4', 'Num4'], ['Digit5', '5', 'Num5'],
  ['Digit6', '6', 'Num6'], ['Digit7', '7', 'Num7'], ['Digit8', '8', 'Num8'],
  ['Digit9', '9', 'Num9'],

  ['Enter', 'Enter', 'Return'], ['Escape', 'Escape', 'Escape'],
  ['Backspace', 'Backspace', 'Backspace'], ['Tab', 'Tab', 'Tab'],
  ['Space', 'Space', 'Space'],

  ['Minus', 'Minus', 'Minus'], ['Equal', 'Equal', 'Equal'],
  ['BracketLeft', 'BracketLeft', 'LeftBracket'],
  ['BracketRight', 'BracketRight', 'RightBracket'],
  ['Backslash', 'Backslash', 'Backslash'],
  ['Semicolon', 'Semicolon', 'Semicolon'], ['Quote', 'Quote', 'Quote'],
  ['Backquote', 'Backquote', 'Grave'], ['Comma', 'Comma', 'Comma'],
  ['Period', 'Period', 'Period'], ['Slash', 'Slash', 'Slash'],

  ['CapsLock', 'CapsLock', 'CapsLock'],

  ['F1', 'F1', 'F1'], ['F2', 'F2', 'F2'], ['F3', 'F3', 'F3'],
  ['F4', 'F4', 'F4'], ['F5', 'F5', 'F5'], ['F6', 'F6', 'F6'],
  ['F7', 'F7', 'F7'], ['F8', 'F8', 'F8'], ['F9', 'F9', 'F9'],
  ['F10', 'F10', 'F10'], ['F11', 'F11', 'F11'], ['F12', 'F12', 'F12'],
  ['F13', 'F13', 'F13'], ['F14', 'F14', 'F14'], ['F15', 'F15', 'F15'],
  ['F16', 'F16', 'F16'], ['F17', 'F17', 'F17'], ['F18', 'F18', 'F18'],
  ['F19', 'F19', 'F19'], ['F20', 'F20', 'F20'],

  ['PrintScreen', 'PrintScreen', 'Print'], ['ScrollLock', 'ScrollLock', 'ScrollLock'],
  ['Pause', 'Pause', 'Pause'],
  ['Insert', 'Insert', 'Insert'], ['Home', 'Home', 'Home'],
  ['PageUp', 'PageUp', 'PageUp'], ['Delete', 'Delete', 'Delete'],
  ['End', 'End', 'End'], ['PageDown', 'PageDown', 'PageDown'],

  ['ArrowRight', 'ArrowRight', 'Right'], ['ArrowLeft', 'ArrowLeft', 'Left'],
  ['ArrowDown', 'ArrowDown', 'Down'], ['ArrowUp', 'ArrowUp', 'Up'],

  ['NumLock', 'NumLock', 'NumLock'],
  ['NumpadDivide', 'NumpadDivide', 'Divide'],
  ['NumpadMultiply', 'NumpadMultiply', 'Multiply'],
  ['NumpadSubtract', 'NumpadSubtract', 'Subtract'],
  ['NumpadAdd', 'NumpadAdd', 'Add'],
  ['NumpadEnter', 'NumpadEnter', 'Enter'],
  ['NumpadDecimal', 'NumpadDecimal', 'Decimal'],
  ['Numpad0', 'Numpad0', 'NumPad0'], ['Numpad1', 'Numpad1', 'NumPad1'],
  ['Numpad2', 'Numpad2', 'NumPad2'], ['Numpad3', 'Numpad3', 'NumPad3'],
  ['Numpad4', 'Numpad4', 'NumPad4'], ['Numpad5', 'Numpad5', 'NumPad5'],
  ['Numpad6', 'Numpad6', 'NumPad6'], ['Numpad7', 'Numpad7', 'NumPad7'],
  ['Numpad8', 'Numpad8', 'NumPad8'], ['Numpad9', 'Numpad9', 'NumPad9'],

  ['ControlLeft', 'Ctrl', 'LeftControl'], ['ControlRight', 'CtrlRight', 'RightControl'],
  ['ShiftLeft', 'Shift', 'LeftShift'], ['ShiftRight', 'ShiftRight', 'RightShift'],
  ['AltLeft', 'Alt', 'LeftAlt'], ['AltRight', 'AltRight', 'RightAlt'],
  ['MetaLeft', 'Meta', 'LeftSuper'], ['MetaRight', 'MetaRight', 'RightSuper'],
];

// Build lookup maps.
const canonByName = new Map(); // canonicalName -> canon code (index)
const uiohookToCanon = new Map(); // uiohook numeric keycode -> canon code
const canonToNut = new Map(); // canon code -> nut Key value

TABLE.forEach((row, i) => {
  const [canonName, uiohookName, nutName] = row;
  canonByName.set(canonName, i);

  if (UiohookKey && uiohookName != null) {
    const v = UiohookKey[uiohookName];
    if (typeof v === 'number') uiohookToCanon.set(v, i);
  }
  if (NutKey && nutName != null) {
    const v = NutKey[nutName];
    if (v !== undefined) canonToNut.set(i, v);
  }
});

// Modifier bitmask (independent of OS).
const MOD = Object.freeze({ SHIFT: 1, CTRL: 2, ALT: 4, META: 8 });

function fromUiohook(uiohookKeycode) {
  const c = uiohookToCanon.get(uiohookKeycode);
  return c === undefined ? -1 : c;
}

function toNut(canonCode) {
  return canonToNut.has(canonCode) ? canonToNut.get(canonCode) : undefined;
}

function canonName(code) {
  return TABLE[code] ? TABLE[code][0] : '?';
}

function nameToCanon(name) {
  return canonByName.has(name) ? canonByName.get(name) : -1;
}

module.exports = { fromUiohook, toNut, canonName, nameToCanon, MOD, TABLE };
