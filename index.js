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
const nextTick = async () => { };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// btoa/atob are Latin-1 only: convert through raw bytes, chunked to avoid arg-spread limits.
function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        bytes[i] = bin.charCodeAt(i);
    return bytes;
}
// Small internal primitive to limit concurrency
function limit(concurrencyLimit) {
    // Non-positive limits cannot start queued work and would leave callers pending.
    if (concurrencyLimit <= 0)
        throw new Error(`expected concurrencyLimit > 0, got ${concurrencyLimit}`);
    let currentlyProcessing = 0;
    const queue = [];
    const next = () => {
        if (!queue.length)
            return;
        if (currentlyProcessing >= concurrencyLimit)
            return;
        currentlyProcessing++;
        const first = queue.shift();
        if (!first)
            throw new Error('empty queue'); // should not happen
        first();
    };
    return (fn) => new Promise((resolve, reject) => {
        queue.push(() => Promise.resolve()
            .then(fn)
            .then(resolve)
            .catch(reject)
            .finally(() => {
            currentlyProcessing--;
            next();
        }));
        next();
    });
}
// Small internal primitive to space out starts: at most `rps` calls begin per second.
function rateLimit(rps) {
    if (!Number.isFinite(rps) || rps <= 0)
        throw new Error(`expected rps > 0, got ${rps}`);
    const interval = 1000 / rps;
    let nextStart = 0;
    return async (fn) => {
        const now = Date.now();
        const start = Math.max(nextStart, now);
        nextStart = start + interval;
        if (start > now)
            await sleep(start - now);
        return fn();
    };
}
// NOTE: we don't expose actual request to make sure there is no way to trigger actual network code
// from wrapped function
// ftch buffers whole bodies by design (see NOTE in ftch), which makes an unbounded response an
// OOM vector: enforce the cap while reading. Content-Length is a fast reject for honest servers;
// streaming catches liars; the arrayBuffer fallback (non-stream FetchFns) can only check after the fact.
async function readBodyLimited(req, maxBodySize, abort) {
    const tooBig = () => {
        abort.abort('maxBodySize exceeded');
        return new Error(`response body exceeds maxBodySize=${maxBodySize}`);
    };
    const len = req.headers.get('content-length');
    if (len !== null && Number(len) > maxBodySize)
        throw tooBig();
    const stream = req.body;
    if (stream != null && typeof stream.getReader === 'function') {
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            total += value.length;
            if (total > maxBodySize) {
                reader.cancel().catch(() => { });
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
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > maxBodySize)
        throw tooBig();
    return body;
}
const getRequestInfo = (req) => ({
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
export function ftch(fetchFunction, opts = {}) {
    const ks = opts.isValidRequest || opts.killswitch;
    if (ks && typeof ks !== 'function')
        throw new Error('opts.isValidRequest must be a function');
    const noNetwork = (url) => ks && !ks(url);
    if (opts.allowedHosts !== undefined &&
        (!Array.isArray(opts.allowedHosts) || opts.allowedHosts.some((h) => typeof h !== 'string')))
        throw new Error('opts.allowedHosts must be an array of strings');
    const hosts = opts.allowedHosts === undefined ? undefined : opts.allowedHosts.map((h) => h.toLowerCase());
    const hostOk = (parsed) => hosts === undefined || hosts.includes(parsed.hostname) || hosts.includes(parsed.host);
    // Checked before isValidRequest: the declarative allowlist must not be bypassable by hook logic.
    const checkHost = (parsed, url) => {
        if (hosts === undefined)
            return;
        if (parsed === undefined)
            throw new Error('allowedHosts: cannot verify host of relative URL: ' + url);
        if (!hostOk(parsed))
            throw new Error('allowedHosts: host not allowed: ' + parsed.host);
    };
    const maxBodySize = opts.maxBodySize === undefined ? 1024 ** 3 : opts.maxBodySize;
    if (!(maxBodySize > 0))
        throw new Error(`expected maxBodySize > 0, got ${maxBodySize}`);
    const wrappedFetch = async (url, reqOpts = {}) => {
        const abort = new AbortController();
        const callerSignal = reqOpts.signal;
        let cleanupCallerSignal = () => { };
        if (callerSignal) {
            // Keep one internal signal for timeout and late killswitch aborts, while preserving caller aborts.
            const abortCaller = () => abort.abort(callerSignal.reason);
            if (callerSignal.aborted)
                abortCaller();
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
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            // Relative URL: fetch resolves it against the document base; there is no userinfo to extract.
        }
        if (parsed && (parsed.username || parsed.password)) {
            // RFC 7617 §2 builds `user-pass` as user-id ":" password; RFC 3986 §3.2.1 deprecates user:password in URI userinfo, so strip it after converting.
            // URL exposes userinfo percent-encoded, and credentials may be non-Latin-1: decode, then base64 the UTF-8 bytes.
            const user = decodeURIComponent(parsed.username);
            const pass = decodeURIComponent(parsed.password);
            const auth = bytesToBase64(new TextEncoder().encode(`${user}:${pass}`));
            headers.set('Authorization', `Basic ${auth}`);
            parsed.username = '';
            parsed.password = '';
            url = '' + parsed;
        }
        if (reqOpts.headers) {
            const h = reqOpts.headers instanceof Headers ? reqOpts.headers : new Headers(reqOpts.headers);
            h.forEach((v, k) => headers.set(k, v));
        }
        checkHost(parsed, url);
        if (noNetwork(url))
            throw new Error('network disabled');
        if (opts.log)
            opts.log(url, reqOpts);
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
            if (hosts !== undefined && res.url) {
                // Redirects can land on a different host; re-verify the final URL before reading the body.
                let finalUrl;
                try {
                    finalUrl = new URL(res.url);
                }
                catch { }
                if (finalUrl !== undefined && !hostOk(finalUrl)) {
                    abort.abort('redirect to disallowed host');
                    throw new Error('allowedHosts: host not allowed: ' + finalUrl.host);
                }
            }
            const body = await readBodyLimited(res, maxBodySize, abort);
            return {
                ...getRequestInfo(res),
                // NOTE: this disables streaming parser and fetches whole body on request (instead of headers only as done in fetch)
                // But this allows to intercept and disable request if killswitch enabled. Also required for concurrency limit,
                // since actual request is not finished
                json: async () => JSON.parse(new TextDecoder().decode(body)),
                text: async () => new TextDecoder().decode(body),
                arrayBuffer: async () => body.buffer,
            };
        }
        finally {
            if (timeout !== undefined)
                clearTimeout(timeout);
            cleanupCallerSignal();
        }
    };
    // rps sits closest to the network so actual request starts stay spaced; concurrencyLimit wraps it.
    let out = wrappedFetch;
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
    code;
    constructor(error) {
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
export class JsonrpcProvider {
    batchSize;
    headers;
    queue = [];
    fetchFunction;
    rpcUrl;
    constructor(fetchFunction, rpcUrl, options = {}) {
        if (typeof fetchFunction !== 'function')
            throw new Error('fetchFunction is required');
        if (typeof rpcUrl !== 'string')
            throw new Error('rpcUrl is required');
        this.fetchFunction = fetchFunction;
        this.rpcUrl = rpcUrl;
        this.batchSize = options.batchSize === undefined ? 1 : options.batchSize;
        this.headers = options.headers || {};
        if (typeof this.headers !== 'object')
            throw new Error('invalid headers: expected object');
    }
    async fetchJson(body) {
        const res = await this.fetchFunction(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.headers },
            body: JSON.stringify(body),
        });
        return await res.json();
    }
    jsonError(error) {
        return new RpcError(error);
    }
    async batchProcess() {
        await nextTick(); // this allows to collect as much requests as we can in single tick
        const curr = this.queue.splice(0, this.batchSize);
        if (!curr.length)
            return;
        // Transport failures must reject every queued request; otherwise the batch leaks pending callers.
        let json;
        try {
            json = await this.fetchJson(curr.map((i, j) => ({
                jsonrpc: '2.0',
                id: j,
                method: i.method,
                params: i.params,
            })));
        }
        catch (err) {
            curr.forEach((req) => req.reject(err));
            return;
        }
        if (!Array.isArray(json)) {
            // Guard property access: `null` and primitives are valid JSON, and throwing here would
            // leave every queued promise pending (batchProcess runs unawaited).
            const hasMsg = json != null && typeof json === 'object' && json.code != null && json.message != null;
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
            if (res == null || typeof res !== 'object')
                continue;
            if (!Number.isSafeInteger(res.id) || res.id < 0 || res.id >= curr.length)
                continue;
            if (processed.has(res.id))
                continue; // multiple responses for same id
            const { reject, resolve } = curr[res.id];
            processed.add(res.id);
            if (res.error)
                reject(this.jsonError(res.error));
            else
                resolve(res.result);
        }
        for (let i = 0; i < curr.length; i++) {
            if (!processed.has(i))
                curr[i].reject(new Error(`response missing in batch request ` + i));
        }
    }
    rpcBatch(method, params) {
        return new Promise((resolve, reject) => {
            this.queue.push({ method, params, resolve, reject });
            this.batchProcess(); // this processed in parallel
        });
    }
    async rpc(method, params) {
        if (typeof method !== 'string')
            throw new Error('rpc method name must be a string');
        if (this.batchSize > 1)
            return this.rpcBatch(method, params);
        const json = await this.fetchJson({
            jsonrpc: '2.0',
            id: 0,
            method,
            params,
        });
        if (json == null || typeof json !== 'object')
            throw new Error('invalid rpc response: ' + JSON.stringify(json));
        if (json.error)
            throw this.jsonError(json.error);
        return json.result;
    }
    call(method, ...args) {
        return this.rpc(method, args);
    }
    callNamed(method, params) {
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
export function jsonrpc(fetchFunction, rpcUrl, options = {}) {
    return new JsonrpcProvider(fetchFunction, rpcUrl, options);
}
const defaultGetKey = (url, opt) => JSON.stringify({ url, opt });
// Used for offline-mode misses: keys are long JSON blobs, so point at the most similar
// existing key (longest common prefix) to make fixture mismatches debuggable.
function closestKey(key, keys) {
    let best;
    let bestLen = -1;
    for (const k of keys) {
        const max = Math.min(k.length, key.length);
        let i = 0;
        while (i < max && k[i] === key[i])
            i++;
        if (i > bestLen) {
            bestLen = i;
            best = k;
        }
    }
    return best;
}
function normalizeHeader(header) {
    return header
        .split('-')
        .map((i) => i.charAt(0).toUpperCase() + i.slice(1).toLowerCase())
        .join('-');
}
// Captured bodies are stored as strings so exported logs stay readable. Binary payloads that
// don't survive a UTF-8 round-trip are stored base64-encoded behind this marker instead of
// being silently corrupted. Existing plain-text fixtures keep working unchanged.
const B64_MARK = ' b64 ';
function encodeBody(bytes) {
    const text = new TextDecoder().decode(bytes);
    const reencoded = new TextEncoder().encode(text);
    const lossless = reencoded.length === bytes.length && reencoded.every((b, i) => b === bytes[i]);
    if (lossless && !text.startsWith(B64_MARK))
        return text;
    return B64_MARK + bytesToBase64(bytes);
}
function decodeBody(stored) {
    if (stored.startsWith(B64_MARK))
        return base64ToBytes(stored.slice(B64_MARK.length));
    return new TextEncoder().encode(stored);
}
const getKey = (url, opts, fn = defaultGetKey) => {
    // RFC 9110 §5.1: field names are case-insensitive, so replay keys need canonicalized header names.
    const headers = {};
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
export function replayable(fetchFunction, logs = {}, opts = {}) {
    const accessed = new Set();
    const wrapped = async (url, reqOpts = {}) => {
        const key = getKey(url, reqOpts, opts.getKey);
        accessed.add(key);
        // Empty-string payloads are valid captures; missing entries must be checked by key presence, not truthiness.
        if (!(key in logs)) {
            if (opts.offline) {
                const closest = closestKey(key, Object.keys(logs));
                throw new Error(`fetchReplay: unknown request=${key}` +
                    (closest === undefined ? '' : `, closest logged request=${closest}`));
            }
            const req = await fetchFunction(url, reqOpts);
            // TODO: save this too?
            const info = getRequestInfo(req);
            // Read the underlying body once and reuse it: raw fetch responses throw on a second read,
            // and callers may invoke several body methods on the same wrapped response.
            let bodyPromise;
            const readBody = () => {
                if (bodyPromise === undefined)
                    bodyPromise = req.arrayBuffer().then((buffer) => {
                        const bytes = new Uint8Array(buffer);
                        const headers = {};
                        info.headers.forEach((v, k) => (headers[k] = v));
                        logs[key] = {
                            status: info.status,
                            statusText: info.statusText,
                            headers,
                            body: encodeBody(bytes),
                        };
                        return bytes;
                    });
                return bodyPromise;
            };
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
            type: 'basic',
            url: url,
            text: async () => new TextDecoder().decode(decodeBody(body)),
            json: async () => JSON.parse(new TextDecoder().decode(decodeBody(body))),
            arrayBuffer: async () => decodeBody(body).buffer,
        };
    };
    wrapped.logs = logs;
    wrapped.accessed = accessed;
    wrapped.export = () => JSON.stringify(Object.fromEntries(Object.entries(logs).filter(([k, _]) => accessed.has(k))));
    return wrapped;
}
const defaultShouldRetry = (ctx) => {
    const method = (ctx.opts.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS')
        return false;
    if (ctx.status === undefined)
        return true; // thrown error: network failure, timeout
    return ctx.status === 408 || ctx.status === 429 || ctx.status >= 500;
};
// RFC 9110 §10.2.3: Retry-After is either delay-seconds or an HTTP-date.
function parseRetryAfter(headers) {
    const value = headers.get('retry-after');
    if (value === null)
        return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds))
        return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    if (!Number.isNaN(date))
        return Math.max(0, date - Date.now());
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
export function retry(fetchFunction, opts = {}) {
    const attempts = opts.attempts === undefined ? 3 : opts.attempts;
    if (!Number.isSafeInteger(attempts) || attempts < 1)
        throw new Error(`expected attempts >= 1, got ${attempts}`);
    const baseDelay = opts.baseDelay === undefined ? 100 : opts.baseDelay;
    const maxDelay = opts.maxDelay === undefined ? 5000 : opts.maxDelay;
    const shouldRetry = opts.shouldRetry || defaultShouldRetry;
    if (typeof shouldRetry !== 'function')
        throw new Error('opts.shouldRetry must be a function');
    return async (url, reqOpts = {}) => {
        for (let attempt = 0;; attempt++) {
            let res;
            let error;
            let failed = false;
            try {
                res = await fetchFunction(url, reqOpts);
            }
            catch (e) {
                error = e;
                failed = true;
            }
            const success = !failed && res !== undefined && res.ok;
            const isLast = attempt >= attempts - 1;
            const aborted = reqOpts.signal !== undefined && reqOpts.signal !== null && reqOpts.signal.aborted;
            if (success ||
                isLast ||
                aborted ||
                !shouldRetry({ url, opts: reqOpts, attempt, error, status: res && res.status })) {
                if (failed)
                    throw error;
                return res;
            }
            // Retry-After takes priority over computed backoff; both are capped by maxDelay.
            const retryAfter = res === undefined ? undefined : parseRetryAfter(res.headers);
            const backoff = Math.random() * Math.min(maxDelay, baseDelay * 2 ** attempt);
            await sleep(retryAfter === undefined ? backoff : Math.min(retryAfter, maxDelay));
        }
    };
}
/** Internal methods for test purposes only. */
export const _TEST = /* @__PURE__ */ Object.freeze({
    limit,
    rateLimit,
});
//# sourceMappingURL=index.js.map