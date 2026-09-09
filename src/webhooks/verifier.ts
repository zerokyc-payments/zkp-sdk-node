/**
 * Webhook signature verification - security critical (P0).
 *
 * Every delivery carries one header:
 *
 *     X-ZKP-Signature: t=<unix seconds>,v1=<64-char lowercase hex>
 *
 * v1 = HMAC-SHA256(webhookSecret, "{t}.{rawBody}") where rawBody is the exact
 * request body as received - never re-serialized JSON. Verification is strict
 * (header format, ±tolerance window) and constant-time (timingSafeEqual).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { WebhookVerificationError as WVE } from "../errors.js";
import { WebhookEvent, type VerificationResult } from "../models/webhook.js";

const HEADER_RE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

export const DEFAULT_TOLERANCE_SECONDS = 300;

const MESSAGES: Record<string, string> = {
  [WVE.MISSING_HEADER]: "X-ZKP-Signature header is missing",
  [WVE.MALFORMED_HEADER]:
    "signature header is malformed (expected t=<int>,v1=<64 lowercase hex>)",
  [WVE.STALE_TIMESTAMP]: "signature timestamp is outside the tolerance window (stale)",
  [WVE.FUTURE_TIMESTAMP]: "signature timestamp is outside the tolerance window (future)",
  [WVE.SIGNATURE_MISMATCH]: "signature does not match the raw body",
  [WVE.MALFORMED_PAYLOAD]: "verified body is not a JSON object",
};

export interface VerifyOptions {
  /** Override `now` (unix seconds) for tests. */
  now?: number;
  /** Signature secret override (config webhookSecret used when omitted). */
  secret?: string;
  /** Tolerance window in seconds, default 300. */
  toleranceSeconds?: number;
}

export class WebhookVerifier {
  private readonly secret: string;
  readonly toleranceSeconds: number;

  constructor(webhookSecret: string, toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS) {
    if (!webhookSecret) {
      throw new Error("webhook secret must not be empty");
    }
    if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 1) {
      throw new Error("tolerance must be at least 1 second");
    }
    this.secret = webhookSecret;
    this.toleranceSeconds = toleranceSeconds;
  }

  /** Verify and decode; throws WebhookVerificationError on any failure. */
  verify(
    rawBody: string | Uint8Array,
    signatureHeader: string,
    options: { now?: number } = {},
  ): WebhookEvent {
    const result = this.check(rawBody, signatureHeader, options);
    if (!result.event) {
      throw new WVE(MESSAGES[result.reason ?? ""] ?? "verification failed", result.reason ?? "invalid");
    }
    return result.event;
  }

  /** Non-throwing variant returning a VerificationResult. */
  check(
    rawBody: string | Uint8Array,
    signatureHeader: string,
    options: { now?: number } = {},
  ): VerificationResult {
    if (!signatureHeader) {
      return { valid: false, reason: WVE.MISSING_HEADER, event: null };
    }
    const match = HEADER_RE.exec(signatureHeader);
    if (!match) {
      return { valid: false, reason: WVE.MALFORMED_HEADER, event: null };
    }
    const [, timestamp, signature] = match as unknown as [string, string, string];

    const now = options.now ?? Math.floor(Date.now() / 1000);
    const skew = now - Number(timestamp);
    if (skew > this.toleranceSeconds) {
      return { valid: false, reason: WVE.STALE_TIMESTAMP, event: null };
    }
    if (-skew > this.toleranceSeconds) {
      return { valid: false, reason: WVE.FUTURE_TIMESTAMP, event: null };
    }

    const expected = this.signPayload(timestamp, rawBody);
    if (
      expected.length !== signature.length ||
      !timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"))
    ) {
      return { valid: false, reason: WVE.SIGNATURE_MISMATCH, event: null };
    }

    let payload: unknown;
    try {
      const text = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
      payload = JSON.parse(text);
    } catch {
      return { valid: false, reason: WVE.MALFORMED_PAYLOAD, event: null };
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { valid: false, reason: WVE.MALFORMED_PAYLOAD, event: null };
    }

    try {
      return { valid: true, reason: null, event: WebhookEvent.fromJson(payload) };
    } catch {
      return { valid: false, reason: WVE.MALFORMED_PAYLOAD, event: null };
    }
  }

  /** Build a signature header for a body (tests and local replay tooling). */
  sign(rawBody: string | Uint8Array, timestamp?: number): string {
    const t = timestamp ?? Math.floor(Date.now() / 1000);
    return `t=${t},v1=${this.signPayload(String(t), rawBody)}`;
  }

  private signPayload(timestamp: string, rawBody: string | Uint8Array): string {
    const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
    return createHmac("sha256", this.secret).update(timestamp + ".").update(body).digest("hex");
  }
}
