/** Status mapping, decimal comparisons, idempotency keys, replay guard. */

import { describe, expect, it } from "vitest";

import { idempotencyKey } from "../src/client.js";
import { compareDecimals, ReplayGuard, type EventStore } from "../src/replay.js";
import { WebhookEvent } from "../src/models/webhook.js";
import { StatusMapper } from "../src/status.js";

class InMemoryEventStore implements EventStore {
  private readonly seen = new Set<string>();
  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }
  markProcessed(eventId: string): void {
    this.seen.add(eventId);
  }
}

describe("StatusMapper", () => {
  it.each([
    ["created", "PENDING"],
    ["pending", "PENDING"],
    ["detecting", "CONFIRMING"],
    ["confirmed", "PAID"],
    ["underpaid", "UNDERPAID"],
    ["expired", "EXPIRED"],
    ["canceled", "CANCELLED"],
  ])("maps %s -> %s", (raw, expected) => {
    expect(StatusMapper.normalize(raw)).toBe(expected);
  });

  it("maps unknown statuses to null and fails explicitly", () => {
    expect(StatusMapper.normalize("something-new")).toBeNull();
    expect(() => StatusMapper.normalizeOrFail("nope")).toThrowError(/unknown/);
  });

  it("knows terminal and paid states", () => {
    for (const raw of ["confirmed", "underpaid", "expired", "canceled"]) {
      expect(StatusMapper.isTerminal(raw)).toBe(true);
    }
    for (const raw of ["created", "pending", "detecting"]) {
      expect(StatusMapper.isTerminal(raw)).toBe(false);
    }
    expect(StatusMapper.isPaid("confirmed")).toBe(true);
    expect(StatusMapper.isPaid("detecting")).toBe(false);
  });
});

describe("compareDecimals", () => {
  it.each([
    ["1.5", "1.5", 0],
    ["2", "10", -1],
    ["10.0000001", "10", 1],
    ["0.1", "0.0999", 1],
    ["19.90", "19.9", 0],
    ["0", "0.000", 0],
    ["1000000.01", "1000000.0099", 1],
  ])("%s vs %s", (a, b, expected) => {
    expect(Math.sign(compareDecimals(a, b))).toBe(expected);
  });
});

describe("idempotencyKey", () => {
  it("formats zerokyc:{platform}:{entity}:{id}", () => {
    expect(idempotencyKey("whmcs", "invoice", 1042)).toBe("zerokyc:whmcs:invoice:1042");
  });
  it("rejects keys over 120 chars", () => {
    expect(() => idempotencyKey("p", "x".repeat(100), "y".repeat(30))).toThrowError(/120/);
  });
});

describe("ReplayGuard", () => {
  it("isDuplicate is pure until markProcessed", () => {
    const guard = new ReplayGuard(new InMemoryEventStore());
    expect(guard.isDuplicate("evt_1")).toBe(false);
    expect(guard.isDuplicate("evt_1")).toBe(false); // crash-safe: still unprocessed

    guard.markProcessed("evt_1");
    expect(guard.isDuplicate("evt_1")).toBe(true);
    expect(guard.isDuplicate("evt_2")).toBe(false);
  });

  const prodEvent = WebhookEvent.fromJson({
    id: "evt_1",
    type: "payment.confirmed",
    data: {
      invoice_id: "inv_9",
      option: { asset: "USDT", network: "tron", paid_amount: "20.5" },
    },
  });

  it("matches the production payload shape (ticker and asset id)", () => {
    const guard = new ReplayGuard(new InMemoryEventStore());
    expect(guard.matchesOrder(prodEvent, "inv_9")).toBe(true);
    expect(guard.matchesOrder(prodEvent, "inv_9", { minAmount: "19.90", asset: "USDT" })).toBe(true);
    expect(guard.matchesOrder(prodEvent, "inv_9", { minAmount: "19.90", asset: "USDT_TRON" })).toBe(true);
    expect(guard.matchesOrder(prodEvent, "inv_9", { minAmount: "20.5", asset: "USDT_TRON" })).toBe(true);
    expect(guard.matchesOrder(prodEvent, "inv_OTHER")).toBe(false);
    expect(guard.matchesOrder(prodEvent, "inv_9", { minAmount: "20.6" })).toBe(false);
    expect(guard.matchesOrder(prodEvent, "inv_9", { minAmount: "19.90", asset: "BTC" })).toBe(false);
    expect(guard.matchesOrder(prodEvent, "inv_9", { minAmount: "19.90", asset: "USDT_BTC" })).toBe(false);
  });

  it("matches the legacy docs-vector shape", () => {
    const guard = new ReplayGuard(new InMemoryEventStore());
    const legacy = WebhookEvent.fromJson({
      id: "evt_2",
      type: "payment.confirmed",
      invoice_id: "inv_9",
      data: { asset: "USDT_TRON", amount: "20.5" },
    });
    expect(guard.matchesOrder(legacy, "inv_9", { minAmount: "19.90", asset: "USDT_TRON" })).toBe(true);
  });


  it("handles negative and zero-sign decimals without float drift", () => {
    expect(Math.sign(compareDecimals("-1", "1"))).toBe(-1);
    expect(Math.sign(compareDecimals("1", "-1"))).toBe(1);
    expect(Math.sign(compareDecimals("-2.5", "-1"))).toBe(-1);
    expect(Math.sign(compareDecimals("-1", "-2.5"))).toBe(1);
    expect(Math.sign(compareDecimals("-1", "-1.0"))).toBe(0);
  });

  it("refuses asset matching when the event carries no asset", () => {
    const guard = new ReplayGuard(new InMemoryEventStore());
    const bare = WebhookEvent.fromJson({ id: "e", type: "payment.confirmed", data: { invoice_id: "i" } });
    expect(guard.matchesOrder(bare, "i", { asset: "USDT" })).toBe(false);
  });

  it("refuses to match when amount data is missing", () => {
    const guard = new ReplayGuard(new InMemoryEventStore());
    const event = WebhookEvent.fromJson({
      id: "e",
      type: "invoice.created",
      data: { invoice_id: "i" },
    });
    expect(guard.matchesOrder(event, "i", { minAmount: "1.00" })).toBe(false);
  });
});
