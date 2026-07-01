'use strict';
// Tests for interface ranking / bind-target resolution (VPN bypass).
// Run with: `npm test` (or `node test/netinfo.js`).

const { score, resolveBindInterface } = require('../src/main/netinfo');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

// A real LAN NIC must outrank VPN tunnels, VM bridges, and link-local.
const nics = [
  { name: 'utun4', address: '10.8.0.2' },        // VPN
  { name: 'bridge100', address: '192.168.64.1' },// docker/VM
  { name: 'en0', address: '192.168.1.23' },      // Wi-Fi LAN
  { name: 'en5', address: '10.0.0.42' },         // Ethernet LAN
  { name: 'en9', address: '169.254.5.5' },       // self-assigned link-local
];
const ranked = [...nics].sort((a, b) => score(a) - score(b)).map((n) => n.name);
ck('a private-LAN NIC ranks first', ranked[0] === 'en0' || ranked[0] === 'en5', 'ranked=' + ranked.join(','));
const last2 = ranked.slice(-2);
ck('VPN + virtual NICs rank last', last2.includes('utun4') && last2.includes('bridge100'), 'ranked=' + ranked.join(','));

// 'off' always means "don't pin — use system routing".
ck("resolveBindInterface('off') is null", resolveBindInterface('off') === null, 'got ' + resolveBindInterface('off'));

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
