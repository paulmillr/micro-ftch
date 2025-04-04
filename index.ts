/**
 * Wrappers for [built-in fetch()](https://developer.mozilla.org/en-US/docs/Web/API/fetch) enabling
 * killswitch, logging, concurrency limit and other features. fetch is great, however, its usage in secure environments is complicated. The library makes it simple.
 * @module
 * @example
```js
import { ftch, jsonrpc, replayable } from 'micro-ftch';

let enabled = false;
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
const testRpc = replayable(rpc);
// Basic auth auto-parsing
await net('https://user:pwd@httpbin.org/basic-auth/user/pwd');
```
 */

// Utils
// Awaiting for promise is equal to node nextTick
const nextTick = async () => {};
// Small internal primitive to limit concurrency
function limit(concurrencyLimit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let currentlyProcessing = 0;
  const queue: ((value?: unknown) => void)[] = [];
  const next = () => {
    if (!queue.length) return;
    if (currentlyProcessing >= concurrencyLimit) return;
    currentlyProcessing++;
    const first = queue.shift();
    if (!first) throw new Error('empty queue'); // should not happen
    first();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() =>
        Promise.resolve()
          .then(fn)
          .then(resolve)
          .catch(reject)
          .finally(() => {
            currentlyProcessing--;
            next();
          })
      );
      next();
    });
}

/** Arguments for built-in fetch, with added timeout method. */
export type FetchOpts = RequestInit & { timeout?: number };

