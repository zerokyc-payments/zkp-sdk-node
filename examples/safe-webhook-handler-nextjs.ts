/**
 * Complete, production-safe webhook flow for a Next.js App Router route.
 *
 * Flow: raw body -> signature verification -> duplicate check -> local order
 * lookup -> invoice/amount/asset validation -> mark paid -> mark event
 * processed -> HTTP 200.
 *
 * app/api/webhooks/zerokyc/route.ts:
 *
 *   export const runtime = "nodejs";        // node:crypto, no edge runtime
 *   export const dynamic = "force-dynamic"; // never cache POSTs
 *
 * Next.js (App Router) gives you the exact raw body via `await request.text()`
 * BEFORE any parsing - which is exactly what HMAC verification needs.
 */

import type { NextRequest} from "next/server";
import { NextResponse } from "next/server";

import { ReplayGuard, WebhookVerificationError, ZeroKYC, type EventStore } from "zkp-sdk-node";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Signature + timestamp first, before touching the payload.
  let event;
  try {
    // exact raw bytes as received - never re-serialized JSON
    event = zkp.verifyWebhook(
      await request.text(),
      request.headers.get("X-ZKP-Signature") ?? "",
    );
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      // machine-readable reason only: never log secrets or full payloads
      console.warn(`zerokyc webhook rejected: ${error.reason}`);
      return new NextResponse("invalid signature", { status: 400 });
    }
    throw error; // unexpected errors must NOT hide under a 400
  }

  // 2. At-least-once delivery: skip duplicates, answer 200 so retries stop.
  if (await guard.isDuplicate(event.id)) {
    return NextResponse.json({ ok: true });
  }

  // 3. Only confirmation events mark orders paid.
  if (!event.isPaymentConfirmed || event.invoiceId === null) {
    return NextResponse.json({ ok: true });
  }

  // 4. TODO load the local order by event.invoiceId from YOUR database
  const order = { expectedAmount: "19.90", expectedAsset: "USDT" };

  // 5. Signature validity alone is NOT enough: match invoice/amount/asset.
  if (
    !guard.matchesOrder(event, event.invoiceId, {
      minAmount: order.expectedAmount,
      asset: order.expectedAsset,
    })
  ) {
    console.error(`zerokyc: event ${event.id} did not match its order`);
    return NextResponse.json({ ok: true });
  }

  // 6. Belt and suspenders for high-value orders:
  // const invoice = await zkp.getInvoice(event.invoiceId);
  // if (!invoice.isPaid) return NextResponse.json({ ok: true });

  // 7. TODO mark the order paid in YOUR system, THEN mark the event processed
  await guard.markProcessed(event.id);
  return NextResponse.json({ ok: true });
}
