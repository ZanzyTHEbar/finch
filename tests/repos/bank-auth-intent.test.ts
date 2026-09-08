import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { Db } from "../../packages/db/src/client.ts";
import { BankAuthIntentRepository } from "../../packages/db/src/repositories/bank-auth-intent.ts";
import { tenants } from "../../packages/db/src/schema/index.ts";
import { makeTestLayers, runTest } from "../setup.ts";

const TIDA = Schema.decodeUnknownSync(TenantId)("t-intent-a");
const TIDB = Schema.decodeUnknownSync(TenantId)("t-intent-b");

const seedTenant = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    );
  });

describe("BankAuthIntentRepository", () => {
  it("puts then gets the same state", async () => {
    const sqlite = new Database(":memory:");
    try {
      const row = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          const intents = yield* BankAuthIntentRepository;
          yield* intents.put(TIDA, "state-1");
          return yield* intents.get("state-1");
        }),
      );
      expect(row?.tenantId).toBe(TIDA);
      expect(row?.state).toBe("state-1");
    } finally {
      sqlite.close();
    }
  });

  it("rejects cross-tenant reuse of the same state by overwriting the owner", async () => {
    const sqlite = new Database(":memory:");
    try {
      const row = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          yield* seedTenant(TIDB);
          const intents = yield* BankAuthIntentRepository;
          yield* intents.put(TIDA, "state-1");
          return yield* intents.put(TIDB, "state-1");
        }),
      );
      expect(row.tenantId).toBe(TIDB);
    } finally {
      sqlite.close();
    }
  });

  it("remove then get is null", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          const intents = yield* BankAuthIntentRepository;
          yield* intents.put(TIDA, "state-1");
          const deleted = yield* intents.remove("state-1");
          const after = yield* intents.get("state-1");
          return { deleted, after };
        }),
      );
      expect(result.deleted).toBe(true);
      expect(result.after).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
