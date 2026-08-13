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
async function nextTick(): Promise<void> {}
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
const DEFAULT_SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
] as const;
function validateStringList(value: unknown, name: string): asserts value is string[] | undefined {
  if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== 'string')))
    throw new Error(`${name} must be an array of strings`);
}
function validateTimeout(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0)
    throw new Error(`expected timeout to be a finite non-negative number, got ${ms}`);
}
// btoa/atob are Latin-1 only: convert through raw bytes, chunked to avoid arg-spread limits.
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
// Small internal primitive to limit concurrency
function limit(concurrencyLimit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  // Non-positive limits cannot start queued work and would leave callers pending.
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit <= 0)
    throw new Error(`expected concurrencyLimit > 0, got ${concurrencyLimit}`);
  let currentlyProcessing = 0;
  const queue: ((value?: unknown) => void)[] = [];
  function next(): void {
    if (!queue.length) return;
    if (currentlyProcessing >= concurrencyLimit) return;
    currentlyProcessing++;
    const first = queue.shift();
    if (!first) throw new Error('empty queue'); // should not happen
    first();
  }
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
// Small internal primitive to space out starts: at most `rps` calls begin per second.
function rateLimit(rps: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isFinite(rps) || rps <= 0) throw new Error(`expected rps > 0, got ${rps}`);
  const interval = 1000 / rps;
  let nextStart = 0;
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const start = Math.max(nextStart, now);
    nextStart = start + interval;
    if (start > now) await sleep(start - now);
    return fn();
  };
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
  /**
   * Optional raw body stream (present on real fetch Responses).
   * When available, `ftch` uses it to enforce `maxBodySize` without buffering first.
   */
  body?: ReadableStream<Uint8Array> | null;
}>;

/** Options for `ftch`. */
export type FtchOpts = {
  /**
   * Returns (or resolves to) `false` to block a request before or after it runs.
   * @param url - Request URL about to be fetched.
   * @returns `true` when the request should be allowed.
   */
  isValidRequest?: (url?: string) => boolean | Promise<boolean>;
  /**
   * Alias for `isValidRequest`.
   * @param url - Request URL about to be fetched.
   * @returns `true` when the request should be allowed.
   */
  killswitch?: (url?: string) => boolean | Promise<boolean>;
  /**
   * One-shot network killswitch. Aborting the signal immediately aborts active requests and
   * blocks queued and future requests made by this wrapper. Create a new wrapper to re-enable it.
   */
  killswitchSignal?: AbortSignal;
  /**
   * Only allow requests to these exact origins. A hostname entry (`example.com`) defaults to
   * HTTPS on port 443. Include a port (`example.com:8443`) to permit another HTTPS port, or
   * include a scheme (`http://example.com:8080`) to explicitly permit HTTP. Matching is
   * case-insensitive. Checked before `isValidRequest` and rejects relative URLs.
   * Absolute HTTP(S) redirects are followed by the wrapper itself (unless the caller passes
   * `redirect: 'manual'` or `'error'`), one hop at a time, with every hop's origin and
   * `isValidRequest` verdict checked BEFORE its request is sent. Cross-origin hops drop
   * `Authorization`, `Cookie`, and `Proxy-Authorization` headers. Capped at 20 hops, like fetch.
   * This validates URL origins, not resolved IP addresses, and is not a complete SSRF sandbox;
   * use trusted DNS resolution and network-level egress controls across a security boundary.
   */
  allowedHosts?: string[];
  /**
   * Permit HTTPS-to-HTTP redirects. Default: `false`. The HTTP landing origin must still be
   * present in `allowedHosts` when an allowlist is configured.
   */
  allowInsecureRedirects?: boolean;
  /** Additional request headers to strip on cross-origin redirects. */
  sensitiveHeaders?: string[];
  /** Maximum number of wrapped requests allowed to run at once. */
  concurrencyLimit?: number;
  /** Maximum request starts per second. */
  rps?: number;
  /**
   * Maximum response body size in bytes; oversized responses are aborted.
   * Default: 1 GiB. Pass `Infinity` to disable.
   */
  maxBodySize?: number;
  /** Default finite, non-negative timeout in milliseconds for wrapped requests. */
  timeout?: number;
  /**
   * Observes every request before it is sent. Receives a shallow snapshot of the actual
   * per-hop options, including redirect rewrites, with a cloned `Headers` object.
   * @param url - Request URL.
   * @param opts - Request options passed to the wrapped fetch. See {@link FetchOpts}.
   */
  log?: (url: string, opts: FetchOpts) => void;
};

