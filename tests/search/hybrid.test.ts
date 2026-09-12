import { Database } from "bun:sqlite";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AppConfigTag } from "../../packages/core/src/config/config.ts";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { EmbeddingProvider } from "../../packages/core/src/ports/embedding-provider.ts";
import { VectorIndex } from "../../packages/core/src/ports/vector-index.ts";
import { LexicalIndex } from "../../packages/core/src/ports/lexical-index.ts";
import { HybridSearch, HybridSearchLive } from "../../packages/search/src/hybrid.ts";
import { NoopRerankerLive } from "../../packages/search/src/rerank.ts";
import { Db } from "../../packages/db/src/client.ts";
import { VectorIndexLive } from "../../packages/db/src/vector-index.ts";
import { LexicalIndexLive } from "../../packages/db/src/lexical/lexical-index.ts";
import { SearchDocumentRepository } from "../../packages/db/src/repositories/search-document.ts";
import { tenants } from "../../packages/db/src/schema/index.ts";
import { makeTestLayers, runTest } from "../setup.ts";

// Hybrid orchestrator over live vec0 + FTS indexes with a canned
// EmbeddingProvider (deterministic vectors, no network, no API keys).
const DIMS = 1024;
const MODEL = "voyage-finance-2";

const TIDA = Schema.decodeUnknownSync(TenantId)("t-hybrid-a");
const TIDB = Schema.decodeUnknownSync(TenantId)("t-hybrid-b");
const TID_EMPTY = Schema.decodeUnknownSync(TenantId)("t-hybrid-empty");

const basis = (i: number): Float32Array => {
  const v = new Float32Array(DIMS);
  v[i] = 1;
  return v;
};

// Golden query embedding: near basis(0), slightly toward basis(1).
const queryVector = (): Float32Array => {
  const v = new Float32Array(DIMS);
  v[0] = 0.9;
  v[1] = 0.1;
  return v;
};

const encode = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer);

const makeLayers = (sqlite: Database) => {
  const base = makeTestLayers(sqlite);
  const cannedEmbeddings = Layer.succeed(
    EmbeddingProvider,
    EmbeddingProvider.of({
      embedDocuments: (texts) =>
        Effect.succeed(texts.map(() => ({ model: MODEL, dims: DIMS, vector: queryVector() }))),
      embedQuery: () => Effect.succeed({ model: MODEL, dims: DIMS, vector: queryVector() }),
    }),
  );
  const testConfig = Layer.succeed(AppConfigTag, {
    databaseUrl: "file::memory:",
    sqliteVecPath: "",
    voyageApiKey: "",
    voyageModel: MODEL,
    llmAdapter: "opencode",
    openCodeApiKey: "",
    openCodeLlmBaseUrl: "https://opencode.ai/zen/v1",
    openCodeLlmModel: "opencode/claude-sonnet-4-20250514",
    bankAdapter: "enablebanking",
    enableBankingBaseUrl: "https://api.enablebanking.com",
    enableBankingApplicationId: "",
    enableBankingPrivateKey: "",
    enableBankingPsuIp: "203.0.113.10",
    enableBankingPsuUserAgent: "finch-test",
    enableDistillation: false,
    enableReranker: false,
    enableSummaries: false,
    enableEmbeddings: false,
  });
  const indexes = Layer.mergeAll(
    Layer.provide(VectorIndexLive, base),
    Layer.provide(LexicalIndexLive, base),
  );
  const hybrid = Layer.provide(
    HybridSearchLive,
    Layer.mergeAll(base, indexes, cannedEmbeddings, NoopRerankerLive, testConfig),
  );
  return Layer.mergeAll(base, indexes, cannedEmbeddings, testConfig, hybrid);
};

const seedTenantRow = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    );
  });

const seedCorpus = (tid: TenantIdT) =>
  Effect.gen(function* () {
    yield* seedTenantRow(tid);
    const docs = yield* SearchDocumentRepository;
    const vectors = yield* VectorIndex;
    yield* docs.upsert(
      tid,
      "transaction",
      "tx-groceries",
      "Continente groceries debit EUR 42.80 weekly shop",
    );
    yield* vectors.upsert(tid, "transaction:tx-groceries", MODEL, DIMS, encode(basis(0)));
    yield* docs.upsert(tid, "transaction", "tx-fuel", "BP fuel station diesel receipt");
    yield* vectors.upsert(tid, "transaction:tx-fuel", MODEL, DIMS, encode(basis(1)));
    yield* docs.upsert(tid, "receipt", "rc-market", "Alvalade market Lisboa fresh produce");
    yield* vectors.upsert(tid, "receipt:rc-market", MODEL, DIMS, encode(basis(2)));
  });

