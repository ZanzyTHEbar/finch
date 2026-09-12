import { toMajor } from "@finch/core";

export interface TransactionCanonicalInput {
  readonly bookingDate: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly merchant?: string | null;
  readonly description?: string | null;
  readonly accountId: string;
  readonly category?: string | null;
  readonly receiptStatus?: string;
}

export interface ReceiptCanonicalInput {
  readonly receiptDate?: string | null;
  readonly totalMinor?: bigint | null;
  readonly currency?: string | null;
  readonly merchant?: string | null;
  readonly imageRef?: string | null;
  readonly status: string;
  readonly transactionId?: string | null;
}

const nonEmpty = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null && value !== "";

// e.g. "2026-09-01 debit EUR 42.80 at Continente, account 3fa85b29, groceries, receipt matched."
// Negative amounts are debits, positive are credits; missing parts are omitted, never "undefined".
export const transactionCanonical = (t: TransactionCanonicalInput): string => {
  const debit = t.amountMinor < 0n;
  let text = `${t.bookingDate} ${debit ? "debit" : "credit"} ${t.currency} ${toMajor(debit ? -t.amountMinor : t.amountMinor)}`;
  if (nonEmpty(t.merchant)) {
    text += ` at ${t.merchant}`;
  }
  text += `, account ${t.accountId.slice(0, 8)}`;
  if (nonEmpty(t.description)) {
    text += `, ${t.description}`;
  }
  if (nonEmpty(t.category)) {
    text += `, ${t.category}`;
  }
  if (nonEmpty(t.receiptStatus)) {
    text += `, receipt ${t.receiptStatus}`;
  }
  return `${text}.`;
};

export const receiptCanonical = (r: ReceiptCanonicalInput): string => {
  let text = "receipt";
  if (nonEmpty(r.merchant)) {
    text += ` from ${r.merchant}`;
  }
  if (r.totalMinor !== undefined && r.totalMinor !== null) {
    text += ` ${toMajor(r.totalMinor)}${nonEmpty(r.currency) ? ` ${r.currency}` : ""}`;
  }
  if (nonEmpty(r.receiptDate)) {
    text += ` on ${r.receiptDate}`;
  }
  text += `, status ${r.status}`;
  if (nonEmpty(r.transactionId)) {
    text += `, linked to transaction ${r.transactionId.slice(0, 8)}`;
  }
  if (nonEmpty(r.imageRef)) {
    text += `, image ${r.imageRef}`;
  }
  return `${text}.`;
};

export const summaryCanonical = (
  periodType: string,
  period: string,
  contentText: string,
): string => `summary ${periodType} ${period}: ${contentText}.`;
