/**
 * Official Node.js/TypeScript SDK for the ZeroKYC Pay crypto payment gateway.
 *
 * Server-side only: API keys and webhook verification must never run in a
 * browser.
 */

export { ZeroKYC, idempotencyKey } from "./client.js";
export { Config, DEFAULT_BASE_URL } from "./config.js";
export {
  Invoice,
  CreateInvoiceResponse,
  type PaymentOption,
  type InvoiceObservation,
  type InvoiceData,
} from "./models/invoice.js";
export { WebhookEvent, type VerificationResult } from "./models/webhook.js";
export { WebhookVerifier, DEFAULT_TOLERANCE_SECONDS } from "./webhooks/verifier.js";
export { ReplayGuard, compareDecimals, type EventStore, type MatchOrderOptions } from "./replay.js";
export { StatusMapper, isTerminalStatus, type InvoiceStatus } from "./status.js";
export {
  ZeroKYCError,
  AuthenticationError,
  ValidationError,
  RateLimitError,
  APIError,
  NetworkError,
  WebhookVerificationError,
} from "./errors.js";
export { VERSION } from "./version.js";
