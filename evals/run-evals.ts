import { Database } from "bun:sqlite";
import { Effect, Layer, Schema } from "effect";
import { TenantId } from "../packages/core/src/domain/tenant.ts";
import type { TenantId as TenantIdT } from "../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../packages/core/src/domain/time.ts";
import { LexicalIndex } from "../packages/core/src/ports/lexical-index.ts";
import { VectorIndex } from "../packages/core/src/ports/vector-index.ts";
import { Db } from "../packages/db/src/client.ts";
import { LexicalIndexLive } from "../packages/db/src/lexical/lexical-index.ts";
import { tenants } from "../packages/db/src/schema/index.ts";
import { SearchDocumentRepository } from "../packages/db/src/repositories/search-document.ts";
import { VectorIndexLive } from "../packages/db/src/vector-index.ts";
import { reciprocalRankFusion } from "../packages/search/src/fusion.ts";
import { parseDocumentId } from "../packages/search/src/document-id.ts";
import { evaluateRun } from "../packages/search/src/eval-metrics.ts";
import { makeTestLayers, runTest } from "../tests/setup.ts";
import { EVAL_CORPUS, EVAL_DIMS, EVAL_MODEL, EVAL_TENANT } from "./corpus.ts";

// Component-level harness: seeds a small separable corpus, runs the dense
// (canned basis vectors, standing in for Voyage) and lexical (real FTS5)
// channels, and fuses them exactly like HybridSearch does. The
// orchestrator itself is covered with a canned EmbeddingProvider in
// tests/search/hybrid.test.ts.
//
// Honest scope: the fixture is separable by construction (unique tokens per
// doc), so macro recall@10 == 1.0 here is a regression smoke gate, not a
// quality claim. Live Voyage (`bun evals/run-evals-live.ts`) gates the same
// recall@10 == 1.0; recall@1 is reported, not gated.

const DIMS = EVAL_DIMS;
const MODEL = EVAL_MODEL;
const TENANT = EVAL_TENANT;
const TOP_K = 20;
const CORPUS = EVAL_CORPUS;

interface EvalCase {
  readonly id: string;
  readonly query: string;
  readonly expectedDocumentIds: readonly string[];
  readonly type: string;
}

const basis = (i: number): Float32Array => {
  const v = new Float32Array(DIMS);
  v[i] = 1;
  return v;
};

const encode = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer);

const splitDocumentId = (documentId: string): { sourceType: string; sourceId: string } => {
  const parsed = parseDocumentId(documentId);
  if (parsed === null) {
    throw new Error(`fixture documentId is malformed: ${JSON.stringify(documentId)}`);
  }
  return parsed;
};

const loadCases = async (): Promise<EvalCase[]> => {
  const text = await Bun.file(new URL("./queries.jsonl", import.meta.url)).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EvalCase);
};

const main = async (): Promise<void> => {
  const cases = await loadCases();
  const docIndex = new Map(CORPUS.map((doc, i) => [doc.documentId, i] as const));
  const sqlite = new Database(":memory:");
  try {
    const base = makeTestLayers(sqlite);
    const layers = Layer.mergeAll(
      base,
      Layer.provide(VectorIndexLive, base),
      Layer.provide(LexicalIndexLive, base),
    );
    const tenantId: TenantIdT = Schema.decodeUnknownSync(TenantId)(TENANT);

    await runTest(
      layers,
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.sync(() =>
          db.insert(tenants).values({ id: tenantId, name: tenantId, createdAt: nowInstant() }).run(),
        );
        const docs = yield* SearchDocumentRepository;
        const vec = yield* VectorIndex;
        for (let i = 0; i < CORPUS.length; i++) {
          const doc = CORPUS[i];
          if (doc === undefined) continue;
          const { sourceType, sourceId } = splitDocumentId(doc.documentId);
          yield* docs.upsert(tenantId, sourceType, sourceId, doc.content);
          yield* vec.upsert(tenantId, doc.documentId, MODEL, DIMS, encode(basis(i)));
        }
      }),
    );

    const results: { queryId: string; rankedIds: string[] }[] = [];
    for (const c of cases) {
      const first = c.expectedDocumentIds[0];
      const idx = first === undefined ? undefined : docIndex.get(first);
      if (idx === undefined) throw new Error(`eval case ${c.id} expects unknown document ${String(first)}`);
      const queryVector = encode(basis(idx));
      const rankedIds = await runTest(
        layers,
        Effect.gen(function* () {
          const lexical = yield* LexicalIndex;
          const vec = yield* VectorIndex;
          const lexHits = yield* lexical.search(tenantId, c.query, TOP_K);
          const vecHits = yield* vec.search(tenantId, queryVector, DIMS, TOP_K);
          const fused = reciprocalRankFusion(
            [vecHits.map((h) => ({ id: h.documentId })), lexHits.map((h) => ({ id: h.documentId }))],
            { topK: TOP_K },
          );
          return fused.map((f) => f.id);
        }),
      );
      results.push({ queryId: c.id, rankedIds });
    }

    const summary = evaluateRun(
      results,
      cases.map((c) => ({ queryId: c.id, expectedIds: c.expectedDocumentIds })),
    );
    const byId = new Map(summary.perQuery.map((p) => [p.queryId, p] as const));

    console.log("query\ttype\texpected-top1\tgot-top1\trecall@1\trecall@3\trecall@10\tmrr");
    for (const c of cases) {
      const score = byId.get(c.id);
      const expectedTop = c.expectedDocumentIds[0] ?? "-";
      const gotTop = results.find((r) => r.queryId === c.id)?.rankedIds[0] ?? "-";
      console.log(
        [
          c.id,
          c.type,
          expectedTop,
          gotTop,
          score?.recallAt1.toFixed(3) ?? "?",
          score?.recallAt3.toFixed(3) ?? "?",
          score?.recallAt10.toFixed(3) ?? "?",
          score?.mrr.toFixed(3) ?? "?",
        ].join("\t"),
      );
    }
    const m = summary.macro;
    console.log(
      `macro\t-\t-\t-\t${m.recallAt1.toFixed(3)}\t${m.recallAt3.toFixed(3)}\t${m.recallAt10.toFixed(3)}\t${m.mrr.toFixed(3)}`,
    );
    if (m.recallAt10 < 1.0) {
      console.error(`FAIL: macro recall@10 ${m.recallAt10.toFixed(3)} < 1.0`);
      process.exit(1);
    }
  } finally {
    sqlite.close();
  }
};

await main();
