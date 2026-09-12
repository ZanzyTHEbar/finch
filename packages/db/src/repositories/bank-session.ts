import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { StorageUnavailable, nowInstant, type TenantId } from "@finch/core";
import { Db } from "../client.ts";
import { bankSessions, type BankSessionStatus } from "../schema/index.ts";

export type BankSessionRow = typeof bankSessions.$inferSelect;

export class BankSessionRepository extends Context.Tag("BankSessionRepository")<
  BankSessionRepository,
  {
    readonly get: (
      tenantId: TenantId,
    ) => Effect.Effect<BankSessionRow | null, StorageUnavailable>;
    readonly upsert: (
      tenantId: TenantId,
      sessionId: string,
      status?: BankSessionStatus,
    ) => Effect.Effect<BankSessionRow, StorageUnavailable>;
    readonly updateStatus: (
      tenantId: TenantId,
      status: BankSessionStatus,
    ) => Effect.Effect<BankSessionRow | null, StorageUnavailable>;
    readonly remove: (tenantId: TenantId) => Effect.Effect<boolean, StorageUnavailable>;
  }
>() {}

export const BankSessionRepositoryLive: Layer.Layer<BankSessionRepository, never, Db> =
  Layer.effect(
    BankSessionRepository,
    Effect.gen(function* () {
      const { db } = yield* Db;

      const get = (
        tenantId: TenantId,
      ): Effect.Effect<BankSessionRow | null, StorageUnavailable> =>
        Effect.map(
          Effect.try({
            try: () =>
              db.select().from(bankSessions).where(eq(bankSessions.tenantId, tenantId)).get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          }),
          (row) => row ?? null,
        );

      const upsert = (
        tenantId: TenantId,
        sessionId: string,
        status: BankSessionStatus = "active",
      ): Effect.Effect<BankSessionRow, StorageUnavailable> =>
        Effect.gen(function* () {
          const row = yield* Effect.try({
            try: () =>
              db
                .insert(bankSessions)
                .values({
                  tenantId,
                  sessionId,
                  status,
                  createdAt: nowInstant(),
                  updatedAt: nowInstant(),
                })
                .onConflictDoUpdate({
                  target: bankSessions.tenantId,
                  set: { sessionId, status, updatedAt: nowInstant() },
                })
                .returning()
                .get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          if (row === undefined) {
            return yield* new StorageUnavailable({
              cause: "bank_sessions upsert returned no row",
            });
          }
          return row;
        });

      const updateStatus = (
        tenantId: TenantId,
        status: BankSessionStatus,
      ): Effect.Effect<BankSessionRow | null, StorageUnavailable> =>
        Effect.map(
          Effect.try({
            try: () =>
              db
                .update(bankSessions)
                .set({ status, updatedAt: nowInstant() })
                .where(eq(bankSessions.tenantId, tenantId))
                .returning()
                .get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          }),
          (row) => row ?? null,
        );

      const remove = (tenantId: TenantId): Effect.Effect<boolean, StorageUnavailable> =>
        Effect.map(
          Effect.try({
            try: () =>
              db
                .delete(bankSessions)
                .where(eq(bankSessions.tenantId, tenantId))
                .returning({ tenantId: bankSessions.tenantId })
                .all(),
            catch: (cause) => new StorageUnavailable({ cause }),
          }),
          (rows) => rows.length > 0,
        );

      return { get, upsert, updateStatus, remove };
    }),
  );
