'use strict';
// Tests for the Windows extended-key classification used by native injection.
// The E0 "extended" flag decides whether SendInput injects arrows/nav/AltGr/
// NumpadEnter/Win/PrintScreen correctly; getting the SET wrong silently breaks
// "alternative keys" on Windows clients. Run with: `npm test`.
//
// keymap_os.isExtended() is gated to Windows (returns false on macOS/Linux, where
// the native backend uses OS-unambiguous codes), so the substantive assertions
// run only on win32; elsewhere we assert the documented no-op.

const os = require('../src/main/keymap_os');
const keymap = require('../src/main/keymap');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

const ext = (name) => os.isExtended(keymap.nameToCanon(name));

if (process.platform === 'win32') {
  // MUST be extended (E0-prefixed hardware make code).
  const MUST = [
    'ControlRight', 'AltRight', 'Insert', 'Delete', 'Home', 'End',
    'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'NumpadDivide', 'NumpadEnter', 'MetaLeft', 'MetaRight', 'PrintScreen',
  ];
  for (const name of MUST) ck(`${name} is extended`, ext(name) === true, 'expected true');

  // MUST NOT be extended — the classic traps.
  const MUST_NOT = [
    'NumLock',       // real make 0x45, no E0 (0xE045 is a reverse-map artifact)
    'ShiftRight',    // 0x36, not E0 (the "right-shift trap")
    'Enter',         // main Enter 0x1C — only NumpadEnter carries E0
    'ControlLeft', 'AltLeft', 'ShiftLeft', 'CapsLock', 'ScrollLock', 'Pause',
    'Numpad0', 'Numpad7', 'NumpadDecimal', 'NumpadAdd', 'NumpadSubtract',
    'NumpadMultiply', 'A', 'Digit0', 'F1',
  ];
  for (const name of MUST_NOT) ck(`${name} is NOT extended`, ext(name) === false, 'expected false');

  // NumpadEnter and Enter share VK_RETURN (0x0D); the extended bit is their only
  // differentiator on injection.
  ck('Enter and NumpadEnter share VK 0x0d', os.WIN.Enter === 0x0d && os.WIN.NumpadEnter === 0x0d,
    `${os.WIN.Enter} / ${os.WIN.NumpadEnter}`);
  ck('Enter/NumpadEnter differ only by extended bit',
    ext('Enter') === false && ext('NumpadEnter') === true, 'Enter=false, NumpadEnter=true');
} else {
  // Documented no-op off Windows.
  ck('isExtended is false off-Windows (ArrowLeft)', ext('ArrowLeft') === false, 'expected false');
  ck('isExtended is false off-Windows (NumpadEnter)', ext('NumpadEnter') === false, 'expected false');
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
