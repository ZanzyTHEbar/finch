import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  ReconciliationConflict,
  StorageUnavailable,
  nowInstant,
  uuidv7,
  type TenantId,
} from "@finch/core";
import { Db } from "../client.ts";
import { reconciliations } from "../schema/index.ts";

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
    ) => Effect.Effect<ReconciliationRow, StorageUnavailable>;
    readonly confirm: (
      tenantId: TenantId,
      transactionId: string,
      receiptId: string,
    ) => Effect.Effect<ReconciliationRow, ReconciliationConflict | StorageUnavailable>;
    readonly reject: (
      tenantId: TenantId,
      transactionId: string,
      receiptId: string,
    ) => Effect.Effect<ReconciliationRow, ReconciliationConflict | StorageUnavailable>;
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

      const propose = (
        tenantId: TenantId,
        input: ProposeInput,
      ): Effect.Effect<ReconciliationRow, StorageUnavailable> =>
        Effect.gen(function* () {
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
      ): Effect.Effect<ReconciliationRow, ReconciliationConflict | StorageUnavailable> =>
        Effect.gen(function* () {
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
