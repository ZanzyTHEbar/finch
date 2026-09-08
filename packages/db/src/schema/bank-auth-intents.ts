import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";

export const bankAuthIntents = sqliteTable("bank_auth_intents", {
  state: text("state").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
});
