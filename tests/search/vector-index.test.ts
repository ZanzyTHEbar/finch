import { Database } from "bun:sqlite";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import { VectorIndex } from "../../packages/core/src/ports/vector-index.ts";
import { VectorIndexLive } from "../../packages/db/src/vector-index.ts";
import { makeTestLayers, runTest } from "../setup.ts";

// vec0 KNN round-trip over document_embeddings_vec with deterministic
// fixture vectors (1024 dims, no network, no API keys).
const DIMS = 1024;
const MODEL = "voyage-finance-2";

const TIDA = Schema.decodeUnknownSync(TenantId)("tenant-vec-a");
const TIDB = Schema.decodeUnknownSync(TenantId)("tenant-vec-b");

const basis = (i: number): Float32Array => {
  const v = new Float32Array(DIMS);
  v[i] = 1;
  return v;
};

const encode = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer);

const scoped = (sqlite: Database): Layer.Layer<VectorIndex, never, never> =>
  Layer.provide(VectorIndexLive, makeTestLayers(sqlite));

describe("VectorIndexLive (vec0)", () => {
  it("retrieves the nearest vector first with distances", async () => {
    const sqlite = new Database(":memory:");
    try {
      const hits = await runTest(
        scoped(sqlite),
        Effect.gen(function* () {
          const index = yield* VectorIndex;
          yield* index.upsert(TIDA, "doc-a", MODEL, DIMS, encode(basis(0)));
          yield* index.upsert(TIDA, "doc-b", MODEL, DIMS, encode(basis(1)));
          yield* index.upsert(TIDA, "doc-c", MODEL, DIMS, encode(basis(2)));
          const query = new Float32Array(DIMS);
          query[0] = 0.9;
          query[1] = 0.1;
          return yield* index.search(TIDA, encode(query), DIMS, 3);
        }),
      );
      expect(hits.map((h) => h.documentId)).toStrictEqual(["doc-a", "doc-b", "doc-c"]);
      const scores = hits.map((h) => h.score);
      expect(scores).toStrictEqual([...scores].sort((a, b) => a - b));
    } finally {
      sqlite.close();
    }
  });

  it("isolates KNN results per tenant", async () => {
    const sqlite = new Database(":memory:");
    try {
      const { scoresA, scoresB } = await runTest(
        scoped(sqlite),
        Effect.gen(function* () {
          const index = yield* VectorIndex;
          yield* index.upsert(TIDA, "shared", MODEL, DIMS, encode(basis(0)));
          yield* index.upsert(TIDB, "shared", MODEL, DIMS, encode(basis(1)));
          const hitsA = yield* index.search(TIDA, encode(basis(0)), DIMS, 5);
          const hitsB = yield* index.search(TIDB, encode(basis(0)), DIMS, 5);
          return {
            scoresA: hitsA.map((h) => ({ documentId: h.documentId, score: h.score })),
            scoresB: hitsB.map((h) => ({ documentId: h.documentId, score: h.score })),
          };
        }),
      );
      // Same documentId in both tenants: each side sees only its own row.
      expect(scoresA.map((h) => h.documentId)).toStrictEqual(["shared"]);
      expect(scoresA.map((h) => h.score)).toStrictEqual([0]);
      expect(scoresB.map((h) => h.documentId)).toStrictEqual(["shared"]);
      expect(scoresB.length).toBe(1);
      // Tenant B's row is basis(1): L2 distance sqrt(2) from the query.
      expect(scoresB[0]?.score).toBeGreaterThan(1);
    } finally {
      sqlite.close();
    }
  });

  it("removes documents and re-inserts cleanly", async () => {
    const sqlite = new Database(":memory:");
    try {
      const ids = await runTest(
        scoped(sqlite),
        Effect.gen(function* () {
          const index = yield* VectorIndex;
          yield* index.upsert(TIDA, "doc-a", MODEL, DIMS, encode(basis(0)));
          yield* index.upsert(TIDA, "doc-b", MODEL, DIMS, encode(basis(1)));
          yield* index.removeByDocument(TIDA, "doc-a");
          const afterRemove = yield* index.search(TIDA, encode(basis(0)), DIMS, 5);
          // Removing a missing document is a no-op, not an error.
          yield* index.removeByDocument(TIDA, "doc-missing");
          yield* index.upsert(TIDA, "doc-a", MODEL, DIMS, encode(basis(0)));
          const afterReinsert = yield* index.search(TIDA, encode(basis(0)), DIMS, 5);
          return {
            afterRemove: afterRemove.map((h) => h.documentId),
            afterReinsert: afterReinsert.map((h) => h.documentId),
          };
        }),
      );
      expect(ids.afterRemove).toStrictEqual(["doc-b"]);
      expect(ids.afterReinsert).toStrictEqual(["doc-a", "doc-b"]);
    } finally {
      sqlite.close();
    }
  });

  it("rejects mismatched dims and invalid topK", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = scoped(sqlite);
      const upsertErr = await runTest(
        layer,
        Effect.flip(
          Effect.gen(function* () {
            const index = yield* VectorIndex;
            return yield* index.upsert(TIDA, "doc-x", MODEL, 3, new Uint8Array(12));
          }),
        ),
      );
      expect(upsertErr._tag).toBe("VectorIndexError");
      const searchErr = await runTest(
        layer,
        Effect.flip(
          Effect.gen(function* () {
            const index = yield* VectorIndex;
            return yield* index.search(TIDA, encode(basis(0)), DIMS, 0);
          }),
        ),
      );
      expect(searchErr._tag).toBe("VectorIndexError");
    } finally {
      sqlite.close();
    }
  });
});
