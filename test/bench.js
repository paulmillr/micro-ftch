require('./server');
const fetch = require('../index').default;

(async () => {
  const NUM = 10;
  const msg = `Fetch ${NUM} sequential requests`;
  let ts = Date.now();
  for (let i = 0; i < NUM; i++) await fetch('http://httpbin.org/json', { keepAlive: false });
  console.log(`HTTP ${msg} (keepalive=false) in ${Date.now() - ts} ms.`);
  ts = Date.now();
  for (let i = 0; i < NUM; i++) await fetch('http://httpbin.org/json');
  console.log(`HTTP ${msg} in ${Date.now() - ts} ms.`);
  ts = Date.now();
  for (let i = 0; i < NUM; i++) await fetch('https://httpbin.org/json', { keepAlive: false });
  console.log(`HTTPS ${msg} (keepalive=false) in ${Date.now() - ts} ms.`);
  ts = Date.now();
  for (let i = 0; i < NUM; i++) await fetch('https://httpbin.org/json');
  console.log(`HTTPS ${msg} in ${Date.now() - ts} ms.`);
  // To make sure that keepalive still works with pinning
  const PIN_OPT = {
    sslAllowSelfSigned: true,
    sslCertificateWhitelist: ['35dffeb2c0b774b6135523cf25bc6d5f24462975499beb5f7eae46f9bddc71b8'],
  };
  ts = Date.now();
  for (let i = 0; i < NUM; i++)
    await fetch('https://localhost:28001', { keepAlive: false, ...PIN_OPT });
  console.log(`HTTPS (local, pin) ${msg} (keepalive=false) in ${Date.now() - ts} ms.`);
  ts = Date.now();
  for (let i = 0; i < NUM; i++) await fetch('https://localhost:28001', { ...PIN_OPT });
  console.log(`HTTPS (local, pin) ${msg} in ${Date.now() - ts} ms.`);

  process.exit();
})();
