/** Fixtures are byte-identical to the PHP/Python SDKs - cross-language contract. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { WebhookVerifier } from "../src/webhooks/verifier.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/webhooks", import.meta.url));
const SECRET = "whsec_fixture_secret";

describe("webhook fixtures", () => {
  it.each([
    ["confirmed.json", "payment.confirmed", "inv_fixture_001"],
    ["underpaid.json", "payment.underpaid", "inv_fixture_002"],
    ["expired.json", "invoice.expired", "inv_fixture_003"],
    ["pending.json", "payment.detected", "inv_fixture_004"],
  ])("%s verifies and parses", (filename, expectedType, expectedInvoice) => {
    const body = readFileSync(`${FIXTURES_DIR}/${filename}`, "utf8");
    const verifier = new WebhookVerifier(SECRET);
    const event = verifier.verify(body, verifier.sign(body));

    expect(event.type).toBe(expectedType);
    expect(event.invoiceId).toBe(expectedInvoice);
    expect(event.id).not.toBe("");
  });

  it("confirmed fixture carries payment data in the production shape", () => {
    const body = readFileSync(`${FIXTURES_DIR}/confirmed.json`, "utf8");
    const verifier = new WebhookVerifier(SECRET);
    const event = verifier.verify(body, verifier.sign(body));

    expect(event.isPaymentConfirmed).toBe(true);
    expect(event.paidAsset).toBe("USDT");
    expect(event.paidNetwork).toBe("tron");
    expect(event.paidAmount).toBe("19.9");
    expect(JSON.parse(body).data.order_id).toBe("INV-1042");
  });
});
