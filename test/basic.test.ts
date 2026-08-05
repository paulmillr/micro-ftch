import { describe, should } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, rejects, throws } from 'node:assert';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import * as mftch from '../index.ts';

// NOTE: this will send real network requests to httpbin (to verify compat)
const REAL_NETWORK = false;

function httpServer(port, cb) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json') {
      res.writeHead(405);
      res.end('Method not allowed');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const buf = [];
    for await (const chunk of req) buf.push(chunk);
    const body = Buffer.concat(buf).toString('utf8');
    const response = await cb(JSON.parse(body), req.headers);
    res.end(JSON.stringify(response));
  });
  server.on('error', (err) => console.log('HTTP ERR', err));
  const stop = () =>
    new Promise((resolve, reject) => {
      server.close(async (err) => {
        await sleep(100); // this somehow broken, without it new server will throw ECONNRESET because old server not fully closed.
        // also, bun will silently use old server even after stopping, so we use different ports for different tests
        if (err) reject(err);
        else resolve();
      });
      server.closeAllConnections();
    });
  const url = `http://127.0.0.1:${port}/`;
  return new Promise((resolve) => server.listen(port, (t) => resolve({ stop, url })));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanHeaders = (headers) => {
  // these changes between node, bun and deno
  const {
    'accept-encoding': _0,
    'sec-fetch-mode': _1,
    'user-agent': _2,
    connection: _3,
    host: _4,
    'accept-language': _5,
    ...rest
  } = headers;
  return rest;
};

