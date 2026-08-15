'use strict';
// server.stop() cleared this.peers synchronously, before the sockets' async
// 'close' fired — so the close handler's identity check missed and
// peer-disconnected never emitted, leaving layout nodes stuck online.

const crypto = require('../src/main/net/crypto');
const { NetServer } = require('../src/main/net/server');
const { NetClient } = require('../src/main/net/client');

const TCP = 34911, SUDP = 34912, CUDP1 = 34913, CUDP2 = 34914;

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

  const mk = (id, uport) => new NetClient({
    key, host: '127.0.0.1', tcpPort: TCP, udpPort: uport, serverUdpPort: SUDP,
    name: id, localId: id, bounds: { originX: 0, originY: 0, width: 1920, height: 1080 },
  });
  const c1 = mk('cli1', CUDP1), c2 = mk('cli2', CUDP2);
  for (const c of [c1, c2]) { c.on('warn', () => {}); c.on('error', () => {}); c.start(); }

  try {
    await waitFor(() => server.peers.size === 2);
    ck('two peers registered', server.peers.size === 2);

    server.stop();
    ck('emits one peer-disconnected per peer', disconnected.length === 2,
       'got ' + disconnected.length + ' [' + disconnected.join(',') + ']');
    ck('emits for both ids', disconnected.includes('cli1') && disconnected.includes('cli2'),
       disconnected.join(','));
    ck('peer map cleared', server.peers.size === 0, 'size=' + server.peers.size);
  } catch (e) {
    ck('no timeout', false, e.message);
  } finally {
    try { c1.stop(); } catch {}
    try { c2.stop(); } catch {}
    try { server.stop(); } catch {}
  }

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
