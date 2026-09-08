import { and, asc, count, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { StorageUnavailable, nowInstant, uuidv7, type TenantId } from "@finch/core";
import { Db } from "../client.ts";
import { searchDocuments } from "../schema/index.ts";

export type SearchDocumentRow = typeof searchDocuments.$inferSelect;

export class SearchDocumentRepository extends Context.Tag("SearchDocumentRepository")<
  SearchDocumentRepository,
  {
    readonly upsert: (
      tenantId: TenantId,
      sourceType: string,
      sourceId: string,
      content: string,
    ) => Effect.Effect<SearchDocumentRow, StorageUnavailable>;
    readonly removeBySource: (
      tenantId: TenantId,
      sourceType: string,
      sourceId: string,
    ) => Effect.Effect<void, StorageUnavailable>;
    readonly listAll: (
      tenantId: TenantId,
    ) => Effect.Effect<readonly SearchDocumentRow[], StorageUnavailable>;
    readonly findBySource: (
      tenantId: TenantId,
      sourceType: string,
      sourceId: string,
    ) => Effect.Effect<SearchDocumentRow | null, StorageUnavailable>;
    readonly count: (tenantId: TenantId) => Effect.Effect<number, StorageUnavailable>;
    readonly listDistinctTenantIds: () => Effect.Effect<readonly TenantId[], StorageUnavailable>;
  }
>() {}

export const SearchDocumentRepositoryLive: Layer.Layer<SearchDocumentRepository, never, Db> =
  Layer.effect(
    SearchDocumentRepository,
    Effect.gen(function* () {
      const { db } = yield* Db;
      const scope = (tenantId: TenantId, sourceType: string, sourceId: string) =>
        and(
          eq(searchDocuments.tenantId, tenantId),
          eq(searchDocuments.sourceType, sourceType),
          eq(searchDocuments.sourceId, sourceId),
        );

      const upsert = (
        tenantId: TenantId,
        sourceType: string,
        sourceId: string,
        content: string,
      ): Effect.Effect<SearchDocumentRow, StorageUnavailable> =>
        Effect.gen(function* () {
          const row = yield* Effect.try({
            try: () =>
              db
                .insert(searchDocuments)
                .values({
                  id: uuidv7(),
                  tenantId,
                  sourceType,
                  sourceId,
                  content,
                  updatedAt: nowInstant(),
                })
                .onConflictDoUpdate({
                  target: [
                    searchDocuments.tenantId,
                    searchDocuments.sourceType,
                    searchDocuments.sourceId,
                  ],
                  set: { content, updatedAt: nowInstant() },
                })
                .returning()
                .get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          if (row === undefined) {
            return yield* new StorageUnavailable({
              cause: "search_documents upsert returned no row",
            });
          }
          return row;
        });

      const removeBySource = (
        tenantId: TenantId,
        sourceType: string,
        sourceId: string,
      ): Effect.Effect<void, StorageUnavailable> =>
        Effect.gen(function* () {
          yield* Effect.try({
            try: () =>
              db.delete(searchDocuments).where(scope(tenantId, sourceType, sourceId)).run(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
        });

      const listAll = (
        tenantId: TenantId,
      ): Effect.Effect<readonly SearchDocumentRow[], StorageUnavailable> =>
        Effect.try({
          try: () =>
            db
              .select()
              .from(searchDocuments)
              .where(eq(searchDocuments.tenantId, tenantId))
              .orderBy(asc(searchDocuments.sourceType), asc(searchDocuments.sourceId))
              .all(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });

      const findBySource = (
        tenantId: TenantId,
        sourceType: string,
        sourceId: string,
      ): Effect.Effect<SearchDocumentRow | null, StorageUnavailable> =>
        Effect.map(
          Effect.try({
            try: () =>
              db
                .select()
                .from(searchDocuments)
                .where(scope(tenantId, sourceType, sourceId))
                .get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          }),
          (row) => row ?? null,
        );

      const countDocuments = (
        tenantId: TenantId,
      ): Effect.Effect<number, StorageUnavailable> =>
        Effect.gen(function* () {
          const row = yield* Effect.try({
            try: () =>
              db
                .select({ value: count(searchDocuments.id) })
                .from(searchDocuments)
                .where(eq(searchDocuments.tenantId, tenantId))
                .get(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
          return row?.value ?? 0;
        });

      const listDistinctTenantIds = (): Effect.Effect<readonly TenantId[], StorageUnavailable> =>
        Effect.try({
          try: () => {
            const rows = db
              .select({ tenantId: searchDocuments.tenantId })
              .from(searchDocuments)
              .groupBy(searchDocuments.tenantId)
              .all();
            return rows.map((row) => row.tenantId as TenantId);
          },
          catch: (cause) => new StorageUnavailable({ cause }),
        });

      return {
        upsert,
        removeBySource,
        listAll,
        findBySource,
        count: countDocuments,
        listDistinctTenantIds,
      };
    }),
  );
