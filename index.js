/**
 * Wrappers for {@link https://developer.mozilla.org/en-US/docs/Web/API/fetch | built-in fetch()} enabling
 * killswitch, logging, concurrency limit, and other features. Fetch is great, but its usage in secure
 * environments is complicated. The library makes it simple.
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
// Small internal primitive to limit concurrency
function limit(concurrencyLimit) {
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
// NOTE: we don't expose actual request to make sure there is no way to trigger actual network code
// from wrapped function
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
    const wrappedFetch = async (url, reqOpts = {}) => {
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
        if (noNetwork(url))
            throw new Error('network disabled');
        if (opts.log)
            opts.log(url, reqOpts);
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
        if (timeout !== undefined)
            clearTimeout(timeout);
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
        const curLimit = limit(opts.concurrencyLimit);
        return (url, reqOpts) => curLimit(() => wrappedFetch(url, reqOpts));
    }
    return wrappedFetch;
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
        const json = await this.fetchJson(curr.map((i, j) => ({
            jsonrpc: '2.0',
            id: j,
            method: i.method,
            params: i.params,
        })));
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
            if (!Number.isSafeInteger(res.id) || res.id < 0 || res.id >= curr.length)
                continue;
            if (processed.has(res.id))
                continue; // multiple responses for same id
            const { reject, resolve } = curr[res.id];
            processed.add(res.id);
            if (res && res.error)
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
        if (json && json.error)
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
function normalizeHeader(header) {
    return header
        .split('-')
        .map((i) => i.charAt(0).toUpperCase() + i.slice(1).toLowerCase())
        .join('-');
}
const getKey = (url, opts, fn = defaultGetKey) => {
    let headers = opts.headers || {};
    if (headers instanceof Headers) {
        const tmp = {};
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
        if (!logs[key]) {
            if (opts.offline)
                throw new Error(`fetchReplay: unknown request=${key}`);
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
            type: 'basic',
            url: url,
            text: async () => logs[key],
            json: async () => JSON.parse(logs[key]),
            arrayBuffer: async () => new TextEncoder().encode(logs[key]).buffer,
        };
    };
    wrapped.logs = logs;
    wrapped.accessed = accessed;
    wrapped.export = () => JSON.stringify(Object.fromEntries(Object.entries(logs).filter(([k, _]) => accessed.has(k))));
    return wrapped;
}
/** Internal methods for test purposes only. */
export const _TEST = {
    limit,
};
//# sourceMappingURL=index.js.map