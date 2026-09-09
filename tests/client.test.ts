/** Client behaviour: DTO parsing, replay flag, error mapping, retry policy,
 * abort/timeout, configuration guards, amount validation. */

import { describe, expect, it } from "vitest";

import { ZeroKYC, idempotencyKey } from "../src/client.js";
import {
  APIError,
  AuthenticationError,
  NetworkError,
  RateLimitError,
  ValidationError,
} from "../src/errors.js";
import { fetchTransport, httpResponse, type FetchInit } from "../src/http.js";

const BASE = "https://api.test";

function invoicePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "inv_123",
    order_id: "INV-1042",
    description: null,
    amount: "19.90",
    base_currency: "USD",
    payment_currency: "any",
    status: "created",
    ttl_minutes: 360,
    expires_at: "2026-09-08T12:00:00Z",
    created_at: "2026-09-08T06:00:00Z",
    checkout_url: "https://pay.test/pay/inv_123",
    metadata: {},
    options: [
      { asset: "USDT_TRON", network: "tron", payment_address: "Tabc", amount_crypto: "19.9", rate: "1", status: "open" },
      { asset: "BTC", network: "bitcoin", payment_address: "bc1q", amount_crypto: "0.0002", rate: "99000", status: "open" },
    ],
    observations: [],
    paid_amount: null,
    paid_asset: null,
    ...overrides,
  };
}

type Recorded = { init: FetchInit; url: string };

