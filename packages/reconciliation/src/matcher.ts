import { Context, Effect, Layer } from "effect"
import {
  DuplicateEvent,
  StorageUnavailable,
  type ReconciliationConflict,
  type TenantId,
  type TenantMismatch,
  type ValidationFailed,
} from "@finch/core"
import {
  EventStore,
  ProjectionRunner,
  ReceiptRepository,
  ReconciliationRepository,
  TransactionRepository,
  receiptCanonical,
  type AppendInput,
  type EventRecord,
} from "@finch/db"
import { HybridSearch, parseDocumentId, type HybridSearchError } from "@finch/search/hybrid"
import { blendScore, scorePair, shouldAutoMatch, shouldPropose } from "./score.ts"

export interface MatchStats {
  readonly proposed: number
  readonly matched: number
  readonly skipped: number
}

export class ReceiptMatcher extends Context.Tag("ReceiptMatcher")<
  ReceiptMatcher,
  {
    readonly match: (
      tenantId: TenantId,
    ) => Effect.Effect<
      MatchStats,
      StorageUnavailable | ValidationFailed | TenantMismatch | ReconciliationConflict | HybridSearchError
    >
    readonly confirm: (
      tenantId: TenantId,
      transactionId: string,
      receiptId: string,
      confirmedBy: string,
    ) => Effect.Effect<
      { readonly id: string },
      StorageUnavailable | ValidationFailed | TenantMismatch | ReconciliationConflict
    >
    readonly reject: (
      tenantId: TenantId,
      transactionId: string,
      receiptId: string,
      reason: string,
    ) => Effect.Effect<
      { readonly id: string },
      StorageUnavailable | ValidationFailed | TenantMismatch | ReconciliationConflict
    >
  }
>() {}

const pairId = (tenantId: TenantId, transactionId: string, receiptId: string): string =>
  `${tenantId}:${transactionId}:${receiptId}`

export const ReceiptMatcherLive: Layer.Layer<
  ReceiptMatcher,
  never,
  | ReceiptRepository
  | TransactionRepository
  | ReconciliationRepository
  | EventStore
  | ProjectionRunner
  | HybridSearch
