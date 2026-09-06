import { Context, Effect, Layer, ParseResult, Schema } from "effect";
import {
  AccountDiscoveredV1,
  AccountRevokedV1,
  AccountUpdatedV1,
  MatchConfirmedV1,
  MatchProposedV1,
  MatchRejectedV1,
  ReceiptCapturedV1,
  ReceiptMatchedV1,
  StorageUnavailable,
  SummaryGeneratedV1,
  TransactionCorrectedV1,
  TransactionDeletedBySourceV1,
  TransactionObservedV1,
  TransactionReclassifiedV1,
  TransactionReversedV1,
  UnknownEventVersion,
  ValidationFailed,
  upcastPayload,
} from "@finch/core";
import type {
  AccountNotFound,
  ReceiptNotFound,
  ReconciliationConflict,
  TenantId,
  TenantMismatch,
  TransactionNotFound,
} from "@finch/core";
import { Db } from "../client.ts";
import { EventStore, type EventRecord } from "../event-store.ts";
import { AccountRepository } from "../repositories/account.ts";
import { EventReadRepository } from "../repositories/event.ts";
import { ReceiptRepository } from "../repositories/receipt.ts";
import { ReconciliationRepository, type ReconciliationRow } from "../repositories/reconciliation.ts";
import { SearchDocumentRepository } from "../repositories/search-document.ts";
import { SummaryRepository } from "../repositories/summary.ts";
import { TransactionRepository } from "../repositories/transaction.ts";
import { tenants } from "../schema/index.ts";
import { receiptCanonical, summaryCanonical, transactionCanonical } from "./search-documents.ts";
import { summaryContentKey } from "./summaries.ts";

export type ProjectError =
  | UnknownEventVersion
  | ValidationFailed
  | StorageUnavailable
  | AccountNotFound
  | TransactionNotFound
  | ReceiptNotFound
  | ReconciliationConflict
  | TenantMismatch;

export class ProjectionRunner extends Context.Tag("ProjectionRunner")<
  ProjectionRunner,
  {
    readonly project: (event: EventRecord) => Effect.Effect<void, ProjectError>;
    readonly rebuild: (opts?: {
      readonly tenantId?: TenantId;
    }) => Effect.Effect<{ readonly processed: number }, ProjectError>;
  }
>() {}

const decodePayload = <A, I>(
  schema: Schema.Schema<A, I, never>,
  eventType: string,
  payload: unknown,
): Effect.Effect<A, ValidationFailed> =>
  Schema.decodeUnknown(schema)(payload).pipe(
    Effect.mapError(
      (issue) =>
        new ValidationFailed({
          issues: [
            `${eventType} payload invalid: ${ParseResult.TreeFormatter.formatErrorSync(issue)}`,
          ],
        }),
    ),
  );

export const ProjectionRunnerLive: Layer.Layer<
  ProjectionRunner,
  never,
  | Db
  | EventStore
  | EventReadRepository
  | AccountRepository
  | TransactionRepository
  | ReceiptRepository
  | SearchDocumentRepository
  | SummaryRepository
  | ReconciliationRepository