function makeSdk(
  respond: (call: Recorded) => HttpResponse | Promise<HttpResponse>,
  slept: number[] = [],
) {
  const calls: Recorded[] = [];
  const fetchImpl = async (url: string, init: FetchInit): Promise<HttpResponse> => {
    const call = { init, url };
    calls.push(call);
    return await respond(call);
  };
  const sdk = new ZeroKYC({
    apiKey: "pk_test_demo",
    environment: "sandbox",
    baseUrl: BASE,
    fetchImpl,
    sleeper: (ms) => slept.push(ms),
  });
  return { sdk, calls, slept };
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  httpResponse(status, JSON.stringify(body), headers);

describe("ZeroKYC client", () => {
  it("createInvoice parses typed models", async () => {
    const { sdk } = makeSdk(() => jsonResponse(201, invoicePayload(), { "Idempotent-Replay": "false" }));
    const result = await sdk.createInvoice({
      amount: "19.90",
      currency: "USD",
      orderId: "INV-1042",
      idempotencyKey: idempotencyKey("test", "invoice", 1042),
    });

    expect(result.invoice.id).toBe("inv_123");
    expect(result.invoice.status).toBe("PENDING");
    expect(result.invoice.rawStatus).toBe("created");
    expect(result.invoice.checkoutUrl).toBe("https://pay.test/pay/inv_123");
    expect(result.invoice.options).toHaveLength(2);
    expect(result.invoice.option("USDT_TRON")?.amount_crypto).toBe("19.9");
    expect(result.invoice.option("SOL")).toBeNull();
    expect(result.idempotentReplay).toBe(false);
  });

  it("flags an idempotent replay from the header (case-insensitive)", async () => {
    const { sdk } = makeSdk(() => jsonResponse(201, invoicePayload(), { "Idempotent-Replay": "TRUE" }));
    const result = await sdk.createInvoice({ amount: "5.00" });
    expect(result.idempotentReplay).toBe(true);
  });

  it("sends the idempotency key header", async () => {
    const { sdk, calls } = makeSdk(() => jsonResponse(201, invoicePayload()));
    await sdk.createInvoice({ amount: "5.00", idempotencyKey: "zerokyc:t:i:1" });
    expect(calls[0]?.init.headers["Idempotency-Key"]).toBe("zerokyc:t:i:1");
  });

  it("keeps amounts as strings in the payload (no float round-trip)", async () => {
    const { sdk, calls } = makeSdk(() => jsonResponse(201, invoicePayload()));
    await sdk.createInvoice({ amount: "0.1" });
    expect(calls[0]?.init.body).toContain('"amount":"0.1"');
  });

  it("getInvoice maps paid state", async () => {
    const { sdk } = makeSdk(() =>
      jsonResponse(200, invoicePayload({ status: "confirmed", paid_amount: "19.9", paid_asset: "USDT_TRON" })),
    );
    const invoice = await sdk.getInvoice("inv_123");
    expect(invoice.isPaid).toBe(true);
    expect(invoice.status).toBe("PAID");
    expect(invoice.paidAmount).toBe("19.9");
  });

  it.each([
    [401, AuthenticationError],
    [403, AuthenticationError],
    [400, ValidationError],
    [422, ValidationError],
    [429, RateLimitError],
    [500, APIError],
    [402, APIError],
    [404, APIError],
  ])("maps HTTP %i to %p", async (status, ctor) => {
    const { sdk } = makeSdk(() => jsonResponse(status, { error: { code: "x", message: "boom" } }));
    await expect(sdk.getInvoice("inv_1")).rejects.toBeInstanceOf(ctor);
    await expect(sdk.getInvoice("inv_1")).rejects.toThrowError("boom");
  });

  it("rejects invalid invoice envelopes with field-specific errors", async () => {
    // one mutated field per case, everything else valid
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ id: "" }, /field 'id'/],
      [{ status: 123 }, /field 'status' must be a non-empty string/],
      [{ amount: 123 }, /field 'amount' must be a decimal string/],
      [{ amount: "NaN" }, /field 'amount' must be a decimal string/],
      [{ amount: "1e3" }, /field 'amount' must be a decimal string/],
      [{ options: "bad" }, /field 'options' must be an array/],
      [{ observations: {} }, /field 'observations' must be an array/],
      [{ metadata: [] }, /field 'metadata' must be a JSON object/],
      [{ ttl_minutes: "360" }, /field 'ttl_minutes' must be an integer/],
      [{ paid_amount: 10 }, /'paid_amount' must be a decimal string or null/],
      [{ paid_asset: {} }, /'paid_asset' must be a string or null/],
      [{ order_id: 5 }, /'order_id' must be a string or null/],
      [{
        options: [{ asset: "USDT_TRON", network: "tron", payment_address: "T",
                    amount_crypto: "1.5", rate: "1", status: 5 }],
      }, /options\[0\]\.status/],
      [{
        options: [{ asset: "USDT_TRON", network: "tron", payment_address: "T",
                    amount_crypto: 1.5, rate: "1", status: "open" }],
      }, /options\[0\]\.amount_crypto/],
    ];
    for (const [overrides, pattern] of cases) {
      const payload = { ...invoicePayload(), ...overrides };
      const { sdk } = makeSdk(() => jsonResponse(200, payload));
      await expect(sdk.getInvoice("inv_1")).rejects.toThrowError(pattern);
    }
  });

  it("accepts a fully valid invoice response and keeps unknown fields in raw", async () => {
    const { sdk } = makeSdk(() =>
      jsonResponse(200, invoicePayload({ future_field: { nested: true } })),
    );
    const invoice = await sdk.getInvoice("inv_123");
    expect(invoice.amount).toBe("19.90");
    expect(typeof invoice.amount).toBe("string");
    expect(Array.isArray(invoice.options)).toBe(true);
    expect(typeof invoice.ttlMinutes).toBe("number");
    expect(invoice.raw["future_field"]).toEqual({ nested: true });
  });
});

