import { and, asc, eq } from "drizzle-orm";
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
        });
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

    return { enqueue, claim, finish, listDue };
  }),
);
