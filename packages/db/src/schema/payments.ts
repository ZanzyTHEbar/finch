import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";
import { integerAsBigint } from "./transactions.ts";

export const payments = sqliteTable(
  "payments",
  {
    paymentId: text("payment_id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    url: text("url"),
    aspspName: text("aspsp_name").notNull(),
    aspspCountry: text("aspsp_country").notNull(),
    amountMinor: integerAsBigint("amount_minor").notNull(),
    currency: text("currency").notNull(),
    creditorName: text("creditor_name").notNull(),
    creditorIban: text("creditor_iban").notNull(),
    paymentType: text("payment_type").notNull(),
    remittance: text("remittance"),
    state: text("state").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("payments_amount_positive", sql`${t.amountMinor} > 0`),
    check("payments_currency_len", sql`length(${t.currency}) = 3`),
  ],
);
