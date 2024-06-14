const eq = (a, b, path) => {
  path = path || ['.'];
  if (typeof a !== typeof b)
    throw new Error(`Eq(${path.join('/')}): different types a=${typeof a} b=${typeof b}`);
  if (a === null || b === null) {
    if (a !== b) throw new Error(`Eq(${path.join('/')}): different values a=${a} b=${b}`);
    else return;
  }
  // prettier-ignore
  if ((Array.isArray(a) && Array.isArray(b)) || (a instanceof Uint8Array && b instanceof Uint8Array)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) eq(a[i], b[i], path.concat(i));
  } else if (typeof a === 'object' && typeof b === 'object') {
    for (let i of new Set([...Object.keys(a), ...Object.keys(b)])) eq(a[i], b[i], path.concat(i));
  } else if (a !== b) throw new Error(`Eq(${path.join('/')}): different values a=${a} b=${b}`);
};
const throws = async (fn) => {
  let err;
  // prettier-ignore
  try { await fn(); }
  catch (e) { err = e; }
  if (!err) throw new Error('Throws: no error!');
};
const sleep = (ms) => new Promise((resolve, _) => setTimeout(resolve, ms));

exports.tests = {
  'Support HTTP': async (fetch) => {
    const res = await fetch('http://httpbin.org/robots.txt');
    eq(res, 'User-agent: *\nDisallow: /deny\n');
  },
  'Support HTTPS': async (fetch) => {
    const res = await fetch('https://httpbin.org/robots.txt');
    eq(res, 'User-agent: *\nDisallow: /deny\n');
  },
  'Auto-detect json': async (fetch) => {
    const res = await fetch('http://httpbin.org/json');
    // prettier-ignore
    eq(res, {slideshow: {author: 'Yours Truly', date: 'date of publication', title: 'Sample Slide Show',
      slides: [{title: 'Wake up to WonderWidgets!', type: 'all'},
          {items: ['Why <em>WonderWidgets</em> are great', 'Who <em>buys</em> WonderWidgets'], title: 'Overview', type: 'all'}]}});
  },
  'Auto-detect text': async (fetch) => {
    const res = await fetch('http://httpbin.org/robots.txt');
    eq(res, 'User-agent: *\nDisallow: /deny\n');
  },
  'Auto-detect binary': async (fetch) => {
    const res = await fetch('http://httpbin.org/image/png');
    eq(
      res.slice(0, 16),
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
    );
  },
  'Force text': async (fetch) => {
    const res = await fetch('http://httpbin.org/json', { type: 'text' });
    eq(
      res.slice(0, 70),
      '{\n  "slideshow": {\n    "author": "Yours Truly", \n    "date": "date of '
    );
  },
  'Force binary': async (fetch) => {
    const res = await fetch('http://httpbin.org/robots.txt', { type: 'binary' });
    // prettier-ignore
    eq(res, new Uint8Array([85, 115, 101, 114, 45, 97, 103, 101, 110, 116, 58, 32, 42, 10, 68, 105, 115, 97, 108, 108, 111, 119, 58, 32, 47, 100, 101,
      110, 121, 10]));
  },
  'Force json': async (fetch) =>
    throws(() => fetch('http://httpbin.org/robots.txt', { type: 'json' })),
  'Force text2': async (fetch) =>
    throws(() => fetch('http://httpbin.org/image/png', { type: 'text' })),
  'POST (json)': async (fetch) => {
    const res = await fetch('http://httpbin.org/anything', { type: 'json', data: { a: 1, b: 2 } });
    eq(res.json, { a: 1, b: 2 });
  },
  'POST (plain)': async (fetch) => {
    const res = await fetch('http://httpbin.org/anything', { data: 'blah-blah' });
    eq(res.data, 'blah-blah');
    eq(res.json, null);
  },
  'Support gzip': async (fetch) => {
    const res = await fetch('https://httpbin.org/gzip');
    eq(res.gzipped, true);
  },
  'Support deflate': async (fetch) => {
    const res = await fetch('https://httpbin.org/deflate');
    eq(res.deflated, true);
  },
  'Support brotli': async (fetch) => {
    const res = await fetch('https://httpbin.org/brotli');
    eq(res.brotli, true);
  },
  'Support encoding': async (fetch) => {
    // CDN returns gzipped version if correct Accept-Encoding is passed
    const res = await fetch('http://httpbingo.org/robots.txt');
    eq(res, 'User-agent: *\nDisallow: /deny\n');
  },
  'Full response': async (fetch) => {
    const res = await fetch('https://httpbin.org/json', { full: true });
    eq(res.status, 200);
    eq(res.body.slideshow.author, 'Yours Truly');
    eq(res.headers['content-length'], '429');
    eq(res.headers['content-type'], 'application/json');
  },
  'Follow redirect': async (fetch) => {
    const res = await fetch('http://httpbingo.org/redirect-to?url=/robots.txt', { type: 'text' });
    eq(res, 'User-agent: *\nDisallow: /deny\n');
  },
  'Follow redirect (absolute)': async (fetch) => {
    const res = await fetch('http://httpbingo.org/redirect-to?url=https://httpbin.org/robots.txt', {
      type: 'text',
    });
    eq(res, 'User-agent: *\nDisallow: /deny\n');
  },
  'Fail on redirect (if disabled)': async (fetch) =>
    throws(() =>
      fetch('http://httpbingo.org/redirect-to?url=/robots.txt', { type: 'text', redirect: false })
    ),
  'Follow redirect (too much redirects)': (fetch) =>
    throws(() => fetch('https://httpbingo.org/absolute-redirect/40')),
  'Basic auth': async (fetch) => {
    const res = await fetch('http://user:pwd@httpbin.org/basic-auth/user/pwd', {
      type: 'json',
    });
    eq(res, {
      authenticated: true,
      user: 'user',
    });
  },
  'Fail on wrong auth': (fetch) => throws(() => fetch('http://httpbin.org/basic-auth/login/pwd')),
  'Fail closed port': (fetch) => throws(() => fetch('http://localhost:28211/')),
  'Status code (200)': async (fetch) => {
    let err;
    try {
      await fetch('http://httpbin.org/robots.txt', {
        type: 'text',
        expectStatusCode: 404,
      });
    } catch (e) {
      err = e;
    }
    eq(err && err.statusCode, 200);
  },
  'Status code (401)': async (fetch) => {
    let err;
    try {
      await fetch('http://httpbin.org/basic-auth/user/pwd', { type: 'text' });
    } catch (e) {
      err = e;
    }
    eq(err && err.statusCode, 401);
  },
  'Status code (404)': async (fetch) => {
    let err;
    try {
      await fetch('http://httpbin.org/not-found', { type: 'text' });
    } catch (e) {
      err = e;
    }
    eq(err && err.statusCode, 404);
  },
};