describe('Network', () => {
  describe('Limit', () => {
    const { limit } = mftch._TEST;
    const delayed = (value, delay, log) =>
      new Promise((resolve) =>
        setTimeout(() => {
          log.push(value);
          resolve(value);
        }, delay)
      );
    should('limit(2)', async () => {
      const ts = Date.now();
      const limit2 = limit(2);
      const log = [];
      await Promise.all([
        limit2(() => delayed(1, 100, log)),
        limit2(() => delayed(2, 100, log)),
        limit2(() => delayed(3, 100, log)),
      ]);
      deepStrictEqual(Date.now() - ts >= 200, true);
      deepStrictEqual(log, [1, 2, 3]);
    });
    should('limit(1), order', async () => {
      const limit1 = limit(1);
      const log = [];
      await Promise.all([
        limit1(() => delayed(1, 50, log)),
        limit1(() => delayed(2, 100, log)),
        limit1(() => delayed(3, 10, log)),
      ]);
      deepStrictEqual(log, [1, 2, 3]);
    });
    should('limit(2), order', async () => {
      const limit2 = limit(2);
      const log = [];
      await Promise.all([
        limit2(() => delayed(1, 50, log)),
        limit2(() => delayed(2, 100, log)),
        limit2(() => delayed(3, 10, log)),
      ]);
      deepStrictEqual(log, [1, 3, 2]);
    });
    should('limit(3), order', async () => {
      const limit3 = limit(3);
      const log = [];
      await Promise.all([
        limit3(() => delayed(1, 50, log)),
        limit3(() => delayed(2, 100, log)),
        limit3(() => delayed(3, 10, log)),
      ]);
      deepStrictEqual(log, [3, 1, 2]);
    });
    should('error', async () => {
      const limit1 = limit(1);
      const log = [];
      limit1(() => delayed(1, 10, log));
      const p2 = limit1(() => {
        throw new Error('Failure'); // sync error
      });
      await rejects(p2);
      const p3 = await limit1(() => delayed(2, 20, log));
      deepStrictEqual(p3, 2);
      deepStrictEqual(log, [1, 2]);
      const p4 = limit1(async () => {
        throw new Error('Failure'); // async error
      });
      await rejects(p4);
      // still processing after error
      const p5 = await limit1(() => delayed(3, 10, log));
      deepStrictEqual(p5, 3);
      deepStrictEqual(log, [1, 2, 3]);
    });
    should('invalid concurrency limit', async () => {
      throws(() => limit(0), { message: 'expected concurrencyLimit > 0, got 0' });
      throws(() => limit(-1), { message: 'expected concurrencyLimit > 0, got -1' });
      throws(() => mftch.ftch(fetch, { concurrencyLimit: 0 }), {
        message: 'expected concurrencyLimit > 0, got 0',
      });
      throws(() => mftch.ftch(fetch, { concurrencyLimit: -1 }), {
        message: 'expected concurrencyLimit > 0, got -1',
      });
    });
  });
  if (REAL_NETWORK) {
    describe('Real network', () => {
      should('Basic req', async () => {
        const ftch = mftch.ftch(fetch);
        const res = await ftch('https://httpbin.org/json');
        deepStrictEqual(res.ok, true);
        deepStrictEqual(res.redirected, false);
        deepStrictEqual(res.status, 200);
        deepStrictEqual(res.statusText, 'OK');
        deepStrictEqual(res.type, 'basic');
        deepStrictEqual(res.url, 'https://httpbin.org/json');
        const h = {};
        res.headers.forEach((v, k) => (h[k] = v));
        delete h.date;
        deepStrictEqual(h, {
          'access-control-allow-credentials': 'true',
          'access-control-allow-origin': '*',
          connection: 'keep-alive',
          'content-length': '429',
          'content-type': 'application/json',
          server: 'gunicorn/19.9.0',
        });
        deepStrictEqual(await res.json(), {
          slideshow: {
            author: 'Yours Truly',
            date: 'date of publication',
            slides: [
              { title: 'Wake up to WonderWidgets!', type: 'all' },
              {
                items: ['Why <em>WonderWidgets</em> are great', 'Who <em>buys</em> WonderWidgets'],
                title: 'Overview',
                type: 'all',
              },
            ],
            title: 'Sample Slide Show',
          },
        });
      });
      should('Headers (class)', async () => {
        const ftch = mftch.ftch(fetch);
        const reqs = await Promise.all([
          // Class
          ftch('https://httpbin.org/headers', { headers: new Headers({ A: 'b' }) }),
          fetch('https://httpbin.org/headers', { headers: new Headers({ A: 'b' }) }),
          // Array
          ftch('https://httpbin.org/headers', { headers: [['A', 'b']] }),
          fetch('https://httpbin.org/headers', { headers: [['A', 'b']] }),
          // Object
          ftch('https://httpbin.org/headers', { headers: { A: 'b' } }),
          fetch('https://httpbin.org/headers', { headers: { A: 'b' } }),
        ]);
        for (const req of reqs) {
          deepStrictEqual(
            {
              ...(await req.json()).headers,
              'X-Amzn-Trace-Id': undefined,
            },
            {
              A: 'b',
              Accept: '*/*',
              'Accept-Encoding': 'br, gzip, deflate',
              'Accept-Language': '*',
              Host: 'httpbin.org',
              'Sec-Fetch-Mode': 'cors',
              'User-Agent': 'node',
              'X-Amzn-Trace-Id': undefined,
            }
          );
        }
      });

      should('Basic auth', async () => {
        const ftch = mftch.ftch(fetch);
        const res = await ftch('https://user:pwd@httpbin.org/basic-auth/user/pwd');
        deepStrictEqual(await res.json(), { authenticated: true, user: 'user' });
        const res2 = await ftch('https://httpbin.org/basic-auth/user/pwd');
        deepStrictEqual(res2.status, 401);
        deepStrictEqual(res2.statusText, 'UNAUTHORIZED');
        deepStrictEqual(await res2.text(), '');
      });
    });
  }

  should('ftch', async () => {
    const serverLog = [];
    const { stop, url } = await httpServer(8001, async (r) => {
      if (r.sleep) await sleep(r.sleep);
      serverLog.push(r.res);
      return { res: r.res };
    });
    let ENABLED = true;
    const f1 = mftch.ftch(fetch, {
      concurrencyLimit: 1,
      killswitch: () => ENABLED,
    });
    const f2 = mftch.ftch(fetch, {
      concurrencyLimit: 2,
      killswitch: () => ENABLED,
    });
    const f3 = mftch.ftch(fetch, {
      concurrencyLimit: 3,
      killswitch: () => ENABLED,
    });
    const t = async (fn, body, opts = {}) => {
      const res = await fn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...opts,
      });
      return await res.json();
    };
    // Basic
    deepStrictEqual(await t(f1, { res: 1 }), { res: 1 });
    // Killswitch
    ENABLED = false;
    await rejects(() => t(f1, { res: 2 }));
    ENABLED = true;
    deepStrictEqual(await t(f1, { res: 3 }), { res: 3 });
    deepStrictEqual(serverLog, [1, 3]);
    serverLog.splice(0, serverLog.length);
    // Concurrency
    // limit(1)
    const t0 = await Promise.all([
      // All processed sequentially
      t(f1, { res: 1, sleep: 50 }),
      t(f1, { res: 2, sleep: 100 }),
      t(f1, { res: 3, sleep: 10 }),
    ]);
    deepStrictEqual(t0, [{ res: 1 }, { res: 2 }, { res: 3 }]);
    deepStrictEqual(serverLog, [1, 2, 3]);
    serverLog.splice(0, serverLog.length);
    // limit(2)
    const t1 = await Promise.all([
      // 1+2 starts [processed: 1, 2]
      // 1 done, 3 starts [processed: 2,3] -> push(1)
      // 3 done [processed: 2] -> push(3)
      // 2 done [processed: none] -> push(2)
      t(f2, { res: 1, sleep: 50 }),
      t(f2, { res: 2, sleep: 100 }),
      t(f2, { res: 3, sleep: 10 }),
    ]);
    deepStrictEqual(t1, [{ res: 1 }, { res: 2 }, { res: 3 }]);
    deepStrictEqual(serverLog, [1, 3, 2]);
    serverLog.splice(0, serverLog.length);
    // limit(3)
    const t2 = await Promise.all([
      // 1+2+3 starts [processed: 1, 2, 3]
      // 3 done [processed 1,2] -> push(3)
      // 1 done [processed 2] -> push(1)
      // 2 done [processed: none] -> push(2)
      t(f3, { res: 1, sleep: 50 }),
      t(f3, { res: 2, sleep: 100 }),
      t(f3, { res: 3, sleep: 10 }),
    ]);
    deepStrictEqual(t2, [{ res: 1 }, { res: 2 }, { res: 3 }]);
    deepStrictEqual(serverLog, [3, 1, 2]);
    serverLog.splice(0, serverLog.length);
    // Timeout: less timeout
    deepStrictEqual(await t(f1, { res: 1, sleep: 10 }, { timeout: 50 }), { res: 1 });
    deepStrictEqual(serverLog, [1]);
    // Timeout: bigger than timeout
    await rejects(() => t(f1, { res: 2, sleep: 50 }, { timeout: 50 }));
    await sleep(10); // make sure request finished on server side
    deepStrictEqual(serverLog, [1, 2]);
    // Timeout: after long request with concurrency
    const t3 = await Promise.all([
      t(f1, { res: 3, sleep: 50 }),
      // if timeout timer starts before enters queue this would crash since previous request takes 50ms
      t(f1, { res: 4, sleep: 1 }, { timeout: 10 }),
    ]);
    deepStrictEqual(t3, [{ res: 3 }, { res: 4 }]);
    deepStrictEqual(serverLog, [1, 2, 3, 4]);
    // Timeout: default
    const f1_t = mftch.ftch(fetch, {
      concurrencyLimit: 1,
      killswitch: () => ENABLED,
      timeout: 10,
    });
    deepStrictEqual(await t(f1_t, { res: 5, sleep: 5 }), { res: 5 });
    await rejects(() => t(f1_t, { res: 6, sleep: 11 }));
    // override timeout
    deepStrictEqual(await t(f1_t, { res: 7, sleep: 11 }, { timeout: 100 }), { res: 7 });
    deepStrictEqual(serverLog, [1, 2, 3, 4, 5, 6, 7]);
    serverLog.splice(0, serverLog.length);
    // AbortSignal
    const seen = [];
    const pendingFetch = async (url, opts = {}) => {
      seen.push({
        url,
        method: opts.method,
        header: opts.headers.get('a'),
      });
      return new Promise((_, reject) => {
        const signal = opts.signal;
        if (!signal) return reject(new Error('missing signal'));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const caller = new AbortController();
    const err = new Error('caller abort');
    const fSignal = mftch.ftch(pendingFetch, { timeout: 30 });
    const pSignal = fSignal('https://example.com', {
      method: 'POST',
      headers: { A: 'b' },
      signal: caller.signal,
    });
    await sleep(0);
    caller.abort(err);
    await rejects(pSignal, { message: 'caller abort' });
    await rejects(() =>
      mftch.ftch(pendingFetch, { timeout: 1 })('https://timeout.example', {
        signal: new AbortController().signal,
      })
    );
    await rejects(() =>
      mftch.ftch(pendingFetch)('https://timeout.example', {
        signal: new AbortController().signal,
        timeout: 1,
      })
    );
    deepStrictEqual(seen, [
      { url: 'https://example.com', method: 'POST', header: 'b' },
      { url: 'https://timeout.example', method: undefined, header: null },
      { url: 'https://timeout.example', method: undefined, header: null },
    ]);
    // URI userinfo auth
    const authLog = [];
    const authFetch = async (url, opts = {}) => {
      authLog.push({
        url,
        auth: opts.headers.get('authorization'),
        header: opts.headers.get('a'),
      });
      return {
        headers: new Headers(),
        ok: true,
        redirected: false,
        status: 200,
        statusText: 'OK',
        type: 'basic',
        url,
        json: async () => ({}),
        text: async () => '',
        arrayBuffer: async () => new TextEncoder().encode('{}').buffer,
      };
    };
    const authNet = mftch.ftch(authFetch);
    await authNet('https://user:pwd@example.com/path');
    await authNet('https://:pwd@example.com/path');
    await authNet('https://user:pa:ss@example.com/path');
    await authNet('https://us%40er:p%40ss@example.com/path');
    await authNet('https://user:p%D0%B0ss@example.com/path'); // non-Latin-1 password (cyrillic а)
    const callerHeaders = new Headers({ A: 'b' });
    await authNet('https://user:pwd@example.com/path', { headers: callerHeaders });
    await authNet('https://user:pwd@example.com/path', {
      headers: { Authorization: 'Bearer token' },
    });
    deepStrictEqual(authLog, [
      { url: 'https://example.com/path', auth: 'Basic dXNlcjpwd2Q=', header: null },
      { url: 'https://example.com/path', auth: 'Basic OnB3ZA==', header: null },
      // userinfo is percent-decoded before encoding (RFC 7617 §2): 'user:pa:ss'
      { url: 'https://example.com/path', auth: 'Basic dXNlcjpwYTpzcw==', header: null },
      // 'us@er:p@ss'
      { url: 'https://example.com/path', auth: 'Basic dXNAZXI6cEBzcw==', header: null },
      // UTF-8 bytes of 'user:pаss' survive base64 (btoa alone would throw)
      { url: 'https://example.com/path', auth: 'Basic dXNlcjpw0LBzcw==', header: null },
      { url: 'https://example.com/path', auth: 'Basic dXNlcjpwd2Q=', header: 'b' },
      { url: 'https://example.com/path', auth: 'Bearer token', header: null },
    ]);
    deepStrictEqual(Array.from(callerHeaders.entries()), [['a', 'b']]);
    // Logs
    const log = [];
    const f1_l = mftch.ftch(fetch, {
      concurrencyLimit: 1,
      log: (url, opts) => log.push({ url, opts }),
    });
    deepStrictEqual(await t(f1_l, { res: 1, sleep: 10 }), { res: 1 });
    deepStrictEqual(serverLog, [1]);
    deepStrictEqual(log, [
      {
        url: 'http://127.0.0.1:8001/',
        opts: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"res":1,"sleep":10}',
        },
      },
    ]);

    serverLog.splice(0, serverLog.length);
    await stop();
  });
  should('jsonrpc', async () => {
    const serverLog = [];
    const { stop, url } = await httpServer(8002, async (r, headers) => {
      serverLog.push({ r, headers: cleanHeaders(headers) });
      if (Array.isArray(r))
        return r.map((i) => (Array.isArray(i.params) ? i.params[0] : i.params.res));
      return Array.isArray(r.params) ? r.params[0] : r.params.res;
    });
    const f = mftch.ftch(fetch);
    const rpc = mftch.jsonrpc(f, url, {
      headers: { Test: '1' },
    });
    // Basic
    deepStrictEqual(
      await rpc.call('tmp', { jsonrpc: '2.0', id: 0, result: 1 }, 1, true, [1, 2, 3]),
      1
    );
    deepStrictEqual(
      await rpc.callNamed('tmp', { res: { jsonrpc: '2.0', id: 0, result: 1 }, A: 1 }),
      1
    );
    await rejects(() =>
      rpc.call('tmp', { jsonrpc: '2.0', id: 0, error: { code: 0, message: 'test' } })
    );
    deepStrictEqual(serverLog, [
      {
        r: {
          jsonrpc: '2.0',
          id: 0,
          method: 'tmp',
          params: [{ jsonrpc: '2.0', id: 0, result: 1 }, 1, true, [1, 2, 3]],
        },
        headers: {
          'content-type': 'application/json',
          test: '1',
          accept: '*/*',
          'content-length': '101',
        },
      },
      {
        r: {
          jsonrpc: '2.0',
          id: 0,
          method: 'tmp',
          params: { res: { jsonrpc: '2.0', id: 0, result: 1 }, A: 1 },
        },
        headers: {
          'content-type': 'application/json',
          test: '1',
          accept: '*/*',
          'content-length': '98',
        },
      },
      {
        r: {
          jsonrpc: '2.0',
          id: 0,
          method: 'tmp',
          params: [{ jsonrpc: '2.0', id: 0, error: { code: 0, message: 'test' } }],
        },
        headers: {
          'content-type': 'application/json',
          test: '1',
          accept: '*/*',
          'content-length': '111',
        },
      },
    ]);
    serverLog.splice(0, serverLog.length);
    // Batch
    const rpcBatch = mftch.jsonrpc(f, url, {
      headers: { Test: '1' },
      batchSize: 2,
    });
    // This tests:
    // - batch processes up to 2 elements in parallel
    // - named + unnamed mix works
    // - if there are less than 2 elements in queue we still create batch
    // - errors work in batch
    const t0 = await Promise.allSettled([
      rpcBatch.call('tmp', { jsonrpc: '2.0', id: 0, result: 1 }, 1, true, [1, 2, 3]),
      rpcBatch.callNamed('tmp', { res: { jsonrpc: '2.0', id: 1, result: 2 }, A: 1 }),
      rpcBatch.call('tmp', { jsonrpc: '2.0', id: 0, error: { code: 0, message: 'test' } }),
      rpcBatch.call('tmp', { jsonrpc: '2.0', id: 1, result: 3 }, 1, true, [1, 2, 3]),
      rpcBatch.call('tmp', { jsonrpc: '2.0', id: 0, result: 4 }, 1, true, [1, 2, 3]),
    ]);
    deepStrictEqual(t0[0], { status: 'fulfilled', value: 1 });
    deepStrictEqual(t0[1], { status: 'fulfilled', value: 2 });
    deepStrictEqual(t0[2].status, 'rejected');
    deepStrictEqual(t0[3], { status: 'fulfilled', value: 3 });
    deepStrictEqual(t0[4], { status: 'fulfilled', value: 4 });
    deepStrictEqual(
      serverLog.map((i) => i.r),
      [
        [
          {
            jsonrpc: '2.0',
            id: 0,
            method: 'tmp',
            params: [{ jsonrpc: '2.0', id: 0, result: 1 }, 1, true, [1, 2, 3]],
          },
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tmp',
            params: { res: { jsonrpc: '2.0', id: 1, result: 2 }, A: 1 },
          },
        ],
        [
          {
            jsonrpc: '2.0',
            id: 0,
            method: 'tmp',
            params: [{ jsonrpc: '2.0', id: 0, error: { code: 0, message: 'test' } }],
          },
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'tmp',
            params: [{ jsonrpc: '2.0', id: 1, result: 3 }, 1, true, [1, 2, 3]],
          },
        ],
        [
          {
            jsonrpc: '2.0',
            id: 0,
            method: 'tmp',
            params: [{ jsonrpc: '2.0', id: 0, result: 4 }, 1, true, [1, 2, 3]],
          },
        ],
      ]
    );
    serverLog.splice(0, serverLog.length);
    // Now, lets breaks ids! (malicious server)
    const t1 = await Promise.allSettled([
      rpcBatch.call('tmp', { jsonrpc: '2.0', id: 90, result: 1 }, 1, true, [1, 2, 3]),
      rpcBatch.callNamed('tmp', { res: { jsonrpc: '2.0', id: 1, result: 2 }, A: 1 }),
      rpcBatch.call('tmp', { jsonrpc: '2.0', id: 5, error: { code: 0, message: 'test' } }),
      rpcBatch.call('tmp', { jsonrpc: '2.0', id: 1, result: 3 }, 1, true, [1, 2, 3]),
      rpcBatch.call('tmp', { jsonrpc: '2.0', id: 4, result: 4 }, 1, true, [1, 2, 3]),
    ]);
    deepStrictEqual(
      t1.map((i) => i.status),
      ['rejected', 'fulfilled', 'rejected', 'fulfilled', 'rejected']
    );
    const transportError = new Error('fetch failed');
    const rpcBatchTransportFailure = mftch.jsonrpc(
      async () => {
        throw transportError;
      },
      url,
      { batchSize: 2 }
    );
    const t2 = await Promise.allSettled([
      rpcBatchTransportFailure.call('tmp', 1),
      rpcBatchTransportFailure.callNamed('tmp', { A: 1 }),
    ]);
    deepStrictEqual(t2, [
      { status: 'rejected', reason: transportError },
      { status: 'rejected', reason: transportError },
    ]);
    await stop();
  });
  should('replayable', async () => {
    const serverLog = [];
    const { stop, url } = await httpServer(8003, async (r) => {
      if (r.sleep) await sleep(r.sleep);
      serverLog.push(r.res);
      return { res: r.res };
    });
    const t = async (fn, body, opts = {}) => {
      const res = await fn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...opts,
      });
      return await res.json();
    };
    const ftch = mftch.ftch(fetch);
    const replayCapture = mftch.replayable(ftch);
    deepStrictEqual(await t(replayCapture, { res: 1 }), { res: 1 });
    deepStrictEqual(await t(replayCapture, { res: 2 }), { res: 2 });
    deepStrictEqual(serverLog, [1, 2]);
    const logs = replayCapture.export();
    const parsedLogs = JSON.parse(logs);
    const logKeys = Object.keys(parsedLogs);
    deepStrictEqual(logKeys, [
      '{"url":"http://127.0.0.1:8003/","opt":{"method":"POST","headers":{"Content-Type":"application/json"},"body":"{\\"res\\":1}"}}',
      '{"url":"http://127.0.0.1:8003/","opt":{"method":"POST","headers":{"Content-Type":"application/json"},"body":"{\\"res\\":2}"}}',
    ]);
    // Entries capture response metadata alongside the body; live server headers (date etc.) vary,
    // so check the stable fields only.
    deepStrictEqual(parsedLogs[logKeys[0]].body, '{"res":1}');
    deepStrictEqual(parsedLogs[logKeys[1]].body, '{"res":2}');
    deepStrictEqual(parsedLogs[logKeys[0]].status, 200);
    deepStrictEqual(parsedLogs[logKeys[0]].headers['content-type'], 'application/json');
    const replayTest = mftch.replayable(ftch, JSON.parse(logs));
    deepStrictEqual(await t(replayTest, { res: 1 }), { res: 1 });
    deepStrictEqual(await t(replayTest, { res: 2 }), { res: 2 });
    deepStrictEqual(await t(replayTest, { res: 3 }), { res: 3 });
    // Third request is real
    deepStrictEqual(serverLog, [1, 2, 3]);
    // Throws in offline mode
    const replayTestOffline = mftch.replayable(ftch, JSON.parse(logs), { offline: true });
    deepStrictEqual(await t(replayTestOffline, { res: 1 }), { res: 1 });
    deepStrictEqual(await t(replayTestOffline, { res: 2 }), { res: 2 });
    await rejects(() => t(replayTestOffline, { res: 3 }));
    deepStrictEqual(serverLog, [1, 2, 3]);
    await stop();
  });
  should('replayable without request opts', async () => {
    const fetchFn: mftch.FetchFn = async (url, opts = {}) => {
      const body = JSON.stringify({ url, method: opts.method || 'GET' });
      return {
        headers: new Headers(),
        ok: true,
        redirected: false,
        status: 200,
        statusText: 'OK',
        type: 'basic',
        url,
        json: async () => JSON.parse(body),
        text: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    };
    const replay = mftch.replayable(fetchFn);
    deepStrictEqual(await (await replay('https://example.com')).json(), {
      url: 'https://example.com',
      method: 'GET',
    });
    deepStrictEqual(replay.logs, {
      '{"url":"https://example.com","opt":{"headers":{}}}': {
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '{"url":"https://example.com","method":"GET"}',
      },
    });
  });
  should('replayable header key casing', async () => {
    const fetchFn: mftch.FetchFn = async (url, opts = {}) => {
      const headers = new Headers(opts.headers);
      const body = JSON.stringify({ url, contentType: headers.get('content-type') });
      return {
        headers: new Headers(),
        ok: true,
        redirected: false,
        status: 200,
        statusText: 'OK',
        type: 'basic',
        url,
        json: async () => JSON.parse(body),
        text: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      };
    };
    const cases = [
      { capture: new Headers({ 'Content-Type': 'x' }), replay: new Headers({ 'content-type': 'x' }) },
      { capture: [['Content-Type', 'x']], replay: [['content-type', 'x']] },
      { capture: { 'Content-Type': 'x' }, replay: { 'content-type': 'x' } },
    ];
    for (const { capture, replay } of cases) {
      const live = mftch.replayable(fetchFn);
      deepStrictEqual(await (await live('https://example.com', { headers: capture })).json(), {
        url: 'https://example.com',
        contentType: 'x',
      });
      const offline = mftch.replayable(fetchFn, live.logs, { offline: true });
      deepStrictEqual(await (await offline('https://example.com', { headers: replay })).json(), {
        url: 'https://example.com',
        contentType: 'x',
      });
    }
  });
  should('replayable empty text body', async () => {
    const fetchFn: mftch.FetchFn = async (url) => ({
      headers: new Headers(),
      ok: true,
      redirected: false,
      status: 204,
      statusText: 'No Content',
      type: 'basic',
      url,
      json: async () => {
        throw new Error('no json');
      },
      text: async () => '',
      arrayBuffer: async () => new Uint8Array().buffer,
    });
    const live = mftch.replayable(fetchFn);
    const res = await live('https://example.com/empty');
    deepStrictEqual(await res.text(), '');
    const logs = live.export();
    deepStrictEqual(JSON.parse(logs), {
      '{"url":"https://example.com/empty","opt":{"headers":{}}}': {
        status: 204,
        statusText: 'No Content',
        headers: {},
        body: '',
      },
    });
    const offline = mftch.replayable(fetchFn, JSON.parse(logs), { offline: true });
    deepStrictEqual(await (await offline('https://example.com/empty')).text(), '');
    await rejects(() => offline('https://example.com/missing'));
  });
});