type UnPromise<T> = T extends Promise<infer U> ? U : T;
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort = () => {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    function aborted(): void {
      onAbort();
      reject(signal.reason ?? new Error('request aborted'));
    }
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
// Forwards aborts from `source` into `abort`, returning a cleanup function.
function linkAbort(source: AbortSignal | null | undefined, abort: AbortController): () => void {
  if (!source) return () => {};
  const signal = source;
  function forward(): void {
    abort.abort(signal.reason);
  }
  if (signal.aborted) {
    forward();
    return () => {};
  }
  signal.addEventListener('abort', forward, { once: true });
  return () => signal.removeEventListener('abort', forward);
}
// NOTE: we don't expose actual request to make sure there is no way to trigger actual network code
// from wrapped function
// ftch buffers whole bodies by design (see NOTE in ftch), which makes an unbounded response an
// OOM vector: enforce the cap while reading. Content-Length is a fast reject for honest servers;
// streaming catches liars; the arrayBuffer fallback for non-stream FetchFns can only check
// after the fact.
async function readBodyLimited(
  req: UnPromise<ReturnType<FetchFn>>,
  maxBodySize: number,
  abort: AbortController
): Promise<Uint8Array<ArrayBuffer>> {
  function tooBig(): Error {
    abort.abort('maxBodySize exceeded');
    return new Error(`response body exceeds maxBodySize=${maxBodySize}`);
  }
  const len = req.headers.get('content-length');
  if (len !== null && Number(len) > maxBodySize) throw tooBig();
  const stream = req.body;
  if (stream != null && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), abort.signal, () => {
        reader.cancel(abort.signal.reason).catch(() => {});
      });
      if (done) break;
      total += value.length;
      if (total > maxBodySize) {
        reader.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return body;
  }
  const body = new Uint8Array(await raceAbort(req.arrayBuffer(), abort.signal));
  if (body.length > maxBodySize) throw tooBig();
  return body;
}

function getRequestInfo(req: UnPromise<ReturnType<FetchFn>>) {
  return {
    headers: req.headers,
    ok: req.ok,
    redirected: req.redirected,
    status: req.status,
    statusText: req.statusText,
    type: req.type,
    url: req.url,
  };
}

