import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";

/** Bank connection status lifecycle: pending → active → expired/revoked/error */
export const bankSessionStatuses = ["pending", "active", "expired", "revoked", "error"] as const;
export type BankSessionStatus = (typeof bankSessionStatuses)[number];

export const bankSessions = sqliteTable("bank_sessions", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  status: text("status", { enum: bankSessionStatuses }).notNull().default("active"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
