import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  PaymentNotFound,
  StorageUnavailable,
  TenantMismatch,
  nowInstant,
  type TenantId,
} from "@finch/core";
import { Db } from "../client.ts";
import { payments } from "../schema/index.ts";

export type PaymentRow = typeof payments.$inferSelect;
export type PaymentInsert = Omit<typeof payments.$inferInsert, "tenantId" | "createdAt" | "updatedAt">;

export class PaymentRepository extends Context.Tag("PaymentRepository")<
  PaymentRepository,
  {
    readonly put: (
      tenantId: TenantId,
      row: PaymentInsert,
    ) => Effect.Effect<PaymentRow, StorageUnavailable | TenantMismatch>;
    readonly get: (
      tenantId: TenantId,
      paymentId: string,
    ) => Effect.Effect<PaymentRow, PaymentNotFound | TenantMismatch | StorageUnavailable>;
    readonly list: (tenantId: TenantId) => Effect.Effect<readonly PaymentRow[], StorageUnavailable>;
    readonly updateStatus: (
      tenantId: TenantId,
      paymentId: string,
      status: string,
      url?: string,
    ) => Effect.Effect<PaymentRow, PaymentNotFound | TenantMismatch | StorageUnavailable>;
    readonly remove: (
      tenantId: TenantId,
      paymentId: string,
    ) => Effect.Effect<boolean, PaymentNotFound | TenantMismatch | StorageUnavailable>;
  }
>() {}

export const PaymentRepositoryLive: Layer.Layer<PaymentRepository, never, Db> = Layer.effect(
  PaymentRepository,
  Effect.gen(function* () {
    const { db } = yield* Db;

    const findByPaymentId = (paymentId: string): Effect.Effect<PaymentRow | null, StorageUnavailable> =>
      Effect.map(
        Effect.try({
          try: () => db.select().from(payments).where(eq(payments.paymentId, paymentId)).get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        }),
        (row) => row ?? null,
      );

    const requireOwned = (
      tenantId: TenantId,
      paymentId: string,
    ): Effect.Effect<PaymentRow, PaymentNotFound | TenantMismatch | StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* findByPaymentId(paymentId);
        if (row === null) {
          return yield* new PaymentNotFound({ paymentId });
        }
        if (row.tenantId !== tenantId) {
          return yield* new TenantMismatch();
        }
        return row;
      });

    const put = (
      tenantId: TenantId,
      row: PaymentInsert,
    ): Effect.Effect<PaymentRow, StorageUnavailable | TenantMismatch> =>
      Effect.gen(function* () {
        const existing = yield* findByPaymentId(row.paymentId);
        if (existing !== null && existing.tenantId !== tenantId) {
          return yield* new TenantMismatch();
        }
        if (existing !== null) {
          const updated = yield* Effect.try({
            try: () =>
              db
                .update(payments)
                .set({
                  status: row.status,
                  url: row.url ?? null,
                  aspspName: row.aspspName,
                  aspspCountry: row.aspspCountry,
                  amountMinor: row.amountMinor,
                  currency: row.currency,
                  creditorName: row.creditorName,
                  creditorIban: row.creditorIban,
                  paymentType: row.paymentType,
                  remittance: row.remittance ?? null,
                  state: row.state,
                  updatedAt: nowInstant(),
                })
                .where(eq(payments.paymentId, row.paymentId))
                .returning()
                .get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          if (updated === undefined) {
            return yield* new StorageUnavailable({ cause: "payments put update returned no row" });
          }
          if (updated.tenantId !== tenantId) {
            return yield* new TenantMismatch();
          }
          return updated;
        }
        const inserted = yield* Effect.try({
          try: () =>
            db
              .insert(payments)
              .values({
                ...row,
                tenantId,
                createdAt: nowInstant(),
                updatedAt: nowInstant(),
              })
              .returning()
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (inserted === undefined) {
          return yield* new StorageUnavailable({ cause: "payments put insert returned no row" });
        }
        if (inserted.tenantId !== tenantId) {
          return yield* new TenantMismatch();
        }
        return inserted;
      });

    const get = (
      tenantId: TenantId,
      paymentId: string,
    ): Effect.Effect<PaymentRow, PaymentNotFound | TenantMismatch | StorageUnavailable> =>
      requireOwned(tenantId, paymentId);

    const list = (tenantId: TenantId): Effect.Effect<readonly PaymentRow[], StorageUnavailable> =>
      Effect.try({
        try: () => db.select().from(payments).where(eq(payments.tenantId, tenantId)).all(),
        catch: (cause) => new StorageUnavailable({ cause }),
      });

    const updateStatus = (
      tenantId: TenantId,
      paymentId: string,
      status: string,
      url?: string,
    ): Effect.Effect<PaymentRow, PaymentNotFound | TenantMismatch | StorageUnavailable> =>
      Effect.gen(function* () {
        yield* requireOwned(tenantId, paymentId);
        const updated = yield* Effect.try({
          try: () =>
            db
              .update(payments)
              .set({
                status,
                ...(url === undefined ? {} : { url }),
                updatedAt: nowInstant(),
              })
              .where(eq(payments.paymentId, paymentId))
              .returning()
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (updated === undefined) {
          return yield* new PaymentNotFound({ paymentId });
        }
        if (updated.tenantId !== tenantId) {
          return yield* new TenantMismatch();
        }
        return updated;
      });

    const remove = (
      tenantId: TenantId,
      paymentId: string,
    ): Effect.Effect<boolean, PaymentNotFound | TenantMismatch | StorageUnavailable> =>
      Effect.gen(function* () {
        yield* requireOwned(tenantId, paymentId);
        const rows = yield* Effect.try({
          try: () =>
            db
              .delete(payments)
              .where(eq(payments.paymentId, paymentId))
              .returning({ paymentId: payments.paymentId })
              .all(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        return rows.length > 0;
      });

    return { put, get, list, updateStatus, remove };
  }),
);
