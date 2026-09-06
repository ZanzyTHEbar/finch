import { sql } from "drizzle-orm";
import { check, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";

export const searchDocuments = sqliteTable(
  "search_documents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    content: text("content").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique("search_documents_source_unique").on(t.tenantId, t.sourceType, t.sourceId),
    check(
      "search_source_type_valid",
      sql`${t.sourceType} IN ('account', 'transaction', 'receipt', 'reconciliation', 'summary')`,
    ),
  ],
);
