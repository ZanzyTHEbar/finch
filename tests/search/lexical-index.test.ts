import { Database } from "bun:sqlite";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { LexicalIndex } from "../../packages/core/src/ports/lexical-index.ts";
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts";
import { TenantId } from "../../packages/core/src/domain/tenant.ts";
import { nowInstant } from "../../packages/core/src/domain/time.ts";
import { buildFtsMatchQuery } from "../../packages/db/src/lexical/fts-query.ts";
import {
  LexicalIndexLive,
  isFtsSyntaxError,
  toLexicalHit,
} from "../../packages/db/src/lexical/lexical-index.ts";
import { SearchDocumentRepository } from "../../packages/db/src/repositories/search-document.ts";
import { tenants } from "../../packages/db/src/schema/index.ts";
import { Db } from "../../packages/db/src/client.ts";
import { makeTestLayers, runTest } from "../setup.ts";

const TIDA = Schema.decodeUnknownSync(TenantId)("t-lex-a");
const TIDB = Schema.decodeUnknownSync(TenantId)("t-lex-b");

const seedTenantRow = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    );
  });

const seedDoc = (tenantId: TenantIdT, sourceType: string, sourceId: string, content: string) =>
  Effect.gen(function* () {
    const docs = yield* SearchDocumentRepository;
    yield* docs.upsert(tenantId, sourceType, sourceId, content);
  });

const seedRankingDocs = (tid: TenantIdT) =>
  Effect.gen(function* () {
    yield* seedTenantRow(tid);
    yield* seedDoc(tid, "transaction", "tx-rank-low", "Continente groceries debit EUR 42.80 weekly shop");
    yield* seedDoc(
      tid,
      "transaction",
      "tx-rank-high",
      "Continente Continente Continente flagship store receipt",
    );
    yield* seedDoc(tid, "receipt", "rc-rank-other", "BP fuel station receipt unmatched");
  });

const makeLexicalLayers = (sqlite: Database) => {
  const base = makeTestLayers(sqlite);
  return Layer.mergeAll(base, Layer.provide(LexicalIndexLive, base));
};

describe("fts query escaper", () => {
  it("quotes terms into an implicit-AND phrase query", () => {
    expect(buildFtsMatchQuery("hello world")).toBe('"hello" "world"');
    expect(buildFtsMatchQuery("  spaced   out  ")).toBe('"spaced" "out"');
    expect(buildFtsMatchQuery("continente")).toBe('"continente"');
  });

  it("neutralizes quotes, operators, wildcards and unicode stays literal", () => {
    expect(buildFtsMatchQuery('"')).toBe('""""');
    expect(buildFtsMatchQuery('say "hi"')).toBe('"say" """hi"""');
    expect(buildFtsMatchQuery("OR 1=1")).toBe('"OR" "1=1"');
    expect(buildFtsMatchQuery("AND OR NOT")).toBe('"AND" "OR" "NOT"');
    expect(buildFtsMatchQuery("*:*")).toBe('"*:*"');
    expect(buildFtsMatchQuery("café naïve")).toBe('"café" "naïve"');
  });

  it("supports trailing prefix on the last term only for as-you-type", () => {
    expect(buildFtsMatchQuery("hel", { prefixLast: true })).toBe('"hel"*');
    expect(buildFtsMatchQuery("hello wor", { prefixLast: true })).toBe('"hello" "wor"*');
    expect(buildFtsMatchQuery("hello wor")).toBe('"hello" "wor"');
  });

  it("maps empty and whitespace queries to a typed empty without throwing", () => {
    expect(buildFtsMatchQuery("")).toBeNull();
    expect(buildFtsMatchQuery("   ")).toBeNull();
    expect(buildFtsMatchQuery("\t\n ")).toBeNull();
  });

  it("classifies FTS5 syntax errors so they fold to empty, never leak", () => {
    expect(isFtsSyntaxError(new Error('fts5: syntax error near "AND"'))).toBe(true);
    expect(isFtsSyntaxError(new Error("unterminated string"))).toBe(true);
    expect(isFtsSyntaxError(new Error("unknown special query: "))).toBe(true);
    expect(isFtsSyntaxError(new Error("no such table: search_documents_fts"))).toBe(false);
    expect(isFtsSyntaxError(new Error("disk I/O error"))).toBe(false);
  });

  it("omits the snippet when it is NULL instead of crashing", () => {
    expect(
      toLexicalHit({ sourceType: "receipt", sourceId: "r1", rank: -1.5, snippet: null }),
    ).toStrictEqual({ documentId: "receipt:r1", rank: -1.5 });
    expect(
      toLexicalHit({ sourceType: "receipt", sourceId: "r1", rank: -1.5, snippet: "<b>x</b>" }),
    ).toStrictEqual({ documentId: "receipt:r1", rank: -1.5, snippet: "<b>x</b>" });
    expect(toLexicalHit(null)).toBeNull();
    expect(toLexicalHit({})).toBeNull();
  });
});

