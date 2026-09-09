/**
 * HTTP client with typed error mapping and a bounded, idempotency-aware
 * retry policy. Adapters never talk to the API directly.
 *
 * Retry rules (identical to the PHP/Python SDKs):
 * - GET: retry NetworkError and selected retryable statuses (429/408/5xx);
 * - POST invoices: retry ONLY when an idempotency key is present;
 * - 429: honors Retry-After up to a 5s cap (plain non-negative integers
 *   only; malformed, negative, fractional and HTTP-date values safely map
 *   to retryAfter: null and never break error construction);
 * - 400/401/403/422: never retried;
 * - bounded exponential backoff (300ms -> 600ms -> 1200ms), no infinite loops.
 *
 * Requests accept an AbortSignal; a per-request timeout is enforced via
 * AbortController. Secrets never appear in exceptions.
 */

import { Config, type ConfigOptions } from "./config.js";
import {
  APIError,
  AuthenticationError,
  NetworkError,
  RateLimitError,
  ValidationError,
} from "./errors.js";
import { fetchTransport, sdkUserAgent, type FetchInit, type FetchLike, type HttpResponse } from "./http.js";
import { buildCreatePayload, type CreateInvoiceOptions } from "./invoices.js";
import { CreateInvoiceResponse, Invoice } from "./models/invoice.js";
import type { WebhookEvent } from "./models/webhook.js";
import { WebhookVerifier } from "./webhooks/verifier.js";

const RETRYABLE_STATUSES = new Set([429, 408]);
const RETRY_AFTER_CAP_SECONDS = 5;

/** Stable idempotency key: zerokyc:{platform}:{entity}:{id} (max 120 chars). */
export function idempotencyKey(...parts: Array<string | number>): string {
  const key = `zerokyc:${parts.join(":")}`;
  if (!key) {
    throw new ValidationError("idempotency key must not be empty");
  }
  if (key.length > 120) {
    throw new ValidationError("idempotency key must be at most 120 characters");
  }
  return key;
}

export interface RequestCallOptions {
  signal?: AbortSignal;
}

/** Injectable delay: sync fire-and-forget or (default) a real Promise-based
 *  sleep that actually waits; the retry loop awaits either form. */
export type Sleeper = (ms: number) => void | Promise<void>;