/** Built-in fetch, or function conforming to its interface. */
export type FetchFn = (
  url: string,
  opts?: FetchOpts
) => Promise<{
  headers: Headers;
  ok: boolean;
  redirected: boolean;
  status: number;
  statusText: string;
  type: ResponseType;
  url: string;
  json: () => Promise<any>;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

/** Options for `ftch`. isValidRequest can disable fetching, while log will receive all requests. */
export type FtchOpts = {
  isValidRequest?: (url?: string) => boolean;
  killswitch?: (url?: string) => boolean;
  concurrencyLimit?: number;
  timeout?: number;
  log?: (url: string, opts: FetchOpts) => void;
};

type UnPromise<T> = T extends Promise<infer U> ? U : T;
// NOTE: we don't expose actual request to make sure there is no way to trigger actual network code
// from wrapped function
const getRequestInfo = (req: UnPromise<ReturnType<FetchFn>>) => ({
  headers: req.headers,
  ok: req.ok,
  redirected: req.redirected,
  status: req.status,
  statusText: req.statusText,
  type: req.type,
  url: req.url,
});

/**
 * Small wrapper over fetch function
 *
 * @param fn - The fetch function to be wrapped.
 * @param opts - Options to control the behavior of the fetch wrapper.
 * @param [opts.isValidRequest] - Function to determine if the fetch request should be cancelled.
 * @param [opts.concurrencyLimit] - Limit on the number of concurrent fetch requests.
 * @param [opts.timeout] - Default timeout for all requests, can be overriden in request opts
 * @param [opts.log] - Callback to log all requests
 * @returns Wrapped fetch function
 * @example
 * ```js
 * let ENABLED = true;
 * const f = ftch(fetch, { isValidRequest: () => ENABLED });
 * f('http://localhost'); // ok
 * ENABLED = false;
 * f('http://localhost'); // throws
 * ```
 * @example
 * ```js
 * const f = ftch(fetch, { concurrencyLimit: 1 });
 * const res = await Promise.all([f('http://url1/'), f('http://url2/')]); // these would be processed sequentially
 * ```
 * @example
 * ```js
 * const f = ftch(fetch);
 * const res = await f('http://url/', { timeout: 1000 }); // throws if request takes more than one second
 * ```
 * @example
 * ```js
 * const f = ftch(fetch, { timeout: 1000 }); // default timeout for all requests
 * const res = await f('http://url/'); // throws if request takes more than one second
 * ```
 * @example
 * ```js
 * const f = ftch(fetch);
 * const res = await f('https://user:pwd@httpbin.org/basic-auth/user/pwd'); // basic auth
 * ```
 * @example
 * ```js
 * const f = ftch(fetch, { log: (url, opts)=>console.log('NET', url, opts) })
 * f('http://url/'); // will print request information
 * ```
 */
export function ftch(fetchFunction: FetchFn, opts: FtchOpts = {}): FetchFn {
  const ks = opts.isValidRequest || opts.killswitch;
  if (ks && typeof ks !== 'function') throw new Error('opts.isValidRequest must be a function');
  const noNetwork = (url: string) => ks && !ks(url);
  const wrappedFetch: FetchFn = async (url, reqOpts = {}) => {
    const abort = new AbortController();
    let timeout = undefined;
    if (opts.timeout !== undefined || reqOpts.timeout !== undefined) {
      const ms = reqOpts.timeout !== undefined ? reqOpts.timeout : opts.timeout;
      timeout = setTimeout(() => abort.abort(), ms);
    }
    const headers = new Headers(); // We cannot re-use object from user since we may modify it
    const parsed = new URL(url);
    if (parsed.username) {
      const auth = btoa(`${parsed.username}:${parsed.password}`);
      headers.set('Authorization', `Basic ${auth}`);
      parsed.username = '';
      parsed.password = '';
      url = '' + parsed;
    }
    if (reqOpts.headers) {
      const h = reqOpts.headers instanceof Headers ? reqOpts.headers : new Headers(reqOpts.headers);
      h.forEach((v, k) => headers.set(k, v));
    }
    if (noNetwork(url)) throw new Error('network disabled');
    if (opts.log) opts.log(url, reqOpts);
    const res = await fetchFunction(url, {
      referrerPolicy: 'no-referrer', // avoid sending referrer by default
      ...reqOpts,
      headers,
      signal: abort.signal,
    });
    if (noNetwork(url)) {
      abort.abort('network disabled');
      throw new Error('network disabled');
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (timeout !== undefined) clearTimeout(timeout);
    return {
      ...getRequestInfo(res),
      // NOTE: this disables streaming parser and fetches whole body on request (instead of headers only as done in fetch)
      // But this allows to intercept and disable request if killswitch enabled. Also required for concurrency limit,
      // since actual request is not finished
      json: async () => JSON.parse(new TextDecoder().decode(body)),
      text: async () => new TextDecoder().decode(body),
      arrayBuffer: async () => body.buffer,
    };
  };
  if (opts.concurrencyLimit !== undefined) {
    const curLimit = limit(opts.concurrencyLimit!);
    return (url, reqOpts) => curLimit(() => wrappedFetch(url, reqOpts));
  }
  return wrappedFetch;
}

// Jsonrpc
type PromiseCb<T> = {
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
};

export type JsonrpcInterface = {
  call: (method: string, ...args: any[]) => Promise<any>;
  callNamed: (method: string, args: Record<string, any>) => Promise<any>;
};

type NetworkOpts = {
  batchSize?: number;
  headers?: Record<string, string>;
};

type RpcParams = any[] | Record<string, any>;
type RpcErrorResponse = { code: number; message: string };

export class RpcError extends Error {
  readonly code: number;
  constructor(error: RpcErrorResponse) {
    super(`FetchProvider(${error.code}): ${error.message || error}`);
    this.code = error.code;
    this.name = 'RpcError';
  }
}

/**
 * Small utility class for Jsonrpc
 * @param fetchFunction - The fetch function
 * @param url - The RPC server url
 * @param opts - Options to control the behavior of RPC client
 * @param [opts.headers] - additional headers to send with requests
 * @param [opts.batchSize] - batch parallel requests up to this value into single request
 * @example
 * ```js
 * const rpc = new JsonrpcProvider(fetch, 'http://rpc_node/', { headers: {}, batchSize: 20 });
 * const res = await rpc.call('method', 'arg0', 'arg1');
 * const res2 = await rpc.callNamed('method', {arg0: '0', arg1: '1'}); // named arguments
 * ```
 */
export class JsonrpcProvider implements JsonrpcInterface {
  private batchSize: number;
  private headers: Record<string, string>;
  private queue: ({ method: string; params: RpcParams } & PromiseCb<any>)[] = [];
  private fetchFunction: FetchFn;
  readonly rpcUrl: string;
  constructor(fetchFunction: FetchFn, rpcUrl: string, options: NetworkOpts = {}) {
    if (typeof fetchFunction !== 'function') throw new Error('fetchFunction is required');
    if (typeof rpcUrl !== 'string') throw new Error('rpcUrl is required');
    this.fetchFunction = fetchFunction;
    this.rpcUrl = rpcUrl;
    this.batchSize = options.batchSize === undefined ? 1 : options.batchSize;
    this.headers = options.headers || {};
    if (typeof this.headers !== 'object') throw new Error('invalid headers: expected object');
  }
  private async fetchJson(body: unknown) {
    const res = await this.fetchFunction(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: JSON.stringify(body),
    });
    return await res.json();
  }
  private jsonError(error: RpcErrorResponse) {
    return new RpcError(error);
  }
  private async batchProcess() {
    await nextTick(); // this allows to collect as much requests as we can in single tick
    const curr = this.queue.splice(0, this.batchSize);
    if (!curr.length) return;
    const json = await this.fetchJson(
      curr.map((i, j) => ({
        jsonrpc: '2.0',
        id: j,
        method: i.method,
        params: i.params,
      }))
    );
    if (!Array.isArray(json)) {
      const hasMsg = json.code && json.message;
      curr.forEach((req, index) => {
        const err = hasMsg
          ? this.jsonError(json)
          : new Error('invalid response in batch request ' + index);
        req.reject(err);
      });
      return;
    }
    const processed = new Set();
    for (const res of json) {
      // Server sent broken ids. We cannot throw error here, since we will have unresolved promises
      // Also, this will break app state.
      if (!Number.isSafeInteger(res.id) || res.id < 0 || res.id >= curr.length) continue;
      if (processed.has(res.id)) continue; // multiple responses for same id
      const { reject, resolve } = curr[res.id];
      processed.add(res.id);
      if (res && res.error) reject(this.jsonError(res.error));
      else resolve(res.result);
    }
    for (let i = 0; i < curr.length; i++) {
      if (!processed.has(i)) curr[i].reject(new Error(`response missing in batch request ` + i));
    }
  }
  private rpcBatch(method: string, params: RpcParams) {
    return new Promise((resolve, reject) => {
      this.queue.push({ method, params, resolve, reject });
      this.batchProcess(); // this processed in parallel
    });
  }
  private async rpc(method: string, params: RpcParams): Promise<any> {
    if (typeof method !== 'string') throw new Error('rpc method name must be a string');
    if (this.batchSize > 1) return this.rpcBatch(method, params);
    const json = await this.fetchJson({
      jsonrpc: '2.0',
      id: 0,
      method,
      params,
    });
    if (json && json.error) throw this.jsonError(json.error);
    return json.result;
  }
  call(method: string, ...args: any[]): Promise<any> {
    return this.rpc(method, args);
  }
  callNamed(method: string, params: Record<string, any>): Promise<any> {
    return this.rpc(method, params);
  }
}

/**
 * Batched JSON-RPC functionality.
 * @example
```js
const rpc = jsonrpc(fetch, 'http://rpc_node/', {
  headers: {},
  batchSize: 20,
});
const res = await rpc.call('method', 'arg0', 'arg1');
const res2 = await rpc.callNamed('method', { arg0: '0', arg1: '1' }); // named arguments
```
 */
export function jsonrpc(
  fetchFunction: FetchFn,
  rpcUrl: string,
  options: NetworkOpts = {}
): JsonrpcProvider {
  return new JsonrpcProvider(fetchFunction, rpcUrl, options);
}

type GetKeyFn = (url: string, opt: FetchOpts) => string;
const defaultGetKey: GetKeyFn = (url, opt) => JSON.stringify({ url, opt });

/** Options for replayable() */
export type ReplayOpts = {
  offline?: boolean; // throw on non-logged requests
  getKey?: GetKeyFn;
};

/** replayable() return function, additional methods */
export type ReplayFn = FetchFn & {
  logs: Record<string, any>;
  accessed: Set<string>;
  export: () => string;
};

function normalizeHeader(header: string): string {
  return header
    .split('-')
    .map((i) => i.charAt(0).toUpperCase() + i.slice(1).toLowerCase())
    .join('-');
}

const getKey = (url: string, opts: FetchOpts, fn = defaultGetKey) => {
  let headers = opts.headers || {};
  if (headers instanceof Headers) {
    const tmp: Record<string, string> = {};
    // Headers is lowercase
    headers.forEach((v, k) => {
      tmp[normalizeHeader(k)] = v;
    });
    headers = tmp;
  }
  return fn(url, { method: opts.method, headers, body: opts.body });
};

/**
 * Log & replay network requests without actually calling network code.
 * @param fetchFunction
 * @param logs - captured logs (JSON.parse(fetchReplay(...).export()))
 * @param opts
 * @param [opts.offline] - Offline mode, throws on non-captured requests
 * @param [opts.getKey] - Optional function to modify key information for capture/replay of requests
 * @example
 * ```js
 * // Capture logs
 * const ftch = ftch(fetch);
 * const replayCapture = replayable(ftch); // wraps fetch
 * await replayCapture('http://url/1');
 * const logs = replayCapture.export(); // Exports logs
 * ```
 * @example
 * ```js
 * // Replay logs
 * const replayTest = replayable(ftch, JSON.parse(logs));
 * await replayTest('http://url/1'); // cached
 * await replayTest('http://url/2'); // real network
 * ```
 * @example
 * ```js
 * // Offline mode
 * const replayTestOffline = replayable(ftch, JSON.parse(logs), { offline: true });
 * await replayTest('http://url/1'); // cached
 * await replayTest('http://url/2'); // throws!
 * ```
 * @example
 * ```js
 * // Custom log key function
 * const getKey = (url, opt) => JSON.stringify({ url: 'https://NODE_URL/', opt }); // use same url for any request
 * const replayCapture = replayable(ftch, {}, { getKey });
 * ```
 */
export function replayable(
  fetchFunction: FetchFn,
  logs: Record<string, string> = {},
  opts: ReplayOpts = {}
): ReplayFn {
  const accessed: Set<string> = new Set();
  const wrapped = async (url: string, reqOpts: any) => {
    const key = getKey(url, reqOpts, opts.getKey);
    accessed.add(key);
    if (!logs[key]) {
      if (opts.offline) throw new Error(`fetchReplay: unknown request=${key}`);
      const req = await fetchFunction(url, reqOpts);
      // TODO: save this too?
      const info = getRequestInfo(req);
      return {
        ...info,
        json: async () => {
          const json = await req.json();
          logs[key] = JSON.stringify(json);
          return json;
        },
        text: async () => (logs[key] = await req.text()),
        arrayBuffer: async () => {
          const buffer = await req.arrayBuffer();
          logs[key] = new TextDecoder().decode(new Uint8Array(buffer));
          return buffer;
        },
      };
    }
    return {
      // Some default values (we don't store this info for now)
      headers: new Headers(),
      ok: true,
      redirected: false,
      status: 200,
      statusText: 'OK',
      type: 'basic' as ResponseType,
      url: url,
      text: async () => logs[key],
      json: async () => JSON.parse(logs[key]),
      arrayBuffer: async () => new TextEncoder().encode(logs[key]).buffer,
    };
  };
  wrapped.logs = logs;
  wrapped.accessed = accessed;
  wrapped.export = () =>
    JSON.stringify(Object.fromEntries(Object.entries(logs).filter(([k, _]) => accessed.has(k))));
  return wrapped;
}

/** Internal methods for test purposes only. */
export const _TEST: {
  limit: typeof limit;
} = {
  limit,
};
