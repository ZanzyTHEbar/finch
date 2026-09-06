import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { tenants } from "./tenants.ts";

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    eventVersion: integer("event_version").notNull(),
    payload: text("payload").notNull(),
    metadata: text("metadata").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: text("occurred_at").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [
    unique("events_agg_seq_unique").on(t.tenantId, t.aggregateType, t.aggregateId, t.sequence),
    unique("events_idempotency_unique").on(t.tenantId, t.idempotencyKey),
    index("events_agg_seq_idx").on(t.tenantId, t.aggregateType, t.aggregateId, t.sequence),
    index("events_type_recorded_idx").on(t.tenantId, t.eventType, t.recordedAt),
    check("events_sequence_positive", sql`${t.sequence} > 0`),
    check("events_version_positive", sql`${t.eventVersion} > 0`),
  ],
);
