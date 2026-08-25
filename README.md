# micro-ftch

Privacy-first wrappers for built-in `fetch()`, enabling allowlists, killswitch, logging, concurrency control, and other features.

## Usage

> `npm install micro-ftch`

> `jsr add jsr:@paulmillr/micro-ftch`

A standalone file
[micro-ftch.js](https://github.com/paulmillr/micro-ftch/releases) is also available.

There are four composable wrappers over `fetch()`:

- [ftch](#ftch) — validation, allowlists, logging, timeouts, rate & size limits, basic auth
- [jsonrpc](#jsonrpc) — batched JSON-RPC requests
- [replayable](#replayable) — record & replay requests in tests, without network
- [retry](#retry) — retries with exponential backoff and jitter

## ftch

All options are optional:

```ts
import { ftch } from 'micro-ftch';

let enabled = true;
const ctrl = new AbortController();
const f = ftch(fetch, {
  isValidRequest: () => enabled, // killswitch: false makes requests throw
  killswitchSignal: ctrl.signal, // one-shot hard killswitch, aborts in-flight requests
  allowedHosts: ['rpc.example.com', 'http://localhost:8545'], // origin allowlist
  log: (url, opts) => console.log(url, opts),
  timeout: 5000, // ms; can also be set per-request: f(url, { timeout: 1000 })
  concurrencyLimit: 10, // max in-flight requests, extras are queued
  rps: 10, // max request starts per second
  maxBodySize: 10 * 1024 * 1024, // bytes; default 1 GiB, bodies are buffered
});

await f('https://rpc.example.com/');
await f('https://user:pwd@httpbin.org/basic-auth/user/pwd'); // basic auth auto-parsing
```

- `isValidRequest` can be toggled at any time and may return a `Promise<boolean>`;
  it is checked before a request, after response headers, and after the body is buffered.
- `killswitchSignal`, once aborted, cancels active requests and blocks all future ones;
  construct a new wrapper to re-enable network access.
- `referrerPolicy: 'no-referrer'` is set by default for privacy.

## jsonrpc

Batches multiple calls into one JSON-RPC HTTP request. Can massively speed things up
when servers are single-threaded or have small per-user limits.

```ts
import { jsonrpc } from 'micro-ftch';

const rpc = jsonrpc(fetch, 'http://rpc_node/', { batchSize: 20 });
const res = await rpc.call('method', 'arg0', 'arg1');
const res2 = await rpc.callNamed('method', { arg0: '0', arg1: '1' }); // named arguments
```

`jsonrpc` automatically restricts requests to the exact origin of `rpcUrl`, whether its
transport is native `fetch` or an `ftch` wrapper. Cross-origin redirects are blocked before the
new origin is contacted. Add trusted redirect origins explicitly with
`{ allowedHosts: ['rpc-failover.example'] }`; the original RPC origin remains allowed.
When the transport was not created by `ftch`, requests also default to a 240-second timeout and
10 concurrent HTTP requests. Set `timeout` or `concurrencyLimit` here to override either value;
an `ftch` transport keeps its existing operational limits unless these options are provided.

## replayable

Records requests and replays them in tests, without calling network code.

```ts
import { replayable } from 'micro-ftch';

const capture = replayable(fetch);
await capture('http://url/1'); // real network
const logs = capture.export();

const replay = replayable(fetch, JSON.parse(logs), { offline: true });
await replay('http://url/1'); // cached
await replay('http://url/2'); // throws: not captured, offline mode forbids network
```

Captured entries include response status and headers, so error handling can be
replay-tested too. Logs store requests and responses verbatim, including any
secrets they contain — treat exported fixtures as sensitive.

## retry

Retries failed requests with exponential backoff, full jitter and `Retry-After` support.
By default only safe methods (GET/HEAD/OPTIONS) are retried — retrying a POST can duplicate
a non-idempotent action — and only on network errors or status 408/429/5xx.
Pass a custom `shouldRetry` to override the policy.

```ts
import { ftch, jsonrpc, retry } from 'micro-ftch';

const net = retry(ftch(fetch), { attempts: 3, baseDelay: 100, maxDelay: 5000 });
await net('https://example.com'); // up to 3 attempts

// JSON-RPC uses POST: opt in explicitly
const rpcNet = retry(ftch(fetch), {
  shouldRetry: (ctx) => ctx.error !== undefined || ctx.status === 429 || ctx.status >= 500,
});
const rpc = jsonrpc(rpcNet, 'http://rpc_node/', { batchSize: 20 });
```

## Security

- `allowedHosts` entries are origins: `example.com` means exactly `https://example.com:443`,
  a port (`example.com:8443`) means an alternate HTTPS origin, HTTP must be explicit
  (`http://localhost:8545`). Paths, queries and credentials are not valid entries.
- Redirects are followed by the wrapper one hop at a time, so the allowlist and
  `isValidRequest` are checked before every hop's request is sent. Hops are capped at 20;
  credentials, cookies and API-key headers (extend via `sensitiveHeaders`) are stripped
  on cross-origin hops.
- HTTPS→HTTP downgrades are rejected, even without an allowlist. Opt in with
  `allowInsecureRedirects: true` if a trusted endpoint requires one.
- `allowedHosts` is not a complete SSRF sandbox: it validates URL origins, but DNS may
  still resolve a permitted hostname to an internal address. Enforce trusted DNS and
  network-level egress rules when requests cross a security boundary.

## License

MIT (c) Paul Miller [(https://paulmillr.com)](https://paulmillr.com), see LICENSE file.