> = Layer.effect(
  ReceiptMatcher,
  Effect.gen(function* () {
    const receipts = yield* ReceiptRepository
    const txs = yield* TransactionRepository
    const recons = yield* ReconciliationRepository
    const events = yield* EventStore
    const projections = yield* ProjectionRunner
    const search = yield* HybridSearch

    const project = (event: EventRecord) =>
      projections.project(event).pipe(
        Effect.catchIf(
          (error) =>
            error._tag !== "StorageUnavailable" &&
            error._tag !== "ValidationFailed" &&
            error._tag !== "TenantMismatch" &&
            error._tag !== "ReconciliationConflict",
          (error) => Effect.fail(new StorageUnavailable({ cause: error })),
        ),
      )

    const append = (
      input: AppendInput,
    ): Effect.Effect<
      EventRecord | null,
      StorageUnavailable | ValidationFailed | TenantMismatch | ReconciliationConflict
    > =>
      events.append(input).pipe(
        Effect.catchIf(
          (error): error is DuplicateEvent => error._tag === "DuplicateEvent",
          () => Effect.succeed(null),
        ),
        Effect.tap((event) => (event === null ? Effect.void : project(event))),
      )

    return ReceiptMatcher.of({
      match: (tenantId) =>
        Effect.gen(function* () {
          const unmatched = yield* receipts.listUnmatched(tenantId, 100)
          const booked = yield* txs.list(tenantId, { status: "booked", limit: 500 })
          const linked = yield* receipts.listLinkedTransactionIds(tenantId)
          const proposed = yield* recons.listByStatus(tenantId, "proposed")
          const confirmed = yield* recons.listByStatus(tenantId, "confirmed")
          const takenTx = new Set<string>(linked)
          const takenRx = new Set<string>()
          for (const row of [...proposed, ...confirmed]) {
            if (row.transactionId !== null) {
              takenTx.add(row.transactionId)
            }
            if (row.receiptId !== null) {
              takenRx.add(row.receiptId)
            }
          }
          let proposedCount = 0
          let matchedCount = 0
          let skipped = 0
          for (const receipt of unmatched) {
            if (takenRx.has(receipt.id) || receipt.totalMinor === null) {
              skipped += 1
              continue
            }
            const found = yield* search.hybridSearch({
              tenantId,
              text: receiptCanonical({
                merchant: receipt.merchant,
                totalMinor: receipt.totalMinor,
                currency: receipt.currency,
                receiptDate: receipt.receiptDate,
                status: receipt.status,
                transactionId: receipt.transactionId,
                imageRef: receipt.imageRef,
              }),
              topK: 20,
            })
            const boosts = new Map<string, number>()
            for (const hit of found.hits) {
              const parsed = parseDocumentId(hit.documentId)
              if (parsed === null || parsed.sourceType !== "transaction" || hit.denseSimilarity === undefined) {
                continue
              }
              const previous = boosts.get(parsed.sourceId)
              if (previous === undefined || hit.denseSimilarity > previous) {
                boosts.set(parsed.sourceId, hit.denseSimilarity)
              }
            }
            let best: { readonly id: string; readonly score: number } | null = null
            for (const tx of booked) {
              if (takenTx.has(tx.id)) {
                continue
              }
              const score = blendScore(
                scorePair({
                  receiptTotalMinor: receipt.totalMinor,
                  receiptCurrency: receipt.currency,
                  receiptDate: receipt.receiptDate,
                  receiptMerchant: receipt.merchant,
                  transactionAmountMinor: tx.amountMinor,
                  transactionCurrency: tx.currency,
                  transactionPostedDate: tx.postedDate,
                  transactionDescription: tx.description,
                  transactionMerchantName: tx.merchantName,
                  transactionCounterpartyName: tx.counterpartyName,
                }),
                boosts.get(tx.id) ?? 0,
              )
              if (!shouldPropose(score)) {
                continue
              }
              if (best === null || score > best.score) {
                best = { id: tx.id, score }
              }
            }
            if (best === null) {
              skipped += 1
              continue
            }
            const id = pairId(tenantId, best.id, receipt.id)
            if (shouldAutoMatch(best.score)) {
              const event = yield* append({
                tenantId,
                aggregateType: "receipt",
                aggregateId: receipt.id,
                eventType: "ReceiptMatched",
                payload: { transactionId: best.id, score: best.score },
                actor: "matcher",
              })
              if (event === null) {
                skipped += 1
                continue
              }
              takenTx.add(best.id)
              takenRx.add(receipt.id)
              matchedCount += 1
            } else {
              const event = yield* append({
                tenantId,
                aggregateType: "reconciliation",
                aggregateId: id,
                eventType: "MatchProposed",
                payload: { transactionId: best.id, receiptId: receipt.id, score: best.score },
                actor: "matcher",
              })
              if (event === null) {
                skipped += 1
                continue
              }
              takenTx.add(best.id)
              takenRx.add(receipt.id)
              proposedCount += 1
            }
          }
          return { proposed: proposedCount, matched: matchedCount, skipped }
        }),
      confirm: (tenantId, transactionId, receiptId, confirmedBy) =>
        Effect.gen(function* () {
          const id = pairId(tenantId, transactionId, receiptId)
          const event = yield* append({
            tenantId,
            aggregateType: "reconciliation",
            aggregateId: id,
            eventType: "MatchConfirmed",
            payload: { transactionId, receiptId, confirmedBy },
            actor: confirmedBy,
          })
          if (event === null) {
            return { id }
          }
          return { id }
        }),
      reject: (tenantId, transactionId, receiptId, reason) =>
        Effect.gen(function* () {
          const id = pairId(tenantId, transactionId, receiptId)
          const event = yield* append({
            tenantId,
            aggregateType: "reconciliation",
            aggregateId: id,
            eventType: "MatchRejected",
            payload: { transactionId, receiptId, reason },
            actor: "mcp",
          })
          if (event === null) {
            return { id }
          }
          return { id }
        }),
    })
  }),
)
