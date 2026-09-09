/**
 * Typed error hierarchy.
 *
 * Mapping: 401/403 -> AuthenticationError, 400/422 -> ValidationError,
 * 429 -> RateLimitError (carries retryAfter seconds when sent), 5xx/402/404
 * -> APIError, transport failures (timeout/DNS/connect/abort) ->
 * NetworkError, webhook verification -> WebhookVerificationError
 * (machine-readable `reason`).
 *
 * Secrets never appear in messages: they carry API-provided text only.
 */

export class ZeroKYCError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 401/403 from the API: missing/invalid key or forbidden scope. Never retried. */
export class AuthenticationError extends ZeroKYCError {}

/** 400/422 from the API (or local request validation). Never retried. */
export class ValidationError extends ZeroKYCError {}

/** 429 from the API; `retryAfter` carries Retry-After seconds when parseable. */
export class RateLimitError extends ZeroKYCError {
  constructor(
    message: string,
    public readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

/** Unexpected API error (5xx, 402 cutoff, 404, malformed envelope). */
export class APIError extends ZeroKYCError {
  constructor(
    message: string,
    public readonly status: number = 0,
    public readonly errorCode?: string,
    public readonly docUrl?: string,
  ) {
    super(message);
  }
}

/** Transport failure: DNS, connect, TLS, timeout or abort. */
export class NetworkError extends ZeroKYCError {}

/** Webhook verification failed; `reason` is machine-readable. */
export class WebhookVerificationError extends ZeroKYCError {
  static readonly MISSING_HEADER = "missing_header";
  static readonly MALFORMED_HEADER = "malformed_header";
  static readonly STALE_TIMESTAMP = "stale_timestamp";
  static readonly FUTURE_TIMESTAMP = "future_timestamp";
  static readonly SIGNATURE_MISMATCH = "signature_mismatch";
  static readonly MALFORMED_PAYLOAD = "malformed_payload";

  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
  }
}
