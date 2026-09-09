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
 */

import type { WebhookEvent } from "./models/webhook.js";

export interface EventStore {
  has(eventId: string): boolean;
  markProcessed(eventId: string): void;
}

/** Decimal-string comparison without floats: "19.9" >= "19.90" is true. */
export function compareDecimals(a: string, b: string): number {
  const norm = (v: string): { neg: boolean; int: string; frac: string } => {
    const negative = v.startsWith("-");
    const clean = negative ? v.slice(1) : v;
    const [int = "0", frac = ""] = clean.split(".");
    return { neg: negative, int: int.replace(/^0+(?=\d)/, ""), frac };
  };
  const an = norm(a);
  const bn = norm(b);
  if (an.neg !== bn.neg) {
    return an.neg ? -1 : 1;
  }
  const intCmp =
    an.int.length !== bn.int.length ? an.int.length - bn.int.length : an.int.localeCompare(bn.int);
  if (intCmp !== 0) {
    return an.neg ? -intCmp : intCmp || 0;
  }
  const scale = Math.max(an.frac.length, bn.frac.length);
  const af = an.frac.padEnd(scale, "0");
  const bf = bn.frac.padEnd(scale, "0");
  const fracCmp = af.localeCompare(bf);
  return (an.neg ? -fracCmp : fracCmp) || 0; // never -0
}

export interface MatchOrderOptions {
  minAmount?: string;
  /** Bare ticker ("USDT") or asset id ("USDT_TRON" - network must match too). */
  asset?: string;
}

export class ReplayGuard {
  constructor(private readonly store: EventStore) {}

  /** Pure check: true when the event was already processed. No side effects. */
  isDuplicate(eventId: string): boolean {
    return this.store.has(eventId);
  }

  /** Call only after the local order update has succeeded. */
  markProcessed(eventId: string): void {
    this.store.markProcessed(eventId);
  }

  /**
   * Signature validity alone is NOT enough to credit an order: match the
   * invoice id, the paid crypto amount (>= minAmount) and the asset.
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
      if (paid === null || compareDecimals(paid, options.minAmount) < 0) {
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
  const [paidTicker, paidRest] = paidRaw.split("_");
  if (paidTicker !== expTicker) {
    return false;
  }
  const paidNetwork = (event.paidNetwork ?? "").toLowerCase() || paidRest;
  if (expNetwork && paidNetwork && paidNetwork !== expNetwork) {
    return false;
  }
  return true;
}