describe("lexical index live", () => {
  it("ranks golden docs by bm25 ascending (negative scores, best first)", async () => {
    const sqlite = new Database(":memory:");
    try {
      const hits = await runTest(
        makeLexicalLayers(sqlite),
        Effect.gen(function* () {
          yield* seedRankingDocs(TIDA);
          const lexical = yield* LexicalIndex;
          return yield* lexical.search(TIDA, "Continente", 10);
        }),
      );
      expect(hits.map((h) => h.documentId)).toStrictEqual([
        "transaction:tx-rank-high",
        "transaction:tx-rank-low",
      ]);
      const [first, second] = hits;
      expect(first?.rank).toBeLessThan(0);
      expect(second?.rank).toBeLessThan(0);
      expect(first?.rank).toBeLessThan(second?.rank ?? 0);
      expect(first?.snippet).toContain("<b>");
      expect(first?.snippet).toContain("Continente");
    } finally {
      sqlite.close();
    }
  });

  it("treats injection strings as literal phrases and empties as no-ops", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeLexicalLayers(sqlite),
        Effect.gen(function* () {
          yield* seedRankingDocs(TIDA);
          const lexical = yield* LexicalIndex;
          const quote = yield* lexical.search(TIDA, '"', 10);
          const orInjection = yield* lexical.search(TIDA, "OR 1=1", 10);
          const operators = yield* lexical.search(TIDA, "AND OR NOT", 10);
          const glob = yield* lexical.search(TIDA, "*:*", 10);
          const paren = yield* lexical.search(TIDA, "(", 10);
          const unicode = yield* lexical.search(TIDA, "café", 10);
          const unbalanced = yield* lexical.search(TIDA, 'say "hi', 10);
          const empty = yield* lexical.search(TIDA, "", 10);
          const blank = yield* lexical.search(TIDA, "   ", 10);
          return { quote, orInjection, operators, glob, paren, unicode, unbalanced, empty, blank };
        }),
      );
      // None throw; hostile inputs match nothing in the seeded corpus.
      expect(result.quote).toStrictEqual([]);
      expect(result.orInjection).toStrictEqual([]);
      expect(result.operators).toStrictEqual([]);
      expect(result.glob).toStrictEqual([]);
      expect(result.paren).toStrictEqual([]);
      expect(result.unicode).toStrictEqual([]);
      expect(result.unbalanced).toStrictEqual([]);
      expect(result.empty).toStrictEqual([]);
      expect(result.blank).toStrictEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("keeps tenants strictly isolated on identical content", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeLexicalLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenantRow(TIDA);
          yield* seedTenantRow(TIDB);
          yield* seedDoc(TIDA, "receipt", "rc-iso-a", "Alvalade market Lisboa fresh produce");
          yield* seedDoc(TIDB, "receipt", "rc-iso-b", "Alvalade market Lisboa fresh produce");
          const lexical = yield* LexicalIndex;
          const hitsA = yield* lexical.search(TIDA, "Alvalade", 10);
          const hitsB = yield* lexical.search(TIDB, "Alvalade", 10);
          return { hitsA, hitsB };
        }),
      );
      expect(result.hitsA.map((h) => h.documentId)).toStrictEqual(["receipt:rc-iso-a"]);
      expect(result.hitsB.map((h) => h.documentId)).toStrictEqual(["receipt:rc-iso-b"]);
    } finally {
      sqlite.close();
    }
  });

  it("supports prefix as-you-type and topK limits", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeLexicalLayers(sqlite),
        Effect.gen(function* () {
          yield* seedRankingDocs(TIDA);
          const lexical = yield* LexicalIndex;
          const plain = yield* lexical.search(TIDA, "Cont", 10);
          const prefixed = yield* lexical.search(TIDA, "Cont", 10, { prefixLast: true });
          const top1 = yield* lexical.search(TIDA, "Continente", 1);
          const zero = yield* lexical.search(TIDA, "Continente", 0);
          const negative = yield* lexical.search(TIDA, "Continente", -3);
          return { plain, prefixed, top1, zero, negative };
        }),
      );
      expect(result.plain).toStrictEqual([]);
      expect(result.prefixed.map((h) => h.documentId)).toStrictEqual([
        "transaction:tx-rank-high",
        "transaction:tx-rank-low",
      ]);
      expect(result.top1.map((h) => h.documentId)).toStrictEqual(["transaction:tx-rank-high"]);
      expect(result.zero).toStrictEqual([]);
      expect(result.negative).toStrictEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("round-trips indexDocument and removeDocument over search_documents", async () => {
    const sqlite = new Database(":memory:");
    try {
      const result = await runTest(
        makeLexicalLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenantRow(TIDA);
          const lexical = yield* LexicalIndex;
          yield* lexical.indexDocument(TIDA, "receipt:rc-lex-rt", "Zanzibar specialty ledger entry");
          const found = yield* lexical.search(TIDA, "Zanzibar", 10);
          yield* lexical.removeDocument(TIDA, "receipt:rc-lex-rt");
          const gone = yield* lexical.search(TIDA, "Zanzibar", 10);
          yield* lexical.removeDocument(TIDA, "receipt:rc-lex-rt");
          const badId = yield* Effect.flip(lexical.indexDocument(TIDA, "no-separator", "x"));
          const badRemove = yield* Effect.flip(lexical.removeDocument(TIDA, ":empty-type"));
          return { found, gone, badId, badRemove };
        }),
      );
      expect(result.found.map((h) => h.documentId)).toStrictEqual(["receipt:rc-lex-rt"]);
      expect(result.found[0]?.snippet).toContain("Zanzibar");
      expect(result.gone).toStrictEqual([]);
      expect(result.badId._tag).toBe("LexicalIndexError");
      expect(result.badRemove._tag).toBe("LexicalIndexError");
    } finally {
      sqlite.close();
    }
  });
});