describe('Wrappers v1.1', () => {
  const fakeRes = (opts: any = {}) => {
    const status = opts.status || 200;
    const body = opts.body || '';
    return {
      headers: new Headers(opts.headers || {}),
      ok: status >= 200 && status < 300,
      redirected: false,
      status,
      statusText: opts.statusText || 'OK',
      type: 'basic' as ResponseType,
      url: opts.url || '',
      json: async () => JSON.parse(body),
      text: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };
  should('allowedHosts', async () => {
    const calls = [];
    const fetchFn = async (url) => {
      calls.push(url);
      return fakeRes({ url, body: 'ok' });
    };
    // Rejected before isValidRequest runs: allowlist takes precedence over the hook
    const f = mftch.ftch(fetchFn, {
      allowedHosts: ['example.com'],
      isValidRequest: () => {
        throw new Error('isValidRequest must not run for disallowed hosts');
      },
    });
    await rejects(() => f('https://evil.com/'), /host not allowed/);
    deepStrictEqual(calls, []);
    let ksCalls = 0;
    const f2 = mftch.ftch(fetchFn, {
      allowedHosts: ['Example.com', 'localhost:8080'],
      isValidRequest: () => {
        ksCalls++;
        return true;
      },
    });
    await f2('https://example.com/x'); // hostname entry, case-insensitive
    deepStrictEqual(ksCalls, 2); // killswitch runs before and after the fetch
    await f2('http://localhost:8080/'); // host:port entry
    await rejects(() => f2('http://localhost:9999/'), /host not allowed/);
    await rejects(() => f2('/relative'), /relative URL/);
    // Redirect landing on a different host is rejected after the fetch
    const fRedir = mftch.ftch(async (url) => fakeRes({ url: 'https://evil.com/landed', body: 'x' }), {
      allowedHosts: ['example.com'],
    });
    await rejects(() => fRedir('https://example.com/'), /host not allowed/);
    throws(() => mftch.ftch(fetchFn, { allowedHosts: 'example.com' as any }));
  });
  should('maxBodySize', async () => {
    const body = 'a'.repeat(100);
    const mkFetch = (headers) => async (url) => fakeRes({ url, body, headers });
    // Content-Length fast reject
    await rejects(
      () => mftch.ftch(mkFetch({ 'content-length': '100' }), { maxBodySize: 10 })('https://x.com/'),
      /maxBodySize/
    );
    // Fallback (no stream): actual length checked after reading
    await rejects(() => mftch.ftch(mkFetch({}), { maxBodySize: 10 })('https://x.com/'), /maxBodySize/);
    deepStrictEqual(
      await (await mftch.ftch(mkFetch({}), { maxBodySize: 100 })('https://x.com/')).text(),
      body
    );
    // Streaming path: aborts mid-body without buffering the rest
    const streamRes = (chunks) => ({
      ...fakeRes({}),
      body: new ReadableStream({
        start(c) {
          for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
          c.close();
        },
      }),
    });
    await rejects(
      () =>
        mftch.ftch(async () => streamRes(['aaaa', 'bbbb', 'cccc']), { maxBodySize: 10 })('https://x.com/'),
      /maxBodySize/
    );
    const ok = await mftch.ftch(async () => streamRes(['aaaa', 'bbbb']), { maxBodySize: 10 })('https://x.com/');
    deepStrictEqual(await ok.text(), 'aaaabbbb');
    throws(() => mftch.ftch(mkFetch({}), { maxBodySize: 0 }));
  });
  should('rps', async () => {
    const starts = [];
    const f = mftch.ftch(
      async (url) => {
        starts.push(Date.now());
        return fakeRes({ url, body: 'x' });
      },
      { rps: 20 } // 50ms spacing
    );
    await Promise.all([f('https://x.com/1'), f('https://x.com/2'), f('https://x.com/3')]);
    deepStrictEqual(starts.length, 3);
    // timers may fire marginally early; assert spacing with tolerance
    for (const gap of [starts[1] - starts[0], starts[2] - starts[1]])
      deepStrictEqual(gap >= 40, true, `expected gap >= 40ms, got ${gap}`);
    throws(() => mftch.ftch(async (url) => fakeRes({ url }), { rps: 0 }));
  });
  should('replayable response metadata', async () => {
    const fetchFn = async (url) =>
      fakeRes({ url, status: 404, statusText: 'Not Found', headers: { 'x-a': '1' }, body: 'missing' });
    const live = mftch.replayable(fetchFn);
    const r1 = await live('https://example.com/404');
    deepStrictEqual([r1.status, r1.ok], [404, false]);
    await r1.text();
    const offline = mftch.replayable(
      async () => {
        throw new Error('no network');
      },
      JSON.parse(live.export()),
      { offline: true }
    );
    const r2 = await offline('https://example.com/404');
    deepStrictEqual(
      [r2.status, r2.statusText, r2.ok, r2.headers.get('x-a')],
      [404, 'Not Found', false, '1']
    );
    deepStrictEqual(await r2.text(), 'missing');
    // Misses in offline mode point at the most similar logged key
    await rejects(() => offline('https://example.com/405'), /closest logged request/);
  });
  should('retry', async () => {
    // network errors retried, succeeds on 3rd attempt
    let n = 0;
    const flaky = async (url) => {
      if (++n < 3) throw new Error('conn reset');
      return fakeRes({ url, body: 'ok' });
    };
    deepStrictEqual(
      await (await mftch.retry(flaky, { baseDelay: 1, maxDelay: 5 })('https://x.com/')).text(),
      'ok'
    );
    deepStrictEqual(n, 3);
    // exhausted attempts rethrow the last error
    n = 0;
    await rejects(
      () =>
        mftch.retry(
          async () => {
            n++;
            throw new Error('conn reset');
          },
          { attempts: 2, baseDelay: 1 }
        )('https://x.com/'),
      /conn reset/
    );
    deepStrictEqual(n, 2);
    // 5xx retried for GET; last non-ok response is returned, not thrown
    n = 0;
    const f500 = mftch.retry(
      async (url) => {
        n++;
        return fakeRes({ url, status: 500, statusText: 'ISE', body: 'e' });
      },
      { attempts: 2, baseDelay: 1 }
    );
    deepStrictEqual((await f500('https://x.com/')).status, 500);
    deepStrictEqual(n, 2);
    // POST not retried by default policy
    n = 0;
    await rejects(() =>
      mftch.retry(
        async () => {
          n++;
          throw new Error('x');
        },
        { attempts: 3, baseDelay: 1 }
      )('https://x.com/', { method: 'POST' })
    );
    deepStrictEqual(n, 1);
    // custom shouldRetry opts POST in
    n = 0;
    const fPost = mftch.retry(
      async (url) => {
        if (++n < 2) throw new Error('x');
        return fakeRes({ url, body: 'ok' });
      },
      { baseDelay: 1, shouldRetry: () => true }
    );
    deepStrictEqual(await (await fPost('https://x.com/', { method: 'POST' })).text(), 'ok');
    deepStrictEqual(n, 2);
    // Retry-After overrides computed backoff (here: no wait instead of 1s base delay)
    n = 0;
    const t0 = Date.now();
    const fRA = mftch.retry(
      async (url) => {
        if (++n < 2)
          return fakeRes({ url, status: 429, statusText: 'TMR', headers: { 'retry-after': '0' } });
        return fakeRes({ url, body: 'ok' });
      },
      { baseDelay: 1000, maxDelay: 2000 }
    );
    deepStrictEqual(await (await fRA('https://x.com/')).text(), 'ok');
    deepStrictEqual(Date.now() - t0 < 500, true);
    throws(() => mftch.retry(flaky, { attempts: 0 }));
  });
});

should.runWhen(import.meta.url);
