import { and, asc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ReceiptNotFound, StorageUnavailable, type TenantId } from "@finch/core";
import { Db } from "../client.ts";
import { receipts } from "../schema/index.ts";

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
    ) => Effect.Effect<ReceiptRow, ReceiptNotFound | StorageUnavailable>;
    readonly listUnmatched: (
      tenantId: TenantId,
      limit?: number,
    ) => Effect.Effect<readonly ReceiptRow[], StorageUnavailable>;
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
    ): Effect.Effect<ReceiptRow, ReceiptNotFound | StorageUnavailable> =>
      Effect.gen(function* () {
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

    return { insert, findById, linkTransaction, listUnmatched };
  }),
);