// Normalizes `allowedHosts` entries into exact origins, rejecting anything that is not a
// bare http(s) origin. URL.origin normalizes case, IDNs, IPv6, and explicit default ports.
function parseAllowedOrigins(hosts: string[] | undefined): string[] | undefined {
  return hosts?.map((host) => {
    function invalid(): Error {
      return new Error('allowedHosts: invalid host entry: ' + host);
    }
    if (host.length === 0 || host.trim() !== host) throw invalid();
    let parsed: URL;
    try {
      const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(host);
      if (!hasScheme && /[\\/?#@]/.test(host)) throw new Error('invalid host');
      parsed = new URL(hasScheme ? host : 'https://' + host);
    } catch {
      throw invalid();
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.href !== parsed.origin + '/'
    )
      throw invalid();
    return parsed.origin;
  });
}

// Header names stripped from requests on cross-origin redirect hops.
function sensitiveHeaderSet(extra: string[] | undefined): Set<string> {
  const set = new Set<string>(DEFAULT_SENSITIVE_HEADERS);
  for (const name of extra || []) {
    // Let the platform enforce the Fetch header-name grammar at construction time.
    for (const normalized of new Headers([[name, '']]).keys()) set.add(normalized);
  }
  return set;
}

// RFC 7617 §2 builds `user-pass` as user-id ":" password; RFC 3986 §3.2.1 deprecates
// user:password in URI userinfo, so callers convert it to this header and strip it.
// URL exposes userinfo percent-encoded, and credentials may be non-Latin-1: decode,
// then base64 the UTF-8 bytes.
function basicAuthFromUrl(parsed: URL): string {
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);
  return 'Basic ' + bytesToBase64(new TextEncoder().encode(`${user}:${pass}`));
}

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
  if (opts.isValidRequest !== undefined && typeof opts.isValidRequest !== 'function')
    throw new Error('opts.isValidRequest must be a function');
  if (opts.killswitch !== undefined && typeof opts.killswitch !== 'function')
    throw new Error('opts.killswitch must be a function');
  const killswitchSignal = opts.killswitchSignal;
  if (
    killswitchSignal !== undefined &&
    (typeof killswitchSignal.aborted !== 'boolean' ||
      typeof killswitchSignal.addEventListener !== 'function' ||
      typeof killswitchSignal.removeEventListener !== 'function')
  )
    throw new Error('opts.killswitchSignal must be an AbortSignal');
  if (opts.allowInsecureRedirects !== undefined && typeof opts.allowInsecureRedirects !== 'boolean')
    throw new Error('opts.allowInsecureRedirects must be a boolean');
  validateStringList(opts.sensitiveHeaders, 'opts.sensitiveHeaders');
  validateStringList(opts.allowedHosts, 'opts.allowedHosts');
  const redirectSensitiveHeaders = sensitiveHeaderSet(opts.sensitiveHeaders);
  const origins = parseAllowedOrigins(opts.allowedHosts);
  const maxBodySize = opts.maxBodySize === undefined ? 1024 ** 3 : opts.maxBodySize;
  if (!(maxBodySize > 0)) throw new Error(`expected maxBodySize > 0, got ${maxBodySize}`);
  if (opts.timeout !== undefined) validateTimeout(opts.timeout);

  const ks = opts.isValidRequest ?? opts.killswitch;
  // The signal is re-checked after the hook: a killswitch aborted during the await must win.
  async function noNetwork(url: string): Promise<boolean> {
    if (killswitchSignal?.aborted) return true;
    if (ks !== undefined && !(await ks(url))) return true;
    return killswitchSignal?.aborted === true;
  }
  // Checked before isValidRequest: the declarative allowlist must not be bypassable by hook logic.
  function checkHost(parsed: URL | undefined, url: string): void {
    if (origins === undefined) return;
    if (parsed === undefined)
      throw new Error('allowedHosts: cannot verify host of relative URL: ' + url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error('allowedHosts: scheme not allowed: ' + parsed.protocol);
    if (!origins.includes(parsed.origin))
      throw new Error(
        `allowedHosts: host not allowed: ${parsed.host}; exact origin not allowed: ${parsed.origin}`
      );
  }
  // Policy every redirect target must pass, whether announced via a Location header
  // (checked before the hop is sent) or via a non-conforming FetchFn's response URL.
  function checkRedirectTarget(from: URL, to: URL, toUrl: string): void {
    if (to.protocol !== 'http:' && to.protocol !== 'https:')
      throw new Error('redirect: scheme not allowed: ' + to.protocol);
    if (
      from.protocol === 'https:' &&
      to.protocol === 'http:' &&
      opts.allowInsecureRedirects !== true
    )
      throw new Error('redirect: HTTPS to HTTP downgrade not allowed: ' + toUrl);
  }
  // Belt and braces for non-conforming FetchFn implementations that ignore
  // `redirect: 'manual'`: validate the reported URL before hooks or body reads.
  function checkResponseUrl(current: URL, reportedUrl: string, abort: AbortController): void {
    let finalUrl: URL;
    try {
      finalUrl = new URL(reportedUrl);
    } catch {
      abort.abort('invalid response URL');
      throw new Error('allowedHosts: cannot verify host of response URL: ' + reportedUrl);
    }
    try {
      checkRedirectTarget(current, finalUrl, reportedUrl);
      checkHost(finalUrl, reportedUrl);
    } catch (error) {
      abort.abort('response URL not allowed');
      throw error;
    }
  }
  // `let out: FetchFn = wrappedFetch` below checks conformance to the FetchFn interface.
  async function wrappedFetch(url: string, reqOpts: FetchOpts = {}) {
    const abort = new AbortController();
    const cleanups: (() => void)[] = [];
    async function assertNetwork(hopUrl: string): Promise<void> {
      if (await noNetwork(hopUrl)) {
        abort.abort('network disabled');
        throw new Error('network disabled');
      }
    }
    try {
      // Runtime callers are not necessarily type-checked. Coerce once so an object cannot validate
      // as one URL and then stringify differently when it reaches fetch.
      url = String(url);
      // Keep one internal signal for timeout and late killswitch aborts, while preserving caller aborts.
      cleanups.push(linkAbort(reqOpts.signal, abort));
      cleanups.push(linkAbort(killswitchSignal, abort));
      if (opts.timeout !== undefined || reqOpts.timeout !== undefined) {
        const ms = reqOpts.timeout !== undefined ? reqOpts.timeout : opts.timeout!;
        validateTimeout(ms);
        const timer = setTimeout(() => abort.abort(), ms);
        cleanups.push(() => clearTimeout(timer));
      }
      const headers = new Headers(); // We cannot re-use object from user since we may modify it
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        // Relative URL: fetch resolves it against the document base; there is no userinfo to extract.
      }
      if (parsed && (parsed.username || parsed.password)) {
        headers.set('Authorization', basicAuthFromUrl(parsed));
        parsed.username = '';
        parsed.password = '';
        url = parsed.href;
      }
      if (reqOpts.headers) {
        const h =
          reqOpts.headers instanceof Headers ? reqOpts.headers : new Headers(reqOpts.headers);
        h.forEach((v, k) => headers.set(k, v));
      }
      checkHost(parsed, url);
      await assertNetwork(url);
      // Walk absolute HTTP(S) redirects one hop at a time. This lets the wrapper reject
      // disallowed origins and HTTPS downgrades BEFORE the redirected request is sent.
      // Callers that pass `redirect: 'manual'`/`'error'` keep their semantics.
      const selfFollow =
        parsed !== undefined &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        (reqOpts.redirect === undefined || reqOpts.redirect === 'follow');
      const hopOpts: FetchOpts = { referrerPolicy: 'no-referrer', ...reqOpts };
      if (selfFollow) hopOpts.redirect = 'manual';
      hopOpts.headers = headers;
      hopOpts.signal = abort.signal;
      let target = url;
      // selfFollow requires a parsed absolute HTTP(S) URL, so `current` is defined in the loop.
      let current = parsed!;
      let hops = 0;
      let res!: UnPromise<ReturnType<FetchFn>>;
      let responseUrl = target;
      for (;;) {
        // Report actual per-hop options; clone the object and Headers so common logger
        // mutations cannot change the request being sent.
        if (opts.log) opts.log(target, { ...hopOpts, headers: new Headers(headers) });
        res = await fetchFunction(target, hopOpts);
        responseUrl = res.url || target;
        if ((origins !== undefined || selfFollow) && res.url)
          checkResponseUrl(current, res.url, abort);
        await assertNetwork(responseUrl);
        if (!selfFollow || ![301, 302, 303, 307, 308].includes(res.status)) break;
        const location = res.headers.get('location');
        if (!location) break;
        // The hop's body is never read; release its socket.
        res.body?.cancel().catch(() => {});
        if (++hops > 20) throw new Error('too many redirects: ' + url);
        // Relative locations resolve against the hop that issued them.
        const next = new URL(location, current);
        checkRedirectTarget(current, next, next.href);
        // Fetch spec: credentials never ride a redirect, and Authorization
        // must not leak to a different origin.
        if (next.username || next.password)
          throw new Error('redirect carries credentials: ' + next.host);
        if (current.origin !== next.origin) {
          // No cookie jar here: manually set credentials and API keys would otherwise
          // ride to a different allowed origin.
          for (const name of redirectSensitiveHeaders) headers.delete(name);
        }
        // Fetch rewrites POST after 301/302, and non-GET/HEAD after 303, as a bodyless GET.
        const method = (hopOpts.method || 'GET').toUpperCase();
        if (
          ((res.status === 301 || res.status === 302) && method === 'POST') ||
          (res.status === 303 && method !== 'GET' && method !== 'HEAD')
        ) {
          hopOpts.method = 'GET';
          delete hopOpts.body;
          for (const name of [
            'Content-Encoding',
            'Content-Language',
            'Content-Location',
            'Content-Type',
          ])
            headers.delete(name);
        }
        target = '' + next;
        checkHost(next, target); // pre-send, exactly like the first hop
        // The hook sees every hop URL too — a redirect inside the allowlist must
        // not smuggle past URL-based hook logic (and a killswitch flipped
        // mid-chain stops the chain now, not after the last hop).
        await assertNetwork(target);
        current = next;
      }
      const body = await readBodyLimited(res, maxBodySize, abort);
      await assertNetwork(responseUrl);
      return {
        ...getRequestInfo(res),
        // Self-followed hops report like fetch's own follow would.
        ...(hops > 0 ? { redirected: true, url: responseUrl } : {}),
        // NOTE: this disables streaming parser and fetches whole body on request (instead of headers only as done in fetch)
        // But this allows to intercept and disable request if killswitch enabled. Also required for concurrency limit,
        // since actual request is not finished
        json: async () => JSON.parse(new TextDecoder().decode(body)),
        text: async () => new TextDecoder().decode(body),
        arrayBuffer: async () => body.buffer,
      };
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  }
  // rps sits closest to the network so actual request starts stay spaced; concurrencyLimit wraps it.
  let out: FetchFn = wrappedFetch;
  if (opts.rps !== undefined) {
    const rate = rateLimit(opts.rps);
    const inner = out;
    out = (url, reqOpts) => rate(() => inner(url, reqOpts));
  }
  if (opts.concurrencyLimit !== undefined) {
    const curLimit = limit(opts.concurrencyLimit);
    const inner = out;
    out = (url, reqOpts) => curLimit(() => inner(url, reqOpts));
  }
  return out;
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
    super(`FetchProvider(${error.code}): ${error.message || JSON.stringify(error)}`);
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
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize <= 0)
      throw new Error(`expected batchSize to be a positive integer, got ${this.batchSize}`);
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
      // Guard property access: `null` and primitives are valid JSON, and throwing here would
      // leave every queued promise pending (batchProcess runs unawaited).
      const hasMsg =
        json != null && typeof json === 'object' && json.code != null && json.message != null;
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
      // Server sent broken ids or entries. We cannot throw error here, since we will have
      // unresolved promises. Also, this will break app state.
      if (res == null || typeof res !== 'object') continue;
      if (!Number.isSafeInteger(res.id) || res.id < 0 || res.id >= curr.length) continue;
      if (processed.has(res.id)) continue; // multiple responses for same id
      const { reject, resolve } = curr[res.id];
      processed.add(res.id);
      if (res.error) reject(this.jsonError(res.error));
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
    if (json == null || typeof json !== 'object')
      throw new Error('invalid rpc response: ' + JSON.stringify(json));
    if (json.error) throw this.jsonError(json.error);
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
function defaultGetKey(url: string, opt: FetchOpts): string {
  return JSON.stringify({ url, opt });
}

/**
 * Structured replay log entry: response metadata captured alongside the body.
 * Plain-string entries (body only, pre-1.1 format) are still accepted and replay
 * with default 200/OK metadata.
 */
export type ReplayLogEntry = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Body text, or base64 behind the binary marker (same encoding as legacy entries). */
  body: string;
};

