import { sql } from "drizzle-orm";
import { check, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { receipts } from "./receipts.ts";
import { tenants } from "./tenants.ts";
import { transactions } from "./transactions.ts";

export const reconciliations = sqliteTable(
  "reconciliations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    transactionId: text("transaction_id").references(() => transactions.id),
    receiptId: text("receipt_id").references(() => receipts.id),
    status: text("status").notNull(),
    score: real("score").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [
    unique("reconciliations_pair_unique").on(t.tenantId, t.transactionId, t.receiptId),
    check(
      "reconciliations_status_valid",
      sql`${t.status} IN ('proposed', 'confirmed', 'rejected')`,
    ),
    check("reconciliations_score_range", sql`${t.score} >= 0 AND ${t.score} <= 1`),
  ],
);
