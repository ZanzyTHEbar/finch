import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Layer, Option, ParseResult, Schema } from "effect"
import {
  NonEmptyTrimmedString,
  TenantId,
  TransactionNotFound,
  ValidationFailed,
  type ReceiptNotFound,
  type StorageUnavailable,
} from "@finch/core"
import type { HybridSearchError } from "@finch/search/hybrid"
import { HybridSearch } from "@finch/search/hybrid"
import { ReceiptRepository, TransactionRepository } from "@finch/db"

// Services the tools run against. The server takes a composed layer of
// these Tags — it never touches a driver, SQL, or connection string.
export type FinchMcpEnv = HybridSearch | TransactionRepository | ReceiptRepository

type ToolFailure = HybridSearchError | TransactionNotFound | ReceiptNotFound | StorageUnavailable

// Effect Schema is the tree's validation language (no zod in-repo): tool
// inputs decode here, and every rejection surfaces as a typed
// ValidationFailed payload instead of a transport error.
const PositiveInt = Schema.Int.pipe(Schema.greaterThan(0))

const SearchFinancesInput = Schema.Struct({
  tenantId: TenantId,
  text: NonEmptyTrimmedString,
  topK: Schema.optional(PositiveInt),
})

const EntityByIdInput = Schema.Struct({
  tenantId: TenantId,
  id: Schema.NonEmptyString,
})

const ListUnmatchedReceiptsInput = Schema.Struct({
  tenantId: TenantId,
  limit: Schema.optional(PositiveInt),
})

const decodeInput = <A, I>(schema: Schema.Schema<A, I>, args: unknown) =>
  Schema.decodeUnknown(schema)(args).pipe(
    Effect.mapError(
      (issue) => new ValidationFailed({ issues: [ParseResult.TreeFormatter.formatErrorSync(issue)] }),
    ),
  )

const TOOLS: Tool[] = [
  {
    name: "search_finances",
    description:
      "Hybrid (dense + lexical, RRF-fused) search over a tenant's finance corpus. Returns fused hits with documentId, fusedScore, sources and per-source ranks.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        text: { type: "string" },
        topK: { type: "integer", minimum: 1 },
      },
      required: ["tenantId", "text"],
    },
  },
  {
    name: "get_transaction",
    description: "Fetch a single ledger transaction row by id (tenant-scoped).",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        id: { type: "string" },
      },
      required: ["tenantId", "id"],
    },
  },
  {
    name: "get_receipt",
    description: "Fetch a single receipt row by id (tenant-scoped).",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        id: { type: "string" },
      },
      required: ["tenantId", "id"],
    },
  },
  {
    name: "list_unmatched_receipts",
    description: "List receipts with no linked transaction (tenant-scoped, id-ordered).",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["tenantId"],
    },
  },
]

const searchFinances = (args: unknown): Effect.Effect<unknown, ToolFailure, FinchMcpEnv> =>
  Effect.gen(function* () {
    const input = yield* decodeInput(SearchFinancesInput, args)
    const search = yield* HybridSearch
    return yield* search.hybridSearch({
      tenantId: input.tenantId,
      text: input.text,
      ...(input.topK === undefined ? {} : { topK: input.topK }),
    })
  })

const getTransaction = (args: unknown): Effect.Effect<unknown, ToolFailure, FinchMcpEnv> =>
  Effect.gen(function* () {
    const input = yield* decodeInput(EntityByIdInput, args)
    const txs = yield* TransactionRepository
    return yield* txs.findById(input.tenantId, input.id)
  })

const getReceipt = (args: unknown): Effect.Effect<unknown, ToolFailure, FinchMcpEnv> =>
  Effect.gen(function* () {
    const input = yield* decodeInput(EntityByIdInput, args)
    const receipts = yield* ReceiptRepository
    return yield* receipts.findById(input.tenantId, input.id)
  })

const listUnmatchedReceipts = (args: unknown): Effect.Effect<unknown, ToolFailure, FinchMcpEnv> =>
  Effect.gen(function* () {
    const input = yield* decodeInput(ListUnmatchedReceiptsInput, args)
    const receipts = yield* ReceiptRepository
    return yield* receipts.listUnmatched(input.tenantId, input.limit)
  })

const toolEffect = (name: string, args: unknown): Effect.Effect<unknown, ToolFailure, FinchMcpEnv> => {
  switch (name) {
    case "search_finances":
      return searchFinances(args)
    case "get_transaction":
      return getTransaction(args)
    case "get_receipt":
      return getReceipt(args)
    case "list_unmatched_receipts":
      return listUnmatchedReceipts(args)
    default:
      return Effect.fail(new ValidationFailed({ issues: [`unknown tool: ${name}`] }))
  }
}

// Ledger rows carry bigint minor-unit amounts: JSON has no bigint, so
// emit the decimal string. Never coerce through Number (precision loss).
const safeJson = (value: unknown): unknown => {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, nested: unknown) =>
        typeof nested === "bigint" ? nested.toString() : nested instanceof Error ? nested.message : nested,
      ),
    )
  } catch {
    return String(value)
  }
}

// Typed failures: every domain error already carries _tag, so report it
// plus its fields (404s stay distinguishable, never a bare string).
const SAFE_ERROR_FIELDS = ["issues", "transactionId", "receiptId", "tenantId", "documentId"] as const

const errorPayload = (failure: unknown): Record<string, unknown> => {
  if (typeof failure === "object" && failure !== null && "_tag" in failure) {
    const json = safeJson(failure) as Record<string, unknown>
    const payload: Record<string, unknown> = { error: json["_tag"] }
    for (const key of SAFE_ERROR_FIELDS) {
      if (json[key] !== undefined) {
        payload[key] = json[key]
      }
    }
    return payload
  }
  return { error: "InternalError" }
}

const textResult = (value: unknown, isError: boolean): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  isError,
})

const runTool = (
  layer: Layer.Layer<FinchMcpEnv, never, never>,
  name: string,
  args: unknown,
): Promise<CallToolResult> =>
  Effect.runPromise(
    toolEffect(name, args).pipe(
      Effect.provide(layer),
      Effect.matchCause({
        onFailure: (cause) =>
          textResult(
            errorPayload(Cause.failureOption(cause).pipe(Option.getOrElse(() => ({ _tag: "InternalError" })))),
            true,
          ),
        onSuccess: (value) => textResult(safeJson(value), false),
      }),
    ),
  )

export const buildMcpServer = (layer: Layer.Layer<FinchMcpEnv, never, never>): Server => {
  const server = new Server({ name: "finch-ledger", version: "0.1.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    runTool(layer, request.params.name, request.params.arguments),
  )
  return server
}
