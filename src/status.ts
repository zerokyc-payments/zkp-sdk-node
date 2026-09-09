/**
 * Normalized invoice status + raw-API status mapping.
 *
 * Raw statuses (created/pending/detecting/confirmed/underpaid/expired/canceled)
 * never leak into billing logic: platforms consume InvoiceStatus
 * (mirrors the PHP/Python SDKs).
 */

export type InvoiceStatus =
  | "PENDING"
  | "CONFIRMING"
  | "PAID"
  | "UNDERPAID"
  | "EXPIRED"
  | "CANCELLED"
  | "OVERPAID"
  | "FAILED";

const MAP: Record<string, InvoiceStatus> = {
  created: "PENDING",
  pending: "PENDING",
  detecting: "CONFIRMING",
  confirmed: "PAID",
  underpaid: "UNDERPAID",
  expired: "EXPIRED",
  canceled: "CANCELLED",
  // overpayment is credited and confirmed server-side; kept for forward
  // compatibility and local bookkeeping
  overpaid: "OVERPAID",
};

const RAW_TERMINAL = new Set(["confirmed", "underpaid", "expired", "canceled"]);

export class StatusMapper {
  static normalize(raw: string): InvoiceStatus | null {
    return MAP[raw] ?? null;
  }

  static normalizeOrFail(raw: string): InvoiceStatus {
    const status = MAP[raw];
    if (!status) {
      throw new Error(`unknown invoice status '${raw}'`);
    }
    return status;
  }

  static isTerminal(raw: string): boolean {
    return RAW_TERMINAL.has(raw);
  }

  static isPaid(raw: string): boolean {
    return raw === "confirmed";
  }
}

export function isTerminalStatus(status: InvoiceStatus): boolean {
  return status !== "PENDING" && status !== "CONFIRMING";
}