describe("amount validation", () => {
  it.each(["19.90", "1", "0.01", "1000000.000001", "999999999999"])(
    "accepts %s",
    async (amount) => {
      const { sdk } = makeSdk(() => jsonResponse(201, invoicePayload()));
      const result = await sdk.createInvoice({ amount });
      expect(result.invoice.id).toBe("inv_123");
    },
  );

  it.each([
    "NaN",
    "Infinity",
    "-Infinity",
    "0",
    "0.0",
    "00.00",
    "-1",
    "-0.5",
    "",
    "   ",
    "abc",
    "19,90",
    "1e3",
    "1E-2",
    "0x10",
    "12.",
    ".99",
    "+1",
    "1 000",
    "1_000",
    "ноль",
  ])("rejects %s with ValidationError", async (amount) => {
    const { sdk } = makeSdk(() => jsonResponse(201, invoicePayload()));
    await expect(sdk.createInvoice({ amount })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects non-string amounts (JS numbers are never valid)", async () => {
    const { sdk } = makeSdk(() => jsonResponse(201, invoicePayload()));
    for (const bad of [19.9, 100, null, undefined, Number.NaN]) {
      await expect(sdk.createInvoice({ amount: bad as unknown as string })).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
  });
});

describe("retries", () => {
  it("retries GET on network errors with bounded backoff", async () => {
    let calls = 0;
    const slept: number[] = [];
    const sdk = new ZeroKYC({
      apiKey: "pk_test_demo",
      environment: "sandbox",
      baseUrl: BASE,
      fetchImpl: async () => {
        calls += 1;
        throw new NetworkError("timeout");
      },
      sleeper: (ms) => slept.push(ms),
    });
    await expect(sdk.getInvoice("inv_1")).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(3); // 1 + 2 retries
    expect(slept).toEqual([300, 600]);
  });

  it("does not retry POST without an idempotency key", async () => {
    let calls = 0;
    const sdk = new ZeroKYC({
      apiKey: "pk_test_demo",
      environment: "sandbox",
      baseUrl: BASE,
      fetchImpl: async () => {
        calls += 1;
        throw new NetworkError("dns");
      },
      sleeper: () => {},
    });
    await expect(sdk.createInvoice({ amount: "5.00" })).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(1);
  });

  it("retries POST with an idempotency key and succeeds", async () => {
    let calls = 0;
    const sdk = new ZeroKYC({
      apiKey: "pk_test_demo",
      environment: "sandbox",
      baseUrl: BASE,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          throw new NetworkError("timeout");
        }
        return jsonResponse(201, invoicePayload());
      },
      sleeper: () => {},
    });
    const result = await sdk.createInvoice({ amount: "5.00", idempotencyKey: "zerokyc:t:i:1" });
    expect(result.invoice.id).toBe("inv_123");
    expect(calls).toBe(2);
  });

  it("retries 5xx on GET then succeeds", async () => {
    const responses = [503, 503, 200];
    let calls = 0;
    const sdk = new ZeroKYC({
      apiKey: "pk_test_demo",
      environment: "sandbox",
      baseUrl: BASE,
      fetchImpl: async () => {
        const status = responses[calls];
        calls += 1;
        return jsonResponse(status, status === 200 ? invoicePayload() : { error: { message: "oops" } });
      },
      sleeper: () => {},
    });
    const invoice = await sdk.getInvoice("inv_1");
    expect(invoice.id).toBe("inv_123");
    expect(calls).toBe(3);
  });
});

