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
