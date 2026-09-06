import { sql } from "drizzle-orm";
import { check, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";

export const summaries = sqliteTable(
  "summaries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    periodType: text("period_type").notNull(),
    period: text("period").notNull(),
    content: text("content").notNull(),
    generatedAt: text("generated_at").notNull(),
  },
  (t) => [
    unique("summaries_period_unique").on(t.tenantId, t.periodType, t.period),
    check("summaries_period_type_valid", sql`${t.periodType} IN ('day', 'week', 'month')`),
  ],
);
