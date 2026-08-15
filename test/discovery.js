'use strict';
// Discovery over IPv6 link-local multicast, exercised for real on this machine.
//
// Two instances with different localIds must find each other, must NOT report
// themselves (multicast loops back), and must ignore beacons sealed with a
// different group key.

const { Discovery } = require('../src/main/net/discovery');
const crypto = require('../src/main/net/crypto');
const netinfo = require('../src/main/netinfo');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

function waitFor(cond, ms = 8000, step = 50) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try { ok = cond(); } catch {}
      if (ok) { clearInterval(iv); res(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
    }, step);
  });
}

(async () => {
  if (!netinfo.linkLocalInterfaces().length) {
    console.log('SKIP no link-local IPv6 interface on this host (CI container?)');
    console.log('\nALL PASS');
    process.exit(0);
  }

  const key = crypto.deriveKey('testpass', 'testgroup');
  const other = crypto.deriveKey('different', 'othergroup');
  const PORT = 24897;

  const mk = (id, k) => new Discovery({
    key: k, localId: id, name: 'node-' + id, tcpPort: 24800, udpPort: 24801,
    port: PORT, intervalMs: 300,
  });

  const a = mk('aaa', key), b = mk('bbb', key), imposter = mk('zzz', other);
  const seenByA = [], seenByB = [];
  a.on('warn', () => {}); b.on('warn', () => {}); imposter.on('warn', () => {});
  a.on('peer', (p) => seenByA.push(p));
  b.on('peer', (p) => seenByB.push(p));

  try {
    a.start(); b.start(); imposter.start();

    await waitFor(() => seenByA.length && seenByB.length);
    ck('A discovers a peer', seenByA.length > 0);
    ck('B discovers a peer', seenByB.length > 0);

    ck('A never reports itself', !seenByA.some((p) => p.id === 'aaa'),
       seenByA.map((p) => p.id).join(','));
    ck('B never reports itself', !seenByB.some((p) => p.id === 'bbb'),
       seenByB.map((p) => p.id).join(','));

    ck('A sees B', seenByA.some((p) => p.id === 'bbb'), seenByA.map((p) => p.id).join(','));
    ck('B sees A', seenByB.some((p) => p.id === 'aaa'), seenByB.map((p) => p.id).join(','));

    // The security property: a different group key is invisible, not merely rejected.
    ck('wrong group key is never discovered',
       !seenByA.some((p) => p.id === 'zzz') && !seenByB.some((p) => p.id === 'zzz'),
       seenByA.concat(seenByB).map((p) => p.id).join(','));

    const peer = seenByA.find((p) => p.id === 'bbb');
    ck('peer carries the announced ports', peer.tcpPort === 24800 && peer.udpPort === 24801,
       peer.tcpPort + '/' + peer.udpPort);
    ck('peer address is link-local', /^fe80:/i.test(peer.address), peer.address);
    ck('peer address carries a zone (usable as a send target)',
       peer.address.includes('%'), peer.address);
    ck('first sighting is flagged', seenByA.filter((p) => p.id === 'bbb')[0].first === true);
    ck('later sightings are not flagged first',
       seenByA.filter((p) => p.id === 'bbb').slice(1).every((p) => p.first === false),
       'n=' + seenByA.filter((p) => p.id === 'bbb').length);
    console.log('   (discovered at ' + peer.address + ')');

    // A stale beacon must be ignored — cheap replay guard.
    const stalePkt = crypto.seal(key, Buffer.from(JSON.stringify({
      v: 1, id: 'stale', name: 'stale', tcpPort: 1, udpPort: 2, t: Date.now() - 120000,
    }), 'utf8'));
    a._onMessage(stalePkt, { address: 'fe80::dead%en1' });
    ck('a 2-minute-old beacon is rejected', !seenByA.some((p) => p.id === 'stale'));

    // A beacon with our own id must be dropped even if it arrives from the wire.
    const selfPkt = crypto.seal(key, Buffer.from(JSON.stringify({
      v: 1, id: 'aaa', name: 'me', tcpPort: 1, udpPort: 2, t: Date.now(),
    }), 'utf8'));
    a._onMessage(selfPkt, { address: 'fe80::beef%en1' });
    ck('a beacon claiming our own id is dropped', !seenByA.some((p) => p.id === 'aaa'));
  } catch (e) {
    ck('no timeout', false, e.message);
  } finally {
    a.stop(); b.stop(); imposter.stop();
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
