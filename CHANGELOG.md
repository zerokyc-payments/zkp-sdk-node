# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [SemVer](https://semver.org/).

## [0.1.0] - 2026-09-09

Initial beta. Public contract mirrors zkp-sdk-php and zkp-sdk-python.

### Added
- `ZeroKYC` client: `createInvoice()`, `getInvoice()`, `cancelInvoice()`,
  `ping()`, `verifyWebhook()`; AbortSignal support + per-request timeout.
- Typed invoice/webhook models; normalized `InvoiceStatus`; amounts as decimal
  strings only (strict `^[0-9]+(\.[0-9]+)?$` grammar, JS numbers rejected).
- `WebhookVerifier`: strict `t=...,v1=...` parsing, +-300 s window,
  HMAC-SHA256 with `timingSafeEqual`; production payload shape and the docs
  test vector both supported (fixtures byte-identical to the PHP/Python SDKs).
- `ReplayGuard`: pure `isDuplicate()`, `markProcessed()` only after the local
  order update succeeds; payment matching (ticker or asset-id spelling);
  float-free decimal comparison.
- `idempotencyKey()` helper (max 120 chars).
- Typed error mapping + bounded idempotency-aware retries; Retry-After parsing
  is digits-only (malformed/negative/fractional/HTTP-date -> `retryAfter:
  null`, never a crash); caller aborts are never retried.
- Zero runtime dependencies (built-in fetch + AbortController + node:crypto);
  SDK User-Agent; dual ESM/CJS build with type declarations.
- Vitest suite (106 tests incl. abort/timeout/Retry-After matrices);
  ESLint + tsc strict; examples for Express and Next.js.
