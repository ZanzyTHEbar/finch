import { and, asc, eq, gt, max, sql } from "drizzle-orm";
import { Context, Effect, Layer, ParseResult, Schema } from "effect";
import {
  DuplicateEvent,
  EventCatalogV1,
  EventEnvelope,
  StorageUnavailable,
  ValidationFailed,
  decodeJson,
  defaultIdempotencyKey,
  encodeJson,
  nowInstant,
  uuidv7,
  type AggregateType,
  type TenantId,
  type UtcInstant,
} from "@finch/core";
import { Db } from "./client.ts";
import { events } from "./schema/index.ts";

export type EventRecord = EventEnvelope & { readonly rowid: number };

export interface EventRow {
  readonly rowid: number;
  readonly id: string;
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: string;
  readonly metadata: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

export interface AppendInput {
  readonly tenantId: TenantId;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly eventVersion?: number;
  readonly payload: unknown;
  readonly actor: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly occurredAt?: UtcInstant;
  readonly idempotencyKey?: string;
}

// ponytail: SQLite rowid has no mapped column, so this single sql`` fragment
// projects/filters/orders it; every other query stays pure-relational.
export const eventRowid = sql<number>`"events"."rowid"`;

export const eventRowSelection = {
  rowid: eventRowid,
  id: events.id,
  tenantId: events.tenantId,
  aggregateType: events.aggregateType,
  aggregateId: events.aggregateId,
  sequence: events.sequence,
  eventType: events.eventType,
  eventVersion: events.eventVersion,
  payload: events.payload,
  metadata: events.metadata,
  idempotencyKey: events.idempotencyKey,
  occurredAt: events.occurredAt,
  recordedAt: events.recordedAt,
};

const toValidationFailed = (issue: ParseResult.ParseError): ValidationFailed =>
  new ValidationFailed({ issues: [ParseResult.TreeFormatter.formatErrorSync(issue)] });

export const decodeEventRow = (row: EventRow): Effect.Effect<EventRecord, ValidationFailed> =>
  Effect.gen(function* () {
    const payload = yield* Effect.try({
      try: () => decodeJson(row.payload),
      catch: () => new ValidationFailed({ issues: [`event ${row.id} has corrupt payload JSON`] }),
    });
    const metadata = yield* Effect.try({
      try: () => decodeJson(row.metadata),
      catch: () => new ValidationFailed({ issues: [`event ${row.id} has corrupt metadata JSON`] }),
    });
    const envelope = yield* Schema.decodeUnknown(EventEnvelope)({
      id: row.id,
      tenantId: row.tenantId,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      sequence: row.sequence,
      eventType: row.eventType,
      eventVersion: row.eventVersion,
      payload,
      metadata,
      idempotencyKey: row.idempotencyKey,
    }).pipe(Effect.mapError(toValidationFailed));
    return { ...envelope, rowid: row.rowid };
  });

const isUniqueViolation = (cause: unknown): boolean => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.includes("UNIQUE constraint failed");
};

export class EventStore extends Context.Tag("EventStore")<
  EventStore,
  {
    readonly append: (
      input: AppendInput,
    ) => Effect.Effect<EventRecord, DuplicateEvent | ValidationFailed | StorageUnavailable>;
    readonly readAggregate: (
      tenantId: TenantId,
      aggregateType: AggregateType,
      aggregateId: string,
    ) => Effect.Effect<readonly EventRecord[], StorageUnavailable | ValidationFailed>;
    readonly readSince: (
      tenantId: TenantId,
      fromRowid: number,
      limit: number,
    ) => Effect.Effect<readonly EventRecord[], StorageUnavailable | ValidationFailed>;
  }
>() {}

