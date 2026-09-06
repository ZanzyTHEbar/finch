import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Db } from "../../packages/db/src/client.ts";
import { AccountRepository } from "../../packages/db/src/repositories/account.ts";
import { ReceiptRepository } from "../../packages/db/src/repositories/receipt.ts";
import { TransactionRepository } from "../../packages/db/src/repositories/transaction.ts";
import { tenants } from "../../packages/db/src/schema/index.ts";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { makeTestLayers, runTest } from "../setup.ts";

const TIDA = Schema.decodeUnknownSync(TenantId)("tenant-a");
const TIDB = Schema.decodeUnknownSync(TenantId)("tenant-b");

describe("tenant isolation", () => {
  it("keeps interleaved account creates strictly separated", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            tenant: fc.constantFrom("a", "b") as fc.Arbitrary<"a" | "b">,
            name: fc.string({ minLength: 1, maxLength: 24 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        async (ops) => {
          const sqlite = new Database(":memory:");
          try {
            const layer = makeTestLayers(sqlite);
            const result = await runTest(
              layer,
              Effect.gen(function* () {
                const accounts = yield* AccountRepository;
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
                const created: Array<{ readonly tenant: "a" | "b"; readonly id: string }> = [];
                let i = 0;
                for (const op of ops) {
                  const id = `acc-${i++}`;
                  const tid = op.tenant === "a" ? TIDA : TIDB;
                  yield* accounts.upsertFromDiscovery(tid, {
                    id,
                    name: op.name,
                    type: "checking",
                    currency: "EUR",
                    status: "active",
                  });
                  created.push({ tenant: op.tenant, id });
                }
                const listA = yield* accounts.list(TIDA);
                const listB = yield* accounts.list(TIDB);
                return {
                  created,
                  listA: listA.map((r) => r.id),
                  listB: listB.map((r) => r.id),
                };
              }),
            );
            const expectedA = result.created
              .filter((c) => c.tenant === "a")
              .map((c) => c.id)
              .sort();
            const expectedB = result.created
              .filter((c) => c.tenant === "b")
              .map((c) => c.id)
              .sort();
            // Each tenant lists exactly its own rows: zero cross-tenant leakage.
            expect([...result.listA].sort()).toStrictEqual(expectedA);
            expect([...result.listB].sort()).toStrictEqual(expectedB);

            const firstA = expectedA[0];
            const firstB = expectedB[0];
            if (firstA !== undefined) {
              const cross = await runTest(
                layer,
                Effect.gen(function* () {
                  const accounts = yield* AccountRepository;
                  return yield* Effect.flip(accounts.findById(TIDB, firstA));
                }),
              );
              expect(cross._tag).toBe("AccountNotFound");
            }
            if (firstB !== undefined) {
              const cross = await runTest(
                layer,
                Effect.gen(function* () {
                  const accounts = yield* AccountRepository;
                  return yield* Effect.flip(accounts.findById(TIDA, firstB));
                }),
              );
              expect(cross._tag).toBe("AccountNotFound");
            }
          } finally {
            sqlite.close();
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it("reflects transaction corrections and receipt linking", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const result = await runTest(
        layer,
        Effect.gen(function* () {
          const accounts = yield* AccountRepository;
          const txs = yield* TransactionRepository;
          const receipts = yield* ReceiptRepository;
          const { db } = yield* Db;
          yield* Effect.sync(() => {
            db
              .insert(tenants)
              .values({ id: TIDA, name: "Tenant A", createdAt: nowInstant() })
              .run();
          });
          yield* accounts.upsertFromDiscovery(TIDA, {
            id: "acct-corr",
            name: "Checking",
            type: "checking",
            currency: "EUR",
            status: "active",
          });
          yield* txs.insert(TIDA, {
            id: "tx-corr-1",
            accountId: "acct-corr",
            amountMinor: 4280n,
            currency: "EUR",
            status: "booked",
            postedDate: "2026-09-01",
            observedAt: nowInstant(),
            description: "Continente",
          });
          const filtered = yield* txs.list(TIDA, { accountId: "acct-corr" });
          const booked = yield* txs.list(TIDA, { status: "booked" });
          yield* txs.updateById(TIDA, "tx-corr-1", { amountMinor: 4300n });
          const corrected = yield* txs.findById(TIDA, "tx-corr-1");
          yield* receipts.insert(TIDA, {
            id: "rc-1",
            merchant: "Continente",
            receiptDate: "2026-09-01",
            currency: "EUR",
            totalMinor: 4280n,
            imageRef: "img-1",
            imageHash: "h1",
            status: "captured",
          });
          const unmatchedBefore = yield* receipts.listUnmatched(TIDA);
          yield* receipts.linkTransaction(TIDA, "rc-1", "tx-corr-1");
          const linked = yield* receipts.findById(TIDA, "rc-1");
          const unmatchedAfter = yield* receipts.listUnmatched(TIDA);
          return {
            filtered: filtered.map((r) => r.id),
            booked: booked.map((r) => r.id),
            correctedAmount: corrected.amountMinor,
            unmatchedBefore: unmatchedBefore.map((r) => r.id),
            linkedTransaction: linked.transactionId,
            unmatchedAfter: unmatchedAfter.map((r) => r.id),
          };
        }),
      );
      expect(result.filtered).toStrictEqual(["tx-corr-1"]);
      expect(result.booked).toContain("tx-corr-1");
      expect(result.correctedAmount).toBe(4300n);
      expect(result.unmatchedBefore).toStrictEqual(["rc-1"]);
      expect(result.linkedTransaction).toBe("tx-corr-1");
      expect(result.unmatchedAfter).toStrictEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
