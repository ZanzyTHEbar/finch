import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  StorageUnavailable,
  ValidationFailed,
  nowInstant,
  uuidv7,
  type TenantId,
} from "@finch/core";
import { Db } from "../client.ts";
import { jobs } from "../schema/index.ts";

export type JobRow = typeof jobs.$inferSelect;

export interface JobOutcome {
  readonly status: "succeeded" | "failed";
  readonly lastError?: string;
}

const isUniqueViolation = (cause: unknown): boolean => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.includes("UNIQUE constraint failed");
};

const queuedPayload = (payloadText: string | null) =>
  payloadText === null ? isNull(jobs.payload) : eq(jobs.payload, payloadText);

export class JobRepository extends Context.Tag("JobRepository")<
  JobRepository,
  {
    readonly enqueue: (
      tenantId: TenantId,
      kind: string,
      payload: unknown,
    ) => Effect.Effect<JobRow, ValidationFailed | StorageUnavailable>;
    readonly claim: (tenantId: TenantId, id: string) => Effect.Effect<boolean, StorageUnavailable>;
    readonly finish: (
      tenantId: TenantId,
      id: string,
      outcome: JobOutcome,
    ) => Effect.Effect<boolean, StorageUnavailable>;
    readonly listDue: (
      tenantId: TenantId,
      limit: number,
    ) => Effect.Effect<readonly JobRow[], StorageUnavailable>;
    readonly listDueAll: (
      kind: string,
      limit: number,
    ) => Effect.Effect<readonly JobRow[], StorageUnavailable>;
    readonly reclaimRunning: (kind: string) => Effect.Effect<number, StorageUnavailable>;
  }
>() {}

export const JobRepositoryLive: Layer.Layer<JobRepository, never, Db> = Layer.effect(
  JobRepository,
  Effect.gen(function* () {
    const { db } = yield* Db;
    const scope = (tenantId: TenantId, id: string) =>
      and(eq(jobs.tenantId, tenantId), eq(jobs.id, id));

    const enqueue = (
      tenantId: TenantId,
      kind: string,
      payload: unknown,
    ): Effect.Effect<JobRow, ValidationFailed | StorageUnavailable> =>
      Effect.gen(function* () {
        const payloadText = yield* Effect.try({
          try: () => {
            if (payload === undefined) {
              return null;
            }
            const text = JSON.stringify(payload);
            if (typeof text !== "string") {
              throw new Error("job payload is not JSON-serializable");
            }
            return text;
          },
          catch: () =>
            new ValidationFailed({ issues: [`job ${kind} payload is not JSON-serializable`] }),
        });
        const queuedWhere = and(
          eq(jobs.tenantId, tenantId),
          eq(jobs.kind, kind),
          eq(jobs.status, "queued"),
          queuedPayload(payloadText),
        );
        const existing = yield* Effect.try({
          try: () => db.select().from(jobs).where(queuedWhere).get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (existing !== undefined) {
          return existing;
        }
        const row = yield* Effect.try({
          try: () =>
            db
              .insert(jobs)
              .values({
                id: uuidv7(),
                tenantId,
                kind,
                status: "queued",
                payload: payloadText,
                attempts: 0,
                lastError: null,
                createdAt: nowInstant(),
                updatedAt: nowInstant(),
              })
              .returning()
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              if (!isUniqueViolation(error.cause)) {
                return yield* error;
              }
              const raced = yield* Effect.try({
                try: () =>
                  db
                    .select()
                    .from(jobs)
                    .where(
                      and(
                        eq(jobs.tenantId, tenantId),
                        eq(jobs.kind, kind),
                        queuedPayload(payloadText),
                        inArray(jobs.status, ["queued", "running"]),
                      ),
                    )
                    .get(),
                catch: (cause) => new StorageUnavailable({ cause }),
              });
              if (raced === undefined) {
                return yield* error;
              }
              return raced;
            }),
          ),
        );
        if (row === undefined) {
          return yield* new StorageUnavailable({ cause: "jobs enqueue returned no row" });
        }
        return row;
      });

    // Compare-and-swap on attempts: the guarded update only lands when no
    // other worker claimed the row between our read and write.
    const claim = (tenantId: TenantId, id: string): Effect.Effect<boolean, StorageUnavailable> =>
      Effect.gen(function* () {
        const seen = yield* Effect.try({
          try: () => db.select().from(jobs).where(scope(tenantId, id)).get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (seen === undefined || seen.status !== "queued") {
          return false;
        }
        const claimed = yield* Effect.try({
          try: () =>
            db
              .update(jobs)
              .set({ status: "running", updatedAt: nowInstant() })
              .where(
                and(
                  eq(jobs.tenantId, tenantId),
                  eq(jobs.id, id),
                  eq(jobs.status, "queued"),
                  eq(jobs.attempts, seen.attempts),
                ),
              )
              .returning({ id: jobs.id })
              .all(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        return claimed.length > 0;
      });

    const finish = (
      tenantId: TenantId,
      id: string,
      outcome: JobOutcome,
    ): Effect.Effect<boolean, StorageUnavailable> =>
      Effect.gen(function* () {
        const seen = yield* Effect.try({
          try: () => db.select().from(jobs).where(scope(tenantId, id)).get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (seen === undefined) {
          return false;
        }
        const updated = yield* Effect.try({
          try: () =>
            db
              .update(jobs)
              .set({
                status: outcome.status,
                lastError: outcome.lastError ?? null,
                attempts: seen.attempts + 1,
                updatedAt: nowInstant(),
              })
              .where(scope(tenantId, id))
              .returning({ id: jobs.id })
              .all(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        return updated.length > 0;
      });

    const listDue = (
      tenantId: TenantId,
      limit: number,
    ): Effect.Effect<readonly JobRow[], StorageUnavailable> =>
      Effect.try({
        try: () =>
          db
            .select()
            .from(jobs)
            .where(and(eq(jobs.tenantId, tenantId), eq(jobs.status, "queued")))
            .orderBy(asc(jobs.createdAt))
            .limit(limit)
            .all(),
        catch: (cause) => new StorageUnavailable({ cause }),
      });

    // Privileged worker scan: the job queue is not a tenant-owned ledger.
    const listDueAll = (
      kind: string,
      limit: number,
    ): Effect.Effect<readonly JobRow[], StorageUnavailable> =>
      Effect.try({
        try: () =>
          db
            .select()
            .from(jobs)
            .where(and(eq(jobs.status, "queued"), eq(jobs.kind, kind)))
            .orderBy(asc(jobs.createdAt))
            .limit(limit)
            .all(),
        catch: (cause) => new StorageUnavailable({ cause }),
      });

    const reclaimRunning = (kind: string): Effect.Effect<number, StorageUnavailable> =>
      Effect.try({
        try: () =>
          db
            .update(jobs)
            .set({ status: "queued", updatedAt: nowInstant() })
            .where(and(eq(jobs.kind, kind), eq(jobs.status, "running")))
            .returning({ id: jobs.id })
            .all().length,
        catch: (cause) => new StorageUnavailable({ cause }),
      });

    return { enqueue, claim, finish, listDue, listDueAll, reclaimRunning };
  }),
);
