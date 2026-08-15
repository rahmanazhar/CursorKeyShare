'use strict';
// Each socket's close handler armed its own reconnect timer while only one
// handle was tracked, so N close events produced N reconnects (and stop()
// cleared only the last one).

const { NetClient } = require('../src/main/net/client');
const crypto = require('../src/main/net/crypto');

let fails = 0;
const ck = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  -> ' + d)); if (!c) fails++; };

const key = crypto.deriveKey('testpass', 'testgroup');
// Port 1 is never listening, so _connect() always fails — we are testing the
// scheduling logic, not a real session.
const client = new NetClient({
  key, host: '127.0.0.1', tcpPort: 1, udpPort: 34931, serverUdpPort: 1,
  name: 'cli', localId: 'cli', bounds: { originX: 0, originY: 0, width: 1, height: 1 },
});
client.on('warn', () => {});
client.on('error', () => {});

let connects = 0;
const realConnect = client._connect.bind(client);
client._connect = function () { connects++; return realConnect(); };

(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  client.start();
  await sleep(200);
  const afterStart = connects;
  ck('one connect attempt on start', afterStart === 1, 'connects=' + afterStart);

  // Fire several close events as if from superseded sockets of one attempt.
  const fakeClose = () => {
    if (client._sock) client._sock.emit('close');
  };
  fakeClose(); fakeClose(); fakeClose();
  ck('exactly one reconnect timer armed', client._reconnectTimer != null);

  await sleep(2200);
  ck('three closes produced ONE reconnect', connects === afterStart + 1,
     'connects=' + connects + ' (expected ' + (afterStart + 1) + ')');

  client.stop();
  const afterStop = connects;
  await sleep(2200);
  ck('no reconnect fires after stop', connects === afterStop, 'connects=' + connects);
  ck('reconnect timer cleared by stop', client._reconnectTimer == null);

  console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'ALL PASS'));
  process.exit(fails ? 1 : 0);
})();
