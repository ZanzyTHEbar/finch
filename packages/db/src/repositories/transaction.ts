import { and, asc, eq, gte, lte } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  StorageUnavailable,
  TransactionNotFound,
  type IsoDate,
  type TenantId,
} from "@finch/core";
import { Db } from "../client.ts";
import { transactions } from "../schema/index.ts";

export type TransactionRow = typeof transactions.$inferSelect;
export type TransactionInsert = Omit<typeof transactions.$inferInsert, "tenantId">;
export type TransactionPatch = Partial<Omit<typeof transactions.$inferInsert, "id" | "tenantId">>;

export interface TransactionFilters {
  readonly accountId?: string;
  readonly status?: string;
  readonly sincePostedDate?: IsoDate;
  readonly untilPostedDate?: IsoDate;
  readonly limit?: number;
  readonly offset?: number;
}

export class TransactionRepository extends Context.Tag("TransactionRepository")<
  TransactionRepository,
  {
    readonly insert: (
      tenantId: TenantId,
      row: TransactionInsert,
    ) => Effect.Effect<TransactionRow, StorageUnavailable>;
    readonly findById: (
      tenantId: TenantId,
      id: string,
    ) => Effect.Effect<TransactionRow, TransactionNotFound | StorageUnavailable>;
    readonly list: (
      tenantId: TenantId,
      filters: TransactionFilters,
    ) => Effect.Effect<readonly TransactionRow[], StorageUnavailable>;
    readonly updateById: (
      tenantId: TenantId,
      id: string,
      patch: TransactionPatch,
    ) => Effect.Effect<TransactionRow, TransactionNotFound | StorageUnavailable>;
  }
>() {}

export const TransactionRepositoryLive: Layer.Layer<TransactionRepository, never, Db> =
  Layer.effect(
    TransactionRepository,
    Effect.gen(function* () {
      const { db } = yield* Db;
      const scope = (tenantId: TenantId, id: string) =>
        and(eq(transactions.tenantId, tenantId), eq(transactions.id, id));

      const findById = (
        tenantId: TenantId,
        id: string,
      ): Effect.Effect<TransactionRow, TransactionNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          const row = yield* Effect.try({
            try: () => db.select().from(transactions).where(scope(tenantId, id)).get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          if (row === undefined) {
            return yield* new TransactionNotFound({ transactionId: id });
          }
          return row;
        });

      const insert = (
        tenantId: TenantId,
        row: TransactionInsert,
      ): Effect.Effect<TransactionRow, StorageUnavailable> =>
        Effect.gen(function* () {
          const inserted = yield* Effect.try({
            try: () =>
              db
                .insert(transactions)
                .values({ ...row, tenantId })
                .returning()
                .get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          if (inserted === undefined) {
            return yield* new StorageUnavailable({ cause: "transactions insert returned no row" });
          }
          return inserted;
        });

      const list = (
        tenantId: TenantId,
        filters: TransactionFilters,
      ): Effect.Effect<readonly TransactionRow[], StorageUnavailable> =>
        Effect.try({
          try: () => {
            const conditions = [eq(transactions.tenantId, tenantId)];
            if (filters.accountId !== undefined) {
              conditions.push(eq(transactions.accountId, filters.accountId));
            }
            if (filters.status !== undefined) {
              conditions.push(eq(transactions.status, filters.status));
            }
            if (filters.sincePostedDate !== undefined) {
              conditions.push(gte(transactions.postedDate, filters.sincePostedDate));
            }
            if (filters.untilPostedDate !== undefined) {
              conditions.push(lte(transactions.postedDate, filters.untilPostedDate));
            }
            return db
              .select()
              .from(transactions)
              .where(and(...conditions))
              .orderBy(asc(transactions.observedAt), asc(transactions.id))
              .limit(filters.limit ?? 100)
              .offset(filters.offset ?? 0)
              .all();
          },
          catch: (cause) => new StorageUnavailable({ cause }),
        });

      const updateById = (
        tenantId: TenantId,
        id: string,
        patch: TransactionPatch,
      ): Effect.Effect<TransactionRow, TransactionNotFound | StorageUnavailable> =>
        Effect.gen(function* () {
          const set = {
            ...(patch.accountId !== undefined ? { accountId: patch.accountId } : {}),
            ...(patch.amountMinor !== undefined ? { amountMinor: patch.amountMinor } : {}),
            ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.postedDate !== undefined ? { postedDate: patch.postedDate } : {}),
            ...(patch.observedAt !== undefined ? { observedAt: patch.observedAt } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.merchantName !== undefined ? { merchantName: patch.merchantName } : {}),
            ...(patch.counterpartyName !== undefined ? { counterpartyName: patch.counterpartyName } : {}),
            ...(patch.valueDate !== undefined ? { valueDate: patch.valueDate } : {}),
            ...(patch.category !== undefined ? { category: patch.category } : {}),
            ...(patch.categorySource !== undefined ? { categorySource: patch.categorySource } : {}),
            ...(patch.externalId !== undefined ? { externalId: patch.externalId } : {}),
          };
          if (Object.keys(set).length === 0) {
            return yield* findById(tenantId, id);
          }
          const updated = yield* Effect.try({
            try: () =>
              db.update(transactions).set(set).where(scope(tenantId, id)).returning().get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          if (updated === undefined) {
            return yield* new TransactionNotFound({ transactionId: id });
          }
          return updated;
        });

      return { insert, findById, list, updateById };
    }),
  );
