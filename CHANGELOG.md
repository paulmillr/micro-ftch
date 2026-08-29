# Changelog for micro-ftch

## 1.2.1 (2026-08-29)

- Added `allowedHosts`, `timeout`, and `concurrencyLimit` options to `jsonrpc`; the RPC URL's origin is always allowed, and transports not created by `ftch` receive conservative defaults (240s timeout, concurrency 10)
- Made policy violations (allowedHosts, redirect, maxBodySize, killswitch) non-retryable errors
- Added a 65,536-entry cap on pending requests queued by `concurrencyLimit` and `rps`
- Made retry delays abortable via the request's `AbortSignal`

## 1.2.0 (2026-08-13)

- Harden redirects and allowedHosts

## 1.1.0 (2026-08-05)

- Add retry, allowedHosts, rps, maxBodySize, caching bytes

## 1.0.0 (2026-04-28)

First stable version

- **April 2026 self-audit** (all files): no major issues found
- Minor stability improvements
- Fix compilation issues on TypeScript v6

## 0.5.0 (2025-06-04)

- The package is now ESM-only, which is fine — since ESM modules can finally be loaded from common.js on node v20.19+
  - Reduces unpacked NPM package size from 93.7 Kb to 59.2 Kb
- Expose error code by @mahnunchik in https://github.com/paulmillr/micro-ftch/pull/2

## 0.4.3 (2025-03-28)

- jsonrpc: correctly handle non-array responses

## 0.4.2 (2025-01-23)

- ftch: Rename killswitch to isValidRequest
- Fix invalid PURE annotation

## 0.4.1 (2025-01-09)

- `ftch`: add `url` argument to `killswitch` option
- Use typescript isolatedDeclarations.
- Publish to JSR

## 0.4.0 (2024-06-16)

Initial release for "updated" package.
