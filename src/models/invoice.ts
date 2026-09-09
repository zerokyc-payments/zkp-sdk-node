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

  private constructor(data: InvoiceData, raw: Record<string, unknown>) {
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
    this.raw = raw as InvoiceData;
  }

  static fromJson(data: unknown): Invoice {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error("invoice response is not a JSON object");
    }
    const d = data as Record<string, unknown>;
    // Every declared field is validated and built explicitly; unknown extras
    // live in `raw` only and can never overwrite a checked/normalized value.
    return new Invoice(
      {
        id: requiredString(d, "id"),
        order_id: nullableString(d.order_id, "order_id"),
        description: nullableString(d.description, "description"),
        amount: requiredDecimalString(d.amount, "amount"),
        base_currency: requiredString(d, "base_currency"),
        payment_currency: requiredString(d, "payment_currency"),
        status: requiredString(d, "status"),
        ttl_minutes: requiredInteger(d.ttl_minutes, "ttl_minutes"),
        expires_at: requiredString(d, "expires_at"),
        created_at: requiredString(d, "created_at"),
        checkout_url: requiredString(d, "checkout_url"),
        metadata: requiredObject(d.metadata, "metadata"),
        options: requiredOptions(d.options),
        observations: requiredObservations(d.observations),
        paid_amount: nullableDecimalString(d.paid_amount, "paid_amount"),
        paid_asset: nullableString(d.paid_asset, "paid_asset"),
      },
      d,
    );
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

// --- runtime validation helpers (public types are the contract) -------------

const DECIMAL_STRING_RE = /^[0-9]+(?:\.[0-9]+)?$/;

function requiredString(d: Record<string, unknown>, field: string): string {
  const value = d[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`invoice response field '${field}' must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`invoice response field '${field}' must be a string or null`);
  }
  return value;
}

function requiredDecimalString(value: unknown, field: string): string {
  if (typeof value !== "string" || !DECIMAL_STRING_RE.test(value)) {
    throw new Error(`invoice response field '${field}' must be a decimal string`);
  }
  return value;
}

function nullableDecimalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !DECIMAL_STRING_RE.test(value)) {
    throw new Error(`invoice response field '${field}' must be a decimal string or null`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`invoice response field '${field}' must be an integer`);
  }
  return value as number;
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invoice response field '${field}' must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`invoice response field '${field}' must be an array`);
  }
  return value;
}

function requiredOptions(value: unknown): PaymentOption[] {
  return requiredArray(value, "options").map((raw, i) => {
    const o = requiredObject(raw, `options[${i}]`);
    return {
      ...o,
      asset: optionString(o, "asset", i),
      network: optionString(o, "network", i),
      payment_address: optionString(o, "payment_address", i),
      amount_crypto: optionDecimal(o, "amount_crypto", i),
      rate: optionString(o, "rate", i),
      status: optionString(o, "status", i),
    } as PaymentOption;
  });
}

function optionString(o: Record<string, unknown>, field: string, i: number): string {
  const value = o[field];
  if (typeof value !== "string" || value === "") {
    throw new Error(`invoice response field 'options[${i}].${field}' must be a non-empty string`);
  }
  return value;
}

function optionDecimal(o: Record<string, unknown>, field: string, i: number): string {
  const value = o[field];
  if (typeof value !== "string" || !DECIMAL_STRING_RE.test(value)) {
    throw new Error(`invoice response field 'options[${i}].${field}' must be a decimal string`);
  }
  return value;
}

function requiredObservations(value: unknown): InvoiceObservation[] {
  return requiredArray(value, "observations").map((raw, i) => {
    const o = requiredObject(raw, `observations[${i}]`);
    return {
      ...o,
      option_id: optionString(o, "option_id", i),
      tx_hash: optionString(o, "tx_hash", i),
      output_index: requiredInteger(o.output_index, `observations[${i}].output_index`),
      amount_paid: optionDecimal(o, "amount_paid", i),
      confirmations: requiredInteger(o.confirmations, `observations[${i}].confirmations`),
      seen_at: optionString(o, "seen_at", i),
    } as InvoiceObservation;
  });
}