// Used for offline-mode misses: keys are long JSON blobs, so point at the most similar
// existing key (longest common prefix) to make fixture mismatches debuggable.
function closestKey(key: string, keys: string[]): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const k of keys) {
    const max = Math.min(k.length, key.length);
    let i = 0;
    while (i < max && k[i] === key[i]) i++;
    if (i > bestLen) {
      bestLen = i;
      best = k;
    }
  }
  return best;
}

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

// Captured bodies are stored as strings so exported logs stay readable. Binary payloads that
// don't survive a UTF-8 round-trip are stored base64-encoded behind this marker instead of
// being silently corrupted. Existing plain-text fixtures keep working unchanged.
const B64_MARK = ' b64 ';
function encodeBody(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  const reencoded = new TextEncoder().encode(text);
  const lossless = reencoded.length === bytes.length && reencoded.every((b, i) => b === bytes[i]);
  if (lossless && !text.startsWith(B64_MARK)) return text;
  return B64_MARK + bytesToBase64(bytes);
}
function decodeBody(stored: string): Uint8Array<ArrayBuffer> {
  if (stored.startsWith(B64_MARK)) return base64ToBytes(stored.slice(B64_MARK.length));
  return new TextEncoder().encode(stored);
}

async function getKey(url: string, opts: FetchOpts, fn = defaultGetKey): Promise<string> {
  // RFC 9110 §5.1: field names are case-insensitive, so replay keys need canonicalized header names.
  const headers: Record<string, string> = {};
  // Headers accepts every HeadersInit shape and normalizes duplicate handling like fetch.
  for (const [key, value] of new Headers(opts.headers)) headers[normalizeHeader(key)] = value;
  return fn(url, { method: opts.method, headers, body: opts.body });
}