> = Layer.effect(
  ProjectionRunner,
  Effect.gen(function* () {
    const { db } = yield* Db;
    const eventStore = yield* EventStore;
    const eventReads = yield* EventReadRepository;
    const accounts = yield* AccountRepository;
    const txs = yield* TransactionRepository;
    const receiptsRepo = yield* ReceiptRepository;
    const docs = yield* SearchDocumentRepository;
    const summariesRepo = yield* SummaryRepository;
    const recons = yield* ReconciliationRepository;

    const refreshTransactionDoc = (
      tenantId: TenantId,
      id: string,
    ): Effect.Effect<void, TransactionNotFound | StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* txs.findById(tenantId, id);
        yield* docs.upsert(
          tenantId,
          "transaction",
          id,
          transactionCanonical({
            bookingDate: row.postedDate ?? row.observedAt.slice(0, 10),
            amountMinor: row.amountMinor,
            currency: row.currency,
            merchant: row.merchantName,
            description: row.description,
            accountId: row.accountId ?? "unknown",
            category: row.category,
          }),
        );
      });

    const refreshReceiptDoc = (
      tenantId: TenantId,
      id: string,
    ): Effect.Effect<void, ReceiptNotFound | StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* receiptsRepo.findById(tenantId, id);
        yield* docs.upsert(
          tenantId,
          "receipt",
          id,
          receiptCanonical({
            receiptDate: row.receiptDate,
            totalMinor: row.totalMinor,
            currency: row.currency,
            merchant: row.merchant,
            imageRef: row.imageRef,
            status: row.status,
            transactionId: row.transactionId,
          }),
        );
      });

    // A decide event can arrive before its propose (out-of-order replay); in
    // that case seed the proposal, then decide again.
    const ensureDecided = (
      tenantId: TenantId,
      transactionId: string,
      receiptId: string,
      score: number,
      decide: (
        tenantId: TenantId,
        transactionId: string,
        receiptId: string,
      ) => Effect.Effect<ReconciliationRow, ReconciliationConflict | StorageUnavailable>,
    ): Effect.Effect<void, ReconciliationConflict | StorageUnavailable> =>
      decide(tenantId, transactionId, receiptId).pipe(
        Effect.asVoid,
        Effect.catchTag("ReconciliationConflict", () =>
          Effect.gen(function* () {
            yield* recons.propose(tenantId, { transactionId, receiptId, score });
            yield* decide(tenantId, transactionId, receiptId);
          }).pipe(Effect.asVoid),
        ),
      );

    const project = (event: EventRecord): Effect.Effect<void, ProjectError> =>
      Effect.gen(function* () {
        const tenantId = event.tenantId;
        const aggregateId = event.aggregateId;
        // Unknown event versions halt loudly instead of silently skipping.
        const payload = yield* upcastPayload(event.eventType, event.eventVersion, event.payload);
        switch (event.eventType) {
          case "AccountDiscovered": {
            const p = yield* decodePayload(AccountDiscoveredV1, event.eventType, payload);
            yield* accounts.upsertFromDiscovery(tenantId, {
              id: aggregateId,
              ...(p.externalRef !== undefined ? { externalRef: p.externalRef } : {}),
              name: p.name,
              type: p.type,
              currency: p.currency,
              status: "active",
              lastDiscoveredAt: event.metadata.recordedAt,
            });
            break;
          }
          case "AccountUpdated": {
            const p = yield* decodePayload(AccountUpdatedV1, event.eventType, payload);
            yield* accounts.applyUpdate(tenantId, aggregateId, {
              ...(p.name !== undefined ? { name: p.name } : {}),
              ...(p.status !== undefined ? { status: p.status } : {}),
            });
            break;
          }
          case "AccountRevoked": {
            yield* decodePayload(AccountRevokedV1, event.eventType, payload);
            yield* accounts.markRevoked(tenantId, aggregateId);
            break;
          }
          case "TransactionObserved": {
            const p = yield* decodePayload(TransactionObservedV1, event.eventType, payload);
            const already = yield* txs.findById(tenantId, aggregateId).pipe(
              Effect.as(true),
              Effect.catchTag("TransactionNotFound", () => Effect.succeed(false)),
            );
            if (!already) {
              yield* txs.insert(tenantId, {
                id: aggregateId,
                accountId: p.accountId,
                amountMinor: p.amountMinor,
                currency: p.currency,
                status: p.status,
                postedDate: p.bookingDate,
                observedAt: event.metadata.recordedAt,
                description: p.rawDescription,
                externalId: p.externalTransactionId ?? null,
                ...(p.valueDate !== undefined ? { valueDate: p.valueDate } : {}),
                ...(p.merchantName !== undefined ? { merchantName: p.merchantName } : {}),
                ...(p.counterpartyName !== undefined ? { counterpartyName: p.counterpartyName } : {}),
              });
            }
            yield* refreshTransactionDoc(tenantId, aggregateId);
            break;
          }
          case "TransactionReclassified": {
            const p = yield* decodePayload(TransactionReclassifiedV1, event.eventType, payload);
            yield* txs.updateById(tenantId, aggregateId, {
              category: p.category,
              categorySource: "explicit",
            });
            yield* refreshTransactionDoc(tenantId, aggregateId);
            break;
          }
          case "TransactionCorrected": {
            const p = yield* decodePayload(TransactionCorrectedV1, event.eventType, payload);
            yield* txs.updateById(tenantId, aggregateId, {
              ...(p.amountMinor !== undefined ? { amountMinor: p.amountMinor } : {}),
              ...(p.bookingDate !== undefined ? { postedDate: p.bookingDate } : {}),
              ...(p.merchantName !== undefined ? { merchantName: p.merchantName } : {}),
            });
            yield* refreshTransactionDoc(tenantId, aggregateId);
            break;
          }
          case "TransactionReversed": {
            yield* decodePayload(TransactionReversedV1, event.eventType, payload);
            yield* txs.updateById(tenantId, aggregateId, { status: "reversed" });
            yield* refreshTransactionDoc(tenantId, aggregateId);
            break;
          }
          case "TransactionDeletedBySource": {
            yield* decodePayload(TransactionDeletedBySourceV1, event.eventType, payload);
            yield* txs.updateById(tenantId, aggregateId, { status: "deleted" });
            yield* refreshTransactionDoc(tenantId, aggregateId);
            break;
          }
          case "ReceiptCaptured": {
            const p = yield* decodePayload(ReceiptCapturedV1, event.eventType, payload);
            const already = yield* receiptsRepo.findById(tenantId, aggregateId).pipe(
              Effect.as(true),
              Effect.catchTag("ReceiptNotFound", () => Effect.succeed(false)),
            );
            if (!already) {
              yield* receiptsRepo.insert(tenantId, {
                id: aggregateId,
                merchant: p.merchant ?? null,
                receiptDate: p.receiptDate ?? null,
                currency: p.currency ?? null,
                totalMinor: p.totalMinor,
                imageRef: p.sourceUri,
                imageHash: p.imageHash,
                status: "captured",
              });
            }
            yield* refreshReceiptDoc(tenantId, aggregateId);
            break;
          }
          case "ReceiptMatched": {
            const p = yield* decodePayload(ReceiptMatchedV1, event.eventType, payload);
            yield* receiptsRepo.linkTransaction(tenantId, aggregateId, p.transactionId);
            yield* ensureDecided(tenantId, p.transactionId, aggregateId, p.score, (t, tx, rx) =>
              recons.confirm(t, tx, rx),
            );
            yield* refreshReceiptDoc(tenantId, aggregateId);
            break;
          }
          case "MatchProposed": {
            const p = yield* decodePayload(MatchProposedV1, event.eventType, payload);
            yield* recons.propose(tenantId, {
              transactionId: p.transactionId,
              receiptId: p.receiptId,
              score: p.score,
            });
            break;
          }
          case "MatchConfirmed": {
            const p = yield* decodePayload(MatchConfirmedV1, event.eventType, payload);
            yield* ensureDecided(tenantId, p.transactionId, p.receiptId, 1, (t, tx, rx) =>
              recons.confirm(t, tx, rx),
            );
            yield* receiptsRepo.linkTransaction(tenantId, p.receiptId, p.transactionId);
            yield* refreshReceiptDoc(tenantId, p.receiptId);
            break;
          }
          case "MatchRejected": {
            const p = yield* decodePayload(MatchRejectedV1, event.eventType, payload);
            yield* ensureDecided(tenantId, p.transactionId, p.receiptId, 0, (t, tx, rx) =>
              recons.reject(t, tx, rx),
            );
            break;
          }
          case "SummaryGenerated": {
            const p = yield* decodePayload(SummaryGeneratedV1, event.eventType, payload);
            const key = summaryContentKey(p);
            yield* summariesRepo.upsert(
              tenantId,
              key.periodType,
              key.period,
              key.content,
              event.metadata.recordedAt,
            );
            yield* docs.upsert(
              tenantId,
              "summary",
              aggregateId,
              summaryCanonical(key.periodType, key.period, p.contentHash),
            );
            break;
          }
          default: {
            return yield* new UnknownEventVersion({
              eventType: event.eventType,
              eventVersion: event.eventVersion,
            });
          }
        }
        // ponytail: checkpoint advances sequentially after row writes, not in the
        // same tx; a crash between write and checkpoint replays from the last
        // checkpoint and converges via idempotent upserts/guarded inserts.
        yield* eventReads.setCheckpoint(tenantId, "main", event.rowid, event.id);
      });

    const rebuild = (opts?: {
      readonly tenantId?: TenantId;
    }): Effect.Effect<{ readonly processed: number }, ProjectError> =>
      Effect.gen(function* () {
        const tenantIds: ReadonlyArray<TenantId> =
          opts?.tenantId !== undefined
            ? [opts.tenantId]
            : yield* Effect.try({
                try: () =>
                  db
                    .select({ id: tenants.id })
                    .from(tenants)
                    .all()
                    .map((row) => row.id as TenantId),
                catch: (cause) => new StorageUnavailable({ cause }),
              });
        let processed = 0;
        for (const tenantId of tenantIds) {
          // ponytail: reset-to-zero full replay reusing setCheckpoint; every
          // row write below is idempotent so replay converges.
          yield* eventReads.setCheckpoint(tenantId, "main", 0);
          let cursor = 0;
          while (true) {
            const batch = yield* eventStore.readSince(tenantId, cursor, 500);
            if (batch.length === 0) {
              break;
            }
            for (const record of batch) {
              yield* project(record);
            }
            const last = batch[batch.length - 1];
            if (last === undefined) {
              break;
            }
            cursor = last.rowid;
            processed += batch.length;
          }
        }
        return { processed };
      });

    return { project, rebuild };
  }),
);
