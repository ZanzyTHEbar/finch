import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { Db } from "../../packages/db/src/client.ts";
import { AccountRepository } from "../../packages/db/src/repositories/account.ts";
import { tenants } from "../../packages/db/src/schema/index.ts";
import { makeTestLayers, runTest } from "../setup.ts";

const TIDA = Schema.decodeUnknownSync(TenantId)("t-xref-a");
const TIDB = Schema.decodeUnknownSync(TenantId)("t-xref-b");

const seedTenant = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    );
  });

describe("AccountRepository.findByExternalRef", () => {
  it("returns the row, null when missing, and never across tenants", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA);
          yield* seedTenant(TIDB);
          const accounts = yield* AccountRepository;
          yield* accounts.upsertFromDiscovery(TIDA, {
            id: "acc-1",
            externalRef: "iban-1",
            name: "Checking",
            type: "checking",
            currency: "EUR",
            status: "active",
          });
          const found = yield* accounts.findByExternalRef(TIDA, "iban-1");
          const missing = yield* accounts.findByExternalRef(TIDA, "iban-nope");
          const foreign = yield* accounts.findByExternalRef(TIDB, "iban-1");
          return { found, missing, foreign };
        }),
      );
      expect(result.found?.id).toBe("acc-1");
      expect(result.missing).toBeNull();
      expect(result.foreign).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