exports.node = {
  'SSL (fails on self-signed)': (fetch) => throws(() => fetch('https://localhost:28001/')),
  'SSL (allow self-signed)': async (fetch) => {
    const res = await fetch('https://localhost:28001/', { sslAllowSelfSigned: true });
    eq(res, { test: 'passed' });
  },
  'SSL (allow self-signed, pinning)': async (fetch) => {
    for (let i = 0; i < 50; i++) {
      const res = await fetch('https://localhost:28001/', {
        sslAllowSelfSigned: true,
        sslPinnedCertificates: ['35dffeb2c0b774b6135523cf25bc6d5f24462975499beb5f7eae46f9bddc71b8'],
      });
      eq(res, { test: 'passed' });
    }
  },
  'SSL (allow self-signed, pinning, fails)': (fetch) =>
    throws(() =>
      fetch('https://localhost:28002/', {
        sslAllowSelfSigned: true,
        sslPinnedCertificates: ['35dffeb2c0b774b6135523cf25bc6d5f24462975499beb5f7eae46f9bddc71b8'],
      })
    ),
  'SSL (allow self-signed, pinning2)': async (fetch) => {
    for (let i = 0; i < 50; i++) {
      const res = await fetch('https://localhost:28002/', {
        sslAllowSelfSigned: true,
        sslPinnedCertificates: ['da5892edb1958c1652fa7f6d19da650312a3cce906ac529cf8830509f1c4b195'],
      });
      eq(res, { test: 'passed' });
    }
  },
  'SSL (allow self-signed, pinning, re-use)': async (fetch) => {
    for (let i = 0; i < 50; i++) {
      const res = await fetch('https://localhost:28002/', {
        sslAllowSelfSigned: true,
        sslPinnedCertificates: [
          'DA 58 92 ED B1 95 8C 16 52 FA 7F 6D 19 DA 65 03 12 A3 CC E9 06 AC 52 9C F8 83 05 09 F1 C4 B1 95',
        ],
      });
      eq(res, { test: 'passed' });
    }
  },
  'SSL (pinning, httpbin)': async (fetch) => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch('https://httpbin.org/robots.txt', {
        sslPinnedCertificates: ['944564e1b2cf887e3cc6ae0b527217d723c8b36c9b0a68a517735b730f8db4f3'],
      });
      eq(res, 'User-agent: *\nDisallow: /deny\n');
    }
  },
  'SSL (pinning, httpbin, fails)': (fetch) =>
    throws(() =>
      fetch('https://httpbin.org/robots.txt', {
        sslPinnedCertificates: ['da5892edb1958c1652fa7f6d19da650312a3cce906ac529cf8830509f1c4b195'],
      })
    ),
  // By some reasons only redirects triggers re-use of tls session
  'SSL (redirects, pinning, re-use)': async (fetch) => {
    const res = await fetch('https://httpbingo.org/absolute-redirect/10', {
      sslPinnedCertificates: ['adb918e1a20b97c19fe072da4436ddaa1bbd1d2c8d9bcb85b4dd9cf954d48311'],
    });
    eq(res.url, 'https://httpbingo.org/get');
  },
  'SSL (redirects, pinning, re-use, fail)': (fetch) =>
    throws(() =>
      fetch('https://httpbingo.org/absolute-redirect/10', {
        sslPinnedCertificates: ['da5892edb1958c1652fa7f6d19da650312a3cce906ac529cf8830509f1c4b195'],
      })
    ),
  'SSL (get error)': async (fetch) => {
    let err;
    try {
      await fetch('https://localhost:28002/', {
        sslAllowSelfSigned: true,
        sslPinnedCertificates: ['35dffeb2c0b774b6135523cf25bc6d5f24462975499beb5f7eae46f9bddc71b8'],
      });
    } catch (e) {
      err = e;
    }
    eq(
      '' + err,
      'Error: Invalid SSL certificate: da5892edb1958c1652fa7f6d19da650312a3cce906ac529cf8830509f1c4b195 Expected: 35dffeb2c0b774b6135523cf25bc6d5f24462975499beb5f7eae46f9bddc71b8'
    );
    eq(err.fingerprint256, 'da5892edb1958c1652fa7f6d19da650312a3cce906ac529cf8830509f1c4b195');
  },
  'SSL (get error, self-signed)': async (fetch) => {
    let err;
    try {
      await fetch('https://localhost:28002/');
    } catch (e) {
      err = e;
    }
    eq(
      '' + err,
      'Error: Self-signed SSL certificate: da5892edb1958c1652fa7f6d19da650312a3cce906ac529cf8830509f1c4b195'
    );
    eq(err.fingerprint256, 'da5892edb1958c1652fa7f6d19da650312a3cce906ac529cf8830509f1c4b195');
  },
};
exports.browser = {};
