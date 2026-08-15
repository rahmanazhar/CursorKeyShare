'use strict';
// Zone-id handling for IPv6 link-local addresses.
//
// A link-local address is meaningless without a zone: fe80::1 alone does not
// say which NIC it lives on. The zone is what makes the address bypass the
// routing table — and it is spelled DIFFERENTLY per platform. libuv parses it
// with if_nametoindex() on POSIX and atoi() under _WIN32, so macOS wants the
// interface NAME and Windows wants the numeric INDEX, and each rejects the
// other's form. Verified on macOS: 'fe80::…%7' times out where '%en1' works.

const { zoneFor, withZone, stripZone, isLinkLocal } = require('../src/main/net/zone');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

const IFACE = { name: 'en1', scopeid: 7 };

// --- zoneFor: the platform split ------------------------------------------
ck('posix zone is the interface NAME',
   zoneFor(IFACE, 'darwin') === 'en1', zoneFor(IFACE, 'darwin'));
ck('linux zone is the interface NAME',
   zoneFor(IFACE, 'linux') === 'en1', zoneFor(IFACE, 'linux'));
ck('win32 zone is the numeric INDEX',
   zoneFor(IFACE, 'win32') === '7', zoneFor(IFACE, 'win32'));
ck('win32 zone is a string, not a number',
   typeof zoneFor(IFACE, 'win32') === 'string', typeof zoneFor(IFACE, 'win32'));
ck('win32 with a friendly name still uses scopeid',
   zoneFor({ name: 'Wi-Fi', scopeid: 12 }, 'win32') === '12',
   zoneFor({ name: 'Wi-Fi', scopeid: 12 }, 'win32'));
ck('missing scopeid on win32 yields null (never a bogus zone)',
   zoneFor({ name: 'Wi-Fi' }, 'win32') === null, String(zoneFor({ name: 'Wi-Fi' }, 'win32')));
ck('scopeid 0 on win32 yields null (0 = unknown interface)',
   zoneFor({ name: 'Wi-Fi', scopeid: 0 }, 'win32') === null,
   String(zoneFor({ name: 'Wi-Fi', scopeid: 0 }, 'win32')));

// --- isLinkLocal ------------------------------------------------------------
ck('fe80:: is link-local', isLinkLocal('fe80::8da:2916:9240:5446') === true);
ck('fe80 uppercase is link-local', isLinkLocal('FE80::1') === true);
ck('a zoned address is still link-local', isLinkLocal('fe80::1%en1') === true);
ck('global IPv6 is not link-local', isLinkLocal('2606:4700:cf1:1000::8') === false);
ck('IPv4 is not link-local', isLinkLocal('192.168.68.52') === false);
ck('fec0:: (site-local) is not link-local', isLinkLocal('fec0::1') === false);
ck('null is not link-local', isLinkLocal(null) === false);

// --- withZone / stripZone ---------------------------------------------------
ck('withZone appends the platform zone',
   withZone('fe80::1', IFACE, 'darwin') === 'fe80::1%en1',
   withZone('fe80::1', IFACE, 'darwin'));
ck('withZone uses the index on win32',
   withZone('fe80::1', IFACE, 'win32') === 'fe80::1%7',
   withZone('fe80::1', IFACE, 'win32'));
ck('withZone replaces an existing (foreign) zone',
   withZone('fe80::1%en5', IFACE, 'darwin') === 'fe80::1%en1',
   withZone('fe80::1%en5', IFACE, 'darwin'));
ck('withZone leaves a non-link-local address alone',
   withZone('2606:4700::8', IFACE, 'darwin') === '2606:4700::8',
   withZone('2606:4700::8', IFACE, 'darwin'));
ck('withZone returns null when the zone is unknowable',
   withZone('fe80::1', { name: 'Wi-Fi' }, 'win32') === null,
   String(withZone('fe80::1', { name: 'Wi-Fi' }, 'win32')));
ck('stripZone removes the zone', stripZone('fe80::1%en1') === 'fe80::1', stripZone('fe80::1%en1'));
ck('stripZone is a no-op without a zone', stripZone('fe80::1') === 'fe80::1');
ck('stripZone handles IPv4', stripZone('192.168.1.1') === '192.168.1.1');

// --- the property that matters: a peer's zone is NEVER portable -------------
// A beacon must never advertise its own zoned address; the receiver has to
// rebuild it from the interface the packet arrived on.
const macForm = withZone('fe80::1', IFACE, 'darwin');   // fe80::1%en1
const winForm = withZone('fe80::1', IFACE, 'win32');    // fe80::1%7
ck('the two platform forms differ (so addresses are not exchangeable)',
   macForm !== winForm, macForm + ' vs ' + winForm);
ck('stripping either yields the same bare address',
   stripZone(macForm) === stripZone(winForm), stripZone(macForm) + ' / ' + stripZone(winForm));

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
process.exit(fails ? 1 : 0);
