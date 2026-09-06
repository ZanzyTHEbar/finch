import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    externalRef: text("external_ref"),
    name: text("name").notNull(),
    type: text("type").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    lastDiscoveredAt: text("last_discovered_at"),
  },
  (t) => [
    check("accounts_type_valid", sql`${t.type} IN ('checking', 'savings', 'credit', 'investment', 'other')`),
    check("accounts_status_valid", sql`${t.status} IN ('active', 'revoked', 'closed')`),
    check("accounts_currency_len", sql`length(${t.currency}) = 3`),
  ],
);
