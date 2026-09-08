import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { StorageUnavailable, uuidv7, type TenantId } from "@finch/core";
import { Db } from "../client.ts";
import { embeddings } from "../schema/index.ts";

export type EmbeddingRow = typeof embeddings.$inferSelect;

export class EmbeddingRepository extends Context.Tag("EmbeddingRepository")<
  EmbeddingRepository,
  {
    readonly upsert: (
      tenantId: TenantId,
      documentId: string,
      model: string,
      dims: number,
      vector: Uint8Array,
      contentHash: string,
    ) => Effect.Effect<EmbeddingRow, StorageUnavailable>;
    readonly get: (
      tenantId: TenantId,
      documentId: string,
      model: string,
    ) => Effect.Effect<EmbeddingRow | null, StorageUnavailable>;
    readonly removeByDocument: (
      tenantId: TenantId,
      documentId: string,
    ) => Effect.Effect<void, StorageUnavailable>;
  }
>() {}

export const EmbeddingRepositoryLive: Layer.Layer<EmbeddingRepository, never, Db> = Layer.effect(
  EmbeddingRepository,
  Effect.gen(function* () {
    const { db } = yield* Db;

    const upsert = (
      tenantId: TenantId,
      documentId: string,
      model: string,
      dims: number,
      vector: Uint8Array,
      contentHash: string,
    ): Effect.Effect<EmbeddingRow, StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* Effect.try({
          try: () =>
            db
              .insert(embeddings)
              .values({
                id: uuidv7(),
                tenantId,
                documentId,
                model,
                dims,
                vector: Buffer.from(vector),
                contentHash,
              })
              .onConflictDoUpdate({
                target: [embeddings.tenantId, embeddings.documentId, embeddings.model],
                set: { dims, vector: Buffer.from(vector), contentHash },
              })
              .returning()
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (row === undefined) {
          return yield* new StorageUnavailable({ cause: "embeddings upsert returned no row" });
        }
        return row;
      });

    const get = (
      tenantId: TenantId,
      documentId: string,
      model: string,
    ): Effect.Effect<EmbeddingRow | null, StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* Effect.try({
          try: () =>
            db
              .select()
              .from(embeddings)
              .where(
                and(
                  eq(embeddings.tenantId, tenantId),
                  eq(embeddings.documentId, documentId),
                  eq(embeddings.model, model),
                ),
              )
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        return row ?? null;
      });

    const removeByDocument = (
      tenantId: TenantId,
      documentId: string,
    ): Effect.Effect<void, StorageUnavailable> =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () =>
            db
              .delete(embeddings)
              .where(
                and(eq(embeddings.tenantId, tenantId), eq(embeddings.documentId, documentId)),
              )
              .run(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
      });

    return { upsert, get, removeByDocument };
  }),
);
