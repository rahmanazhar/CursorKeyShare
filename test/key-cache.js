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
