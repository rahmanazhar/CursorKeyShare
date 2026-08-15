'use strict';
// setHost() retargets a running client at a newly discovered server.
//
// The hazard is the outgoing socket: its close handler would otherwise fire
// after the switch and schedule a reconnect to the address we just left. The
// attempt epoch is what prevents that.

const crypto = require('../src/main/net/crypto');
const { NetServer } = require('../src/main/net/server');
const { NetClient } = require('../src/main/net/client');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

// Generous timeouts on purpose: this file runs straight after transport6.js,
// which opens three full sessions, so connect latency here is load-sensitive.
// A tight bound makes the test flaky without making it more meaningful.
function waitFor(cond, ms = 20000, step = 40) {
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
  const key = crypto.deriveKey('testpass', 'testgroup');
  // Two servers on different ports stand in for "the address changed".
  const mkServer = (id, tcp, udp) => {
    const s = new NetServer({ key, tcpPort: tcp, udpPort: udp, name: id, localId: id });
    s.on('error', () => {}); s.on('warn', () => {});
    s.start();
    return s;
  };
  const s1 = mkServer('srv1', 34951, 34952);
  const s2 = mkServer('srv2', 34953, 34954);

  const client = new NetClient({
    key, host: '127.0.0.1', tcpPort: 34951, udpPort: 34955, serverUdpPort: 34952,
    name: 'cli', localId: 'cli',
    bounds: { originX: 0, originY: 0, width: 1920, height: 1080 },
  });
  client.on('error', () => {}); client.on('warn', () => {});
  const welcomes = [];
  client.on('welcome', (w) => welcomes.push(w.id));
  client.start();

  try {
    await waitFor(() => client.connected && s1.peers.size === 1);
    ck('connected to the first server', welcomes.includes('srv1'), welcomes.join(','));

    // Retarget. Ports differ, so this also exercises the full reconnect path.
    client.tcpPort = 34953;
    client.serverUdpPort = 34954;
    const changed = client.setHost('::1');
    ck('setHost reports a change', changed === true);

    await waitFor(() => client.connected && s2.peers.size === 1, 20000);
    ck('connected to the second server', welcomes.includes('srv2'), welcomes.join(','));
    ck('client.host reflects the new target', client.host === '::1', client.host);

    // The critical property: the abandoned socket must not drag us back.
    const s1PeersAfter = s1.peers.size;
    await new Promise((r) => setTimeout(r, 2500));
    ck('does not reconnect to the old server',
       s1.peers.size <= s1PeersAfter && client.connected && s2.peers.size === 1,
       `s1=${s1.peers.size} s2=${s2.peers.size} connected=${client.connected}`);

    ck('setHost to the same host is a no-op', client.setHost('::1') === false);
    ck('setHost to empty is a no-op', client.setHost('') === false);
  } catch (e) {
    ck('no timeout', false, e.message);
  } finally {
    try { client.stop(); } catch {}
    try { s1.stop(); } catch {}
    try { s2.stop(); } catch {}
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
