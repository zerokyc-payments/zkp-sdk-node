/**
 * At-least-once delivery protection and payment matching (P0).
 *
 * `isDuplicate()` is a PURE lookup: it never mutates the store. An event is
 * marked processed only via `markProcessed()` AFTER the local order update
 * succeeded - marking earlier would turn any crash in between into a
 * permanently unpaid order (the retry would be skipped as a duplicate).
 *
 * Concurrent deliveries of the same event can both pass `isDuplicate()`;
 * apps needing strict single-processing should implement an atomic claim
 * (INSERT ... ON CONFLICT / unique constraint) in their EventStore and use
 * it as the source of truth.
 *
 * Monetary validation is fail-closed: an unparseable amount never compares
 * as "enough" - `matchesOrder()` returns false and `compareDecimals()`
 * throws instead of silently comparing garbage.
 */

import type { WebhookEvent } from "./models/webhook.js";

/** Storage backed by your DB: sync (in-memory) or async - both awaited. */
export interface EventStore {
  has(eventId: string): boolean | Promise<boolean>;
  markProcessed(eventId: string): void | Promise<void>;
}

/** Plain non-negative decimal only: no sign, exponent, spaces, extra dots or
 *  NaN/Infinity spellings. Zero is a syntactically valid amount. */
const DECIMAL_RE = /^[0-9]+(?:\.[0-9]+)?$/;

/** True only for plain non-negative decimal strings (no float arithmetic). */
export function isValidDecimal(value: string): boolean {
  return typeof value === "string" && DECIMAL_RE.test(value);
}

/**
 * Compare two plain non-negative decimal strings WITHOUT floats.
 * Throws TypeError on anything that is not a plain decimal - garbage must
 * never compare silently (validate first; matchesOrder does).
 */
export function compareDecimals(a: string, b: string): number {
  for (const value of [a, b]) {
    if (!DECIMAL_RE.test(value)) {
      throw new TypeError(`not a plain non-negative decimal string: ${JSON.stringify(value)}`);
    }
  }
  const [ai = "0", af = ""] = a.split(".");
  const [bi = "0", bf = ""] = b.split(".");
  // normalize BEFORE comparing: leading zeros must not affect length/value
  // ("0002" is 2, not a 4-digit number greater than "10")
  const norm = (s: string): string => s.replace(/^0+(?=\d)/, "");
  const nAi = norm(ai);
  const nBi = norm(bi);
  const intCmp =
    nAi.length !== nBi.length ? nAi.length - nBi.length : nAi.localeCompare(nBi);
  const fracCmp = af.padEnd(bf.length, "0").localeCompare(bf.padEnd(af.length, "0"));
  return intCmp || fracCmp; // never -0 (0 stays 0 via ||)
}

export interface MatchOrderOptions {
  minAmount?: string;
  /** Bare ticker ("USDT": any network) or asset id ("USDT_TRON": the webhook
   *  MUST carry a matching network - a missing network is a mismatch). */
  asset?: string;
}

export class ReplayGuard {
  constructor(private readonly store: EventStore) {}

  /** Pure check: true when the event was already processed. No side effects. */
  async isDuplicate(eventId: string): Promise<boolean> {
    return await this.store.has(eventId);
  }

  /** Call only after the local order update has succeeded. */
  async markProcessed(eventId: string): Promise<void> {
    await this.store.markProcessed(eventId);
  }

  /**
   * Signature validity alone is NOT enough to credit an order: match the
   * invoice id, the paid crypto amount (>= minAmount) and the asset.
   * Fail-closed: invalid amount data means "not enough", never "paid".
   */
  matchesOrder(
    event: WebhookEvent,
    expectedInvoiceId: string,
    options: MatchOrderOptions = {},
  ): boolean {
    if (event.invoiceId !== expectedInvoiceId) {
      return false;
    }
    if (options.asset !== undefined && !assetMatches(event, options.asset)) {
      return false;
    }
    if (options.minAmount !== undefined) {
      const paid = event.paidAmount;
      if (paid === null || !isValidDecimal(paid) || !isValidDecimal(options.minAmount)) {
        return false;
      }
      if (compareDecimals(paid, options.minAmount) < 0) {
        return false;
      }
    }
    return true;
  }
}

function assetMatches(event: WebhookEvent, expected: string): boolean {
  const paidRaw = (event.paidAsset ?? "").toLowerCase();
  if (!paidRaw) {
    return false;
  }
  const [expTicker, expNetwork] = expected.toLowerCase().split("_");
  const [paidTicker] = paidRaw.split("_");
  if (paidTicker !== expTicker) {
    return false;
  }
  if (expNetwork !== undefined && expNetwork !== "") {
    // asset id expected: the webhook MUST carry the network explicitly;
    // missing or different network is a mismatch (fail-closed)
    const paidNetwork = (event.paidNetwork ?? "").toLowerCase();
    if (paidNetwork !== expNetwork) {
      return false;
    }
  }
  return true;
}
