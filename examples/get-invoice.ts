/**
 * Reconciliation / recovery: poll an invoice status server-to-server.
 *
 * Usage: ZEROKYC_API_KEY=pk_test_... npx tsx get-invoice.ts <invoice-id>
 */

import type { Invoice} from "zkp-sdk-node";
import { ZeroKYC } from "zkp-sdk-node";

const invoiceId = process.argv[2];
if (!invoiceId) {
  console.error("usage: get-invoice.ts <invoice-id>");
  process.exit(1);
}

const zkp = new ZeroKYC({
  apiKey: process.env.ZEROKYC_API_KEY!,
  environment: "sandbox",
});

const invoice: Invoice = await zkp.getInvoice(invoiceId);

console.log(`invoice: ${invoice.id}`);
console.log(`status:  ${invoice.status} (raw: ${invoice.rawStatus})`);
console.log(`paid:    ${invoice.paidAmount ?? "-"} ${invoice.paidAsset ?? ""}`.trimEnd());
console.log(`expires: ${invoice.expiresAt}`);

// platform mapping example
switch (invoice.status) {
  case "PAID":
    console.log("-> mark local order paid");
    break;
  case "UNDERPAID":
    console.log("-> flag order: contact customer");
    break;
  case "EXPIRED":
  case "CANCELLED":
    console.log("-> close/void local order");
    break;
  case "PENDING":
  case "CONFIRMING":
    console.log("-> keep waiting");
    break;
  default:
    console.log("-> alert: unexpected state");
}
