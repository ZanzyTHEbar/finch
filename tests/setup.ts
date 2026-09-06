import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Effect, Layer } from "effect";
import { Db } from "../packages/db/src/client.ts";
import * as schema from "../packages/db/src/schema/index.ts";
import { EventStoreLive, type EventStore } from "../packages/db/src/event-store.ts";
import { ProjectionRunnerLive, type ProjectionRunner } from "../packages/db/src/projections/runner.ts";
import {
  AccountRepositoryLive,
  type AccountRepository,
} from "../packages/db/src/repositories/account.ts";
import { EventReadRepositoryLive, type EventReadRepository } from "../packages/db/src/repositories/event.ts";
import {
  ReceiptRepositoryLive,
  type ReceiptRepository,
} from "../packages/db/src/repositories/receipt.ts";
import {
  ReconciliationRepositoryLive,
  type ReconciliationRepository,
} from "../packages/db/src/repositories/reconciliation.ts";
import {
  SearchDocumentRepositoryLive,
  type SearchDocumentRepository,
} from "../packages/db/src/repositories/search-document.ts";
import {
  SummaryRepositoryLive,
  type SummaryRepository,
} from "../packages/db/src/repositories/summary.ts";
import {
  TransactionRepositoryLive,
  type TransactionRepository,
} from "../packages/db/src/repositories/transaction.ts";

export type TestServices =
  | Db
  | EventStore
  | EventReadRepository
  | AccountRepository
  | TransactionRepository
  | ReceiptRepository
  | SearchDocumentRepository
  | SummaryRepository
  | ReconciliationRepository
  | ProjectionRunner;

export const makeTestLayers = (sqlite: Database): Layer.Layer<TestServices, never, never> => {
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "packages/db/drizzle" });
  const DbLive = Layer.succeed(Db, { db, sqlite });
  const ReposLive = Layer.mergeAll(
    EventStoreLive,
    EventReadRepositoryLive,
    AccountRepositoryLive,
    TransactionRepositoryLive,
    ReceiptRepositoryLive,
    SearchDocumentRepositoryLive,
    SummaryRepositoryLive,
    ReconciliationRepositoryLive,
  );
  const ReposProvided = Layer.provide(ReposLive, DbLive);
  const RunnerProvided = Layer.provide(
    ProjectionRunnerLive,
    Layer.mergeAll(DbLive, ReposProvided),
  );
  return Layer.mergeAll(DbLive, ReposProvided, RunnerProvided);
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const describeFailure = (failure: unknown): string => {
  if (failure instanceof Error) {
    return failure.message;
  }
  if (typeof failure === "object" && failure !== null && "_tag" in failure) {
    const tag = (failure as { readonly _tag: unknown })._tag;
    return `${String(tag)}: ${safeJson(failure)}`;
  }
  return safeJson(failure);
};

export const runTest = <A, E, R>(
  layer: Layer.Layer<R, never, never>,
  effect: Effect.Effect<A, E, R>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(effect, layer).pipe(
      Effect.mapError((failure) => new Error(describeFailure(failure), { cause: failure })),
    ),
  );
