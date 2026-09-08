import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { StorageUnavailable, nowInstant, type TenantId } from "@finch/core";
import { Db } from "../client.ts";
import { bankAuthIntents } from "../schema/index.ts";

export type BankAuthIntentRow = typeof bankAuthIntents.$inferSelect;

export class BankAuthIntentRepository extends Context.Tag("BankAuthIntentRepository")<
  BankAuthIntentRepository,
  {
    readonly put: (
      tenantId: TenantId,
      state: string,
    ) => Effect.Effect<BankAuthIntentRow, StorageUnavailable>;
    readonly get: (
      state: string,
    ) => Effect.Effect<BankAuthIntentRow | null, StorageUnavailable>;
    readonly remove: (state: string) => Effect.Effect<boolean, StorageUnavailable>;
  }
>() {}

export const BankAuthIntentRepositoryLive: Layer.Layer<BankAuthIntentRepository, never, Db> =
  Layer.effect(
    BankAuthIntentRepository,
    Effect.gen(function* () {
      const { db } = yield* Db;

      const put = (
        tenantId: TenantId,
        state: string,
      ): Effect.Effect<BankAuthIntentRow, StorageUnavailable> =>
        Effect.gen(function* () {
          const row = yield* Effect.try({
            try: () =>
              db
                .insert(bankAuthIntents)
                .values({ state, tenantId, createdAt: nowInstant() })
                .onConflictDoUpdate({
                  target: bankAuthIntents.state,
                  set: { tenantId, createdAt: nowInstant() },
                })
                .returning()
                .get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          if (row === undefined) {
            return yield* new StorageUnavailable({
              cause: "bank_auth_intents put returned no row",
            });
          }
          return row;
        });

      const get = (state: string): Effect.Effect<BankAuthIntentRow | null, StorageUnavailable> =>
        Effect.map(
          Effect.try({
            try: () =>
              db.select().from(bankAuthIntents).where(eq(bankAuthIntents.state, state)).get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          }),
          (row) => row ?? null,
        );

      const remove = (state: string): Effect.Effect<boolean, StorageUnavailable> =>
        Effect.map(
          Effect.try({
            try: () =>
              db
                .delete(bankAuthIntents)
                .where(eq(bankAuthIntents.state, state))
                .returning({ state: bankAuthIntents.state })
                .all(),
            catch: (cause) => new StorageUnavailable({ cause }),
          }),
          (rows) => rows.length > 0,
        );

      return { put, get, remove };
    }),
  );
