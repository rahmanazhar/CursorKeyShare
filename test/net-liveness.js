'use strict';
// Integration test for the connection self-healing added for the "minimize
// disconnects sharing" bug: the server drops a peer that has gone silent
// (half-open socket), and the client auto-reconnects after a drop. Runs a real
// server + client over loopback. Run with: `npm test` (or node test/net-liveness.js).

const crypto = require('../src/main/net/crypto');
const { NetServer } = require('../src/main/net/server');
const { NetClient } = require('../src/main/net/client');

const TCP = 34811, SUDP = 34812, CUDP = 34813;

function waitFor(cond, ms = 6000, step = 40) {
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

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

(async () => {
  const key = crypto.deriveKey('testpass', 'testgroup');
  const server = new NetServer({ key, tcpPort: TCP, udpPort: SUDP, name: 'srv', localId: 'srv' });
  server.on('error', () => {});
  server.on('warn', () => {});
  server.start();

  const client = new NetClient({
    key, host: '127.0.0.1', tcpPort: TCP, udpPort: CUDP, serverUdpPort: SUDP,
    name: 'cli', localId: 'cli', bounds: { originX: 0, originY: 0, width: 1920, height: 1080 },
  });
  let connects = 0;
  client.on('warn', () => {});
  client.on('error', () => {});
  client.on('connected', () => { connects++; });
  client.start();

  try {
    // 1) Connects and registers a peer.
    await waitFor(() => client.connected && server.peers.size === 1);
    ck('connects + registers peer', true);
    ck('client _lastRx baselined', client._lastRx > 0, 'lastRx=' + client._lastRx);
    const peer = [...server.peers.values()][0];
    ck('peer lastRx baselined', peer.lastRx > 0, 'peer.lastRx=' + peer.lastRx);

    // 2) Reaper drops a peer that has gone silent (simulated half-open).
    peer.lastRx = Date.now() - 8000;
    server._reapDeadPeers();
    ck('reaper destroys stale peer socket', peer.socket.destroyed === true);

    // 3) Client auto-reconnects after the drop (proves the refactored connect
    //    path + reconnect timer still work).
    const before = connects;
    await waitFor(() => connects > before && client.connected, 6000);
    ck('client reconnects after drop', true, '');
    await waitFor(() => server.peers.size === 1, 3000);
    ck('server re-registers the peer', server.peers.size === 1);

    // 4) Motion still flows after a reconnect. The server's _motionSeq restarts
    //    at 0 for a new NetServer; if the client kept its old high-water mark
    //    the (now working) stale-drop would reject everything forever.
    client._lastMoveSeq = 50000; // simulate a long previous session
    client.stop();
    client.start();
    await waitFor(() => client.connected, 6000);
    ck('lastMoveSeq reset on reconnect', client._lastMoveSeq === 0,
       'lastMoveSeq=' + client._lastMoveSeq);

    const moved = [];
    client.on('mousemove', (m) => moved.push(m));
    await waitFor(() => server.peers.size === 1, 3000);
    const p2 = [...server.peers.values()][0];
    server.sendMouseMove(p2.id, 111, 222);
    await waitFor(() => moved.length > 0, 3000);
    ck('motion delivered after reconnect', moved.length > 0, 'moved=' + moved.length);
  } catch (e) {
    ck('no timeout', false, e.message);
  } finally {
    try { client.stop(); } catch {}
    try { server.stop(); } catch {}
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
