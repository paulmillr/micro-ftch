type FETCH_OPT = {
  json?: boolean;
  ignoreStatus?: boolean;
  data?: object;
};

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 1) return arrays[0];
  const length = arrays.reduce((a, arr) => a + arr.length, 0);
  const result = new Uint8Array(length);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const arr = arrays[i];
    result.set(arr, pad);
    pad += arr.length;
  }
  return result;
}

function fetchNode(url: string, options: FETCH_OPT = {}): Promise<any> {
  const http = require('http');
  const https = require('https');
  const lib = /^https/.test(url) ? https : http;
  let opts: any = { method: 'GET' };
  if (options.json) opts.headers = { 'Content-Type': 'application/json' };
  if (options.data) {
    opts.method = 'POST';
    opts.body = options.json ? JSON.stringify(options.data) : options.data;
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(url, opts, async (res: any) => {
      res.on('error', reject);
      if (res.statusCode !== 200 && !options.ignoreStatus) {
        res.resume(); // Consume response data to free up memory
        return reject(new Error(`Request Failed.\nStatus Code: ${res.statusCode}`));
      }
      const isJson = options.json || /^application\/json/.test(res.headers['content-type']);
      try {
        if (isJson) {
          res.setEncoding('utf8');
          let raw = '';
          for await (const chunk of res) raw += chunk;
          resolve(JSON.parse(raw));
        } else {
          let buf = [];
          for await (const chunk of res) buf.push(Uint8Array.from(chunk));
          return resolve(concatBytes(...buf));
        }
      } catch (error) {
        reject(error);
      }
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function fetchBrowser(url: string, options: FETCH_OPT = {}): Promise<any> {
  const headers = new Headers();
  if (options.json) headers.append('Content-Type', 'application/json');
  let opts: any = { headers, redirect: 'follow' };
  if (options.data) {
    opts.method = 'POST';
    opts.body = options.json ? JSON.stringify(options.data) : options.data;
  }
  const res = await fetch(url, opts);
  if ((!res.ok || res.status !== 200) && !options.ignoreStatus) {
    throw new Error(`Request failed. Status code: ${res.status}`);
  }
  const type = res.headers.get('content-type');
  if (options.json || (type && /^application\/json/.test(type))) {
    return await res.json();
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

const IS_NODE = !!(
  typeof process == 'object' &&
  process.versions &&
  process.versions.node &&
  process.versions.v8
);

// We cannot name this fetch, since browser uses one.
export default function fetchUrl(url: string, options: FETCH_OPT = {}): Promise<any> {
  const fn = IS_NODE ? fetchNode : fetchBrowser;
  return fn(url, options);
}
