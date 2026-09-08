import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";

export const bankSessions = sqliteTable("bank_sessions", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
