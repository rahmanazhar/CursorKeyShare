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

    // --- role is carried, so clients never dial other clients ---------------
    ck('beacon carries a role', typeof peer.role === 'string', String(peer.role));

    const seal = (o) => crypto.seal(key, Buffer.from(JSON.stringify(o), 'utf8'));
    const base = { v: 1, name: 'x', tcpPort: 1, udpPort: 2 };

    // --- an off-link source is rejected before we even try to decrypt -------
    const before = seenByA.length;
    a._onMessage(seal({ ...base, id: 'offlink', role: 'server', t: Date.now() }),
                 { address: '192.168.68.99' });
    a._onMessage(seal({ ...base, id: 'offlink6', role: 'server', t: Date.now() }),
                 { address: '2606:4700::8' });
    ck('a non-link-local source is ignored', seenByA.length === before,
       'grew by ' + (seenByA.length - before));

    // --- address change is reported, so a moved peer is re-targeted ---------
    // Each beacon must claim the address it is sent from, matching the real
    // announce path.
    const from = (addr, id) =>
      a._onMessage(seal({ ...base, id, role: 'server', a: addr, t: Date.now() }),
                   { address: addr + '%en1' });

    from('fe80::1111', 'mover');
    const m1 = seenByA.filter((p) => p.id === 'mover');
    ck('a new peer is flagged changed', m1.length === 1 && m1[0].changed === true,
       JSON.stringify(m1.map((p) => p.changed)));

    from('fe80::1111', 'mover');
    const m2 = seenByA.filter((p) => p.id === 'mover');
    ck('a repeat at the SAME address is not flagged changed',
       m2.length === 2 && m2[1].changed === false, JSON.stringify(m2.map((p) => p.changed)));

    from('fe80::2222', 'mover');
    const m3 = seenByA.filter((p) => p.id === 'mover');
    ck('a MOVED peer is flagged changed again',
       m3.length === 3 && m3[2].changed === true && m3[2].address === 'fe80::2222%en1',
       JSON.stringify(m3.map((p) => p.changed)));

    // --- a replayed beacon cannot claim someone else's address --------------
    a._onMessage(seal({ ...base, id: 'spoof', role: 'server', a: 'fe80::aaaa', t: Date.now() }),
                 { address: 'fe80::bbbb%en1' });
    ck('a beacon whose claimed address differs from its source is dropped',
       !seenByA.some((p) => p.id === 'spoof'));
    a._onMessage(seal({ ...base, id: 'honest', role: 'server', a: 'fe80::cccc', t: Date.now() }),
                 { address: 'fe80::cccc%en1' });
    ck('a beacon whose claimed address matches its source is accepted',
       seenByA.some((p) => p.id === 'honest'));

    // A beacon with NO address field must be rejected outright. Treating the
    // field as optional would leave the replay path open — and would make the
    // two checks above pass while protecting nothing.
    a._onMessage(seal({ ...base, id: 'noaddr', role: 'server', t: Date.now() }),
                 { address: 'fe80::dddd%en1' });
    ck('a beacon with no source-address field is rejected',
       !seenByA.some((p) => p.id === 'noaddr'));

    // --- the guard must be live on the REAL announce path -------------------
    // The check above only proves _onMessage enforces the field. This proves
    // _announce actually SENDS it — without this the guard is inert in
    // production while every test above still passes.
    const sent = [];
    const realSock = a._sock;
    a._sock = { setMulticastInterface() {}, send: (blob) => sent.push(blob) };
    a._announce();
    a._sock = realSock;
    ck('_announce emitted at least one beacon', sent.length > 0, 'n=' + sent.length);
    const decoded = sent.map((b) => JSON.parse(crypto.open(key, b).toString('utf8')));
    ck('every real beacon carries a source-address field',
       decoded.length > 0 && decoded.every((d) => typeof d.a === 'string'),
       JSON.stringify(decoded.map((d) => d.a)));
    ck('the advertised address is zone-stripped (portable across platforms)',
       decoded.every((d) => !d.a.includes('%')), JSON.stringify(decoded.map((d) => d.a)));
    ck('every real beacon carries a role',
       decoded.every((d) => d.role === 'server'), JSON.stringify(decoded.map((d) => d.role)));
    // And the round trip: a genuine beacon must be accepted from its own address.
    const realBeacon = sent[0];
    const own = decoded[0].a;
    a.seen.delete('aaa');
    const idBefore = seenByA.length;
    const b2 = mk('bbb2', key); // a receiver with a different localId
    let got = null;
    b2.on('peer', (p) => { if (p.id === 'aaa') got = p; });
    b2._onMessage(realBeacon, { address: own + '%en1' });
    ck('a genuine beacon is accepted from its own address', got !== null,
       'own=' + own);
    void idBefore;
  } catch (e) {
    ck('no timeout', false, e.message);
  } finally {
    a.stop(); b.stop(); imposter.stop();
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
