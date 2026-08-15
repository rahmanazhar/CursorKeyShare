'use strict';
// End-to-end transport over IPv6 link-local, and IPv4 backward compatibility.
//
// This is the test that matters: it proves a real session — TCP control plus
// UDP motion — runs over a link-local address, which is the path a full-tunnel
// VPN cannot capture. It also proves the dual-stack change did not break the
// existing IPv4 path, since a udp6 socket rejects bare dotted quads (EINVAL)
// and the old code stripped exactly the ::ffff: prefix that keeps them working.

const crypto = require('../src/main/net/crypto');
const { NetServer } = require('../src/main/net/server');
const { NetClient } = require('../src/main/net/client');
const netinfo = require('../src/main/netinfo');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

function waitFor(cond, ms = 8000, step = 40) {
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

// One full session against `host`: connect, register, deliver a key over TCP
// and motion over UDP.
async function session(label, host, ports) {
  const key = crypto.deriveKey('testpass', 'testgroup');
  const server = new NetServer({
    key, tcpPort: ports.tcp, udpPort: ports.sudp, name: 'srv', localId: 'srv-' + label,
  });
  server.on('error', () => {}); server.on('warn', () => {});
  server.start();

  const client = new NetClient({
    key, host, tcpPort: ports.tcp, udpPort: ports.cudp, serverUdpPort: ports.sudp,
    name: 'cli', localId: 'cli-' + label,
    bounds: { originX: 0, originY: 0, width: 1920, height: 1080 },
  });
  client.on('error', () => {}); client.on('warn', () => {});
  const moves = [], keys = [];
  client.on('mousemove', (m) => moves.push(m));
  client.on('key', (k) => keys.push(k));
  client.start();

  try {
    await waitFor(() => client.connected && server.peers.size === 1);
    ck(`${label}: TCP session established`, true);

    const peer = [...server.peers.values()][0];
    ck(`${label}: server recorded a peer address`, !!peer.ip, String(peer.ip));
    console.log(`   (peer.ip = ${peer.ip})`);

    // TCP path: a key event must arrive.
    server.sendKey(peer.id, true, 'a', 0, {});
    await waitFor(() => keys.length > 0, 4000);
    ck(`${label}: key delivered over TCP`, keys.length > 0, 'keys=' + keys.length);

    // UDP path: motion must arrive. This is the one the ::ffff: strip broke.
    await waitFor(() => peer.udpPort > 0, 4000).catch(() => {});
    for (let i = 0; i < 10 && !moves.length; i++) {
      server.sendMouseMove(peer.id, 100 + i, 200 + i);
      await new Promise((r) => setTimeout(r, 150));
    }
    ck(`${label}: motion delivered over UDP`, moves.length > 0, 'moves=' + moves.length);
    if (moves.length) console.log(`   (first motion: ${JSON.stringify(moves[0])})`);
  } catch (e) {
    ck(`${label}: no timeout`, false, e.message);
  } finally {
    try { client.stop(); } catch {}
    try { server.stop(); } catch {}
  }
}

(async () => {
  // 1) IPv4 — must still work exactly as before the dual-stack change.
  await session('ipv4', '127.0.0.1', { tcp: 34941, sudp: 34942, cudp: 34943 });

  // 2) IPv6 loopback.
  await session('ipv6-loopback', '::1', { tcp: 34944, sudp: 34945, cudp: 34946 });

  // 3) The real thing: this machine's own link-local address, zone and all.
  const nics = netinfo.linkLocalInterfaces();
  if (!nics.length) {
    console.log('SKIP link-local session (no link-local NIC on this host)');
  } else {
    console.log(`\n--- link-local session via ${nics[0].sendable} ---`);
    await session('link-local', nics[0].sendable, { tcp: 34947, sudp: 34948, cudp: 34949 });
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
