import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  StorageUnavailable,
  ValidationFailed,
  nowInstant,
  uuidv7,
  type TenantId,
} from "@finch/core";
import { Db } from "../client.ts";
import { summaries } from "../schema/index.ts";

export type SummaryRow = typeof summaries.$inferSelect;
export type SummaryRecord = Omit<SummaryRow, "content"> & { readonly content: unknown };

export class SummaryRepository extends Context.Tag("SummaryRepository")<
  SummaryRepository,
  {
    readonly upsert: (
      tenantId: TenantId,
      periodType: string,
      period: string,
      content: unknown,
      generatedAt?: string,
    ) => Effect.Effect<SummaryRow, ValidationFailed | StorageUnavailable>;
    readonly get: (
      tenantId: TenantId,
      periodType: string,
      period: string,
    ) => Effect.Effect<SummaryRecord | null, ValidationFailed | StorageUnavailable>;
  }
>() {}

export const SummaryRepositoryLive: Layer.Layer<SummaryRepository, never, Db> = Layer.effect(
  SummaryRepository,
  Effect.gen(function* () {
    const { db } = yield* Db;

    const upsert = (
      tenantId: TenantId,
      periodType: string,
      period: string,
      content: unknown,
      generatedAt?: string,
    ): Effect.Effect<SummaryRow, ValidationFailed | StorageUnavailable> =>
      Effect.gen(function* () {
        const contentText = yield* Effect.try({
          try: () => {
            const text = JSON.stringify(content);
            if (typeof text !== "string") {
              throw new Error("summary content is not JSON-serializable");
            }
            return text;
          },
          catch: () =>
            new ValidationFailed({
              issues: [`summary ${periodType}/${period} content is not JSON-serializable`],
            }),
        });
        const stampedAt = generatedAt ?? nowInstant();
        const row = yield* Effect.try({
          try: () =>
            db
              .insert(summaries)
              .values({
                id: uuidv7(),
                tenantId,
                periodType,
                period,
                content: contentText,
                generatedAt: stampedAt,
              })
              .onConflictDoUpdate({
                target: [summaries.tenantId, summaries.periodType, summaries.period],
                set: { content: contentText, generatedAt: stampedAt },
              })
              .returning()
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (row === undefined) {
          return yield* new StorageUnavailable({ cause: "summaries upsert returned no row" });
        }
        return row;
      });

    const get = (
      tenantId: TenantId,
      periodType: string,
      period: string,
    ): Effect.Effect<SummaryRecord | null, ValidationFailed | StorageUnavailable> =>
      Effect.gen(function* () {
        const row = yield* Effect.try({
          try: () =>
            db
              .select()
              .from(summaries)
              .where(
                and(
                  eq(summaries.tenantId, tenantId),
                  eq(summaries.periodType, periodType),
                  eq(summaries.period, period),
                ),
              )
              .get(),
          catch: (cause) => new StorageUnavailable({ cause }),
        });
        if (row === undefined) {
          return null;
        }
        const content = yield* Effect.try({
          try: () => JSON.parse(row.content) as unknown,
          catch: () =>
            new ValidationFailed({
              issues: [`summary ${periodType}/${period} has corrupt content JSON`],
            }),
        });
        return { ...row, content };
      });

    return { upsert, get };
  }),
);
