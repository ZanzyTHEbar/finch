import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { StorageUnavailable, nowInstant, type TenantId } from "@finch/core";
import { Db } from "../client.ts";
import { tenants } from "../schema/index.ts";

export type TenantRow = typeof tenants.$inferSelect;

export class TenantRepository extends Context.Tag("TenantRepository")<
  TenantRepository,
  {
    readonly get: (id: TenantId) => Effect.Effect<TenantRow | null, StorageUnavailable>;
    readonly create: (id: TenantId, name: string) => Effect.Effect<TenantRow, StorageUnavailable>;
    readonly list: () => Effect.Effect<readonly TenantRow[], StorageUnavailable>;
    readonly remove: (id: TenantId) => Effect.Effect<boolean, StorageUnavailable>;
  }
>() {}

export const TenantRepositoryLive: Layer.Layer<TenantRepository, never, Db> = Layer.effect(
  TenantRepository,
  Effect.gen(function* () {
    const { db } = yield* Db;

    const get = (id: TenantId): Effect.Effect<TenantRow | null, StorageUnavailable> =>
      Effect.map(
        Effect.try({
          try: () => db.select().from(tenants).where(eq(tenants.id, id)).get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        }),
        (row) => row ?? null,
      );

    const create = (id: TenantId, name: string): Effect.Effect<TenantRow, StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* Effect.try({
          try: () =>
            db.insert(tenants).values({ id, name, createdAt: nowInstant() }).returning().get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (row === undefined) {
          return yield* new StorageUnavailable({ cause: "tenant create returned no row" });
        }
        return row;
      });

    const list = (): Effect.Effect<readonly TenantRow[], StorageUnavailable> =>
      Effect.try({
        try: () => db.select().from(tenants).all(),
        catch: (cause) => new StorageUnavailable({ cause }),
      });

    const remove = (id: TenantId): Effect.Effect<boolean, StorageUnavailable> =>
      Effect.map(
        Effect.try({
          try: () =>
            db.delete(tenants).where(eq(tenants.id, id)).returning({ id: tenants.id }).all(),
          catch: (cause) => new StorageUnavailable({ cause }),
        }),
        (rows) => rows.length > 0,
      );

    return { get, create, list, remove };
  }),
);
