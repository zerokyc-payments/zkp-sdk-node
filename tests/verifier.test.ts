/** Webhook verification - same cases and vector as the PHP/Python SDKs. */

import { describe, expect, it } from "vitest";

import { WebhookVerificationError } from "../src/errors.js";
import { WebhookEvent } from "../src/models/webhook.js";
import { WebhookVerifier } from "../src/webhooks/verifier.js";

const VECTOR_SECRET = "whsec_zkp_test_vector_2026";
const VECTOR_BODY =
  '{"id":"evt_test_001","type":"payment.confirmed","invoice_id":"inv_test_001"}';
const VECTOR_TS = 1_788_788_073;
const VECTOR_SIG = "ade537fa13aec79a6d1648bd7f197872066c161676c389243ab5c6b13fea7f52";
const VECTOR_HEADER = `t=${VECTOR_TS},v1=${VECTOR_SIG}`;

const make = (secret = VECTOR_SECRET, tolerance = 300) => new WebhookVerifier(secret, tolerance);

describe("WebhookVerifier", () => {
  it("accepts the documented test vector", () => {
    const event = make().verify(VECTOR_BODY, VECTOR_HEADER, { now: VECTOR_TS });
    expect(event.id).toBe("evt_test_001");
    expect(event.type).toBe("payment.confirmed");
    expect(event.invoiceId).toBe("inv_test_001");
    expect(event.isPaymentConfirmed).toBe(true);
  });

  it("accepts Uint8Array raw bodies", () => {
    const event = make().verify(new TextEncoder().encode(VECTOR_BODY), VECTOR_HEADER, {
      now: VECTOR_TS,
    });
    expect(event.id).toBe("evt_test_001");
  });

  it("rejects a wrong secret", () => {
    expect(() =>
      new WebhookVerifier("whsec_some_other_secret").verify(VECTOR_BODY, VECTOR_HEADER, {
        now: VECTOR_TS,
      }),
    ).toThrowError(/signature does not match/);
  });

  it("rejects a modified body", () => {
    const forged = VECTOR_BODY.replace("inv_test_001", "inv_evil_999");
    const result = make().check(forged, VECTOR_HEADER, { now: VECTOR_TS });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe(WebhookVerificationError.SIGNATURE_MISMATCH);
  });

  it("rejects stale and future timestamps", () => {
    expect(make().check(VECTOR_BODY, VECTOR_HEADER, { now: VECTOR_TS + 301 }).reason).toBe(
      WebhookVerificationError.STALE_TIMESTAMP,
    );
    expect(make().check(VECTOR_BODY, VECTOR_HEADER, { now: VECTOR_TS - 301 }).reason).toBe(
      WebhookVerificationError.FUTURE_TIMESTAMP,
    );
  });

  it("accepts the edge of the tolerance window", () => {
    expect(make().check(VECTOR_BODY, VECTOR_HEADER, { now: VECTOR_TS + 300 }).valid).toBe(true);
  });

  it.each([
    ["", WebhookVerificationError.MISSING_HEADER],
    ["garbage", WebhookVerificationError.MALFORMED_HEADER],
    [`t=abc,v1=${VECTOR_SIG}`, WebhookVerificationError.MALFORMED_HEADER],
    [`t=${VECTOR_TS}`, WebhookVerificationError.MALFORMED_HEADER],
    [`v1=${VECTOR_SIG}`, WebhookVerificationError.MALFORMED_HEADER],
    [`t=${VECTOR_TS},v1=${VECTOR_SIG.toUpperCase()}`, WebhookVerificationError.MALFORMED_HEADER],
    [`t=${VECTOR_TS},v1=${VECTOR_SIG},extra=1`, WebhookVerificationError.MALFORMED_HEADER],
    ["t=1788788073,v1=deadbeef", WebhookVerificationError.MALFORMED_HEADER],
  ])("rejects malformed header %j", (header, reason) => {
    const result = make().check(VECTOR_BODY, header, { now: VECTOR_TS });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe(reason);
  });

  it("rejects a verified but non-JSON body", () => {
    const verifier = make();
    const header = verifier.sign("not json at all", VECTOR_TS);
    const result = verifier.check("not json at all", header, { now: VECTOR_TS });
    expect(result.reason).toBe(WebhookVerificationError.MALFORMED_PAYLOAD);
  });

  it("rejects verified non-object JSON", () => {
    const verifier = make();
    const body = "[1,2,3]";
    const result = verifier.check(body, verifier.sign(body, VECTOR_TS), { now: VECTOR_TS });
    expect(result.reason).toBe(WebhookVerificationError.MALFORMED_PAYLOAD);
  });

  it("sign() produces the documented header", () => {
    expect(make().sign(VECTOR_BODY, VECTOR_TS)).toBe(VECTOR_HEADER);
  });

  it("rejects an empty secret", () => {
    expect(() => new WebhookVerifier("")).toThrowError(/secret/);
  });

  it("resolves the production payload shape (invoice id + paid asset in data.option)", () => {
    const body = JSON.stringify({
      id: "evt_qhLi9",
      type: "payment.confirmed",
      created_at: "2026-09-08T18:40:00Z",
      data: {
        invoice_id: "inv_x",
        order_id: "O-1",
        amount: "19.90",
        base_currency: "USD",
        option: { asset: "USDT", network: "tron", amount_crypto: "19.9", paid_amount: "20.5" },
      },
    });
    const verifier = make();
    const event = verifier.verify(body, verifier.sign(body, VECTOR_TS), { now: VECTOR_TS });
    expect(event.invoiceId).toBe("inv_x");
    expect(event.paidAsset).toBe("USDT");
    expect(event.paidNetwork).toBe("tron");
    expect(event.paidAmount).toBe("20.5");
    expect(WebhookEvent.fromJson(JSON.parse(body)).invoiceId).toBe("inv_x");
  });
});
