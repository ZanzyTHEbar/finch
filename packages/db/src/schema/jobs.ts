import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    payload: text("payload"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("jobs_attempts_nonnegative", sql`${t.attempts} >= 0`),
    check(
      "jobs_status_valid",
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'dead')`,
    ),
  ],
);
