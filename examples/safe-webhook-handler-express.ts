/**
 * Complete, production-safe webhook flow for Express.
 *
 * Flow: raw body -> signature verification -> duplicate check -> local order
 * lookup -> invoice/amount/asset validation -> mark paid -> mark event
 * processed -> HTTP 200.
 *
 * Never trust a browser success/return URL as proof of payment.
 *
 * Express needs the RAW body for verification - enable the raw-body capture
 * BEFORE any json parser:
 *
 *   app.use(express.json({
 *     verify: (req, _res, buf) => { (req as any).rawBody = buf; },
 *   }));
 *
 * Run: npm i express && ZEROKYC_API_KEY=pk_test_... \
 *      ZEROKYC_WEBHOOK_SECRET=whsec_... node --experimental-strip-types \
 *      safe-webhook-handler-express.ts
 */

import express, { type Request, type Response } from "express";

import { ReplayGuard, WebhookVerificationError, ZeroKYC, type EventStore } from "zkp-sdk-node";

const app = express();
app.use(
  express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

const zkp = new ZeroKYC({
  apiKey: process.env.ZEROKYC_API_KEY!,
  environment: "production",
  webhookSecret: process.env.ZEROKYC_WEBHOOK_SECRET!,
});

// TODO implement with YOUR database (a processed_events table with a unique
// constraint doubles as the atomic claim for concurrent deliveries)
class InMemoryEventStore implements EventStore {
  private readonly seen = new Set<string>();
  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }
  markProcessed(eventId: string): void {
    this.seen.add(eventId);
  }
}
const guard = new ReplayGuard(new InMemoryEventStore());

function loadOrder(_invoiceId: string): { expectedAmount: string; expectedAsset: string } | null {
  // TODO look up the local order by the ZeroKYC invoice id in YOUR tables
  return { expectedAmount: "19.90", expectedAsset: "USDT" };
}

app.post("/webhooks/zerokyc", async (req: Request, res: Response) => {
  // 1. Signature + timestamp first, before touching the payload.
  let event;
  try {
    const raw = (req as express.Request & { rawBody?: Buffer }).rawBody;
    if (!raw) {
      res.status(400).send("raw body missing: enable the verify() capture");
      return;
    }
    event = zkp.verifyWebhook(raw, req.header("X-ZKP-Signature") ?? "");
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      // machine-readable reason only: never log secrets or full payloads
      console.warn(`zerokyc webhook rejected: ${error.reason}`);
      res.status(400).send("invalid signature");
      return;
    }
    throw error; // unexpected errors must NOT hide under a 400
  }

  // 2. At-least-once delivery: skip duplicates, answer 200 so retries stop.
  if (await guard.isDuplicate(event.id)) {
    res.sendStatus(200);
    return;
  }

  // 3. Only confirmation events mark orders paid.
  if (!event.isPaymentConfirmed || event.invoiceId === null) {
    res.sendStatus(200);
    return;
  }

  const order = loadOrder(event.invoiceId);
  if (order === null) {
    res.sendStatus(200); // unknown invoice: investigate manually
    return;
  }

  // 4. Signature validity alone is NOT enough: match invoice/amount/asset.
  if (
    !guard.matchesOrder(event, event.invoiceId, {
      minAmount: order.expectedAmount,
      asset: order.expectedAsset,
    })
  ) {
    console.error(`zerokyc: event ${event.id} did not match its order`);
    res.sendStatus(200);
    return;
  }

  // 5. Belt and suspenders for high-value orders: confirm server-to-server.
  // zkp.getInvoice(event.invoiceId).then((i) => { if (!i.isPaid) ... });

  // 6. TODO mark the order paid in YOUR system (activate service, email...)

  // 7. Mark processed only AFTER the order update succeeded.
  await guard.markProcessed(event.id);
  res.sendStatus(200);
});

app.listen(8080, () => console.log("listening on :8080"));
