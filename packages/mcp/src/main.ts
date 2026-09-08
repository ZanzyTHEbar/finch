import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Effect, Layer } from "effect"
import { AppConfigLive } from "@finch/core"
import {
  AccountRepositoryLive,
  BankAuthIntentRepositoryLive,
  BankSessionRepositoryLive,
  EmbeddingRepositoryLive,
  EventReadRepositoryLive,
  EventStoreLive,
  JobRepositoryLive,
  LexicalIndexLive,
  MigratedSqliteLive,
  ProjectionRunnerLive,
  ReceiptRepositoryLive,
  ReconciliationRepositoryLive,
  SearchDocumentRepositoryLive,
  SummaryRepositoryLive,
  TransactionRepositoryLive,
  VectorIndexLive,
} from "@finch/db"
import { BankIngestLive, EnableBankingLive } from "@finch/enablebanking"
import { DocumentEmbedWorker, DocumentEmbedWorkerLive } from "@finch/search/embed-worker"
import { HybridSearchLive } from "@finch/search/hybrid"
import { VoyageEmbeddingProviderLive } from "@finch/search/voyage"
import { buildMcpServer } from "./server.ts"

// Production composition for `bun packages/mcp/src/main.ts`: sqlite file
// from DATABASE_URL (see AppConfig), file migrations applied on boot, live
// voyage embeddings. Run from the repo root so the drizzle folder resolves.
const MigratedDb = Layer.provide(MigratedSqliteLive, AppConfigLive)

const SearchDocs = Layer.provide(SearchDocumentRepositoryLive, MigratedDb)
const Vectors = Layer.provide(VectorIndexLive, MigratedDb)
const Lexical = Layer.provide(LexicalIndexLive, Layer.mergeAll(MigratedDb, SearchDocs))
const Embeddings = Layer.provide(VoyageEmbeddingProviderLive, AppConfigLive)
const Hybrid = Layer.provide(HybridSearchLive, Layer.mergeAll(Embeddings, Vectors, Lexical, SearchDocs))
const Transactions = Layer.provide(TransactionRepositoryLive, MigratedDb)
const Receipts = Layer.provide(ReceiptRepositoryLive, MigratedDb)
const Jobs = Layer.provide(JobRepositoryLive, MigratedDb)
const Stored = Layer.provide(EmbeddingRepositoryLive, MigratedDb)
const Worker = Layer.provide(
  DocumentEmbedWorkerLive,
  Layer.mergeAll(AppConfigLive, Embeddings, Vectors, Jobs, SearchDocs, Stored),
)
const Accounts = Layer.provide(AccountRepositoryLive, MigratedDb)
const Events = Layer.provide(EventStoreLive, MigratedDb)
const EventReads = Layer.provide(EventReadRepositoryLive, MigratedDb)
const Summaries = Layer.provide(SummaryRepositoryLive, MigratedDb)
const Recons = Layer.provide(ReconciliationRepositoryLive, MigratedDb)
const Sessions = Layer.provide(BankSessionRepositoryLive, MigratedDb)
const Intents = Layer.provide(BankAuthIntentRepositoryLive, MigratedDb)
const Bank = Layer.provide(EnableBankingLive, AppConfigLive)
const Runner = Layer.provide(
  ProjectionRunnerLive,
  Layer.mergeAll(
    MigratedDb,
    Events,
    EventReads,
    Accounts,
    Transactions,
    Receipts,
    SearchDocs,
    Summaries,
    Recons,
    Jobs,
  ),
)
const Ingest = Layer.provide(BankIngestLive, Layer.mergeAll(Bank, Sessions, Accounts, Events, Runner))

const FinchMcpLive = Layer.mergeAll(
  Layer.mergeAll(Hybrid, Transactions, Receipts, Bank),
  Layer.mergeAll(Sessions, Intents, Ingest),
).pipe(Layer.orDie)
const BootLive = Layer.mergeAll(FinchMcpLive, Worker).pipe(Layer.orDie)

const main = Effect.gen(function* () {
  const worker = yield* DocumentEmbedWorker
  yield* worker.requeueAllMissing()
  yield* worker.drain(500)
  const server = buildMcpServer(FinchMcpLive)
  yield* Effect.promise(() => server.connect(new StdioServerTransport()))
  // connect() resolves once the transport is up; hold the session on stdin.
  // Never write to stdout — MCP JSON-RPC owns it.
  yield* Effect.never
}).pipe(Effect.provide(BootLive))

Effect.runPromise(main).catch((cause) => {
  console.error(`finch-mcp: fatal: ${cause instanceof Error ? cause.message : String(cause)}`)
  process.exit(1)
})
