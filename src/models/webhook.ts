/**
 * Verified webhook event model.
 *
 * Production payloads keep the invoice id inside `data` and the paid asset as
 * a TICKER nested in `data.option`; the docs test vector uses a simplified
 * top-level shape. Both resolve transparently (same as the PHP/Python SDKs).
 */

export interface WebhookEventData {
  id: string;
  type: string;
  invoice_id?: string | null;
  created_at?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export class WebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly invoiceId: string | null;
  readonly data: Record<string, unknown>;
  readonly raw: WebhookEventData;

  private constructor(payload: WebhookEventData) {
    this.id = payload.id;
    this.type = payload.type;
    const data = (payload.data as Record<string, unknown>) ?? {};
    const invoiceId = payload.invoice_id ?? data["invoice_id"];
    this.invoiceId = typeof invoiceId === "string" ? invoiceId : null;
    this.data = data;
    this.raw = payload;
  }

  static fromJson(payload: unknown): WebhookEvent {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("webhook payload is not a JSON object");
    }
    const p = payload as Record<string, unknown>;
    // id/type are required non-empty strings - a signed `{}` must not pass
    if (typeof p.id !== "string" || p.id === "") {
      throw new Error("webhook payload is missing required field 'id'");
    }
    if (typeof p.type !== "string" || p.type === "") {
      throw new Error("webhook payload is missing required field 'type'");
    }
    if (p.data !== undefined &&
        (typeof p.data !== "object" || p.data === null || Array.isArray(p.data))) {
      throw new Error("webhook payload field 'data' must be a JSON object");
    }
    for (const key of ["invoice_id"] as const) {
      const value = p[key];
      if (value !== undefined && value !== null &&
          (typeof value !== "string" || value === "")) {
        throw new Error(`webhook payload field '${key}' must be a non-empty string`);
      }
    }
    const data = (p.data as Record<string, unknown>) ?? {};
    const dataInvoiceId = data["invoice_id"];
    if (dataInvoiceId !== undefined && dataInvoiceId !== null &&
        (typeof dataInvoiceId !== "string" || dataInvoiceId === "")) {
      throw new Error("webhook payload field 'data.invoice_id' must be a non-empty string");
    }
    const invoiceId = p.invoice_id ?? dataInvoiceId;
    if (p.type === "payment.confirmed" &&
        (typeof invoiceId !== "string" || invoiceId === "")) {
      // crediting an order requires knowing which invoice was paid
      throw new Error("payment.confirmed payload is missing the invoice id");
    }
    return new WebhookEvent(payload as WebhookEventData);
  }

  get isPaymentConfirmed(): boolean {
    return this.type === "payment.confirmed";
  }

  /**
   * Crypto amount actually received (payment.* events carry it under
   * data.option.paid_amount; docs-vector shape: data.amount). For non-stable
   * assets compare against the amount_crypto you invoiced, not the base total.
   */
  get paidAmount(): string | null {
    const option = this.option();
    const paid = option ? option["paid_amount"] : undefined;
    const fallback =
      this.data["amount_paid"] ?? this.data["amount"] ?? undefined;
    const value = paid ?? fallback;
    return typeof value === "string" && value !== "" ? value : null;
  }

  /** Asset the payment arrived in: ticker ("USDT") or asset id ("USDT_TRON"). */
  get paidAsset(): string | null {
    const option = this.option();
    const asset = (option ? option["asset"] : undefined) ?? this.data["asset"];
    return typeof asset === "string" && asset !== "" ? asset : null;
  }

  /** Network of the paying option ("tron", "polygon", ...), when present. */
  get paidNetwork(): string | null {
    const option = this.option();
    const network = option ? option["network"] : undefined;
    return typeof network === "string" && network !== "" ? network : null;
  }

  private option(): Record<string, unknown> | null {
    const option = this.data["option"];
    return typeof option === "object" && option !== null && !Array.isArray(option)
      ? (option as Record<string, unknown>)
      : null;
  }
}

export interface VerificationResult {
  valid: boolean;
  reason: string | null;
  event: WebhookEvent | null;
}
