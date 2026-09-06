import { Effect, Layer } from "effect";
import { VectorIndex, VectorIndexError, type TenantId, type VectorScoredHit } from "@finch/core";
import { Db } from "./client.ts";

// ponytail: voyage-finance-2 output width; must match the 0004 vec0 float[N].
const VECTOR_DIMS = 1024;

const DELETE_MODEL_SQL =
  "DELETE FROM document_embeddings_vec WHERE tenant_id = ? AND document_id = ? AND model = ?";
const DELETE_DOCUMENT_SQL =
  "DELETE FROM document_embeddings_vec WHERE tenant_id = ? AND document_id = ?";
const INSERT_SQL =
  "INSERT INTO document_embeddings_vec(embedding, tenant_id, document_id, model) VALUES (?, ?, ?, ?)";
const SEARCH_SQL =
  "SELECT document_id, distance FROM document_embeddings_vec" +
  " WHERE embedding MATCH ? AND k = ? AND tenant_id = ?";

// The port carries raw bytes; vec0 binds float32 blobs, so reinterpret the
// bytes (copying onto a 4-byte-aligned buffer: Buffer-backed inputs are not).
const toFloat32 = (vector: Uint8Array, dims: number): Effect.Effect<Float32Array, VectorIndexError> => {
  if (dims !== VECTOR_DIMS) {
    return Effect.fail(
      new VectorIndexError({
        message: `unsupported dims ${dims}: document_embeddings_vec stores float[${VECTOR_DIMS}]`,
      }),
    );
  }
  if (vector.byteLength !== dims * 4) {
    return Effect.fail(
      new VectorIndexError({
        message: `vector byte length ${vector.byteLength} does not match dims ${dims}`,
      }),
    );
  }
  return Effect.succeed(new Float32Array(Uint8Array.from(vector).buffer));
};

export const VectorIndexLive: Layer.Layer<VectorIndex, never, Db> = Layer.effect(
  VectorIndex,
  Effect.gen(function* () {
    const { sqlite } = yield* Db;

    const upsert = (
      tenantId: TenantId,
      documentId: string,
      model: string,
      dims: number,
      vector: Uint8Array,
    ): Effect.Effect<void, VectorIndexError> =>
      Effect.gen(function* () {
        const embedding = yield* toFloat32(vector, dims);
        yield* Effect.try({
          try: () => {
            sqlite.transaction(() => {
              sqlite.query(DELETE_MODEL_SQL).run(tenantId, documentId, model);
              sqlite.query(INSERT_SQL).run(embedding, tenantId, documentId, model);
            })();
          },
          catch: (cause) =>
            new VectorIndexError({
              message: `vector upsert failed for document ${JSON.stringify(documentId)}`,
              cause,
            }),
        });
      });

    const removeByDocument = (
      tenantId: TenantId,
      documentId: string,
    ): Effect.Effect<void, VectorIndexError> =>
      Effect.try({
        try: () => {
          sqlite.query(DELETE_DOCUMENT_SQL).run(tenantId, documentId);
        },
        catch: (cause) =>
          new VectorIndexError({
            message: `vector remove failed for document ${JSON.stringify(documentId)}`,
            cause,
          }),
      });

    const search = (
      tenantId: TenantId,
      query: Uint8Array,
      dims: number,
      topK: number,
    ): Effect.Effect<readonly VectorScoredHit[], VectorIndexError> =>
      Effect.gen(function* () {
        const embedding = yield* toFloat32(query, dims);
        const limit = Math.floor(topK);
        if (!Number.isFinite(limit) || limit <= 0) {
          return yield* new VectorIndexError({
            message: `invalid topK ${JSON.stringify(topK)}: expected a positive integer`,
          });
        }
        return yield* Effect.try({
          try: (): ReadonlyArray<VectorScoredHit> => {
            const rows = sqlite.query(SEARCH_SQL).all(embedding, limit, tenantId);
            return (rows as ReadonlyArray<unknown>).map((row): VectorScoredHit => {
              const record =
                typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
              const documentId = record?.["document_id"];
              const distance = record?.["distance"];
              if (typeof documentId !== "string" || typeof distance !== "number") {
                throw new Error("malformed vec0 row");
              }
              // score is the L2 distance: smaller sorts nearer.
              return { documentId, score: distance };
            });
          },
          catch: (cause) =>
            cause instanceof VectorIndexError
              ? cause
              : new VectorIndexError({ message: "vector search unavailable", cause }),
        });
      });

    return { upsert, removeByDocument, search };
  }),
);
