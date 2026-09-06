import { sql } from "drizzle-orm";
import { check, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";
import { integerAsBigint, transactions } from "./transactions.ts";

export const receipts = sqliteTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    transactionId: text("transaction_id").references(() => transactions.id),
    merchant: text("merchant"),
    totalMinor: integerAsBigint("total_minor"),
    currency: text("currency"),
    receiptDate: text("receipt_date"),
    imageRef: text("image_ref"),
    imageHash: text("image_hash"),
    status: text("status").notNull(),
  },
  (t) => [
    unique("receipts_image_unique").on(t.tenantId, t.imageRef),
    check("receipts_total_nonnegative", sql`${t.totalMinor} >= 0`),
    check("receipts_currency_len", sql`${t.currency} IS NULL OR length(${t.currency}) = 3`),
    check(
      "receipts_status_valid",
      sql`${t.status} IN ('captured', 'matched', 'unmatched', 'archived')`,
    ),
    check(
      "receipts_date_iso",
      sql`${t.receiptDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
  ],
);
