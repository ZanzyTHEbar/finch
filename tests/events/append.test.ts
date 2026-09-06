import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Db } from "../../packages/db/src/client.ts";
import { EventStore } from "../../packages/db/src/event-store.ts";
import { ProjectionRunner } from "../../packages/db/src/projections/runner.ts";
import { tenants } from "../../packages/db/src/schema/index.ts";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { makeTestLayers, runTest } from "../setup.ts";

const TID = Schema.decodeUnknownSync(TenantId)("t-append-1");

const observedPayload = {
  accountId: "acct-1",
  amountMinor: 4280n,
  currency: "EUR",
  bookingDate: "2026-09-01",
  rawDescription: "Continente purchase",
  merchantName: "Continente",
  sourceFingerprint: "fp-1",
  status: "booked",
};

const seedTenant = Effect.gen(function* () {
  const { db } = yield* Db;
  yield* Effect.sync(() =>
    db.insert(tenants).values({ id: TID, name: "append", createdAt: nowInstant() }).run(),
  );
});

describe("event append", () => {
  it("round-trips a real bigint payload through the EventStore", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const back = await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* seedTenant;
          yield* store.append({
            tenantId: TID,
            aggregateType: "transaction",
            aggregateId: "tx-1",
            eventType: "TransactionObserved",
            payload: observedPayload,
            actor: "test",
          });
          return yield* store.readAggregate(TID, "transaction", "tx-1");
        }),
      );
      expect(back.length).toBe(1);
      const first = back[0];
      expect(first).toBeDefined();
      if (first !== undefined) {
        expect(first.payload).toStrictEqual(observedPayload);
        const payload = first.payload as { readonly amountMinor: unknown };
        expect(typeof payload.amountMinor).toBe("bigint");
        expect(payload.amountMinor).toBe(4280n);
      }
    } finally {
      sqlite.close();
    }
  });

  it("assigns monotonic sequences per aggregate", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const back = await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* seedTenant;
          for (let i = 0; i < 3; i++) {
            yield* store.append({
              tenantId: TID,
              aggregateType: "transaction",
              aggregateId: "tx-seq",
              eventType: "TransactionObserved",
              // ponytail: identical payloads now dedupe by default, so each
              // sequenced append carries a distinct fingerprint.
              payload: { ...observedPayload, sourceFingerprint: `fp-seq-${i}` },
              actor: "test",
            });
          }
          return yield* store.readAggregate(TID, "transaction", "tx-seq");
        }),
      );
      expect(back.map((r) => r.sequence)).toStrictEqual([1, 2, 3]);
    } finally {
      sqlite.close();
    }
  });

  it("rejects a repeated idempotencyKey with DuplicateEvent", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const failure = await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* seedTenant;
          yield* store.append({
            tenantId: TID,
            aggregateType: "transaction",
            aggregateId: "tx-dup-a",
            eventType: "TransactionObserved",
            payload: observedPayload,
            actor: "test",
            idempotencyKey: "dup-key-1",
          });
          return yield* Effect.flip(
            store.append({
              tenantId: TID,
              aggregateType: "transaction",
              aggregateId: "tx-dup-b",
              eventType: "TransactionObserved",
              payload: observedPayload,
              actor: "test",
              idempotencyKey: "dup-key-1",
            }),
          );
        }),
      );
      expect(failure._tag).toBe("DuplicateEvent");
    } finally {
      sqlite.close();
    }
  });

  it("dedupes an identical retried append without a caller key", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const failure = await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* seedTenant;
          const retryInput = () => ({
            tenantId: TID,
            aggregateType: "transaction" as const,
            aggregateId: "tx-retry",
            eventType: "TransactionObserved",
            payload: observedPayload,
            actor: "test",
          });
          yield* store.append(retryInput());
          return yield* Effect.flip(store.append(retryInput()));
        }),
      );
      expect(failure._tag).toBe("DuplicateEvent");
    } finally {
      sqlite.close();
    }
  });

  it("appends distinct payloads with distinct default keys", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const records = await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* seedTenant;
          const first = yield* store.append({
            tenantId: TID,
            aggregateType: "transaction",
            aggregateId: "tx-distinct",
            eventType: "TransactionObserved",
            payload: observedPayload,
            actor: "test",
          });
          const second = yield* store.append({
            tenantId: TID,
            aggregateType: "transaction",
            aggregateId: "tx-distinct",
            eventType: "TransactionObserved",
            payload: { ...observedPayload, sourceFingerprint: "fp-2" },
            actor: "test",
          });
          return [first, second] as const;
        }),
      );
      expect(records.map((r) => r.sequence)).toStrictEqual([1, 2]);
      expect(records[0].idempotencyKey).not.toBe(records[1].idempotencyKey);
    } finally {
      sqlite.close();
    }
  });

  it("honors an explicit caller-supplied idempotency key", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const record = await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          yield* seedTenant;
          return yield* store.append({
            tenantId: TID,
            aggregateType: "transaction",
            aggregateId: "tx-explicit",
            eventType: "TransactionObserved",
            payload: observedPayload,
            actor: "test",
            idempotencyKey: "caller-key-1",
          });
        }),
      );
      expect(record.idempotencyKey).toBe("caller-key-1");
    } finally {
      sqlite.close();
    }
  });

  it("accepts an unknown event version on append but halts projection loudly", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeTestLayers(sqlite);
      const failure = await runTest(
        layer,
        Effect.gen(function* () {
          const store = yield* EventStore;
          const runner = yield* ProjectionRunner;
          yield* seedTenant;
          const record = yield* store.append({
            tenantId: TID,
            aggregateType: "transaction",
            aggregateId: "tx-unknown",
            eventType: "TransactionObserved",
            eventVersion: 99,
            payload: { whatever: true },
            actor: "test",
          });
          return yield* Effect.flip(runner.project(record));
        }),
      );
      expect(failure._tag).toBe("UnknownEventVersion");
    } finally {
      sqlite.close();
    }
  });
});
