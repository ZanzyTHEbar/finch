import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { Db } from "../../packages/db/src/client.ts";
import { tenants } from "../../packages/db/src/schema/index.ts";
import { SearchDocumentRepository } from "../../packages/db/src/repositories/search-document.ts";
import { makeTestLayers, runTest } from "../setup.ts";

const TIDA = Schema.decodeUnknownSync(TenantId)("t-sdoc-a");
const TIDB = Schema.decodeUnknownSync(TenantId)("t-sdoc-b");

const seedTenant = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    );
  });

describe("SearchDocumentRepository.findBySource", () => {
  it("returns the row, null when missing, and never across tenants", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          yield* seedTenant(TIDB);
          const docs = yield* SearchDocumentRepository;
          yield* docs.upsert(TIDA, "transaction", "tx-1", "groceries");
          const found = yield* docs.findBySource(TIDA, "transaction", "tx-1");
          const missing = yield* docs.findBySource(TIDA, "transaction", "tx-nope");
          const foreign = yield* docs.findBySource(TIDB, "transaction", "tx-1");
          return { found, missing, foreign };
        }),
      );
      expect(result.found?.content).toBe("groceries");
      expect(result.missing).toBeNull();
      expect(result.foreign).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("lists distinct tenant ids that own documents", async () => {
    const sqlite = new Database(":memory:");
    try {
      const ids = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          yield* seedTenant(TIDB);
          const docs = yield* SearchDocumentRepository;
          yield* docs.upsert(TIDA, "transaction", "tx-1", "groceries");
          yield* docs.upsert(TIDA, "receipt", "rc-1", "receipt");
          yield* docs.upsert(TIDB, "transaction", "tx-2", "fuel");
          return yield* docs.listDistinctTenantIds();
        }),
      );
      expect(ids.slice().sort()).toEqual([TIDA, TIDB].slice().sort());
    } finally {
      sqlite.close();
    }
  });
});