/**
 * Log & replay network requests without actually calling network code.
 * @param fetchFunction - Wrapped fetch implementation used to capture new responses.
 * @param logs - Captured request/response map, usually from `JSON.parse(replay.export())`.
 * @param opts - Replay configuration such as offline mode or custom keying. See {@link ReplayOpts}.
 * @returns Fetch-compatible wrapper with log export helpers.
 * @throws If replay options are invalid. {@link Error}
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
  logs: Record<string, string | ReplayLogEntry> = {},
  opts: ReplayOpts = {}
): ReplayFn {
  const accessed: Set<string> = new Set();
  async function wrapped(url: string, reqOpts: FetchOpts = {}) {
    const key = await getKey(url, reqOpts, opts.getKey);
    accessed.add(key);
    // Empty-string payloads are valid captures; missing entries must be checked by key presence,
    // not truthiness — and by OWN key presence: `in` would match Object.prototype members
    // ('toString', '__proto__') whenever a custom getKey produces such a key.
    if (!Object.hasOwn(logs, key)) {
      if (opts.offline) {
        const closest = closestKey(key, Object.keys(logs));
        throw new Error(
          `fetchReplay: unknown request=${key}` +
            (closest === undefined ? '' : `, closest logged request=${closest}`)
        );
      }
      const req = await fetchFunction(url, reqOpts);
      // TODO: save this too?
      const info = getRequestInfo(req);
      // Read the underlying body once and reuse it: raw fetch responses throw on a second read,
      // and callers may invoke several body methods on the same wrapped response.
      let bodyPromise: Promise<Uint8Array<ArrayBuffer>> | undefined;
      function readBody(): Promise<Uint8Array<ArrayBuffer>> {
        if (bodyPromise === undefined)
          bodyPromise = req.arrayBuffer().then((buffer) => {
            const bytes = new Uint8Array(buffer);
            const headers: Record<string, string> = {};
            info.headers.forEach((value, key) =>
              Object.defineProperty(headers, key, {
                value,
                enumerable: true,
                writable: true,
                configurable: true,
              })
            );
            // defineProperty, not assignment: a '__proto__' key would swap the
            // log object's prototype instead of storing the capture.
            Object.defineProperty(logs, key, {
              value: {
                status: info.status,
                statusText: info.statusText,
                headers,
                body: encodeBody(bytes),
              },
              enumerable: true,
              writable: true,
              configurable: true,
            });
            return bytes;
          });
        return bodyPromise;
      }
      return {
        ...info,
        json: async () => JSON.parse(new TextDecoder().decode(await readBody())),
        text: async () => new TextDecoder().decode(await readBody()),
        arrayBuffer: async () => (await readBody()).buffer,
      };
    }
    const entry = logs[key];
    const isLegacy = typeof entry === 'string'; // body-only entry: replay with default metadata
    const body = isLegacy ? entry : entry.body;
    const status = isLegacy ? 200 : entry.status;
    return {
      headers: new Headers(isLegacy ? undefined : entry.headers),
      ok: status >= 200 && status < 300,
      redirected: false,
      status,
      statusText: isLegacy ? 'OK' : entry.statusText,
      type: 'basic' as ResponseType,
      url: url,
      text: async () => new TextDecoder().decode(decodeBody(body)),
      json: async () => JSON.parse(new TextDecoder().decode(decodeBody(body))),
      arrayBuffer: async () => decodeBody(body).buffer,
    };
  }
  wrapped.logs = logs;
  wrapped.accessed = accessed;
  wrapped.export = () =>
    JSON.stringify(Object.fromEntries(Object.entries(logs).filter(([key]) => accessed.has(key))));
  return wrapped;
}

// Retry
/** Context passed to `RetryOpts.shouldRetry` after a failed attempt. */
export type RetryContext = {
  /** Request URL. */
  url: string;
  /** Options of the request being retried. */
  opts: FetchOpts;
  /** 0-based index of the attempt that just failed. */
  attempt: number;
  /** Error thrown by the wrapped fetch, when it rejected (network error, timeout, abort). */
  error?: unknown;
  /** HTTP status, when a (non-ok) response was received. */
  status?: number;
};

