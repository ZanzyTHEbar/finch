import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { AccountNotFound, StorageUnavailable, TenantMismatch, type TenantId } from "@finch/core";
import { Db } from "../client.ts";
import { accounts } from "../schema/index.ts";

export type AccountRow = typeof accounts.$inferSelect;

export interface AccountDiscovery {
  readonly id: string;
  readonly externalRef?: string;
  readonly name: string;
  readonly type: string;
  readonly currency: string;
  readonly status: string;
  readonly lastDiscoveredAt?: string;
}

export interface AccountPatch {
  readonly name?: string;
  readonly status?: string;
}

export class AccountRepository extends Context.Tag("AccountRepository")<
  AccountRepository,
  {
    readonly upsertFromDiscovery: (
      tenantId: TenantId,
      data: AccountDiscovery,
    ) => Effect.Effect<AccountRow, StorageUnavailable | TenantMismatch>;
    readonly applyUpdate: (
      tenantId: TenantId,
      id: string,
      patch: AccountPatch,
    ) => Effect.Effect<AccountRow, AccountNotFound | StorageUnavailable>;
    readonly markRevoked: (
      tenantId: TenantId,
      id: string,
    ) => Effect.Effect<AccountRow, AccountNotFound | StorageUnavailable>;
    readonly findById: (
      tenantId: TenantId,
      id: string,
    ) => Effect.Effect<AccountRow, AccountNotFound | StorageUnavailable>;
    readonly findByExternalRef: (
      tenantId: TenantId,
      externalRef: string,
    ) => Effect.Effect<AccountRow | null, StorageUnavailable>;
    readonly list: (tenantId: TenantId) => Effect.Effect<readonly AccountRow[], StorageUnavailable>;
  }
>() {}

export const AccountRepositoryLive: Layer.Layer<AccountRepository, never, Db> = Layer.effect(
  AccountRepository,
  Effect.gen(function* () {
    const { db } = yield* Db;
    const scope = (tenantId: TenantId, id: string) =>
      and(eq(accounts.tenantId, tenantId), eq(accounts.id, id));

    const findById = (
      tenantId: TenantId,
      id: string,
    ): Effect.Effect<AccountRow, AccountNotFound | StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* Effect.try({
          try: () => db.select().from(accounts).where(scope(tenantId, id)).get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (row === undefined) {
          return yield* new AccountNotFound({ accountId: id });
        }
        return row;
      });

    const upsertFromDiscovery = (
      tenantId: TenantId,
      data: AccountDiscovery,
    ): Effect.Effect<AccountRow, StorageUnavailable | TenantMismatch> =>
      Effect.gen(function* () {
        // ponytail: account ids are a global namespace (PK); a cross-tenant
        // id reuse fails loudly instead of clobbering the owning tenant's row.
        const occupying = yield* Effect.try({
          try: () =>
            db
              .select({ tenantId: accounts.tenantId })
              .from(accounts)
              .where(eq(accounts.id, data.id))
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (occupying !== undefined && occupying.tenantId !== tenantId) {
          return yield* new TenantMismatch();
        }
        const row = yield* Effect.try({
          try: () =>
            db
              .insert(accounts)
              .values({
                id: data.id,
                tenantId,
                externalRef: data.externalRef ?? null,
                name: data.name,
                type: data.type,
                currency: data.currency,
                status: data.status,
                lastDiscoveredAt: data.lastDiscoveredAt ?? null,
              })
              .onConflictDoUpdate({
                target: accounts.id,
                set: {
                  externalRef: data.externalRef ?? null,
                  name: data.name,
                  type: data.type,
                  currency: data.currency,
                  status: data.status,
                  lastDiscoveredAt: data.lastDiscoveredAt ?? null,
                },
              })
              .returning()
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (row === undefined) {
          return yield* new StorageUnavailable({ cause: "accounts upsert returned no row" });
        }
        return row;
      });

    const applyUpdate = (
      tenantId: TenantId,
      id: string,
      patch: AccountPatch,
    ): Effect.Effect<AccountRow, AccountNotFound | StorageUnavailable> =>
      Effect.gen(function* () {
        if (patch.name === undefined && patch.status === undefined) {
          return yield* findById(tenantId, id);
        }
        const row = yield* Effect.try({
          try: () =>
            db
              .update(accounts)
              .set({
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                ...(patch.status !== undefined ? { status: patch.status } : {}),
              })
              .where(scope(tenantId, id))
              .returning()
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (row === undefined) {
          return yield* new AccountNotFound({ accountId: id });
        }
        return row;
      });

    const markRevoked = (
      tenantId: TenantId,
      id: string,
    ): Effect.Effect<AccountRow, AccountNotFound | StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* Effect.try({
          try: () =>
            db
              .update(accounts)
              .set({ status: "revoked" })
              .where(scope(tenantId, id))
              .returning()
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (row === undefined) {
          return yield* new AccountNotFound({ accountId: id });
        }
        return row;
      });

    const findByExternalRef = (
      tenantId: TenantId,
      externalRef: string,
    ): Effect.Effect<AccountRow | null, StorageUnavailable> =>
      Effect.map(
        Effect.try({
          try: () =>
            db
              .select()
              .from(accounts)
              .where(and(eq(accounts.tenantId, tenantId), eq(accounts.externalRef, externalRef)))
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        }),
        (row) => row ?? null,
      );

    const list = (tenantId: TenantId): Effect.Effect<readonly AccountRow[], StorageUnavailable> =>
      Effect.try({
        try: () => db.select().from(accounts).where(eq(accounts.tenantId, tenantId)).all(),
        catch: (cause) => new StorageUnavailable({ cause }),
      });

    return { upsertFromDiscovery, applyUpdate, markRevoked, findById, findByExternalRef, list };
  }),
);