const defaultSleeper: Sleeper = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class ZeroKYC {
  readonly config: Config;
  private readonly fetchLike: (url: string, init: FetchInit) => Promise<HttpResponse>;
  private readonly sleeper: Sleeper;

  constructor(
    options: ConfigOptions & {
      fetchImpl?: FetchLike;
      /** Injectable for tests; default is a real Promise-based sleep. */
      sleeper?: Sleeper;
    } = { apiKey: "" },
  ) {
    this.config = new Config(options);
    this.fetchLike = options.fetchImpl ?? fetchTransport;
    this.sleeper = options.sleeper ?? defaultSleeper;
  }

  /** Create an invoice; with an idempotency key a timeout+retry returns the
   *  same invoice instead of creating a duplicate. */
  async createInvoice(options: CreateInvoiceOptions & RequestCallOptions): Promise<CreateInvoiceResponse> {
    const { signal, ...create } = options;
    const payload = buildCreatePayload(create);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (create.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = create.idempotencyKey;
    }
    const response = await this.request("POST", "/v1/invoices", {
      headers,
      body: JSON.stringify(payload),
      mayRetry: create.idempotencyKey !== undefined,
      expectedStatus: 201,
      signal,
    });
    const replay = (response.header("Idempotent-Replay") ?? "").toLowerCase() === "true";
    return new CreateInvoiceResponse(Invoice.fromJson(parseJson(response)), replay);
  }

  /** Reconciliation/recovery: poll a status server-to-server. */
  async getInvoice(invoiceId: string, options: RequestCallOptions = {}): Promise<Invoice> {
    const response = await this.request("GET", `/v1/invoices/${encodeURIComponent(invoiceId)}`, {
      mayRetry: true,
      expectedStatus: 200,
      signal: options.signal,
    });
    return Invoice.fromJson(parseJson(response));
  }

  async cancelInvoice(invoiceId: string, options: RequestCallOptions = {}): Promise<Invoice> {
    const response = await this.request(
      "POST",
      `/v1/invoices/${encodeURIComponent(invoiceId)}/cancel`,
      {
        headers: { "Content-Type": "application/json" },
        body: "{}",
        mayRetry: false,
        expectedStatus: 200,
        signal: options.signal,
      },
    );
    return Invoice.fromJson(parseJson(response));
  }

  /** Liveness/configuration probe; returns the decoded /v1/ping body. */
  async ping(options: RequestCallOptions = {}): Promise<Record<string, unknown>> {
    const response = await this.request("GET", "/v1/ping", {
      mayRetry: true,
      expectedStatus: 200,
      signal: options.signal,
    });
    return parseJson(response) as Record<string, unknown>;
  }

  /** Verify a delivery; throws WebhookVerificationError on any failure. */
  verifyWebhook(
    rawBody: string | Uint8Array,
    signatureHeader: string,
    options: { secret?: string } = {},
  ): WebhookEvent {
    return this.verifier(options.secret).verify(rawBody, signatureHeader);
  }

  verifier(secret?: string): WebhookVerifier {
    return new WebhookVerifier(secret ?? this.config.webhookSecret);
  }

  /** Await the sleeper; a caller abort during the wait stops the retry loop. */
  private async wait(ms: number, signal?: AbortSignal): Promise<void> {
    const sleep = Promise.resolve(this.sleeper(ms));
    if (!signal) {
      await sleep;
      return;
    }
    if (signal.aborted) {
      throw new NetworkError("aborted while waiting to retry");
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new NetworkError("aborted while waiting to retry"));
      signal.addEventListener("abort", onAbort, { once: true });
      void sleep.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private async request(
    method: string,
    path: string,
    opts: {
      headers?: Record<string, string>;
      body?: string;
      mayRetry: boolean;
      expectedStatus: number;
      signal?: AbortSignal;
    },
  ): Promise<HttpResponse> {
    let attempt = 0;
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.fetchLike(this.config.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: "application/json",
            "User-Agent": sdkUserAgent(),
            ...opts.headers,
          },
          body: opts.body,
          signal: opts.signal,
          redirect: "manual",
          timeoutMs: this.config.timeoutMs,
        });
      } catch (e) {
        if (!(e instanceof NetworkError)) {
          throw e;
        }
        // the caller cancelled: retrying their own abort is pointless
        if (opts.signal?.aborted) {
          throw e;
        }
        if (!opts.mayRetry || attempt >= this.config.maxRetries) {
          throw e;
        }
        await this.wait(backoffMs(attempt), opts.signal);
        attempt += 1;
        continue;
      }

      if (response.status === opts.expectedStatus) {
        return response;
      }

      if (
        (RETRYABLE_STATUSES.has(response.status) || response.status >= 500) &&
        opts.mayRetry &&
        attempt < this.config.maxRetries
      ) {
        const delayMs =
          response.status === 429
            ? retryAfterMs(response.header("Retry-After"))
            : backoffMs(attempt);
        if (delayMs !== null) {
          await this.wait(delayMs, opts.signal);
          attempt += 1;
          continue;
        }
        // Retry-After beyond the cap: fall through and surface the 429
      }

      throw mapError(response);
    }
  }
}

function parseJson(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new APIError("response was not valid JSON", response.status);
  }
}

function mapError(response: HttpResponse): Error {
  let error: Record<string, unknown> = {};
  try {
    const decoded = JSON.parse(response.body) as { error?: Record<string, unknown> };
    if (decoded && typeof decoded === "object" && typeof decoded.error === "object") {
      error = decoded.error;
    }
  } catch {
    // non-JSON error body
  }
  const message =
    typeof error.message === "string" && error.message
      ? error.message
      : `unexpected HTTP ${response.status}`;

  if (response.status === 401 || response.status === 403) {
    return new AuthenticationError(message);
  }
  if (response.status === 429) {
    return new RateLimitError(message, parseRetryAfter(response.header("Retry-After")));
  }
  if (response.status === 400 || response.status === 422) {
    return new ValidationError(message);
  }
  return new APIError(
    message,
    response.status,
    typeof error.code === "string" ? error.code : undefined,
    typeof error.doc_url === "string" ? error.doc_url : undefined,
  );
}

/** Seconds from Retry-After: plain non-negative integers only, else null. */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) {
    return null;
  }
  const value = header.trim();
  return /^\d+$/.test(value) ? Number(value) : null;
}

/** Delay for a 429 retry; null means "surface the error immediately". */
function retryAfterMs(header: string | null): number | null {
  if (header === null) {
    return backoffMs(0);
  }
  const seconds = parseRetryAfter(header);
  if (seconds === null) {
    // malformed or HTTP-date: unsupported -> retryAfter reported as null,
    // still retry on the default bounded backoff
    return backoffMs(0);
  }
  return seconds <= RETRY_AFTER_CAP_SECONDS ? seconds * 1000 : null;
}

function backoffMs(attempt: number): number {
  return 300 * 2 ** attempt;
}
