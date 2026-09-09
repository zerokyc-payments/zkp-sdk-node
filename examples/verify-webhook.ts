/**
 * Minimal webhook signature verification.
 *
 * Framework integration: pass the exact raw body and the X-ZKP-Signature
 * header from the request - never re-serialized JSON.
 */

import { WebhookVerifier, WebhookVerificationError } from "zkp-sdk-node";

const verifier = new WebhookVerifier(process.env.ZEROKYC_WEBHOOK_SECRET!, 300);

try {
  // Express (raw-body middleware enabled):  const raw = req.body
  // Next.js App Router (route.ts):           const raw = await request.text()
  const raw = ""; // exact raw string/bytes as received
  const header = ""; // req.header("X-ZKP-Signature")
  const event = verifier.verify(raw, header);
  console.log(`verified event ${event.type} for invoice ${event.invoiceId}`);
} catch (error) {
  if (error instanceof WebhookVerificationError) {
    // respond 400; log only the machine-readable reason - never secrets
    console.error(`rejected: ${error.reason}`);
    process.exit(1);
  }
  throw error;
}
