/** Typed invoice models (create + get responses share the shape). */

import { isTerminalStatus, type InvoiceStatus, StatusMapper } from "../status.js";

export interface PaymentOption {
  asset: string;
  network: string;
  payment_address: string;
  amount_crypto: string;
  rate: string;
  status: string;
  window_low?: string | null;
  window_high?: string | null;
  payment_url_extra?: string | null;
  confirmed_tx_hash?: string | null;
  [key: string]: unknown;
}

export interface InvoiceObservation {
  option_id: string;
  tx_hash: string;
  output_index: number;
  amount_paid: string;
  confirmations: number;
  seen_at: string;
  [key: string]: unknown;
}

export interface InvoiceData {
  id: string;
  order_id?: string | null;
  description?: string | null;
  amount: string;
  base_currency: string;
  payment_currency: string;
  status: string;
  ttl_minutes: number;
  expires_at: string;
  created_at: string;
  checkout_url: string;
  metadata: Record<string, unknown>;
  options: PaymentOption[];
  observations: InvoiceObservation[];
  paid_amount?: string | null;
  paid_asset?: string | null;
  [key: string]: unknown;
}

export class Invoice {
  readonly id: string;
  readonly orderId: string | null;
  readonly description: string | null;
  /** Decimal string - never a JS number. */
  readonly amount: string;
  readonly baseCurrency: string;
  readonly paymentCurrency: string;
  readonly rawStatus: string;
  readonly status: InvoiceStatus;
  readonly ttlMinutes: number;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly checkoutUrl: string;
  readonly metadata: Record<string, unknown>;
  readonly options: PaymentOption[];
  readonly observations: InvoiceObservation[];
  readonly paidAmount: string | null;
  readonly paidAsset: string | null;
  /** Full decoded response (unknown fields preserved). */
  readonly raw: InvoiceData;

  private constructor(data: InvoiceData) {
    this.id = data.id;
    this.orderId = data.order_id ?? null;
    this.description = data.description ?? null;
    this.amount = data.amount;
    this.baseCurrency = data.base_currency;
    this.paymentCurrency = data.payment_currency;
    this.rawStatus = data.status;
    this.status = StatusMapper.normalize(data.status) ?? "FAILED";
    this.ttlMinutes = data.ttl_minutes;
    this.expiresAt = data.expires_at;
    this.createdAt = data.created_at;
    this.checkoutUrl = data.checkout_url;
    this.metadata = data.metadata ?? {};
    this.options = data.options ?? [];
    this.observations = data.observations ?? [];
    this.paidAmount = data.paid_amount ?? null;
    this.paidAsset = data.paid_asset ?? null;
    this.raw = data;
  }

  static fromJson(data: unknown): Invoice {
    if (typeof data !== "object" || data === null) {
      throw new Error("invoice response is not a JSON object");
    }
    const d = data as Partial<InvoiceData>;
    // required fields must be present with the right shape - never silently
    // accept an invalid envelope
    if (typeof d.id !== "string" || !d.id) {
      throw new Error("invoice response is missing required field 'id'");
    }
    if (typeof d.status !== "string") {
      throw new Error("invoice response is missing required field 'status'");
    }
    return new Invoice({
      id: d.id,
      order_id: d.order_id,
      description: d.description,
      amount: d.amount ?? "",
      base_currency: d.base_currency ?? "",
      payment_currency: d.payment_currency ?? "",
      status: d.status,
      ttl_minutes: d.ttl_minutes ?? 0,
      expires_at: d.expires_at ?? "",
      created_at: d.created_at ?? "",
      checkout_url: d.checkout_url ?? "",
      metadata: (d.metadata as Record<string, unknown>) ?? {},
      options: d.options ?? [],
      observations: d.observations ?? [],
      paid_amount: d.paid_amount,
      paid_asset: d.paid_asset,
      ...d,
    });
  }

  get isPaid(): boolean {
    return this.status === "PAID";
  }

  get isTerminal(): boolean {
    return isTerminalStatus(this.status);
  }

  /** Payment option by asset id (e.g. "USDT_TRON"), or null. */
  option(asset: string): PaymentOption | null {
    return this.options.find((o) => o.asset === asset) ?? null;
  }
}

export class CreateInvoiceResponse {
  constructor(
    public readonly invoice: Invoice,
    /** True when the API returned a previously created invoice for the same
     *  Idempotency-Key (safe timeout/retry path). */
    public readonly idempotentReplay: boolean,
  ) {}
}
