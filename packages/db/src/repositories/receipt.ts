import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ReceiptNotFound, StorageUnavailable, TransactionNotFound, type TenantId } from "@finch/core";
import { Db } from "../client.ts";
import { receipts, transactions } from "../schema/index.ts";

export type ReceiptRow = typeof receipts.$inferSelect;
export type ReceiptInsert = Omit<typeof receipts.$inferInsert, "tenantId">;

export class ReceiptRepository extends Context.Tag("ReceiptRepository")<
  ReceiptRepository,
  {
    readonly insert: (
      tenantId: TenantId,
      row: ReceiptInsert,
    ) => Effect.Effect<ReceiptRow, StorageUnavailable>;
    readonly findById: (
      tenantId: TenantId,
      id: string,
    ) => Effect.Effect<ReceiptRow, ReceiptNotFound | StorageUnavailable>;
    readonly linkTransaction: (
      tenantId: TenantId,
      receiptId: string,
      transactionId: string,
    ) => Effect.Effect<ReceiptRow, ReceiptNotFound | TransactionNotFound | StorageUnavailable>;
    readonly listUnmatched: (
      tenantId: TenantId,
      limit?: number,
    ) => Effect.Effect<readonly ReceiptRow[], StorageUnavailable>;
    readonly listLinkedTransactionIds: (
      tenantId: TenantId,
    ) => Effect.Effect<readonly string[], StorageUnavailable>;
  }
>() {}

export const ReceiptRepositoryLive: Layer.Layer<ReceiptRepository, never, Db> = Layer.effect(
  ReceiptRepository,
  Effect.gen(function* () {
    const { db } = yield* Db;
    const scope = (tenantId: TenantId, id: string) =>
      and(eq(receipts.tenantId, tenantId), eq(receipts.id, id));

    const findById = (
      tenantId: TenantId,
      id: string,
    ): Effect.Effect<ReceiptRow, ReceiptNotFound | StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* Effect.try({
          try: () => db.select().from(receipts).where(scope(tenantId, id)).get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (row === undefined) {
          return yield* new ReceiptNotFound({ receiptId: id });
        }
        return row;
      });

    const insert = (
      tenantId: TenantId,
      row: ReceiptInsert,
    ): Effect.Effect<ReceiptRow, StorageUnavailable> =>
      Effect.gen(function* () {
        const inserted = yield* Effect.try({
          try: () =>
            db
              .insert(receipts)
              .values({ ...row, tenantId })
              .returning()
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (inserted === undefined) {
          return yield* new StorageUnavailable({ cause: "receipts insert returned no row" });
        }
        return inserted;
      });

    const linkTransaction = (
      tenantId: TenantId,
      receiptId: string,
      transactionId: string,
    ): Effect.Effect<ReceiptRow, ReceiptNotFound | TransactionNotFound | StorageUnavailable> =>
      Effect.gen(function* () {
        // FKs only prove the transaction id exists, not that it belongs to
        // this tenant — refuse cross-tenant links before touching the receipt.
        const tx = yield* Effect.try({
          try: () =>
            db
              .select({ id: transactions.id })
              .from(transactions)
              .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId)))
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (tx === undefined) {
          return yield* new TransactionNotFound({ transactionId });
        }
        const linked = yield* Effect.try({
          try: () =>
            db
              .update(receipts)
              .set({ transactionId })
              .where(scope(tenantId, receiptId))
              .returning()
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (linked === undefined) {
          return yield* new ReceiptNotFound({ receiptId });
        }
        return linked;
      });

    const listUnmatched = (
      tenantId: TenantId,
      limit?: number,
    ): Effect.Effect<readonly ReceiptRow[], StorageUnavailable> =>
      Effect.try({
        try: () =>
          db
            .select()
            .from(receipts)
            .where(and(eq(receipts.tenantId, tenantId), isNull(receipts.transactionId)))
            .orderBy(asc(receipts.id))
            .limit(limit ?? 100)
            .all(),
        catch: (cause) => new StorageUnavailable({ cause }),
      });

    const listLinkedTransactionIds = (
      tenantId: TenantId,
    ): Effect.Effect<readonly string[], StorageUnavailable> =>
      Effect.try({
        try: () =>
          db
            .select({ transactionId: receipts.transactionId })
            .from(receipts)
            .where(and(eq(receipts.tenantId, tenantId), isNotNull(receipts.transactionId)))
            .all()
            .flatMap((row) => (row.transactionId === null ? [] : [row.transactionId])),
        catch: (cause) => new StorageUnavailable({ cause }),
      });

    return { insert, findById, linkTransaction, listUnmatched, listLinkedTransactionIds };
  }),
);
