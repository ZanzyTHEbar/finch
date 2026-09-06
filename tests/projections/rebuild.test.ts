import { Database } from "bun:sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Db } from "../../packages/db/src/client.ts";
import { EventStore, type AppendInput } from "../../packages/db/src/event-store.ts";
import { ProjectionRunner } from "../../packages/db/src/projections/runner.ts";
import { EventReadRepository } from "../../packages/db/src/repositories/event.ts";
import { ReconciliationRepository } from "../../packages/db/src/repositories/reconciliation.ts";
import { ReceiptRepository } from "../../packages/db/src/repositories/receipt.ts";
import { SearchDocumentRepository } from "../../packages/db/src/repositories/search-document.ts";
import { SummaryRepository } from "../../packages/db/src/repositories/summary.ts";
import { TransactionRepository } from "../../packages/db/src/repositories/transaction.ts";
import { tenants } from "../../packages/db/src/schema/index.ts";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { makeTestLayers, runTest } from "../setup.ts";

const TID = Schema.decodeUnknownSync(TenantId)("t-rebuild-1");
const TIDC = Schema.decodeUnknownSync(TenantId)("t-crash-a");
const TIDD = Schema.decodeUnknownSync(TenantId)("t-crash-b");
const TIDF = Schema.decodeUnknownSync(TenantId)("t-fts-1");

const ACCT = "acct-main";
const TX1 = "tx-main-1";
const TX2 = "tx-main-2";
const TX3 = "tx-main-3";
const RC = "rc-main-1";

const seedTenantRow = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    );
  });

const observed = (
  tid: TenantIdT,
  aggregateId: string,
  accountId: string,
  amountMinor: bigint,
  merchantName: string,
  fingerprint: string,
): AppendInput => ({
  tenantId: tid,
  aggregateType: "transaction",
  aggregateId,
  eventType: "TransactionObserved",
  payload: {
    accountId,
    amountMinor,
    currency: "EUR",
    bookingDate: "2026-09-01",
    rawDescription: `${merchantName} purchase`,
    merchantName,
    sourceFingerprint: fingerprint,
    status: "booked",
  },
  actor: "test",
});

// Full realistic stream: account + 3 observed (one reversed, one reclassified)
// + receipt + propose/confirm + summary.
const mainStream = (tid: TenantIdT): ReadonlyArray<AppendInput> => [
  {
    tenantId: tid,
    aggregateType: "account",
    aggregateId: ACCT,
    eventType: "AccountDiscovered",
    payload: { name: "Checking", type: "checking", currency: "EUR", status: "active" },
    actor: "test",
  },
  observed(tid, TX1, ACCT, 4280n, "Continente", "fp-main-1"),
  observed(tid, TX2, ACCT, 1299n, "BP", "fp-main-2"),
  observed(tid, TX3, ACCT, 7550n, "Worten", "fp-main-3"),
  {
    tenantId: tid,
    aggregateType: "receipt",
    aggregateId: RC,
    eventType: "ReceiptCaptured",
    payload: {
      merchant: "Continente",
      receiptDate: "2026-09-01",
      currency: "EUR",
      totalMinor: 4280n,
      imageHash: "hash-main-1",
      sourceUri: "img://main-1",
    },
    actor: "test",
  },
  {
    tenantId: tid,
    aggregateType: "reconciliation",
    aggregateId: "match-main-1",
    eventType: "MatchProposed",
    payload: { transactionId: TX1, receiptId: RC, score: 0.92 },
    actor: "test",
  },
  {
    tenantId: tid,
    aggregateType: "reconciliation",
    aggregateId: "match-main-1",
    eventType: "MatchConfirmed",
    payload: { transactionId: TX1, receiptId: RC, confirmedBy: "clerk" },
    actor: "test",
  },
  {
    tenantId: tid,
    aggregateType: "transaction",
    aggregateId: TX2,
    eventType: "TransactionReclassified",
    payload: { category: "groceries" },
    actor: "test",
  },
  {
    tenantId: tid,
    aggregateType: "transaction",
    aggregateId: TX3,
    eventType: "TransactionReversed",
    payload: { reason: "duplicate charge" },
    actor: "test",
  },
  {
    tenantId: tid,
    aggregateType: "summary",
    aggregateId: "sum-main-1",
    eventType: "SummaryGenerated",
    payload: { periodType: "month", period: "2026-09", contentHash: "abc123" },
    actor: "test",
  },
];

