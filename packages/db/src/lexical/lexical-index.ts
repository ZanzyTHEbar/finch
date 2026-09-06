import { Effect, Layer } from "effect";
import {
  LexicalIndex,
  LexicalIndexError,
  type LexicalHit,
  type TenantId,
} from "@finch/core";
import { Db } from "../client.ts";
import { SearchDocumentRepository } from "../repositories/search-document.ts";
import { buildFtsMatchQuery } from "./fts-query.ts";

// documentId is the search_documents address "sourceType:sourceId".
const splitDocumentId = (documentId: string): { sourceType: string; sourceId: string } | null => {
  const sep = documentId.indexOf(":");
  if (sep <= 0 || sep === documentId.length - 1) {
    return null;
  }
  return { sourceType: documentId.slice(0, sep), sourceId: documentId.slice(sep + 1) };
};

// FTS5 reports malformed queries through the error message only (bun:sqlite
// exposes no error code): "fts5: syntax error near ...", "unterminated
// string", "unknown special query: ". Anything else is a genuine storage
// failure and must surface instead of folding to no hits.
const FTS_SYNTAX_MESSAGE =
  /syntax error|unterminated string|unknown special query|malformed query|unrecognized token/i;

export const isFtsSyntaxError = (cause: unknown): boolean => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return FTS_SYNTAX_MESSAGE.test(message);
};

// ponytail: snippet() yields NULL when the match sits in another FTS column;
// the hit stays valid and the excerpt is simply omitted.
export const toLexicalHit = (row: unknown): LexicalHit | null => {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const { sourceType, sourceId, rank, snippet } = row as Record<string, unknown>;
  if (typeof sourceType !== "string" || typeof sourceId !== "string" || typeof rank !== "number") {
    return null;
  }
  const base = { documentId: `${sourceType}:${sourceId}`, rank };
  return typeof snippet === "string" ? { ...base, snippet } : base;
};

// bm25() returns NEGATIVE scores, so the best match sorts FIRST ascending.
const SEARCH_SQL =
  "SELECT sd.source_type AS sourceType, sd.source_id AS sourceId," +
  " bm25(search_documents_fts) AS rank," +
  " snippet(search_documents_fts, 0, '<b>', '</b>', '...', 16) AS snippet" +
  " FROM search_documents_fts" +
  " JOIN search_documents sd ON sd.rowid = search_documents_fts.rowid" +
  " WHERE sd.tenant_id = ? AND search_documents_fts MATCH ?" +
  " ORDER BY bm25(search_documents_fts) ASC LIMIT ?";

export const LexicalIndexLive: Layer.Layer<LexicalIndex, never, Db | SearchDocumentRepository> =
  Layer.effect(
    LexicalIndex,
    Effect.gen(function* () {
      const { sqlite } = yield* Db;
      const docs = yield* SearchDocumentRepository;

      const indexDocument = (
        tenantId: TenantId,
        documentId: string,
        content: string,
      ): Effect.Effect<void, LexicalIndexError> =>
        Effect.gen(function* () {
          const parts = splitDocumentId(documentId);
          if (parts === null) {
            return yield* new LexicalIndexError({
              message: `invalid documentId ${JSON.stringify(documentId)}: expected "sourceType:sourceId"`,
            });
          }
          yield* docs.upsert(tenantId, parts.sourceType, parts.sourceId, content).pipe(
            Effect.mapError(
              (cause) => new LexicalIndexError({ message: "lexical index write unavailable", cause }),
            ),
            Effect.asVoid,
          );
        });

      const removeDocument = (
        tenantId: TenantId,
        documentId: string,
      ): Effect.Effect<void, LexicalIndexError> =>
        Effect.gen(function* () {
          const parts = splitDocumentId(documentId);
          if (parts === null) {
            return yield* new LexicalIndexError({
              message: `invalid documentId ${JSON.stringify(documentId)}: expected "sourceType:sourceId"`,
            });
          }
          yield* docs.removeBySource(tenantId, parts.sourceType, parts.sourceId).pipe(
            Effect.mapError(
              (cause) => new LexicalIndexError({ message: "lexical index write unavailable", cause }),
            ),
          );
        });

      const search = (
        tenantId: TenantId,
        query: string,
        topK: number,
        options?: { readonly prefixLast?: boolean },
      ): Effect.Effect<readonly LexicalHit[], LexicalIndexError> =>
        Effect.gen(function* () {
          const match = buildFtsMatchQuery(query, options);
          if (match === null) {
            return [];
          }
          const limit = Math.floor(topK);
          if (!Number.isFinite(limit) || limit <= 0) {
            return [];
          }
          const rows = yield* Effect.try({
            try: (): ReadonlyArray<unknown> => {
              try {
                return sqlite.query(SEARCH_SQL).all(tenantId, match, limit);
              } catch (cause) {
                // Unreachable through the escaper in practice; fold to no
                // hits so engine internals never leak through the error channel.
                if (isFtsSyntaxError(cause)) {
                  return [];
                }
                throw cause;
              }
            },
            catch: (cause) => new LexicalIndexError({ message: "lexical search unavailable", cause }),
          });
          const hits: LexicalHit[] = [];
          for (const row of rows) {
            const hit = toLexicalHit(row);
            if (hit !== null) {
              hits.push(hit);
            }
          }
          return hits;
        });

      return { indexDocument, removeDocument, search };
    }),
  );
