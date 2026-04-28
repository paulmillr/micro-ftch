/**
 * Wrappers for {@link https://developer.mozilla.org/en-US/docs/Web/API/fetch | built-in fetch()}
 * enabling killswitch, logging, concurrency limit, and other features. Fetch is great, but its
 * usage in secure environments is complicated. The library makes it simple.
 * @module
 * @example
 * Wrap fetch once, then compose JSON-RPC batching and replay support on top.
 * ```js
 * import { ftch, jsonrpc, replayable } from 'micro-ftch';
 *
 * let enabled = true;
 * const events = [];
 * const net = ftch(fetch, {
 *   isValidRequest: () => enabled,
 *   log: (url, options) => events.push({ url, method: options.method }),
 *   timeout: 5000,
 *   concurrencyLimit: 10,
 * });
 * const res = await net('https://example.com');
 *
 * const rpc = jsonrpc(net, 'http://rpc_node/', {
 *   headers: {},
 *   batchSize: 20,
 * });
 * const res1 = await rpc.call('method', 'arg0', 'arg1');
 * const res2 = await rpc.callNamed('method', { arg0: '0', arg1: '1' });
 *
 * const replayNet = replayable(net);
 * const replayRpc = jsonrpc(replayNet, 'http://rpc_node/', {
 *   headers: {},
 *   batchSize: 20,
 * });
 * const replayRes = await replayRpc.call('method', 'arg0', 'arg1');
 *
 * await net('https://user:pwd@httpbin.org/basic-auth/user/pwd');
 * ```
 */

