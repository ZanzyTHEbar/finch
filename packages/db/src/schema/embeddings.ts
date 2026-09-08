import { sql } from "drizzle-orm";
import { blob, check, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { searchDocuments } from "./search.ts";
import { tenants } from "./tenants.ts";

export const embeddings = sqliteTable(
  "embeddings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    documentId: text("document_id")
      .notNull()
      .references(() => searchDocuments.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    dims: integer("dims").notNull(),
    vector: blob("vector", { mode: "buffer" }).notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (t) => [
    unique("embeddings_document_model_unique").on(t.tenantId, t.documentId, t.model),
    check("embeddings_dims_positive", sql`${t.dims} > 0`),
  ],
);
