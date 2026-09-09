/** Status mapping, decimal comparisons, idempotency keys, replay guard. */

import { describe, expect, it } from "vitest";

import { idempotencyKey } from "../src/client.js";
import { compareDecimals, isValidDecimal, ReplayGuard, type EventStore } from "../src/replay.js";
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
  it("isDuplicate is pure until markProcessed (sync store)", async () => {
    const guard = new ReplayGuard(new InMemoryEventStore());
    expect(await guard.isDuplicate("evt_1")).toBe(false);
    expect(await guard.isDuplicate("evt_1")).toBe(false); // crash-safe: still unprocessed

    await guard.markProcessed("evt_1");
    expect(await guard.isDuplicate("evt_1")).toBe(true);
    expect(await guard.isDuplicate("evt_2")).toBe(false);
  });

  it("works with an async database-backed store", async () => {
    const store: EventStore = {
      async has(id: string): Promise<boolean> {
        await Promise.resolve();
        return id === "evt_9";
      },
      async markProcessed(_id: string): Promise<void> {
        await Promise.resolve();
      },
    };
    const guard = new ReplayGuard(store);
    expect(await guard.isDuplicate("evt_9")).toBe(true);
    expect(await guard.isDuplicate("evt_1")).toBe(false);
    await guard.markProcessed("evt_1"); // resolves without throwing
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

  it("matches the legacy docs-vector shape by bare ticker", () => {
    const guard = new ReplayGuard(new InMemoryEventStore());
    const legacy = WebhookEvent.fromJson({
      id: "evt_2",
      type: "payment.confirmed",
      invoice_id: "inv_9",
      data: { asset: "USDT_TRON", amount: "20.5" },
    });
    // bare ticker expectation: any network is acceptable
    expect(guard.matchesOrder(legacy, "inv_9", { minAmount: "19.90", asset: "USDT" })).toBe(true);
    // asset id expectation REQUIRES the webhook to carry the network
    expect(guard.matchesOrder(legacy, "inv_9", { minAmount: "19.90", asset: "USDT_TRON" })).toBe(false);
  });

  it("asset id expectations require a matching network (fail-closed)", () => {
    const guard = new ReplayGuard(new InMemoryEventStore());
    const mk = (network: string | null) =>
      WebhookEvent.fromJson({
        id: "e",
        type: "payment.confirmed",
        data: {
          invoice_id: "i",
          option: network === null
            ? { asset: "USDT", paid_amount: "20.5" }
            : { asset: "USDT", network, paid_amount: "20.5" },
        },
      });
    expect(guard.matchesOrder(mk(null), "i", { asset: "USDT_TRON" })).toBe(false); // missing network
    expect(guard.matchesOrder(mk("tron"), "i", { asset: "USDT_TRON" })).toBe(true); // correct
    expect(guard.matchesOrder(mk("polygon"), "i", { asset: "USDT_TRON" })).toBe(false); // wrong
    expect(guard.matchesOrder(mk(null), "i", { asset: "USDT" })).toBe(true); // ticker: any network
    expect(guard.matchesOrder(mk("polygon"), "i", { asset: "USDT" })).toBe(true);
  });

  it("fails closed on unparseable paid amounts (never 'enough')", () => {
    const guard = new ReplayGuard(new InMemoryEventStore());
    for (const bad of ["NaN", "Infinity", "abc", "1e3", "1.2.3", "", " 20 ", "-1"]) {
      const event = WebhookEvent.fromJson({
        id: "e",
        type: "payment.confirmed",
        data: { invoice_id: "i", option: { asset: "USDT", network: "tron", paid_amount: bad } },
      });
      expect(guard.matchesOrder(event, "i", { minAmount: "19.90" })).toBe(false);
    }
    // invalid expectation is also rejected instead of crashing
    const ok = WebhookEvent.fromJson({
      id: "e",
      type: "payment.confirmed",
      data: { invoice_id: "i", option: { asset: "USDT", network: "tron", paid_amount: "20.5" } },
    });
    expect(guard.matchesOrder(ok, "i", { minAmount: "abc" })).toBe(false);
    expect(guard.matchesOrder(ok, "i", { minAmount: "-1" })).toBe(false);
  });



  it("compares leading-zero decimals correctly (normalize before length)", () => {
    expect(Math.sign(compareDecimals("0002", "10"))).toBe(-1);
    expect(Math.sign(compareDecimals("10", "0002"))).toBe(1);
    expect(compareDecimals("00010", "10")).toBe(0);
    expect(compareDecimals("0000.50", "0.5")).toBe(0);
    expect(compareDecimals("000000", "0")).toBe(0);
    expect(compareDecimals("0010.000", "10")).toBe(0);
    expect(Math.sign(compareDecimals("00020.5", "19.90"))).toBe(1);
  });

  it("a leading-zero paid amount is never enough for a bigger order", () => {
    const guard = new ReplayGuard(new InMemoryEventStore());
    const event = WebhookEvent.fromJson({
      id: "e",
      type: "payment.confirmed",
      data: { invoice_id: "i", option: { asset: "USDT", network: "tron", paid_amount: "0002" } },
    });
    expect(guard.matchesOrder(event, "i", { minAmount: "10" })).toBe(false);
    // and the opposite direction is still accepted
    const rich = WebhookEvent.fromJson({
      id: "e2",
      type: "payment.confirmed",
      data: { invoice_id: "i", option: { asset: "USDT", network: "tron", paid_amount: "00020.5" } },
    });
    expect(guard.matchesOrder(rich, "i", { minAmount: "19.90" })).toBe(true);
  });

  it("throws on invalid decimal strings instead of comparing silently", () => {
    for (const bad of ["NaN", "Infinity", "abc", "1e3", "1.2.3", "", " 20 ", "-1", "1E-2", "12.", ".99"]) {
      expect(() => compareDecimals(bad, "1")).toThrowError(TypeError);
      expect(() => compareDecimals("1", bad)).toThrowError(TypeError);
      expect(isValidDecimal(bad)).toBe(false);
    }
    for (const good of ["0", "0.0", "1", "19.90", "0.0000001"]) {
      expect(isValidDecimal(good)).toBe(true);
    }
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
