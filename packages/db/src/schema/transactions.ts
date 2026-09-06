import { sql } from "drizzle-orm";
import { check, customType, index, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { accounts } from "./accounts.ts";
import { tenants } from "./tenants.ts";

// drizzle-orm 0.45.x sqlite `integer()` has no bigint mode, so map TS bigint
// <-> SQLite INTEGER explicitly. bun:sqlite binds bigints natively and
// returns numbers for INTEGERs; both directions are covered below.
export const integerAsBigint = (name: string) =>
  customType<{ data: bigint; driverData: number | bigint }>({
    dataType() {
      return "integer";
    },
    fromDriver(value) {
      return typeof value === "bigint" ? value : BigInt(value);
    },
    toDriver(value) {
      return value;
    },
  })(name);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => accounts.id),
    amountMinor: integerAsBigint("amount_minor").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    postedDate: text("posted_date"),
    valueDate: text("value_date"),
    observedAt: text("observed_at").notNull(),
    description: text("description"),
    merchantName: text("merchant_name"),
    counterpartyName: text("counterparty_name"),
    category: text("category"),
    categorySource: text("category_source"),
    externalId: text("external_id"),
  },
  (t) => [
    // NULL external_ids stay distinct in SQLite (NULL <> NULL), so source
    // rows without an external id never collide here; dedupe for those
    // relies on the source fingerprint carried in the event payload.
    unique("transactions_external_unique").on(t.tenantId, t.accountId, t.externalId),
    index("transactions_account_posted_idx").on(t.tenantId, t.accountId, t.postedDate),
    index("transactions_status_idx").on(t.tenantId, t.status),
    check("transactions_amount_nonzero", sql`${t.amountMinor} <> 0`),
    check("transactions_currency_len", sql`length(${t.currency}) = 3`),
    check(
      "transactions_status_valid",
      sql`${t.status} IN ('booked', 'pending', 'corrected', 'reversed', 'deleted')`,
    ),
    check(
      "transactions_posted_date_iso",
      sql`${t.postedDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    ),
  ],
);