// Utils
// Awaiting for promise is equal to node nextTick
const nextTick = async () => {};
// Small internal primitive to limit concurrency
function limit(concurrencyLimit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  // Non-positive limits cannot start queued work and would leave callers pending.
  if (concurrencyLimit <= 0)
    throw new Error(`expected concurrencyLimit > 0, got ${concurrencyLimit}`);
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

/** Arguments for built-in fetch, with added timeout support. */
export type FetchOpts = RequestInit & {
  /** Abort the request after this many milliseconds. */
  timeout?: number;
};

/**
 * Built-in fetch, or function conforming to its interface.
 * Shared by `ftch`, `jsonrpc`, and `replayable`.
 */
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

/** Options for `ftch`. */
export type FtchOpts = {
  /**
   * Returns `false` to block a request before or after it runs.
   * @param url - Request URL about to be fetched.
   * @returns `true` when the request should be allowed.
   */
  isValidRequest?: (url?: string) => boolean;
  /**
   * Alias for `isValidRequest`.
   * @param url - Request URL about to be fetched.
   * @returns `true` when the request should be allowed.
   */
  killswitch?: (url?: string) => boolean;
  /** Maximum number of wrapped requests allowed to run at once. */
  concurrencyLimit?: number;
  /** Default timeout in milliseconds for wrapped requests. */
  timeout?: number;
  /**
   * Observes every request before it is sent.
   * @param url - Request URL.
   * @param opts - Request options passed to the wrapped fetch. See {@link FetchOpts}.
   */
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
 * @param fetchFunction - Fetch implementation to wrap.
 * @param opts - Wrapper configuration like timeout, killswitch, and logging. See {@link FtchOpts}.
 * @returns Wrapped fetch function with timeout, auth parsing, and optional request gating.
 * @throws If the killswitch hook is invalid or a wrapped request is blocked by the network policy. {@link Error}
 * @example
 * Add a simple network killswitch around an existing fetch implementation.
 * ```js
 * import { ftch } from 'micro-ftch';
 * let enabled = true;
 * const net = ftch(fetch, { isValidRequest: () => enabled });
 * await net('https://example.com');
 * enabled = false;
 * ```
 * @example
 * Force wrapped requests to run one at a time.
 * ```js
 * import { ftch } from 'micro-ftch';
 * const net = ftch(fetch, { concurrencyLimit: 1 });
 * await Promise.all([net('https://example.com/1'), net('https://example.com/2')]);
 * ```
 * @example
 * Apply the same timeout to every request made through the wrapper.
 * ```js
 * import { ftch } from 'micro-ftch';
 * const net = ftch(fetch, { timeout: 1000 });
 * await net('https://example.com');
 * ```
 * @example
 * Capture a structured request log without changing the call sites.
 * ```js
 * import { ftch } from 'micro-ftch';
 * const events = [];
 * const net = ftch(fetch, {
 *   log: (url, options) => events.push({ url, method: options.method }),
 * });
 * await net('https://example.com');
 * ```
 * @example
 * User info in the URL becomes the Authorization header automatically.
 * ```js
 * import { ftch } from 'micro-ftch';
 * const net = ftch(fetch);
 * await net('https://user:pwd@example.com/private');
 * ```
 */
export function ftch(fetchFunction: FetchFn, opts: FtchOpts = {}): FetchFn {
  const ks = opts.isValidRequest || opts.killswitch;
  if (ks && typeof ks !== 'function') throw new Error('opts.isValidRequest must be a function');
  const noNetwork = (url: string) => ks && !ks(url);
  const wrappedFetch: FetchFn = async (url, reqOpts = {}) => {
    const abort = new AbortController();
    const callerSignal = reqOpts.signal;
    let cleanupCallerSignal = () => {};
    if (callerSignal) {
      // Keep one internal signal for timeout and late killswitch aborts, while preserving caller aborts.
      const abortCaller = () => abort.abort(callerSignal.reason);
      if (callerSignal.aborted) abortCaller();
      else {
        callerSignal.addEventListener('abort', abortCaller, { once: true });
        cleanupCallerSignal = () => callerSignal.removeEventListener('abort', abortCaller);
      }
    }
    let timeout = undefined;
    if (opts.timeout !== undefined || reqOpts.timeout !== undefined) {
      const ms = reqOpts.timeout !== undefined ? reqOpts.timeout : opts.timeout;
      timeout = setTimeout(() => abort.abort(), ms);
    }
    const headers = new Headers(); // We cannot re-use object from user since we may modify it
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      // RFC 7617 §2 builds `user-pass` as user-id ":" password; RFC 3986 §3.2.1 deprecates user:password in URI userinfo, so strip it after converting.
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
    try {
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
      return {
        ...getRequestInfo(res),
        // NOTE: this disables streaming parser and fetches whole body on request (instead of headers only as done in fetch)
        // But this allows to intercept and disable request if killswitch enabled. Also required for concurrency limit,
        // since actual request is not finished
        json: async () => JSON.parse(new TextDecoder().decode(body)),
        text: async () => new TextDecoder().decode(body),
        arrayBuffer: async () => body.buffer,
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      cleanupCallerSignal();
    }
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

/** Minimal JSON-RPC client interface. */
export type JsonrpcInterface = {
  /**
   * Calls a JSON-RPC method with positional parameters.
   * @param method - JSON-RPC method name.
   * @param args - Positional JSON-RPC params.
   * @returns Decoded JSON-RPC result.
   */
  call: (method: string, ...args: any[]) => Promise<any>;
  /**
   * Calls a JSON-RPC method with named parameters.
   * @param method - JSON-RPC method name.
   * @param args - Named JSON-RPC params.
   * @returns Decoded JSON-RPC result.
   */
  callNamed: (method: string, args: Record<string, any>) => Promise<any>;
};

type NetworkOpts = {
  batchSize?: number;
  headers?: Record<string, string>;
};

type RpcParams = any[] | Record<string, any>;
type RpcErrorResponse = { code: number; message: string };

/**
 * JSON-RPC server error wrapper.
 * @param error - JSON-RPC error payload.
 * @example
 * Inspect the JSON-RPC error code and message from a failed response.
 * ```js
 * import { RpcError } from 'micro-ftch';
 * const err = new RpcError({ code: -32000, message: 'oops' });
 * console.log(err.code, err.message);
 * ```
 */
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
 * @param fetchFunction - Fetch implementation used for transport.
 * @param rpcUrl - JSON-RPC endpoint URL.
 * @param options - Batching and header configuration. See {@link NetworkOpts}.
 * @example
 * Create a batched JSON-RPC client and call it with positional and named params.
 * ```js
 * import { JsonrpcProvider } from 'micro-ftch';
 * const rpc = new JsonrpcProvider(fetch, 'http://rpc_node/', {
 *   headers: {},
 *   batchSize: 20,
 * });
 * const res = await rpc.call('method', 'arg0', 'arg1');
 * const res2 = await rpc.callNamed('method', { arg0: '0', arg1: '1' });
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
    // Transport failures must reject every queued request; otherwise the batch leaks pending callers.
    let json;
    try {
      json = await this.fetchJson(
        curr.map((i, j) => ({
          jsonrpc: '2.0',
          id: j,
          method: i.method,
          params: i.params,
        }))
      );
    } catch (err) {
      curr.forEach((req) => req.reject(err));
      return;
    }
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
 * @param fetchFunction - Fetch implementation used for transport.
 * @param rpcUrl - JSON-RPC endpoint URL.
 * @param options - Batching and header configuration. See {@link NetworkOpts}.
 * @returns Configured JSON-RPC provider.
 * @example
 * Create a batched JSON-RPC helper.
 * ```js
 * import { jsonrpc } from 'micro-ftch';
 * const rpc = jsonrpc(fetch, 'http://rpc_node/', {
 *   headers: {},
 *   batchSize: 20,
 * });
 * const res = await rpc.call('method', 'arg0', 'arg1');
 * const res2 = await rpc.callNamed('method', { arg0: '0', arg1: '1' });
 * ```
 */
export function jsonrpc(
  fetchFunction: FetchFn,
  rpcUrl: string,
  options: NetworkOpts = {}
): JsonrpcProvider {
  return new JsonrpcProvider(fetchFunction, rpcUrl, options);
}

/**
 * Builds a replay bucket key from the request URL and fetch options.
 * @param url - Request URL.
 * @param opt - Fetch options used for the request.
 * @returns Stable string key used for capture and replay.
 */
type GetKeyFn = (url: string, opt: FetchOpts) => string;
const defaultGetKey: GetKeyFn = (url, opt) => JSON.stringify({ url, opt });

/** Options for replayable(). */
export type ReplayOpts = {
  /** Throw instead of using the wrapped fetch when a request is missing from the log. */
  offline?: boolean;
  /** Custom request-key function used for capture and replay. */
  getKey?: GetKeyFn;
};

/** replayable() return function, with additional logging helpers. */
export type ReplayFn = FetchFn & {
  /** Captured request/response payloads keyed by the replay fingerprint. */
  logs: Record<string, any>;
  /** Keys that have been read or written through this replay wrapper. */
  accessed: Set<string>;
  /**
   * Exports only the log entries touched through this wrapper.
   * @returns JSON string that can seed another `replayable()` instance.
   */
  export: () => string;
};

function normalizeHeader(header: string): string {
  return header
    .split('-')
    .map((i) => i.charAt(0).toUpperCase() + i.slice(1).toLowerCase())
    .join('-');
}

const getKey = (url: string, opts: FetchOpts, fn = defaultGetKey) => {
  // RFC 9110 §5.1: field names are case-insensitive, so replay keys need canonicalized header names.
  const headers: Record<string, string> = {};
  // Headers accepts every HeadersInit shape and normalizes duplicate handling like fetch.
  new Headers(opts.headers).forEach((v, k) => {
    headers[normalizeHeader(k)] = v;
  });
  return fn(url, { method: opts.method, headers, body: opts.body });
};

/**
 * Log & replay network requests without actually calling network code.
 * @param fetchFunction - Wrapped fetch implementation used to capture new responses.
 * @param logs - Captured request/response map, usually from `JSON.parse(replay.export())`.
 * @param opts - Replay configuration such as offline mode or custom keying. See {@link ReplayOpts}.
 * @returns Fetch-compatible wrapper with log export helpers.
 * @example
 * Record live responses once, then export the captured log.
 * ```js
 * import { ftch as createFtch, replayable } from 'micro-ftch';
 * const ftch = createFtch(fetch);
 * const replayCapture = replayable(ftch);
 * await replayCapture('https://example.com/1');
 * await replayCapture('https://example.com/2');
 * const logs = replayCapture.export();
 * ```
 * @example
 * Replay cached responses from a previously exported log snapshot.
 * ```js
 * import { ftch as createFtch, replayable } from 'micro-ftch';
 * const ftch = createFtch(fetch);
 * const logs = { '{"method":"GET"}': '{"ok":true}' };
 * const replay = replayable(ftch, logs, {
 *   offline: true,
 *   getKey: (_url, opt = {}) => JSON.stringify({ method: opt.method || 'GET' }),
 * });
 * await replay('https://example.com/1');
 * ```
 * @example
 * Offline mode throws instead of making a new request.
 * ```js
 * import { ftch as createFtch, replayable } from 'micro-ftch';
 * const ftch = createFtch(fetch);
 * const logs = { '{"url":"https://example.com/1","opt":{"headers":{}}}': '{"ok":true}' };
 * const replayTestOffline = replayable(ftch, logs, { offline: true });
 * await replayTestOffline('https://example.com/1');
 * ```
 * @example
 * Collapse multiple URLs into one replay bucket when the HTTP method is what matters.
 * ```ts
 * import { ftch as createFtch, replayable, type FetchOpts } from 'micro-ftch';
 * const ftch = createFtch(fetch);
 * const getKey = (_url: string, opt: FetchOpts = {}) =>
 *   JSON.stringify({ method: opt.method || 'GET' });
 * const replay = replayable(
 *   ftch,
 *   { '{"method":"GET"}': '{"ok":true}' },
 *   { getKey, offline: true }
 * );
 * await replay('https://example.com/1', { method: 'GET' });
 * ```
 */
export function replayable(
  fetchFunction: FetchFn,
  logs: Record<string, string> = {},
  opts: ReplayOpts = {}
): ReplayFn {
  const accessed: Set<string> = new Set();
  const wrapped = async (url: string, reqOpts: FetchOpts = {}) => {
    const key = getKey(url, reqOpts, opts.getKey);
    accessed.add(key);
    // Empty-string payloads are valid captures; missing entries must be checked by key presence, not truthiness.
    if (!(key in logs)) {
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
          // TODO: add opt-in binary-safe replay; default logs stay readable text for existing fixtures.
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
} = /* @__PURE__ */ Object.freeze({
  limit,
});