describe("Retry-After handling", () => {
  const HTTP_DATE = "Wed, 21 Oct 2026 07:28:00 GMT";

  function rateLimited(retryAfter: string | null) {
    const slept: number[] = [];
    const headers: Record<string, string> = retryAfter === null ? {} : { "Retry-After": retryAfter };
    const sdk = new ZeroKYC({
      apiKey: "pk_test_demo",
      environment: "sandbox",
      baseUrl: BASE,
      fetchImpl: async () =>
        jsonResponse(429, { error: { code: "rate_limited", message: "slow down" } }, headers),
      sleeper: (ms) => slept.push(ms),
    });
    return { sdk, slept };
  }

  it.each([
    ["3", 3, [3000, 3000]],
    ["0", 0, [0, 0]],
    ["9", 9, []],
    ["not-a-number", null, [300, 300]],
    [HTTP_DATE, null, [300, 300]],
    ["-1", null, [300, 300]],
    ["1.5", null, [300, 300]],
    [null, null, [300, 300]],
  ])("Retry-After %j -> retryAfter %s, sleeps %j", async (header, retryAfter, sleeps) => {
    const { sdk, slept } = rateLimited(header);
    const err = await sdk.getInvoice("inv_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(retryAfter);
    expect(slept).toEqual(sleeps);
    expect(slept.every((ms) => ms >= 0)).toBe(true);
  });

  it("never raises ValueError-style surprises from a malformed header", async () => {
    for (const header of ["not-a-number", HTTP_DATE, "-1", "1.5", ""]) {
      const { sdk } = rateLimited(header);
      const err = await sdk.getInvoice("inv_1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBeNull();
    }
  });
});

describe("abort and timeout", () => {
  it("surfaces caller aborts as NetworkError without retries on POST", async () => {
    // real transport: fetch rejects on abort and is wrapped into NetworkError
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    let calls = 0;
    const sdk = new ZeroKYC({
      apiKey: "pk_test_demo",
      environment: "sandbox",
      baseUrl: BASE,
      fetchImpl: async (url, init) => {
        calls += 1;
        return fetchTransport(url, init);
      },
      sleeper: () => {},
    });
    await expect(
      sdk.createInvoice({ amount: "5.00", idempotencyKey: "zerokyc:t:i:1", signal: controller.signal }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(1);
  });

  it("enforces the configured request timeout via AbortController", async () => {
    const seenTimeouts: Array<number | undefined> = [];
    const sdk = new ZeroKYC({
      apiKey: "pk_test_demo",
      environment: "sandbox",
      baseUrl: BASE,
      timeoutMs: 2500,
      fetchImpl: async (_url, init) => {
        seenTimeouts.push(init.timeoutMs);
        return jsonResponse(200, invoicePayload());
      },
      sleeper: () => {},
    });
    await sdk.getInvoice("inv_1");
    expect(seenTimeouts[0]).toBe(2500);
  });
});

describe("configuration guards", () => {
  it("refuses a sandbox key in production", () => {
    expect(
      () => new ZeroKYC({ apiKey: "pk_test_demo", environment: "production" }),
    ).toThrowError(/sandbox key/);
  });

  it("refuses a live key in sandbox", () => {
    expect(
      () => new ZeroKYC({ apiKey: "pk_live_demo", environment: "sandbox" }),
    ).toThrowError(/not a sandbox key/);
  });

  it("infers the environment from the key", () => {
    expect(new ZeroKYC({ apiKey: "pk_test_demo" }).config.isSandbox).toBe(true);
    expect(new ZeroKYC({ apiKey: "pk_live_demo" }).config.isSandbox).toBe(false);
  });
});

describe("secrets", () => {
  it("never leak into exception messages", async () => {
    const { sdk } = makeSdk(() =>
      jsonResponse(401, { error: { code: "unauthorized", message: "invalid key" } }),
    );
    const err = await sdk.getInvoice("inv_1").catch((e: unknown) => e);
    expect(String(err)).not.toContain("pk_test_demo");
    expect(String(err)).not.toContain("Bearer");
  });
});

describe("sleeper semantics", () => {
  it("awaits the sleeper promise before the next attempt (no fire-and-forget)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    let calls = 0;
    const sdk = new ZeroKYC({
      apiKey: "pk_test_demo",
      environment: "sandbox",
      baseUrl: BASE,
      fetchImpl: async () => {
        calls += 1;
        order.push(`attempt${calls}`);
        throw new NetworkError("timeout");
      },
      sleeper: (ms) => {
        order.push(`sleep${ms}`);
        return gate; // stays pending until the test releases it
      },
    });
    const pending = sdk.getInvoice("inv_1").catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toBe(1); // second attempt must NOT start while sleeping
    expect(order).toEqual(["attempt1", "sleep300"]);

    release();
    const err = await pending;
    expect(err).toBeInstanceOf(NetworkError);
    expect(order).toEqual(["attempt1", "sleep300", "attempt2", "sleep600", "attempt3"]);
    expect(calls).toBe(3);
  });

  it("accepts sync sleepers too (fire-and-forget back-compat)", async () => {
    let calls = 0;
    const sdk = new ZeroKYC({
      apiKey: "pk_test_demo",
      environment: "sandbox",
      baseUrl: BASE,
      fetchImpl: async () => {
        calls += 1;
        throw new NetworkError("timeout");
      },
      sleeper: () => {
        /* sync void */
      },
    });
    await expect(sdk.getInvoice("inv_1")).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toBe(3);
  });
});
