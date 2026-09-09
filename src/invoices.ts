/**
 * Invoice creation options + payload building with local validation.
 *
 * Amounts are decimal STRINGS end to end (never JS numbers). Validation
 * accepts only plain finite positive decimals - the strict ^[0-9]+(\.[0-9]+)?$
 * grammar (no sign, exponent, NaN/Infinity spellings) with a redundant
 * finiteness/positivity check, so obvious mistakes never leave the process.
 */

import { ValidationError } from "./errors.js";

/** Plain decimal only: no sign, no exponent, no NaN/Infinity spellings. */
const AMOUNT_RE = /^[0-9]+(?:\.[0-9]+)?$/;

export interface CreateInvoiceOptions {
  /** Decimal string, e.g. "19.90". */
  amount: string;
  /** Base currency: "USD" | "EUR" | "RUB" | asset id. Default "USD". */
  currency?: string;
  paymentCurrency?: string;
  orderId?: string;
  description?: string;
  ttlMinutes?: number;
  webhookUrl?: string;
  successUrl?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface CreateInvoicePayload {
  amount: string;
  base_currency: string;
  payment_currency: string;
  order_id?: string;
  description?: string;
  ttl_minutes?: number;
  webhook_url?: string;
  success_url?: string;
  metadata?: Record<string, unknown>;
}

export function buildCreatePayload(options: CreateInvoiceOptions): CreateInvoicePayload {
  const { amount } = options;
  if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) {
    throw new ValidationError(`amount must be a plain positive decimal string, got ${JSON.stringify(amount)}`);
  }
  // belt and suspenders: the regex already rejects NaN/Infinity/0/negatives
  if (!isFinitePositiveDecimal(amount)) {
    throw new ValidationError(`amount must be a positive finite decimal, got ${JSON.stringify(amount)}`);
  }
  const currency = options.currency ?? "USD";
  if (!currency) {
    throw new ValidationError("currency must not be empty");
  }
  if (options.ttlMinutes !== undefined &&
      (!Number.isInteger(options.ttlMinutes) ||
       options.ttlMinutes < 10 || options.ttlMinutes > 4320)) {
    throw new ValidationError("ttlMinutes must be an integer between 10 and 4320");
  }
  if (options.orderId !== undefined && options.orderId.length > 255) {
    throw new ValidationError("orderId must be at most 255 characters");
  }
  if (options.description !== undefined && options.description.length > 500) {
    throw new ValidationError("description must be at most 500 characters");
  }
  if (options.webhookUrl !== undefined && options.webhookUrl.length > 2000) {
    throw new ValidationError("webhookUrl must be at most 2000 characters");
  }
  if (options.successUrl !== undefined && options.successUrl.length > 2000) {
    throw new ValidationError("successUrl must be at most 2000 characters");
  }

  const payload: CreateInvoicePayload = {
    amount, // stays a string - no float round-trip
    base_currency: currency,
    payment_currency: options.paymentCurrency ?? "any",
  };
  if (options.orderId !== undefined) {
    payload.order_id = options.orderId;
  }
  if (options.description !== undefined) {
    payload.description = options.description;
  }
  if (options.ttlMinutes !== undefined) {
    payload.ttl_minutes = options.ttlMinutes;
  }
  if (options.webhookUrl !== undefined) {
    payload.webhook_url = options.webhookUrl;
  }
  if (options.successUrl !== undefined) {
    payload.success_url = options.successUrl;
  }
  if (options.metadata && Object.keys(options.metadata).length > 0) {
    payload.metadata = options.metadata;
  }
  return payload;
}

/** Rejects "0", "0.000", all-zero decimals; grammar already excludes the rest. */
function isFinitePositiveDecimal(amount: string): boolean {
  const trimmed = amount.replace(/^0+(?=\d)/, "");
  return !/^0*(\.0+)?$/.test(trimmed);
}
