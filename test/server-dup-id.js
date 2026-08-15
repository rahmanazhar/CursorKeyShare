'use strict';
// Two machines sharing a localId (cloned config / restored backup) used to
// silently evict each other: peers.size stayed 1, the first peer got no
// disconnect event, and both sockets were left open.

const crypto = require('../src/main/net/crypto');
const { NetServer } = require('../src/main/net/server');
const { NetClient } = require('../src/main/net/client');

const TCP = 34921, SUDP = 34922, CUDP1 = 34923, CUDP2 = 34924;

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
  const disconnected = [];
  server.on('peer-disconnected', (id) => disconnected.push(id));
  server.start();

  const mk = (uport) => new NetClient({
    key, host: '127.0.0.1', tcpPort: TCP, udpPort: uport, serverUdpPort: SUDP,
    name: 'clone', localId: 'same-id', bounds: { originX: 0, originY: 0, width: 1920, height: 1080 },
  });

  const c1 = mk(CUDP1);
  c1.on('warn', () => {}); c1.on('error', () => {});
  c1.start();

  let c2 = null;
  try {
    await waitFor(() => server.peers.size === 1);
    const first = [...server.peers.values()][0];
    ck('first client registered', server.peers.size === 1);

    c2 = mk(CUDP2);
    let byeReason = null;
    c2.on('warn', (m) => { if (/duplicate-id/.test(String(m))) byeReason = 'duplicate-id'; });
    c2.on('error', () => {});
    c2.start();

    await waitFor(() => byeReason !== null, 6000);
    ck('second client told duplicate-id', byeReason === 'duplicate-id', 'reason=' + byeReason);
    ck('still exactly one peer', server.peers.size === 1, 'size=' + server.peers.size);
    ck('the surviving peer is the FIRST one', [...server.peers.values()][0] === first);
    ck('first peer not disconnected', disconnected.length === 0, 'disconnected=' + disconnected.join(','));
    ck('first peer socket still open', first.socket.destroyed === false);
  } catch (e) {
    ck('no timeout', false, e.message);
  } finally {
    try { if (c2) c2.stop(); } catch {}
    try { c1.stop(); } catch {}
    try { server.stop(); } catch {}
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
