# micro-ftch

Wrappers for [built-in fetch()](https://developer.mozilla.org/en-US/docs/Web/API/fetch) enabling killswitch, logging, concurrency limit and other features.

fetch is great, however, its usage in secure environments is complicated. The library makes it simple.

## Usage

A standalone file
[micro-ftch.js](https://github.com/paulmillr/micro-ftch/releases) is also available.

> `npm install micro-ftch`

> `jsr add jsr:@paulmillr/micro-ftch`

```ts
import { ftch, jsonrpc, replayable } from 'micro-ftch';

let enabled = true;
const net = ftch(fetch, {
  isValidRequest: () => enabled,
  log: (url, options) => console.log(url, options),
  timeout: 5000,
  concurrencyLimit: 10,
});
const res = await net('https://example.com');

// Composable
const rpc = jsonrpc(net, 'http://rpc_node/', {
  headers: {},
  batchSize: 20,
});
const res1 = await rpc.call('method', 'arg0', 'arg1');
const res2 = await rpc.callNamed('method', { arg0: '0', arg1: '1' }); // named arguments
const replayNet = replayable(net);
const replayRpc = jsonrpc(replayNet, 'http://rpc_node/', { headers: {}, batchSize: 20 });
const replayRes = await replayRpc.call('method', 'arg0', 'arg1');
// Basic auth auto-parsing
await net('https://user:pwd@httpbin.org/basic-auth/user/pwd');
```

- [ftch](#ftch)
  - [isValidRequest](#isValidRequest)
  - [allowedHosts](#allowedHosts)
  - [log](#log)
  - [timeout](#timeout)
  - [concurrencyLimit](#concurrencyLimit)
  - [rps](#rps)
  - [maxBodySize](#maxBodySize)
  - [Basic auth](#basic-auth)
- [jsonrpc](#jsonrpc)
- [replayable](#replayable)
- [retry](#retry)
- [Privacy](#privacy)
- [License](#license)

There are four wrappers over `fetch()`:

1. `ftch(fetch)` - isValidRequest, allowed hosts, logging, timeouts, concurrency & rate limits, body size limits, basic auth
2. `jsonrpc(fetch)` - batched JSON-RPC functionality
3. `replayable(fetch)` - log & replay network requests without actually calling network code.
4. `retry(fetch)` - retries failed requests with exponential backoff and jitter.

## ftch

Basic wrapper over `fetch()`.

### isValidRequest

When isValidRequest killswitch is enabled, all requests will throw an error.
You can dynamically enable and disable it at any time. The callback may return a
boolean or a `Promise<boolean>`; it is checked before a request, after response
headers, and after the response body has been buffered.

```ts
import { ftch } from 'micro-ftch';

let ENABLED = true;
const f = ftch(fetch, { isValidRequest: () => ENABLED });
f('http://localhost'); // ok
ENABLED = false;
f('http://localhost'); // throws
ENABLED = true;
f('http://localhost'); // ok
```

For immediate cancellation of active requests, use the one-shot signal killswitch. It also
blocks queued and future requests made through that wrapper; construct a new wrapper to re-enable
network access.

```ts
import { ftch } from 'micro-ftch';

const network = new AbortController();
const f = ftch(fetch, { killswitchSignal: network.signal });
const pending = f('https://example.com/slow');
network.abort(new Error('network disabled')); // aborts pending immediately
```

### allowedHosts

Declarative origin allowlist, kept under the `allowedHosts` option name for compatibility.
It is checked before `isValidRequest` and rejects relative URLs whose origin cannot be verified.
A bare hostname such as `example.com` means exactly `https://example.com:443`. A port means an
alternate HTTPS origin, such as `example.com:8443`. HTTP must be explicit, for example
`http://example.com` or `http://localhost:8080`. Paths, queries, credentials, and fragments are
not valid entries.

Absolute HTTP(S) redirects are followed by the wrapper itself, one hop at a time. This
lets every hop's downgrade policy and `isValidRequest` verdict—and, when configured,
its allowlisted origin—be checked _before_ its request is sent. Hops are capped at 20;
credentials, cookies, and common API-key headers do not survive cross-origin hops. Add custom
secret header names with `sensitiveHeaders`. Callers that pass `redirect: 'manual'`/`'error'`
keep their own semantics and get only an after-the-fact check of the response URL.

HTTPS-to-HTTP redirects are rejected before the HTTP request is sent, including when no
allowlist is configured. If a trusted endpoint genuinely requires a downgrade, opt in with
`allowInsecureRedirects: true`; when using `allowedHosts`, the exact HTTP landing origin must
also be listed.

```ts
import { ftch } from 'micro-ftch';

const f = ftch(fetch, {
  allowedHosts: ['rpc.example.com', 'rpc.example.com:8443', 'http://localhost:8545'],
  sensitiveHeaders: ['X-Project-Secret'],
});
f('https://rpc.example.com/'); // ok
f('https://rpc.example.com:8443/'); // ok
f('http://localhost:8545/'); // ok: HTTP was explicit
f('https://evil.com/'); // throws
```

`allowedHosts` is not a complete SSRF sandbox. It validates URL origins, but the fetch
implementation still performs DNS resolution. A permitted hostname can resolve or be rebound
to loopback, private, link-local, cloud-metadata, or other internal addresses. Enforce trusted
DNS resolution and network-level egress rules when requests cross a security boundary.

### log

The callback receives a shallow snapshot of the actual per-hop request options,
including method and header changes made while following redirects. The `Headers`
object is cloned so logger mutations do not alter the request.

```ts
import { ftch } from 'micro-ftch';

const f = ftch(fetch, { log: (url, opts) => console.log('fetching', url, opts) });
f('http://url/'); // will print request information
```

### timeout

```ts
import { ftch } from 'micro-ftch';

// browser and OS may have additional timeouts, we cannot override them
// a: per-request timeout
const f = ftch(fetch);
const res = await f('http://url/', { timeout: 1000 }); // throws if request takes more than one second

// b: timeout for all
const f2 = ftch(fetch, { timeout: 1000 });
const res2 = await f2('http://url/'); // throws if request takes more than one second
```

### concurrencyLimit

Allows to not accidentally hit rate limits or do DoS.

```ts
import { ftch } from 'micro-ftch';

// browser and OS may have additional limits, we cannot override them
const f = ftch(fetch, { concurrencyLimit: 1 });
const res = await Promise.all([f('http://url1/'), f('http://url2/')]); // these would be processed sequentially
```

### rps

Rate limit: at most this many requests start per second. Complements `concurrencyLimit`
(which caps in-flight requests, not request rate) for providers with per-second quotas.

```ts
import { ftch } from 'micro-ftch';

const f = ftch(fetch, { rps: 10 }); // request starts are spaced >= 100ms apart
```

### maxBodySize

Maximum response body size in bytes, 1 GiB by default. Since ftch buffers whole bodies,
an unbounded response is an OOM vector; oversized responses are aborted mid-transfer.
Pass `Infinity` to disable.

```ts
import { ftch } from 'micro-ftch';

const f = ftch(fetch, { maxBodySize: 10 * 1024 * 1024 }); // 10 MiB
```

### Basic auth

```ts
import { ftch } from 'micro-ftch';

const f = ftch(fetch);
const res = await f('https://user:pwd@httpbin.org/basic-auth/user/pwd'); // supports basic auth!
```

### jsonrpc

Supports batching multiple HTTP requests into one "Batched" JSON RPC HTTP request. Can massively speed-up when servers are single-threaded, has small per-user limits

```ts
import { jsonrpc } from 'micro-ftch';

const rpc = jsonrpc(fetch, 'http://rpc_node/', {
  headers: {},
  batchSize: 20,
});
const res = await rpc.call('method', 'arg0', 'arg1');
const res2 = await rpc.callNamed('method', { arg0: '0', arg1: '1' }); // named arguments
```

### replayable

Small utility to log & replay network requests in tests, without actually calling network code.

```ts
import { ftch as createFtch, replayable } from 'micro-ftch';

const ftch = createFtch(fetch);
const replayCapture = replayable(ftch); // wraps fetch
await replayCapture('http://url/1'); // real network
await replayCapture('http://url/2');
const logs = replayCapture.export(); // Exports logs

// When logs provided - use cached version (faster)
const replayTest = replayable(ftch, JSON.parse(logs));
await replayTest('http://url/1'); // cached
await replayTest('http://url/2'); // cached
await replayTest('http://url/3'); // real network

// When done and everything is captured, turn on 'offline' mode to throw on network requests:
const replayTestOffline = replayable(ftch, JSON.parse(logs), {
  offline: true,
});
await replayTestOffline('http://url/1'); // cached
await replayTestOffline('http://url/2'); // cached
await replayTestOffline('http://url/3'); // throws! (error names the closest logged request)
```

Captured entries record response metadata (`status`, `statusText`, `headers`) alongside the
body, so error handling can be replay-tested too. Old body-only log files still replay,
with default `200 OK` metadata. Binary bodies that don't survive a UTF-8 round-trip are
stored base64-encoded automatically; text bodies stay readable in exported logs.

Logs capture requests and responses verbatim, including any credentials or secrets they
contain, so treat exported fixtures as sensitive test artifacts.

### retry

Retries failed requests with exponential backoff, full jitter and `Retry-After` support.
The default policy only retries safe methods (GET/HEAD/OPTIONS) — retrying a POST can
duplicate a non-idempotent action — and only on thrown errors or status 408/429/5xx.
Non-ok responses that exhaust attempts are returned, not thrown, like fetch.

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

## Privacy

ftch() disables referrer by default by setting `referrerPolicy: 'no-referrer'`.

## License

MIT (c) Paul Miller [(https://paulmillr.com)](https://paulmillr.com), see LICENSE file.
