import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { Db } from "../../packages/db/src/client.ts";
import { BankSessionRepository } from "../../packages/db/src/repositories/bank-session.ts";
import { tenants } from "../../packages/db/src/schema/index.ts";
import { makeTestLayers, runTest } from "../setup.ts";

const TIDA = Schema.decodeUnknownSync(TenantId)("t-bank-a");
const TIDB = Schema.decodeUnknownSync(TenantId)("t-bank-b");

const seedTenant = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    );
  });

describe("BankSessionRepository", () => {
  it("upserts then gets the same tenant row", async () => {
    const sqlite = new Database(":memory:");
    try {
      const row = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          const sessions = yield* BankSessionRepository;
          yield* sessions.upsert(TIDA, "sess-1");
          return yield* sessions.get(TIDA);
        }),
      );
      expect(row?.tenantId).toBe(TIDA);
      expect(row?.sessionId).toBe("sess-1");
    } finally {
      sqlite.close();
    }
  });

  it("get missing returns null", async () => {
    const sqlite = new Database(":memory:");
    try {
      const row = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          const sessions = yield* BankSessionRepository;
          return yield* sessions.get(TIDA);
        }),
      );
      expect(row).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("upsert overwrites sessionId", async () => {
    const sqlite = new Database(":memory:");
    try {
      const row = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          const sessions = yield* BankSessionRepository;
          yield* sessions.upsert(TIDA, "sess-1");
          return yield* sessions.upsert(TIDA, "sess-2");
        }),
      );
      expect(row.sessionId).toBe("sess-2");
    } finally {
      sqlite.close();
    }
  });

  it("remove returns true then get is null", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          const sessions = yield* BankSessionRepository;
          yield* sessions.upsert(TIDA, "sess-1");
          const deleted = yield* sessions.remove(TIDA);
          const after = yield* sessions.get(TIDA);
          return { deleted, after };
        }),
      );
      expect(result.deleted).toBe(true);
      expect(result.after).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("does not leak sessions across tenants", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          yield* seedTenant(TIDB);
          const sessions = yield* BankSessionRepository;
          yield* sessions.upsert(TIDA, "sess-a");
          yield* sessions.upsert(TIDB, "sess-b");
          const a = yield* sessions.get(TIDA);
          const b = yield* sessions.get(TIDB);
          return { a, b };
        }),
      );
      expect(result.a?.sessionId).toBe("sess-a");
      expect(result.b?.sessionId).toBe("sess-b");
    } finally {
      sqlite.close();
    }
  });
});