/** Options for retry(). */
export type RetryOpts = {
  /** Total number of attempts, including the first one. Default: 3. */
  attempts?: number;
  /** Base backoff delay in ms; grows exponentially per attempt, with full jitter. Default: 100. */
  baseDelay?: number;
  /** Upper bound in ms for backoff and Retry-After waits. Default: 5000. */
  maxDelay?: number;
  /**
   * Decides whether a failed attempt should be retried.
   * Default policy only retries safe methods (GET/HEAD/OPTIONS) — retrying a POST can duplicate
   * a non-idempotent action — and only on thrown errors or status 408/429/5xx.
   * Pass a custom predicate to retry POST (e.g. JSON-RPC) explicitly.
   */
  shouldRetry?: (ctx: RetryContext) => boolean;
};

function defaultShouldRetry(ctx: RetryContext): boolean {
  const method = (ctx.opts.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return false;
  if (ctx.status === undefined) return true; // thrown error: network failure, timeout
  return ctx.status === 408 || ctx.status === 429 || ctx.status >= 500;
}

// RFC 9110 §10.2.3: Retry-After is either delay-seconds or an HTTP-date.
function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * Retries failed requests with exponential backoff and full jitter.
 * Composable with the other wrappers: stack it over `ftch`, under `jsonrpc`.
 * Non-ok responses that exhaust attempts (or are not retriable) are returned, not thrown,
 * preserving fetch semantics. Honors the server's Retry-After header, capped by `maxDelay`.
 * @param fetchFunction - Fetch implementation to wrap.
 * @param opts - Retry configuration. See {@link RetryOpts}.
 * @returns Wrapped fetch function that retries failed attempts.
 * @example
 * Retry flaky GET endpoints with default policy (3 attempts, 408/429/5xx or network errors).
 * ```js
 * import { ftch, retry } from 'micro-ftch';
 * const net = retry(ftch(fetch), { attempts: 3, baseDelay: 100 });
 * await net('https://example.com');
 * ```
 * @example
 * JSON-RPC uses POST, which the default policy does not retry; opt in explicitly.
 * ```js
 * import { ftch, jsonrpc, retry } from 'micro-ftch';
 * const net = retry(ftch(fetch), {
 *   shouldRetry: (ctx) => ctx.error !== undefined || ctx.status === 429 || ctx.status >= 500,
 * });
 * const rpc = jsonrpc(net, 'http://rpc_node/', { batchSize: 20 });
 * ```
 */
export function retry(fetchFunction: FetchFn, opts: RetryOpts = {}): FetchFn {
  const attempts = opts.attempts === undefined ? 3 : opts.attempts;
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new Error(`expected attempts >= 1, got ${attempts}`);
  const baseDelay = opts.baseDelay === undefined ? 100 : opts.baseDelay;
  const maxDelay = opts.maxDelay === undefined ? 5000 : opts.maxDelay;
  if (!Number.isFinite(baseDelay) || baseDelay < 0)
    throw new Error(`expected baseDelay to be a finite non-negative number, got ${baseDelay}`);
  if (!Number.isFinite(maxDelay) || maxDelay < 0)
    throw new Error(`expected maxDelay to be a finite non-negative number, got ${maxDelay}`);
  const shouldRetry = opts.shouldRetry || defaultShouldRetry;
  if (typeof shouldRetry !== 'function') throw new Error('opts.shouldRetry must be a function');
  return async (url, reqOpts = {}) => {
    for (let attempt = 0; ; attempt++) {
      let res;
      let error: unknown;
      let failed = false;
      try {
        res = await fetchFunction(url, reqOpts);
      } catch (e) {
        error = e;
        failed = true;
      }
      const success = !failed && res !== undefined && res.ok;
      const isLast = attempt >= attempts - 1;
      const aborted =
        reqOpts.signal !== undefined && reqOpts.signal !== null && reqOpts.signal.aborted;
      if (
        success ||
        isLast ||
        aborted ||
        !shouldRetry({ url, opts: reqOpts, attempt, error, status: res && res.status })
      ) {
        if (failed) throw error;
        return res!;
      }
      // Retry-After takes priority over computed backoff; both are capped by maxDelay.
      const retryAfter = res === undefined ? undefined : parseRetryAfter(res.headers);
      const backoff = Math.random() * Math.min(maxDelay, baseDelay * 2 ** attempt);
      await sleep(retryAfter === undefined ? backoff : Math.min(retryAfter, maxDelay));
    }
  };
}

/** Internal methods for test purposes only. */
export const _TEST: {
  limit: typeof limit;
  rateLimit: typeof rateLimit;
} = /* @__PURE__ */ Object.freeze({
  limit,
  rateLimit,
});
