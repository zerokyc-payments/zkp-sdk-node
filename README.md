# zkp-sdk-node

Official Node.js/TypeScript SDK for the [ZeroKYC Pay](https://zerokyc-payments.com)
crypto payment gateway. Framework-agnostic, zero runtime dependencies (built-in
`fetch`, `AbortController`, `node:crypto`), Node.js **20.3+** (22+ recommended; `AbortSignal.any` needs 20.3),
TypeScript `strict`. **Server-side only** — API keys and webhook verification
must never run in a browser.

The same public contract and security guarantees as
[zkp-sdk-php](https://github.com/zerokyc-payments/zkp-sdk-php) and
[zkp-sdk-python](https://github.com/zerokyc-payments/zkp-sdk-python).

## Install

```bash
npm install zkp-sdk-node
```

(If the package is not on npm yet, install from source:

```bash
npm install github:zerokyc-payments/zkp-sdk-node
```
)

## Quickstart (sandbox invoice in 5 minutes)

1. Create an account at [console.zerokyc-payments.com](https://console.zerokyc-payments.com)
   and copy a **sandbox** API key (`pk_test_...`) from *API keys*.
2. Create an invoice and send the buyer to the hosted checkout:

```ts
import { idempotencyKey, ZeroKYC } from "zkp-sdk-node";

const zkp = new ZeroKYC({
  apiKey: process.env.ZEROKYC_API_KEY!, // pk_test_... / pk_live_...
  environment: "sandbox",
});

const response = await zkp.createInvoice({
  amount: "19.90",
  currency: "USD",
  orderId: "INV-1042",
  description: "VPS plan: starter",
  idempotencyKey: idempotencyKey("myshop", "order", 1042), // stable per order
});

res.redirect(response.invoice.checkoutUrl);
```

3. Get paid: ZeroKYC detects the on-chain payment and POSTs a signed webhook.
   **A verified webhook (or a server-side `getInvoice()`) is the only proof of
   payment — never a browser success URL.**

```ts
import { WebhookVerificationError } from "zkp-sdk-node";

try {
  const event = zkp.verifyWebhook(rawBody, req.header("X-ZKP-Signature") ?? "");
} catch (error) {
  if (error instanceof WebhookVerificationError) {
    res.status(400).end();
  } else throw error;
}
```

Full production flow with duplicate protection and payment matching:
[examples/safe-webhook-handler-express.ts](examples/safe-webhook-handler-express.ts)
/ [examples/safe-webhook-handler-nextjs.ts](examples/safe-webhook-handler-nextjs.ts).

## API surface

| Method | Purpose |
|---|---|
| `createInvoice({ amount, currency, ... })` | create an invoice (idempotent with `idempotencyKey`) |
| `getInvoice(invoiceId)` | reconciliation / polling / lost-webhook recovery |
| `cancelInvoice(invoiceId)` | cancel an unpaid invoice |
| `ping()` | liveness / configuration probe |
| `verifyWebhook(rawBody, signatureHeader)` | HMAC verification of a delivery |

Every method accepts `{ signal }` (standard `AbortSignal`) as the last option;
a per-request timeout (`timeoutMs`, default 15 s) is enforced via `AbortController`.

## Raw bodies for webhook verification (important)

The signature covers the **exact raw bytes**. Never verify re-serialized JSON:

- **Express**: enable the raw-body capture before the JSON parser:
  `app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }))`
- **Next.js App Router**: `await request.text()` in a `route.ts` with
  `export const runtime = "nodejs"` — that *is* the raw body.
- **Fastify**: `addContentTypeParser("application/json", { parseAs: "buffer" }, ...)`.

## Configuration

`new ZeroKYC({ apiKey, environment?, webhookSecret?, timeoutMs?, maxRetries?, baseUrl? })`

- `apiKey`: `pk_test_...` (sandbox) / `pk_live_...` (production).
- `environment`: `"sandbox" | "production"`; inferred from the key; a mismatch throws.
- `webhookSecret`: `whsec_...` from console → Webhooks (used by `verifyWebhook`).
- `baseUrl`: tests/local development only — the URL is defined centrally.

## Status normalization

Raw API statuses never leak into your billing logic:

| API (raw)                | `InvoiceStatus` |
|--------------------------|-----------------|
| `created`, `pending`     | `"PENDING"`     |
| `detecting`              | `"CONFIRMING"`  |
| `confirmed`              | `"PAID"`        |
| `underpaid`              | `"UNDERPAID"`   |
| `expired`                | `"EXPIRED"`     |
| `canceled`               | `"CANCELLED"`   |
| unknown                  | `"FAILED"` (alert) |

`invoice.isPaid` / `invoice.isTerminal` answer the common questions. Monetary
amounts are **decimal strings everywhere** — never JavaScript numbers.

## Idempotency

```ts
import { idempotencyKey } from "zkp-sdk-node";
idempotencyKey("whmcs", "invoice", 1042); // zerokyc:whmcs:invoice:1042 (<=120 chars)
```

A timeout + retry then returns **the same** invoice
(`response.idempotentReplay === true`) instead of a duplicate.

## Error handling & retries

| Error                    | HTTP          | Retried automatically? |
|--------------------------|---------------|------------------------|
| `AuthenticationError`    | 401 / 403     | never                  |
| `ValidationError`        | 400 / 422     | never                  |
| `RateLimitError`         | 429           | yes (Retry-After up to 5 s, max twice) |
| `APIError`               | 5xx, 402, 404 | only GET / idempotent POST |
| `NetworkError`           | transport/abort | only GET / idempotent POST (never a caller abort) |
| `WebhookVerificationError` | n/a         | n/a (machine-readable `.reason`) |

`RateLimitError.retryAfter` is the parsed Retry-After in seconds or `null`
(malformed, negative, fractional and HTTP-date values map to `null` safely).
Backoff is bounded exponential (300 ms → 600 ms → 1200 ms, capped by `maxRetries`).

## Webhook security checklist

- verify against the **exact raw body** (never re-serialized JSON);
- strict `t=`/`v1=` header format, lowercase hex, `timingSafeEqual` (built in);
- default ±300 s window (`new WebhookVerifier(secret, 600)` to widen);
- at-least-once delivery: `ReplayGuard.isDuplicate()` is a **pure** check —
  call `markProcessed()` only after the local order update succeeded;
- match invoice id / amount / asset before crediting (`matchesOrder()`);
- secrets never appear in exceptions or logs.

Self-test against the documented vector:

```ts
import { WebhookVerifier } from "zkp-sdk-node";

const event = new WebhookVerifier("whsec_zkp_test_vector_2026").verify(
  '{"id":"evt_test_001","type":"payment.confirmed","invoice_id":"inv_test_001"}',
  "t=1788788073,v1=ade537fa13aec79a6d1648bd7f197872066c161676c389243ab5c6b13fea7f52",
  { now: 1788788073 },
);
```

## Assets

USDT (TRC-20), USDC/USDT (Polygon, Arbitrum), BTC, XMR, TON, USDT-TON. Pin one
via `paymentCurrency: "USDT_TRON"`, or let the buyer choose with `"any"` (default).

## Node support & SemVer

Node 20.3 / 22 / 24 (CI-tested, minimum 20.3.0; 22+ recommended). ESM and CommonJS entry points
with full type declarations. SemVer: 0.x collects integration feedback,
breaking changes before 1.0 land in minor bumps and are listed in the
[CHANGELOG](CHANGELOG.md).

## Development

```bash
npm ci
npm run lint && npm run typecheck
npm test               # vitest
npm run build && npm pack --dry-run
```

## License

MIT — see [LICENSE](LICENSE).