// Volatile timestamps/uuids are projected out so incremental and rebuild
// snapshots compare exactly.
const captureMainSnapshot = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const txs = yield* TransactionRepository;
    const receipts = yield* ReceiptRepository;
    const recons = yield* ReconciliationRepository;
    const docs = yield* SearchDocumentRepository;
    const summaries = yield* SummaryRepository;
    const checkpoints = yield* EventReadRepository;
    const txList = yield* txs.list(tid, {});
    const receipt = yield* receipts.findById(tid, RC);
    const reconList = yield* recons.findByTransaction(tid, TX1);
    const docList = yield* docs.listAll(tid);
    const summary = yield* summaries.get(tid, "month", "2026-09");
    const checkpoint = yield* checkpoints.getCheckpoint(tid, "main");
    return {
      txs: txList.map((t) => ({
        id: t.id,
        accountId: t.accountId,
        amountMinor: t.amountMinor,
        currency: t.currency,
        status: t.status,
        postedDate: t.postedDate,
        description: t.description,
        merchantName: t.merchantName,
        category: t.category,
        categorySource: t.categorySource,
      })),
      receipt: {
        id: receipt.id,
        merchant: receipt.merchant,
        totalMinor: receipt.totalMinor,
        currency: receipt.currency,
        receiptDate: receipt.receiptDate,
        status: receipt.status,
        transactionId: receipt.transactionId,
      },
      recons: reconList.map((r) => ({
        transactionId: r.transactionId,
        receiptId: r.receiptId,
        status: r.status,
        score: r.score,
      })),
      docs: docList.map((d) => ({
        sourceType: d.sourceType,
        sourceId: d.sourceId,
        content: d.content,
      })),
      summary:
        summary === null
          ? null
          : { periodType: summary.periodType, period: summary.period, content: summary.content },
      checkpoint,
    };
  });

const crashStream = (tid: TenantIdT, tag: string): ReadonlyArray<AppendInput> => [
  {
    tenantId: tid,
    aggregateType: "account",
    aggregateId: `acct-${tag}`,
    eventType: "AccountDiscovered",
    payload: { name: "Checking", type: "checking", currency: "EUR", status: "active" },
    actor: "test",
  },
  ...([1000n, 2100n, 3250n, 4999n, 6120n] as const).map(
    (amountMinor, i): AppendInput =>
      observed(tid, `tx-${tag}-${i + 1}`, `acct-${tag}`, amountMinor, `Merchant ${i + 1}`, `fp-${tag}-${i + 1}`),
  ),
];

const captureCrashSnapshot = (tid: TenantIdT, tag: string) =>
  Effect.gen(function* () {
    const txs = yield* TransactionRepository;
    const docs = yield* SearchDocumentRepository;
    const txList = yield* txs.list(tid, {});
    const docList = yield* docs.listAll(tid);
    // Normalize the per-tenant id tokens (multi-char, so prose is untouched).
    const tagToken = (s: string): string =>
      s.split(`acct-${tag}`).join("acct-tag").split(`tx-${tag}-`).join("tx-tag-");
    return {
      txs: txList.map((t) => ({
        id: tagToken(t.id),
        amountMinor: t.amountMinor,
        currency: t.currency,
        status: t.status,
        merchantName: t.merchantName,
      })),
      docs: docList.map((d) => ({ sourceType: d.sourceType, content: tagToken(d.content) })),
    };
  });

// Test-local read-only mapping of the FTS5 mirror table (relational API only).
const searchDocumentsFts = sqliteTable("search_documents_fts", {
  rowid: integer("rowid"),
  content: text("content"),
});

