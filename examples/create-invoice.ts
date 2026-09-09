/**
 * Create a sandbox invoice and print the hosted-checkout URL.
 *
 * Set your key first (console -> API keys):
 *   export ZEROKYC_API_KEY=pk_test_...
 */

import { idempotencyKey, ZeroKYC } from "zkp-sdk-node";

const zkp = new ZeroKYC({
  apiKey: process.env.ZEROKYC_API_KEY!,
  environment: "sandbox",
});

const response = await zkp.createInvoice({
  amount: "19.90",
  currency: "USD",
  orderId: "INV-1042",
  description: "VPS plan: starter",
  paymentCurrency: "any",
  // stable key: a crash + retry returns the same invoice, never a duplicate
  idempotencyKey: idempotencyKey("example", "demo", "20260909"),
});

console.log(`invoice:  ${response.invoice.id}`);
console.log(`status:   ${response.invoice.status} (raw: ${response.invoice.rawStatus})`);
console.log(`amount:   ${response.invoice.amount} ${response.invoice.baseCurrency}`);
console.log(`replay:   ${response.idempotentReplay ? "yes (same invoice returned)" : "no"}`);
console.log(`checkout: ${response.invoice.checkoutUrl}`);
for (const option of response.invoice.options) {
  console.log(`  - ${option.asset} on ${option.network}: ${option.amount_crypto} -> ${option.payment_address}`);
}