export const EventStoreLive: Layer.Layer<EventStore, never, Db> = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const { db } = yield* Db;

    const append = (
      input: AppendInput,
    ): Effect.Effect<EventRecord, DuplicateEvent | ValidationFailed | StorageUnavailable> =>
      Effect.gen(function* () {
        const eventVersion = input.eventVersion ?? 1;
        const catalogSchema = (
          eventVersion === 1 ? EventCatalogV1[input.eventType] : undefined
        ) as Schema.Schema<unknown, unknown, never> | undefined;
        if (catalogSchema !== undefined) {
          yield* Schema.decodeUnknown(catalogSchema, { errors: "all" })(input.payload).pipe(
            Effect.mapError(toValidationFailed),
          );
        }
        const occurredAt = input.occurredAt ?? nowInstant();
        const recordedAt = nowInstant();
        const id = uuidv7();
        const payloadText = yield* Effect.try({
          try: () => encodeJson(input.payload),
          catch: () =>
            new ValidationFailed({
              issues: [`event ${input.eventType} payload is not JSON-serializable`],
            }),
        });
        const metadataText = yield* Effect.try({
          try: () =>
            encodeJson({
              actor: input.actor,
              ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
              ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
              occurredAt,
              recordedAt,
            }),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        // ponytail: default key hashes the canonical append identity (no
        // sequence/timestamps) so a retry with a new sequence still collides.
        const idempotencyKey =
          input.idempotencyKey ??
          defaultIdempotencyKey({
            tenantId: input.tenantId,
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            eventType: input.eventType,
            eventVersion,
            payload: input.payload,
          });
        const inserted = yield* Effect.try({
          try: (): EventRow =>
            db.transaction((tx) => {
              const peak = tx
                .select({ value: max(events.sequence) })
                .from(events)
                .where(
                  and(
                    eq(events.tenantId, input.tenantId),
                    eq(events.aggregateType, input.aggregateType),
                    eq(events.aggregateId, input.aggregateId),
                  ),
                )
                .get();
              const sequence = (peak?.value ?? 0) + 1;
              tx.insert(events)
                .values({
                  id,
                  tenantId: input.tenantId,
                  aggregateType: input.aggregateType,
                  aggregateId: input.aggregateId,
                  sequence,
                  eventType: input.eventType,
                  eventVersion,
                  payload: payloadText,
                  metadata: metadataText,
                  idempotencyKey,
                  occurredAt,
                  recordedAt,
                })
                .run();
              const row = tx
                .select(eventRowSelection)
                .from(events)
                .where(and(eq(events.id, id), eq(events.tenantId, input.tenantId)))
                .get();
              if (row === undefined) {
                throw new Error(`inserted event ${id} not found`);
              }
              return row;
            }),
          catch: (cause) => {
            if (cause instanceof ValidationFailed) {
              return cause;
            }
            if (isUniqueViolation(cause)) {
              return new DuplicateEvent();
            }
            return new StorageUnavailable({ cause });
          },
        });
        return yield* decodeEventRow(inserted);
      });

    const readAggregate = (
      tenantId: TenantId,
      aggregateType: AggregateType,
      aggregateId: string,
    ): Effect.Effect<readonly EventRecord[], StorageUnavailable | ValidationFailed> =>
      Effect.gen(function* () {
        const rows = yield* Effect.try({
          try: () =>
            db
              .select(eventRowSelection)
              .from(events)
              .where(
                and(
                  eq(events.tenantId, tenantId),
                  eq(events.aggregateType, aggregateType),
                  eq(events.aggregateId, aggregateId),
                ),
              )
              .orderBy(asc(events.sequence))
              .all(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        return yield* Effect.forEach(rows, decodeEventRow);
      });

    const readSince = (
      tenantId: TenantId,
      fromRowid: number,
      limit: number,
    ): Effect.Effect<readonly EventRecord[], StorageUnavailable | ValidationFailed> =>
      Effect.gen(function* () {
        const rows = yield* Effect.try({
          try: () =>
            db
              .select(eventRowSelection)
              .from(events)
              .where(and(eq(events.tenantId, tenantId), gt(eventRowid, fromRowid)))
              .orderBy(asc(eventRowid))
              .limit(limit)
              .all(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        return yield* Effect.forEach(rows, decodeEventRow);
      });

    return { append, readAggregate, readSince };
  }),
);
