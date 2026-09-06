import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";

export const projectionCheckpoints = sqliteTable(
  "projection_checkpoints",
  {
    projectionName: text("projection_name").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    lastRowid: integer("last_rowid").notNull().default(0),
    lastEventId: text("last_event_id"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectionName, t.tenantId] })],
);
