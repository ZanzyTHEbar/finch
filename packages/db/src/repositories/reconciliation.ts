import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  ReconciliationConflict,
  StorageUnavailable,
  TenantMismatch,
  nowInstant,
  uuidv7,
  type TenantId,
} from "@finch/core";
import { Db } from "../client.ts";
import { receipts, reconciliations, transactions } from "../schema/index.ts";

export type ReconciliationRow = typeof reconciliations.$inferSelect;

export interface ProposeInput {
  readonly id?: string;
  readonly transactionId: string;
  readonly receiptId: string;
  readonly score: number;
}

export class ReconciliationRepository extends Context.Tag("ReconciliationRepository")<
  ReconciliationRepository,
  {
    readonly propose: (
      tenantId: TenantId,
      input: ProposeInput,
    ) => Effect.Effect<ReconciliationRow, StorageUnavailable | TenantMismatch>;
    readonly confirm: (
      tenantId: TenantId,
      transactionId: string,
      receiptId: string,
    ) => Effect.Effect<ReconciliationRow, ReconciliationConflict | StorageUnavailable | TenantMismatch>;
    readonly reject: (
      tenantId: TenantId,
      transactionId: string,
      receiptId: string,
    ) => Effect.Effect<ReconciliationRow, ReconciliationConflict | StorageUnavailable | TenantMismatch>;
    readonly findByTransaction: (
      tenantId: TenantId,
      transactionId: string,
    ) => Effect.Effect<readonly ReconciliationRow[], StorageUnavailable>;
    readonly listByStatus: (
      tenantId: TenantId,
      status: string,
    ) => Effect.Effect<readonly ReconciliationRow[], StorageUnavailable>;
  }
>() {}

export const ReconciliationRepositoryLive: Layer.Layer<ReconciliationRepository, never, Db> =
  Layer.effect(
    ReconciliationRepository,
    Effect.gen(function* () {
      const { db } = yield* Db;
      const pair = (tenantId: TenantId, transactionId: string, receiptId: string) =>
        and(
          eq(reconciliations.tenantId, tenantId),
          eq(reconciliations.transactionId, transactionId),
          eq(reconciliations.receiptId, receiptId),
        );

      // Both sides of a link must live under the calling tenant. A missing
      // row and a foreign-tenant row are indistinguishable here on purpose:
      // confirming existence across tenants would leak tenant membership.
      const assertSameTenant = (
        tenantId: TenantId,
        transactionId: string,
        receiptId: string,
      ): Effect.Effect<void, StorageUnavailable | TenantMismatch> =>
        Effect.gen(function* () {
          const rows = yield* Effect.try({
            try: () => ({
              tx: db
                .select({ id: transactions.id })
                .from(transactions)
                .where(
                  and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId)),
                )
                .get(),
              rc: db
                .select({ id: receipts.id })
                .from(receipts)
                .where(and(eq(receipts.tenantId, tenantId), eq(receipts.id, receiptId)))
                .get(),
            }),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          if (rows.tx === undefined || rows.rc === undefined) {
            return yield* new TenantMismatch();
          }
        });

      const propose = (
        tenantId: TenantId,
        input: ProposeInput,
      ): Effect.Effect<ReconciliationRow, StorageUnavailable | TenantMismatch> =>
        Effect.gen(function* () {
          yield* assertSameTenant(tenantId, input.transactionId, input.receiptId);
          const row = yield* Effect.try({
            try: () =>
              db
                .insert(reconciliations)
                .values({
                  id: input.id ?? uuidv7(),
                  tenantId,
                  transactionId: input.transactionId,
                  receiptId: input.receiptId,
                  status: "proposed",
                  score: input.score,
                  decidedAt: null,
                })
                .onConflictDoUpdate({
                  target: [
                    reconciliations.tenantId,
                    reconciliations.transactionId,
                    reconciliations.receiptId,
                  ],
                  set: { status: "proposed", score: input.score, decidedAt: null },
                })
                .returning()
                .get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          if (row === undefined) {
            return yield* new StorageUnavailable({
              cause: "reconciliations propose returned no row",
            });
          }
          return row;
        });

      const decide = (
        status: "confirmed" | "rejected",
        tenantId: TenantId,
        transactionId: string,
        receiptId: string,
      ): Effect.Effect<ReconciliationRow, ReconciliationConflict | StorageUnavailable | TenantMismatch> =>
        Effect.gen(function* () {
          yield* assertSameTenant(tenantId, transactionId, receiptId);
          const row = yield* Effect.try({
            try: () =>
              db
                .update(reconciliations)
                .set({ status, decidedAt: nowInstant() })
                .where(pair(tenantId, transactionId, receiptId))
                .returning()
                .get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          if (row === undefined) {
            return yield* new ReconciliationConflict({
              reason: `no reconciliation for transaction ${transactionId} and receipt ${receiptId}`,
            });
          }
          return row;
        });

      const findByTransaction = (
        tenantId: TenantId,
        transactionId: string,
      ): Effect.Effect<readonly ReconciliationRow[], StorageUnavailable> =>
        Effect.try({
          try: () =>
            db
              .select()
              .from(reconciliations)
              .where(
                and(
                  eq(reconciliations.tenantId, tenantId),
                  eq(reconciliations.transactionId, transactionId),
                ),
              )
              .all(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });

      const listByStatus = (
        tenantId: TenantId,
        status: string,
      ): Effect.Effect<readonly ReconciliationRow[], StorageUnavailable> =>
        Effect.try({
          try: () =>
            db
              .select()
              .from(reconciliations)
              .where(
                and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.status, status)),
              )
              .all(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });

      return {
        propose,
        confirm: (tenantId, transactionId, receiptId) =>
          decide("confirmed", tenantId, transactionId, receiptId),
        reject: (tenantId, transactionId, receiptId) =>
          decide("rejected", tenantId, transactionId, receiptId),
        findByTransaction,
        listByStatus,
      };
    }),
  );
