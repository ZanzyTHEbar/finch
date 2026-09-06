import { and, asc, eq, gt } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  StorageUnavailable,
  ValidationFailed,
  nowInstant,
  type AggregateType,
  type TenantId,
} from "@finch/core";
import { Db } from "../client.ts";
import {
  decodeEventRow,
  eventRowSelection,
  eventRowid,
  type EventRecord,
} from "../event-store.ts";
import { events, projectionCheckpoints } from "../schema/index.ts";

export class EventReadRepository extends Context.Tag("EventReadRepository")<
  EventReadRepository,
  {
    readonly readSince: (
      tenantId: TenantId,
      fromRowid: number,
      limit: number,
    ) => Effect.Effect<readonly EventRecord[], StorageUnavailable | ValidationFailed>;
    readonly readAggregate: (
      tenantId: TenantId,
      aggregateType: AggregateType,
      aggregateId: string,
    ) => Effect.Effect<readonly EventRecord[], StorageUnavailable | ValidationFailed>;
    readonly getCheckpoint: (
      tenantId: TenantId,
      projectionName: string,
    ) => Effect.Effect<number, StorageUnavailable>;
    readonly setCheckpoint: (
      tenantId: TenantId,
      projectionName: string,
      rowid: number,
      lastEventId?: string,
    ) => Effect.Effect<void, StorageUnavailable>;
  }
>() {}

export const EventReadRepositoryLive: Layer.Layer<EventReadRepository, never, Db> = Layer.effect(
  EventReadRepository,
  Effect.gen(function* () {
    const { db } = yield* Db;

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

    const getCheckpoint = (
      tenantId: TenantId,
      projectionName: string,
    ): Effect.Effect<number, StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* Effect.try({
          try: () =>
            db
              .select()
              .from(projectionCheckpoints)
              .where(
                and(
                  eq(projectionCheckpoints.projectionName, projectionName),
                  eq(projectionCheckpoints.tenantId, tenantId),
                ),
              )
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        return row?.lastRowid ?? 0;
      });

    const setCheckpoint = (
      tenantId: TenantId,
      projectionName: string,
      rowid: number,
      lastEventId?: string,
    ): Effect.Effect<void, StorageUnavailable> =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () =>
            db
              .insert(projectionCheckpoints)
              .values({
                projectionName,
                tenantId,
                lastRowid: rowid,
                lastEventId: lastEventId ?? null,
                updatedAt: nowInstant(),
              })
              .onConflictDoUpdate({
                target: [
                  projectionCheckpoints.projectionName,
                  projectionCheckpoints.tenantId,
                ],
                set: {
                  lastRowid: rowid,
                  lastEventId: lastEventId ?? null,
                  updatedAt: nowInstant(),
                },
              })
              .run(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
      });

    return { readSince, readAggregate, getCheckpoint, setCheckpoint };
  }),
);
