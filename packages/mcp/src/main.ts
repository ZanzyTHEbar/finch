import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Effect, Layer } from "effect"
import { AppConfigLive, StorageUnavailable } from "@finch/core"
import {
  Db,
  LexicalIndexLive,
  ReceiptRepositoryLive,
  SearchDocumentRepositoryLive,
  SqliteLive,
  TransactionRepositoryLive,
  VectorIndexLive,
} from "@finch/db"
import { HybridSearchLive } from "@finch/search/hybrid"
import { VoyageEmbeddingProviderLive } from "@finch/search/voyage"
import { buildMcpServer } from "./server.ts"

// Production composition for `bun packages/mcp/src/main.ts`: sqlite file
// from DATABASE_URL (see AppConfig), file migrations applied on boot, live
// voyage embeddings. Run from the repo root so the drizzle folder resolves.
const MigratedDb = Layer.effect(
  Db,
  Effect.gen(function* () {
    const { db, sqlite } = yield* Db
    yield* Effect.try({
      try: () => migrate(db, { migrationsFolder: "packages/db/drizzle" }),
      catch: (cause) => new StorageUnavailable({ cause }),
    })
    return { db, sqlite }
  }),
).pipe(Layer.provide(SqliteLive), Layer.provide(AppConfigLive))

const SearchDocs = Layer.provide(SearchDocumentRepositoryLive, MigratedDb)
const Vectors = Layer.provide(VectorIndexLive, MigratedDb)
const Lexical = Layer.provide(LexicalIndexLive, Layer.mergeAll(MigratedDb, SearchDocs))
const Embeddings = Layer.provide(VoyageEmbeddingProviderLive, AppConfigLive)
const Hybrid = Layer.provide(HybridSearchLive, Layer.mergeAll(Embeddings, Vectors, Lexical, SearchDocs))
const Transactions = Layer.provide(TransactionRepositoryLive, MigratedDb)
const Receipts = Layer.provide(ReceiptRepositoryLive, MigratedDb)

const FinchMcpLive = Layer.mergeAll(Hybrid, Transactions, Receipts).pipe(Layer.orDie)

const main = Effect.gen(function* () {
  const server = buildMcpServer(FinchMcpLive)
  yield* Effect.promise(() => server.connect(new StdioServerTransport()))
  // connect() resolves once the transport is up; hold the session on stdin.
  // Never write to stdout — MCP JSON-RPC owns it.
  yield* Effect.never
})

Effect.runPromise(main as Effect.Effect<void>).catch((cause) => {
  console.error(`finch-mcp: fatal: ${cause instanceof Error ? cause.message : String(cause)}`)
  process.exit(1)
})