describe("HybridSearchLive", () => {
  it("ranks the dense+lexical consensus doc top-1 via hybridSearch", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeLayers(sqlite),
        Effect.gen(function* () {
          yield* seedCorpus(TIDA);
          const search = yield* HybridSearch;
          return yield* search.hybridSearch({
            tenantId: TIDA,
            text: "Continente groceries",
            topK: 5,
          });
        }),
      );
      const top = result.hits[0];
      expect(top?.documentId).toBe("transaction:tx-groceries");
      // RRF over rank 1 in both lists with k=60: 1/61 + 1/61.
      expect(top?.fusedScore).toBeCloseTo(2 / 61, 12);
      expect(top?.sources).toStrictEqual(["dense", "lexical"]);
      expect(top?.denseRank).toBe(1);
      expect(top?.lexicalRank).toBe(1);
      // L2 distance ||q - e0|| = 0.1*sqrt(2); similarity reported as 1/(1+d).
      expect(top?.denseSimilarity).toBeCloseTo(1 / (1 + 0.1 * Math.SQRT2), 6);
      expect(top?.lexicalScore).toBeLessThan(0);
      // Dense-only doc keeps its dense provenance and no lexical rank.
      const fuel = result.hits.find((h) => h.documentId === "transaction:tx-fuel");
      expect(fuel?.sources).toStrictEqual(["dense"]);
      expect(fuel?.denseRank).toBe(2);
      expect(fuel?.lexicalRank).toBeUndefined();
      expect(fuel?.lexicalScore).toBeUndefined();
      expect(result.diagnostics).toStrictEqual({
        denseCandidates: 3,
        lexicalCandidates: 1,
        fusedCandidates: 3,
      });
    } finally {
      sqlite.close();
    }
  });

  it("keeps hybridSearch results strictly isolated per tenant", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeLayers(sqlite),
        Effect.gen(function* () {
          yield* seedCorpus(TIDA);
          // Tenant B reuses a documentId with decoy content plus an exact-query
          // vector decoy, so any cross-tenant leak would pollute A (and vice versa).
          yield* seedTenantRow(TIDB);
          const docs = yield* SearchDocumentRepository;
          const vectors = yield* VectorIndex;
          yield* docs.upsert(
            TIDB,
            "transaction",
            "tx-groceries",
            "Continente groceries decoy duplicate content",
          );
          yield* vectors.upsert(TIDB, "transaction:tx-groceries", MODEL, DIMS, encode(basis(0)));
          yield* docs.upsert(TIDB, "receipt", "rc-secret", "Continente groceries secret ledger");
          yield* vectors.upsert(TIDB, "receipt:rc-secret", MODEL, DIMS, encode(queryVector()));
          const search = yield* HybridSearch;
          const hitsA = yield* search.hybridSearch({
            tenantId: TIDA,
            text: "Continente groceries",
            topK: 5,
          });
          const hitsB = yield* search.hybridSearch({
            tenantId: TIDB,
            text: "Continente groceries",
            topK: 5,
          });
          return { hitsA, hitsB };
        }),
      );
      // B's exact-query vector + matching doc never leak into A.
      expect(result.hitsA.hits.map((h) => h.documentId).sort()).toStrictEqual([
        "receipt:rc-market",
        "transaction:tx-fuel",
        "transaction:tx-groceries",
      ]);
      // Symmetric: A's docs never leak into B; B's consensus doc ranks top.
      expect(result.hitsB.hits.map((h) => h.documentId).sort()).toStrictEqual([
        "receipt:rc-secret",
        "transaction:tx-groceries",
      ]);
      expect(result.hitsB.hits[0]?.documentId).toBe("receipt:rc-secret");
    } finally {
      sqlite.close();
    }
  });

  it("skips fused candidates missing from search_documents without throwing", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeLayers(sqlite),
        Effect.gen(function* () {
          yield* seedCorpus(TIDA);
          // Vector-only ghost: dense rank 1 (exact query vector) but no
          // search_documents row, so resolution must drop it silently.
          const vectors = yield* VectorIndex;
          yield* vectors.upsert(TIDA, "ghost:doc", MODEL, DIMS, encode(queryVector()));
          const search = yield* HybridSearch;
          return yield* search.hybridSearch({
            tenantId: TIDA,
            text: "Continente groceries",
            topK: 5,
          });
        }),
      );
      expect(result.hits.map((h) => h.documentId)).not.toContain("ghost:doc");
      expect(result.hits[0]?.documentId).toBe("transaction:tx-groceries");
      expect(result.diagnostics).toStrictEqual({
        denseCandidates: 4,
        lexicalCandidates: 1,
        fusedCandidates: 4,
      });
    } finally {
      sqlite.close();
    }
  });

  it("returns empty hits with zero diagnostics on an empty corpus", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeLayers(sqlite),
        Effect.gen(function* () {
          const search = yield* HybridSearch;
          return yield* search.hybridSearch({ tenantId: TID_EMPTY, text: "Continente groceries" });
        }),
      );
      expect(result.hits).toStrictEqual([]);
      expect(result.diagnostics).toStrictEqual({
        denseCandidates: 0,
        lexicalCandidates: 0,
        fusedCandidates: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it("rejects empty text with ValidationFailed", async () => {
    const sqlite = new Database(":memory:");
    try {
      const layer = makeLayers(sqlite);
      for (const text of ["", "   "]) {
        const failure = await runTest(
          layer,
          Effect.flip(
            Effect.gen(function* () {
              const search = yield* HybridSearch;
              return yield* search.hybridSearch({ tenantId: TIDA, text });
            }),
          ),
        );
        expect(failure._tag).toBe("ValidationFailed");
      }
    } finally {
      sqlite.close();
    }
  });
});
