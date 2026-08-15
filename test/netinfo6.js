'use strict';
// IPv6 link-local interface enumeration.
//
// The danger this guards against: every utun the VPN creates ALSO has an fe80::
// address. Beaconing on those would push discovery traffic straight into the
// tunnel we exist to escape — and on Windows the adapter keys are FriendlyNames
// like "Cloudflare WARP" or "Cisco AnyConnect Virtual Miniport Adapter", so the
// filter has to catch those too.

const { linkLocalInterfaces } = require('../src/main/netinfo');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

// A fixture modelled on this Mac under live Cloudflare WARP.
const MAC_TABLE = {
  lo0: [{ family: 'IPv6', address: '::1', internal: true, scopeid: 0 },
        { family: 'IPv6', address: 'fe80::1', internal: true, scopeid: 1 }],
  en1: [{ family: 'IPv6', address: 'fe80::8da:2916:9240:5446', internal: false, scopeid: 7 },
        { family: 'IPv4', address: '192.168.68.52', internal: false, netmask: '255.255.252.0' }],
  awdl0: [{ family: 'IPv6', address: 'fe80::e477:fff:fea2:7a2c', internal: false, scopeid: 8 }],
  llw0: [{ family: 'IPv6', address: 'fe80::e477:fff:fea2:7a2c', internal: false, scopeid: 9 }],
  utun0: [{ family: 'IPv6', address: 'fe80::909d:c0ef:ac62:a1f0', internal: false, scopeid: 13 }],
  utun4: [{ family: 'IPv4', address: '172.16.0.2', internal: false, netmask: '255.255.255.255' },
          { family: 'IPv6', address: 'fe80::7a7b:8aff:fed9:8925', internal: false, scopeid: 20 },
          { family: 'IPv6', address: '2606:4700:cf1:1000::8', internal: false, scopeid: 0 }],
};

const mac = linkLocalInterfaces('darwin', MAC_TABLE);
const names = mac.map((c) => c.name);

ck('finds the physical Wi-Fi NIC', names.includes('en1'), names.join(','));
ck('excludes every utun (VPN tunnels)', !names.some((n) => /^utun/.test(n)), names.join(','));
ck('excludes awdl0 (AirDrop peer-to-peer)', !names.includes('awdl0'), names.join(','));
ck('excludes llw0 (low-latency WLAN)', !names.includes('llw0'), names.join(','));
ck('excludes loopback', !names.includes('lo0'), names.join(','));
ck('returns exactly the one real NIC', mac.length === 1, JSON.stringify(names));

const en1 = mac[0];
ck('carries the bare address', en1.address === 'fe80::8da:2916:9240:5446', en1.address);
ck('carries the scopeid', en1.scopeid === 7, String(en1.scopeid));
ck('posix sendable form uses the NAME',
   en1.sendable === 'fe80::8da:2916:9240:5446%en1', en1.sendable);
ck('exposes the zone separately', en1.zone === 'en1', en1.zone);

// Windows: same shape, but zones are numeric and adapter keys are FriendlyNames.
const WIN_TABLE = {
  'Loopback Pseudo-Interface 1': [{ family: 'IPv6', address: '::1', internal: true, scopeid: 1 }],
  'Wi-Fi': [{ family: 'IPv6', address: 'fe80::a1b2:c3d4:e5f6:1234', internal: false, scopeid: 12 },
            { family: 'IPv4', address: '192.168.68.50', internal: false, netmask: '255.255.252.0' }],
  'Ethernet': [{ family: 'IPv6', address: 'fe80::dead:beef:cafe:1', internal: false, scopeid: 5 }],
  'Cloudflare WARP': [{ family: 'IPv6', address: 'fe80::9999:8888:7777:6666', internal: false, scopeid: 30 }],
  'OpenVPN TAP-Windows6': [{ family: 'IPv6', address: 'fe80::1111:2222:3333:4444', internal: false, scopeid: 31 }],
};

const win = linkLocalInterfaces('win32', WIN_TABLE);
const wnames = win.map((c) => c.name);
ck('win: finds Wi-Fi and Ethernet', wnames.includes('Wi-Fi') && wnames.includes('Ethernet'), wnames.join(','));
ck('win: excludes Cloudflare WARP by friendly name', !wnames.includes('Cloudflare WARP'), wnames.join(','));
ck('win: excludes OpenVPN TAP adapter', !wnames.includes('OpenVPN TAP-Windows6'), wnames.join(','));
ck('win: excludes loopback', !wnames.some((n) => /Loopback/i.test(n)), wnames.join(','));

const wifi = win.find((c) => c.name === 'Wi-Fi');
ck('win: sendable form uses the numeric INDEX',
   wifi.sendable === 'fe80::a1b2:c3d4:e5f6:1234%12', wifi.sendable);
ck('win: zone is the index as a string', wifi.zone === '12', wifi.zone);

// Degenerate cases must not throw.
ck('empty table yields []', linkLocalInterfaces('darwin', {}).length === 0);
ck('a NIC with no link-local is skipped',
   linkLocalInterfaces('darwin', { en0: [{ family: 'IPv4', address: '10.0.0.1', internal: false }] }).length === 0);
ck('win: scopeid 0 is dropped rather than emitting a bogus zone',
   linkLocalInterfaces('win32', { 'Wi-Fi': [{ family: 'IPv6', address: 'fe80::1', internal: false, scopeid: 0 }] }).length === 0);

// The real machine — must not throw, and must never include a tunnel.
const live = linkLocalInterfaces();
ck('live enumeration does not throw', Array.isArray(live), typeof live);
ck('live enumeration excludes tunnels',
   !live.some((c) => /utun|awdl|llw/.test(c.name)), live.map((c) => c.name).join(','));
console.log('   (live: ' + (live.map((c) => c.sendable).join(', ') || 'none') + ')');

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
