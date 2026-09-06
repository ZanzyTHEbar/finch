// Manual rebuild round-trip verification (not a vitest file).
// Run: DATABASE_URL=file:./data/verify.db bun tests/manual/rebuild-roundtrip.ts
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
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
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { makeTestLayers, runTest } from "../setup.ts";

const stableStringify = (value: unknown): string => {
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const main = async (): Promise<void> => {
  const raw = process.env["DATABASE_URL"] ?? "file:./data/verify.db";
  const path = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
  const dir = dirname(path);
  if (dir !== "" && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  try {
    const layer = makeTestLayers(sqlite);
    const tid = Schema.decodeUnknownSync(TenantId)("verify-tenant");
    const acct = "verify-acct";
    const txIds = ["v-tx-1", "v-tx-2", "v-tx-3", "v-tx-4", "v-tx-5"];
    const receiptId = "v-rc-1";
    const amounts = [4280n, 1299n, 7550n, 2100n, 999n];

    await runTest(
      layer,
      Effect.gen(function* () {
        const store = yield* EventStore;
        const runner = yield* ProjectionRunner;
        const { db } = yield* Db;
        yield* Effect.sync(() =>
          db
            .insert(tenants)
            .values({ id: tid, name: "verify", createdAt: nowInstant() })
            .run(),
        );
        const inputs: Array<AppendInput> = [
          {
            tenantId: tid,
            aggregateType: "account",
            aggregateId: acct,
            eventType: "AccountDiscovered",
            payload: { name: "Checking", type: "checking", currency: "EUR", status: "active" },
            actor: "verify",
          },
          ...txIds.map(
            (id, i): AppendInput => ({
              tenantId: tid,
              aggregateType: "transaction",
              aggregateId: id,
              eventType: "TransactionObserved",
              payload: {
                accountId: acct,
                amountMinor: amounts[i] ?? 100n,
                currency: "EUR",
                bookingDate: "2026-09-01",
                rawDescription: `Merchant ${String(i + 1)} purchase`,
                merchantName: `Merchant ${String(i + 1)}`,
                sourceFingerprint: `fp-verify-${String(i + 1)}`,
                status: "booked",
              },
              actor: "verify",
            }),
          ),
          {
            tenantId: tid,
            aggregateType: "receipt",
            aggregateId: receiptId,
            eventType: "ReceiptCaptured",
            payload: {
              merchant: "Merchant 1",
              receiptDate: "2026-09-01",
              currency: "EUR",
              totalMinor: 4280n,
              imageHash: "hash-verify-1",
              sourceUri: "img://verify-1",
            },
            actor: "verify",
          },
          {
            tenantId: tid,
            aggregateType: "reconciliation",
            aggregateId: "v-match-1",
            eventType: "MatchProposed",
            payload: { transactionId: "v-tx-1", receiptId, score: 0.95 },
            actor: "verify",
          },
          {
            tenantId: tid,
            aggregateType: "reconciliation",
            aggregateId: "v-match-1",
            eventType: "MatchConfirmed",
            payload: { transactionId: "v-tx-1", receiptId, confirmedBy: "verify" },
            actor: "verify",
          },
          {
            tenantId: tid,
            aggregateType: "summary",
            aggregateId: "v-sum-1",
            eventType: "SummaryGenerated",
            payload: { periodType: "month", period: "2026-09", contentHash: "verify123" },
            actor: "verify",
          },
        ];
        for (const input of inputs) {
          const record = yield* store.append(input);
          yield* runner.project(record);
        }
      }),
    );

    const hashState = (): Promise<string> =>
      runTest(
        layer,
        Effect.gen(function* () {
          const txs = yield* TransactionRepository;
          const receipts = yield* ReceiptRepository;
          const recons = yield* ReconciliationRepository;
          const docs = yield* SearchDocumentRepository;
          const summaries = yield* SummaryRepository;
          const checkpoints = yield* EventReadRepository;
          const txList = yield* txs.list(tid, {});
          const receipt = yield* receipts.findById(tid, receiptId);
          const reconList = yield* recons.findByTransaction(tid, "v-tx-1");
          const docList = yield* docs.listAll(tid);
          const summary = yield* summaries.get(tid, "month", "2026-09");
          const checkpoint = yield* checkpoints.getCheckpoint(tid, "main");
          const state = {
            txs: txList.map((t) => ({
              id: t.id,
              amountMinor: t.amountMinor,
              status: t.status,
              merchantName: t.merchantName,
            })),
            receipt: { id: receipt.id, transactionId: receipt.transactionId },
            recons: reconList.map((r) => ({ status: r.status, score: r.score })),
            docs: docList.map((d) => ({
              sourceType: d.sourceType,
              sourceId: d.sourceId,
              content: d.content,
            })),
            summary: summary === null ? null : summary.content,
            checkpoint,
          };
          const digest = createHash("sha256").update(stableStringify(state)).digest("hex");
          return digest;
        }),
      );

    const first = await hashState();
    await runTest(
      layer,
      Effect.gen(function* () {
        const checkpoints = yield* EventReadRepository;
        const runner = yield* ProjectionRunner;
        yield* checkpoints.setCheckpoint(tid, "main", 0);
        yield* runner.rebuild({ tenantId: tid });
      }),
    );
    const second = await hashState();
    console.log(`before: ${first}`);
    console.log(`after:  ${second}`);
    if (first === second) {
      console.log("MATCH");
    } else {
      console.error("MISMATCH");
      process.exit(1);
    }
  } finally {
    sqlite.close();
  }
};

await main();