describe("projection rebuild", () => {
  it("incremental projection is identical to a full rebuild", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const before = await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          const runner = yield* ProjectionRunner;
          yield* seedTenantRow(TID);
          for (const input of mainStream(TID)) {
            const record = yield* store.append(input);
            yield* runner.project(record);
          }
          return yield* captureMainSnapshot(TID);
        }),
      );
      // Sanity: the derived state actually reflects the stream.
      expect(before.txs.length).toBe(3);
      expect(before.txs.find((t) => t.id === TX1)?.status).toBe("booked");
      expect(before.txs.find((t) => t.id === TX2)?.category).toBe("groceries");
      expect(before.txs.find((t) => t.id === TX3)?.status).toBe("reversed");
      expect(before.receipt.transactionId).toBe(TX1);
      expect(before.recons.map((r) => r.status)).toStrictEqual(["confirmed"]);
      expect(before.docs.length).toBe(5);
      expect(before.summary?.content).toStrictEqual({
        periodType: "month",
        period: "2026-09",
        contentHash: "abc123",
      });

      const after = await runTest(
        layer,
        Effect.gen(function* () {
          const checkpoints = yield* EventReadRepository;
          const runner = yield* ProjectionRunner;
          yield* checkpoints.setCheckpoint(TID, "main", 0);
          yield* runner.rebuild({ tenantId: TID });
          return yield* captureMainSnapshot(TID);
        }),
      );
      expect(after).toStrictEqual(before);
    } finally {
      sqlite.close();
    }
  });

  it("crash-resume converges to the full projection", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      // Tenant C: append 6 events but project only the first 3 (crash), then rebuild.
      await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          const runner = yield* ProjectionRunner;
          yield* seedTenantRow(TIDC);
          for (const input of crashStream(TIDC, "a")) {
            yield* store.append(input);
          }
          const recent = yield* store.readSince(TIDC, 0, 100);
          for (const record of recent.slice(0, 3)) {
            yield* runner.project(record);
          }
        }),
      );
      // Tenant D: same stream shape under distinct aggregate ids (projection
      // tables are keyed by global id), fully projected — the target.
      const expected = await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          const runner = yield* ProjectionRunner;
          yield* seedTenantRow(TIDD);
          for (const input of crashStream(TIDD, "b")) {
            const record = yield* store.append(input);
            yield* runner.project(record);
          }
          return yield* captureCrashSnapshot(TIDD, "b");
        }),
      );
      const actual = await runTest(
        layer,
        Effect.gen(function* () {
          const runner = yield* ProjectionRunner;
          const checkpoints = yield* EventReadRepository;
          yield* runner.rebuild({ tenantId: TIDC });
          const snapshot = yield* captureCrashSnapshot(TIDC, "a");
          // Resume consumed the whole stream: checkpoint sits on the last row.
          const checkpoint = yield* checkpoints.getCheckpoint(TIDC, "main");
          return { ...snapshot, checkpoint };
        }),
      );
      expect(actual.txs.length).toBe(5);
      expect(actual.checkpoint).toBe(6);
      expect({ txs: actual.txs, docs: actual.docs }).toStrictEqual(expected);
    } finally {
      sqlite.close();
    }
  });

  it("fts mirror stays in sync with search_documents", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const counts = await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          const runner = yield* ProjectionRunner;
          const docs = yield* SearchDocumentRepository;
          const { db } = yield* Db;
          yield* seedTenantRow(TIDF);
          for (const input of mainStream(TIDF)) {
            const record = yield* store.append(input);
            yield* runner.project(record);
          }
          const all = yield* docs.listAll(TIDF);
          const ftsRows = yield* Effect.sync(() => db.select().from(searchDocumentsFts).all());
          return { docs: all.length, fts: ftsRows.length };
        }),
      );
      expect(counts.docs).toBe(5);
      expect(counts.fts).toBe(counts.docs);
    } finally {
      sqlite.close();
    }
  });
});
