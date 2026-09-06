import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Db } from "../../packages/db/src/client.ts";
import { AccountRepository } from "../../packages/db/src/repositories/account.ts";
import { ReceiptRepository } from "../../packages/db/src/repositories/receipt.ts";
import { ReconciliationRepository } from "../../packages/db/src/repositories/reconciliation.ts";
import { TransactionRepository } from "../../packages/db/src/repositories/transaction.ts";
import { tenants } from "../../packages/db/src/schema/index.ts";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { makeTestLayers, runTest } from "../setup.ts";

const TIDA = Schema.decodeUnknownSync(TenantId)("tenant-a");
const TIDB = Schema.decodeUnknownSync(TenantId)("tenant-b");

// One receipt + one transaction per tenant, all under distinct global ids.
const seedBothTenants = Effect.gen(function* () {
  const accounts = yield* AccountRepository;
  const txs = yield* TransactionRepository;
  const receipts = yield* ReceiptRepository;
  const { db } = yield* Db;
  yield* Effect.sync(() => {
    db
      .insert(tenants)
      .values([
        { id: TIDA, name: "Tenant A", createdAt: nowInstant() },
        { id: TIDB, name: "Tenant B", createdAt: nowInstant() },
      ])
      .run();
  });
  for (const [tid, acct] of [
    [TIDA, "acct-a"],
    [TIDB, "acct-b"],
  ] as const) {
    yield* accounts.upsertFromDiscovery(tid, {
      id: acct,
      name: "Checking",
      type: "checking",
      currency: "EUR",
      status: "active",
    });
  }
  yield* txs.insert(TIDA, {
    id: "tx-a-1",
    accountId: "acct-a",
    amountMinor: 4280n,
    currency: "EUR",
    status: "booked",
    postedDate: "2026-09-01",
    observedAt: nowInstant(),
    description: "Continente",
  });
  yield* txs.insert(TIDB, {
    id: "tx-b-1",
    accountId: "acct-b",
    amountMinor: 999n,
    currency: "EUR",
    status: "booked",
    postedDate: "2026-09-01",
    observedAt: nowInstant(),
    description: "Fnac",
  });
  yield* receipts.insert(TIDA, {
    id: "rc-a-1",
    merchant: "Continente",
    receiptDate: "2026-09-01",
    currency: "EUR",
    totalMinor: 4280n,
    imageRef: "img-a-1",
    imageHash: "ha1",
    status: "captured",
  });
  yield* receipts.insert(TIDB, {
    id: "rc-b-1",
    merchant: "Fnac",
    receiptDate: "2026-09-01",
    currency: "EUR",
    totalMinor: 999n,
    imageRef: "img-b-1",
    imageHash: "hb1",
    status: "captured",
  });
});

describe("cross-tenant links", () => {
  it("rejects linkTransaction against another tenant's transaction", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const failure = await runTest(
        layer,
        Effect.gen(function* () {
          const receipts = yield* ReceiptRepository;
          yield* seedBothTenants;
          return yield* Effect.flip(receipts.linkTransaction(TIDA, "rc-a-1", "tx-b-1"));
        }),
      );
      expect(failure._tag).toBe("TransactionNotFound");
      // The failed link must not have touched the receipt.
      const untouched = await runTest(
        layer,
        Effect.gen(function* () {
          const receipts = yield* ReceiptRepository;
          return yield* receipts.findById(TIDA, "rc-a-1");
        }),
      );
      expect(untouched.transactionId).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("rejects propose across tenants", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const failures = await runTest(
        layer,
        Effect.gen(function* () {
          const recons = yield* ReconciliationRepository;
          yield* seedBothTenants;
          const ab = yield* Effect.flip(
            recons.propose(TIDA, { transactionId: "tx-b-1", receiptId: "rc-a-1", score: 0.9 }),
          );
          const ba = yield* Effect.flip(
            recons.propose(TIDB, { transactionId: "tx-a-1", receiptId: "rc-b-1", score: 0.9 }),
          );
          return [ab._tag, ba._tag] as const;
        }),
      );
      expect(failures).toStrictEqual(["TenantMismatch", "TenantMismatch"]);
    } finally {
      sqlite.close();
    }
  });

  it("rejects decide under a tenant that owns neither side", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const failure = await runTest(
        layer,
        Effect.gen(function* () {
          const recons = yield* ReconciliationRepository;
          yield* seedBothTenants;
          yield* recons.propose(TIDA, {
            transactionId: "tx-a-1",
            receiptId: "rc-a-1",
            score: 0.9,
          });
          return yield* Effect.flip(recons.confirm(TIDB, "tx-a-1", "rc-a-1"));
        }),
      );
      expect(failure._tag).toBe("TenantMismatch");
    } finally {
      sqlite.close();
    }
  });

  it("still links, proposes, and confirms within one tenant", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const result = await runTest(
        layer,
        Effect.gen(function* () {
          const receipts = yield* ReceiptRepository;
          const recons = yield* ReconciliationRepository;
          yield* seedBothTenants;
          yield* receipts.linkTransaction(TIDA, "rc-a-1", "tx-a-1");
          const linked = yield* receipts.findById(TIDA, "rc-a-1");
          yield* recons.propose(TIDA, {
            transactionId: "tx-a-1",
            receiptId: "rc-a-1",
            score: 0.9,
          });
          const decided = yield* recons.confirm(TIDA, "tx-a-1", "rc-a-1");
          return { linkedTransaction: linked.transactionId, status: decided.status };
        }),
      );
      expect(result.linkedTransaction).toBe("tx-a-1");
      expect(result.status).toBe("confirmed");
    } finally {
      sqlite.close();
    }
  });
});
