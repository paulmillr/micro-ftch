# micro-ftch

Wrappers for [built-in fetch()](https://developer.mozilla.org/en-US/docs/Web/API/fetch) enabling killswitch, logging, concurrency limit and other features.

fetch is great, however, its usage in secure environments is complicated. The library makes it simple.

## Usage

A standalone file
[micro-ftch.js](https://github.com/paulmillr/micro-ftch/releases) is also available.

> npm install micro-ftch

```ts
import { ftch, jsonrpc, replayable } from 'micro-ftch';

let enabled = false;
const net = ftch(fetch, {
  killswitch: () => enabled,
  log: (url, options) => console.log(url, options),
  timeout: 5000,
  concurrencyLimit: 10,
});
const result = await net('https://example.com');

net('https://user:pwd@httpbin.org/basic-auth/user/pwd'); // Basic auth

// Composable
const rpc = jsonrpc(net, 'http://rpc_node/', {
  headers: {},
  batchSize: 20,
});
const res1 = await rpc.call('method', 'arg0', 'arg1');
const res2 = await rpc.callNamed('method', { arg0: '0', arg1: '1' }); // named arguments

const testRpc = replayable(rpc);
```

- [ftch](#ftch)
  - [killswitch](#killswitch)
  - [log](#log)
  - [timeout](#timeout)
  - [concurrencyLimit](#concurrencyLimit)
  - [Basic auth](#basic-auth)
- [jsonrpc](#jsonrpc)
- [replayable](#replayable)
- [Privacy](#privacy)
- [License](#license)


There are three wrappers over `fetch()`:

1. `ftch(fetch)` - killswitch, logging, timeouts, concurrency limits, basic auth
2. `jsonrpc(fetch)` - batched JSON-RPC functionality
3. `replayable(fetch)` - log & replay network requests without actually calling network code.

## ftch

Basic wrapper over `fetch()`.

### killswitch

When kill-switch is enabled, all requests will throw an error.
You can dynamically enable and disable it any any time.

```ts
let ENABLED = true;
const f = ftch(fetch, { killswitch: () => ENABLED });
f('http://localhost'); // ok
ENABLED = false;
f('http://localhost'); // throws
ENABLED = true;
f('http://localhost'); // ok
```

### log

```ts
const f = ftch(fetch, { log: (url, opts) => console.log('fetching', url, opts) });
f('http://url/'); // will print request information
```

### timeout

```ts
// browser and OS may have additional timeouts, we cannot override them
// a: per-request timeout
const f = ftch(fetch);
const res = await f('http://url/', { timeout: 1000 }); // throws if request takes more than one second

// b: timeout for all
const f = ftch(fetch, { timeout: 1000 });
const res = await f('http://url/'); // throws if request takes more than one second
```

### concurrencyLimit

Allows to not accidentally hit rate limits or do DoS.

```ts
// browser and OS may have additional limits, we cannot override them
const f = ftch(fetch, { concurrencyLimit: 1 });
const res = await Promise.all([f('http://url1/'), f('http://url2/')]); // these would be processed sequentially
```

### Basic auth

```ts
const f = ftch(fetch);
const res = await f('https://user:pwd@httpbin.org/basic-auth/user/pwd'); // supports basic auth!
```

### jsonrpc

Supports batching multiple HTTP requests into one "Batched" JSON RPC HTTP request. Can massively speed-up when servers are single-threaded, has small per-user limits

```ts
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
const ftch = ftch(fetch);
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
await replayTest('http://url/1'); // cached
await replayTest('http://url/2'); // cached
await replayTest('http://url/3'); // throws!
```

## Privacy

ftch() disables referrer by default by setting `referrerPolicy: 'no-referrer'`.

## License

MIT (c) Paul Miller [(https://paulmillr.com)](https://paulmillr.com), see LICENSE file.
