require('./server');
const fetch = require('../index').default;
const common = require('./common');
const error = (...txt) => console.log('[\x1b[31mERROR\x1b[0m]', ...txt);
const ok = (...txt) => console.log('[\x1b[32mOK\x1b[0m]', ...txt);
const run = async (txt, fn) => {
  const ts = Date.now();
  try {
    await fn();
    ok(`${txt} done in ${Date.now() - ts} ms.`);
  } catch (e) {
    error(txt, e);
  }
};
(async () => {
  const tests = { ...common.tests, ...common.node };
  await run('All', async () => {
    for (let k in tests) await run(k, tests[k].bind(null, fetch));
  });
  process.exit();
})();
