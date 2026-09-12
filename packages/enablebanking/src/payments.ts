import { Context, Effect, Layer } from "effect"
import {
  BankProvider,
  DuplicateEvent,
  PaymentNotFound,
  ProviderUnavailable,
  StorageUnavailable,
  TenantMismatch,
  ValidationFailed,
  type BankPayment,
  type CreateBankPaymentInput,
  type TenantId,
} from "@finch/core"
import { EventStore, PaymentRepository, ProjectionRunner, type EventRecord } from "@finch/db"
import type { AppendInput } from "@finch/db"

export type BankPaymentsError =
  | StorageUnavailable
  | ValidationFailed
  | TenantMismatch
  | PaymentNotFound
  | ProviderUnavailable

export class BankPayments extends Context.Tag("BankPayments")<
  BankPayments,
  {
    readonly create: (
      tenantId: TenantId,
      input: CreateBankPaymentInput,
    ) => Effect.Effect<BankPayment, BankPaymentsError>
    readonly get: (tenantId: TenantId, paymentId: string) => Effect.Effect<BankPayment, BankPaymentsError>
    readonly list: (tenantId: TenantId) => Effect.Effect<readonly BankPayment[], BankPaymentsError>
    readonly submit: (tenantId: TenantId, paymentId: string) => Effect.Effect<BankPayment, BankPaymentsError>
    readonly delete: (tenantId: TenantId, paymentId: string) => Effect.Effect<void, BankPaymentsError>
  }
>() {}

const toBankPayment = (row: {
  readonly paymentId: string
  readonly status: string
  readonly url: string | null
}): BankPayment => ({
  paymentId: row.paymentId,
  status: row.status,
  ...(row.url === null ? {} : { url: row.url }),
})

export const BankPaymentsLive: Layer.Layer<
  BankPayments,
  never,
  BankProvider | PaymentRepository | EventStore | ProjectionRunner
> = Layer.effect(
  BankPayments,
  Effect.gen(function* () {
    const bank = yield* BankProvider
    const payments = yield* PaymentRepository
    const events = yield* EventStore
    const projections = yield* ProjectionRunner

    const project = (event: EventRecord) =>
      projections.project(event).pipe(
        Effect.catchIf(
          (error) =>
            error._tag !== "StorageUnavailable" &&
            error._tag !== "ValidationFailed" &&
            error._tag !== "TenantMismatch" &&
            error._tag !== "PaymentNotFound",
          (error) => Effect.fail(new StorageUnavailable({ cause: error })),
        ),
      )

    const append = (
      input: AppendInput,
    ): Effect.Effect<EventRecord | null, StorageUnavailable | ValidationFailed | TenantMismatch | PaymentNotFound> =>
      events.append(input).pipe(
        Effect.catchIf(
          (error): error is DuplicateEvent => error._tag === "DuplicateEvent",
          () => Effect.succeed(null),
        ),
        Effect.tap((event) => (event === null ? Effect.void : project(event))),
      )

    const persistStatus = (
      tenantId: TenantId,
      live: BankPayment,
    ): Effect.Effect<BankPayment, StorageUnavailable | ValidationFailed | TenantMismatch | PaymentNotFound> =>
      Effect.gen(function* () {
        const stored = yield* payments.get(tenantId, live.paymentId)
        if (stored.status === live.status && (stored.url ?? undefined) === live.url) {
          return live
        }
        yield* append({
          tenantId,
          aggregateType: "payment",
          aggregateId: `${tenantId}:${live.paymentId}`,
          eventType: "PaymentStatusChanged",
          payload: {
            paymentId: live.paymentId,
            status: live.status,
            ...(live.url === undefined ? {} : { url: live.url }),
          },
          actor: "enablebanking",
        })
        return live
      })

    return BankPayments.of({
      create: (tenantId, input) =>
        Effect.gen(function* () {
          const live = yield* bank.createPayment(input)
          yield* append({
            tenantId,
            aggregateType: "payment",
            aggregateId: `${tenantId}:${live.paymentId}`,
            eventType: "PaymentCreated",
            payload: {
              paymentId: live.paymentId,
              status: live.status,
              ...(live.url === undefined ? {} : { url: live.url }),
              aspspName: input.aspsp.name,
              aspspCountry: input.aspsp.country,
              amountMinor: input.amountMinor,
              currency: input.currency,
              creditorName: input.creditorName,
              creditorIban: input.creditorIban,
              paymentType: input.paymentType,
              ...(input.remittance === undefined ? {} : { remittance: input.remittance }),
              state: input.state,
            },
            actor: "enablebanking",
          })
          return live
        }),
      get: (tenantId, paymentId) =>
        Effect.gen(function* () {
          yield* payments.get(tenantId, paymentId)
          const live = yield* bank.getPayment(paymentId)
          return yield* persistStatus(tenantId, live)
        }),
      list: (tenantId) =>
        Effect.gen(function* () {
          const rows = yield* payments.list(tenantId)
          return rows.map(toBankPayment)
        }),
      submit: (tenantId, paymentId) =>
        Effect.gen(function* () {
          yield* payments.get(tenantId, paymentId)
          const live = yield* bank.submitPayment(paymentId)
          return yield* persistStatus(tenantId, live)
        }),
      delete: (tenantId, paymentId) =>
        Effect.gen(function* () {
          yield* payments.get(tenantId, paymentId)
          yield* bank.deletePayment(paymentId)
          yield* append({
            tenantId,
            aggregateType: "payment",
            aggregateId: `${tenantId}:${paymentId}`,
            eventType: "PaymentDeleted",
            payload: { paymentId },
            actor: "enablebanking",
          })
        }),
    })
  }),
)
