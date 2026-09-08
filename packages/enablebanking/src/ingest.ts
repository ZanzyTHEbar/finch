import { Context, Effect, Layer } from "effect"
import {
  BankProvider,
  BankSessionMissing,
  StorageUnavailable,
  type IsoDate,
  type ProviderUnavailable,
  type TenantId,
  type TenantMismatch,
  type ValidationFailed,
} from "@finch/core"
import {
  AccountRepository,
  BankSessionRepository,
  EventStore,
  ProjectionRunner,
  type EventRecord,
} from "@finch/db"
import { mapCashAccountType, sourceFingerprint } from "./map.ts"

export interface IngestStats {
  readonly accountsObserved: number
  readonly transactionsObserved: number
  readonly duplicatesSkipped: number
  readonly zerosSkipped: number
  readonly invalidSkipped: number
}

export class BankIngest extends Context.Tag("BankIngest")<
  BankIngest,
  {
    readonly sync: (
      tenantId: TenantId,
      since?: IsoDate,
    ) => Effect.Effect<
      IngestStats,
      ProviderUnavailable | BankSessionMissing | StorageUnavailable | ValidationFailed | TenantMismatch
    >
  }
>() {}

export const BankIngestLive: Layer.Layer<
  BankIngest,
  never,
  BankProvider | BankSessionRepository | AccountRepository | EventStore | ProjectionRunner
> = Layer.effect(
  BankIngest,
  Effect.gen(function* () {
    const bank = yield* BankProvider
    const bankSessions = yield* BankSessionRepository
    const accounts = yield* AccountRepository
    const events = yield* EventStore
    const projections = yield* ProjectionRunner

    const project = (event: EventRecord) =>
      projections.project(event).pipe(
        Effect.catchIf(
          (error) =>
            error._tag !== "StorageUnavailable" &&
            error._tag !== "ValidationFailed" &&
            error._tag !== "TenantMismatch",
          (error) => Effect.fail(new StorageUnavailable({ cause: error })),
        ),
      )

    return BankIngest.of({
      sync: (tenantId, since) =>
        Effect.gen(function* () {
          const session = yield* bankSessions.get(tenantId)
          if (session === null) {
            return yield* new BankSessionMissing({ tenantId })
          }
          let accountsObserved = 0
          let transactionsObserved = 0
          let duplicatesSkipped = 0
          let zerosSkipped = 0
          let invalidSkipped = 0
          const snapshots = yield* bank.listAccounts(session.sessionId)
          for (const account of snapshots) {
            if (account.currency === undefined) {
              invalidSkipped += 1
              continue
            }
            const uid = account.externalAccountId
            const type = mapCashAccountType(account.cashAccountType)
            const name = account.name ?? account.iban ?? uid
            const existing = yield* accounts.findByExternalRef(tenantId, uid)
            const aggregateId = existing?.id ?? uid
            const discovered = yield* events
              .append({
                tenantId,
                aggregateType: "account",
                aggregateId,
                eventType: "AccountDiscovered",
                payload: {
                  externalRef: uid,
                  name,
                  type,
                  currency: account.currency,
                  status: "active",
                },
                actor: "enablebanking",
              })
              .pipe(
                Effect.catchTag("DuplicateEvent", () => {
                  duplicatesSkipped += 1
                  return Effect.succeed(null)
                }),
              )
            if (discovered !== null) {
              yield* project(discovered)
            }
            const byRef = yield* accounts.findByExternalRef(tenantId, uid)
            const local =
              byRef !== null
                ? byRef
                : yield* accounts.findById(tenantId, aggregateId).pipe(
                    Effect.catchTag("AccountNotFound", (error) =>
                      Effect.fail(new StorageUnavailable({ cause: error })),
                    ),
                  )
            const txs = yield* bank.listTransactions(session.sessionId, uid, since)
            for (const tx of txs) {
              if (tx.amountMinor === 0n) {
                zerosSkipped += 1
                continue
              }
              const fingerprint = sourceFingerprint({
                accountExternalId: uid,
                ...(tx.externalTransactionId !== undefined
                  ? { externalTransactionId: tx.externalTransactionId }
                  : {}),
                ...(tx.entryReference !== undefined ? { entryReference: tx.entryReference } : {}),
                bookingDate: tx.bookingDate,
                amountMinor: tx.amountMinor,
                currency: tx.currency,
                creditDebitIndicator: tx.creditDebitIndicator,
              })
              const observed = yield* events
                .append({
                  tenantId,
                  aggregateType: "transaction",
                  aggregateId: `${tenantId}:${fingerprint}`,
                  eventType: "TransactionObserved",
                  payload: {
                    accountId: local.id,
                    amountMinor: tx.amountMinor,
                    currency: tx.currency,
                    bookingDate: tx.bookingDate,
                    rawDescription: tx.rawDescription,
                    sourceFingerprint: fingerprint,
                    status: tx.status,
                    ...(tx.valueDate !== undefined ? { valueDate: tx.valueDate } : {}),
                    ...(tx.merchantName !== undefined ? { merchantName: tx.merchantName } : {}),
                    ...(tx.counterpartyName !== undefined
                      ? { counterpartyName: tx.counterpartyName }
                      : {}),
                    ...(tx.externalTransactionId !== undefined
                      ? { externalTransactionId: tx.externalTransactionId }
                      : {}),
                  },
                  actor: "enablebanking",
                })
                .pipe(
                  Effect.catchTag("DuplicateEvent", () => {
                    duplicatesSkipped += 1
                    return Effect.succeed(null)
                  }),
                )
              if (observed !== null) {
                yield* project(observed)
                transactionsObserved += 1
              }
            }
            accountsObserved += 1
          }
          return {
            accountsObserved,
            transactionsObserved,
            duplicatesSkipped,
            zerosSkipped,
            invalidSkipped,
          }
        }),
    })
  }),
)
