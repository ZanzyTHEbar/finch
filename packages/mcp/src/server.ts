import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Layer, Option, ParseResult, Schema } from "effect"
import { eq } from "drizzle-orm"
import {
  BankProvider,
  BankSessionMissing,
  ReconciliationConflict,
  StorageUnavailable,
  TenantId,
  TenantMismatch,
  TransactionNotFound,
  ValidationFailed,
  PaymentNotFound,
  type ProviderUnavailable,
  type ReceiptNotFound,
} from "@finch/core"
import type { HybridSearchError, HybridSearchResult } from "@finch/search/hybrid"
import { HybridSearch } from "@finch/search/hybrid"
import {
  AccountRepository,
  BankAuthIntentRepository,
  BankSessionRepository,
  EventStore,
  ProjectionRunner,
  ReceiptRepository,
  TransactionRepository,
  type AccountRow,
  type BankSessionStatus,
  type ReceiptRow,
  type TransactionRow,
  accounts,
  embeddings,
  events,
  jobs,
  payments,
  projectionCheckpoints,
  receipts,
  reconciliations,
  searchDocuments,
  summaries,
  transactions,
  bankSessions,
  bankAuthIntents,
} from "@finch/db"
import { Db } from "@finch/db"
import { BankIngest, BankPayments, type IngestStats } from "@finch/enablebanking"
import { ReceiptMatcher, type MatchStats } from "@finch/reconciliation"
import type {
  BankAspsp,
  BankAuthorization,
  BankPayment,
  BankSession,
} from "@finch/core"
import {
  authorizeBankSession,
  captureReceipt,
  confirmMatch,
  createPayment,
  deleteBankSession,
  deletePayment,
  getBankStatus,
  getPayment,
  getReceipt,
  getTransaction,
  listAspsps,
  listPayments,
  listUnmatchedReceipts,
  matchReceipts,
  rejectMatch,
  searchFinances,
  startBankAuth,
  submitPayment,
  syncBank,
} from "@finch/lib-legacy"

// Services the tools run against. The server takes a composed layer of
// these Tags — it never touches a driver, SQL, or connection string.
export type FinchMcpEnv =
  | HybridSearch
  | TransactionRepository
  | ReceiptRepository
  | BankProvider
  | BankIngest
  | BankSessionRepository
  | BankAuthIntentRepository
  | EventStore
  | ProjectionRunner
  | ReceiptMatcher
  | BankPayments
  | AccountRepository
  | Db

type ToolFailure =
  | HybridSearchError
  | TransactionNotFound
  | ReceiptNotFound
  | StorageUnavailable
  | ProviderUnavailable
  | BankSessionMissing
  | ValidationFailed
  | TenantMismatch
  | ReconciliationConflict
  | PaymentNotFound

// Effect Schema is the tree's validation language (no zod in-repo): tool
// inputs decode here, and every rejection surfaces as a typed
// ValidationFailed payload instead of a transport error.
const ExportDataInput = Schema.Struct({
  tenantId: TenantId,
})

const DeleteAccountInput = Schema.Struct({
  tenantId: TenantId,
  confirm: Schema.Boolean,
})

const DataPrivacyInput = Schema.Struct({
  tenantId: TenantId,
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
    name: "capture_receipt",
    description: "Append ReceiptCaptured and project the receipt row (idempotent on tenant+imageHash+payload).",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        totalMinor: { type: "integer", minimum: 0 },
        imageHash: { type: "string" },
        sourceUri: { type: "string" },
        merchant: { type: "string" },
        receiptDate: { type: "string" },
        currency: { type: "string" },
      },
      required: ["tenantId", "totalMinor", "imageHash", "sourceUri"],
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
  {
    name: "list_aspsps",
    description:
      "List available bank ASPSPs (Account Servicing Payment Service Providers) from the banking provider. Use this to discover which banks are supported and their country codes before starting an auth flow.",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", description: "ISO 3166-1 alpha-2 country code to filter by (e.g. 'PT', 'DE')" },
      },
    },
  },
  {
    name: "start_bank_auth",
    description:
      "Begin the bank account connection flow for a tenant. Returns a redirect URL the user must visit to authorize access to their bank account. After the user authorizes, call authorize_bank_session with the returned code and state.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", description: "Unique tenant identifier" },
        aspspName: { type: "string", description: "Bank name as listed by list_aspsps (e.g. 'CGD')" },
        aspspCountry: { type: "string", description: "Bank country code (e.g. 'PT')" },
        redirectUrl: { type: "string", description: "URL to redirect the user back to after authorization" },
        state: { type: "string", description: "Opaque state token to pass back in authorize_bank_session" },
      },
      required: ["tenantId", "aspspName", "aspspCountry", "redirectUrl", "state"],
    },
  },
  {
    name: "authorize_bank_session",
    description:
      "Complete the bank connection by exchanging the authorization code for a persistent session. Call this after the user returns from the bank's redirect with the code and state parameters.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", description: "Unique tenant identifier" },
        code: { type: "string", description: "Authorization code from the bank redirect" },
        state: { type: "string", description: "State token from the original start_bank_auth call" },
      },
      required: ["tenantId", "code", "state"],
    },
  },
  {
    name: "get_bank_status",
    description:
      "Check whether a tenant has an active bank connection. Returns the session status (connected/disconnected) and basic info if connected.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", description: "Unique tenant identifier" },
      },
      required: ["tenantId"],
    },
  },
  {
    name: "sync_bank",
    description:
      "Fetch the latest accounts and transactions from the connected bank. Optionally sync only recent transactions by providing a 'since' date. Returns counts of accounts, transactions, and skipped items.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", description: "Unique tenant identifier" },
        since: { type: "string", description: "ISO 8601 date to sync from (e.g. '2026-01-01'). If omitted, syncs all available data." },
      },
      required: ["tenantId"],
    },
  },
  {
    name: "match_receipts",
    description: "Score unmatched receipts against booked transactions; auto-link high scores, propose the rest.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
      },
      required: ["tenantId"],
    },
  },
  {
    name: "confirm_match",
    description: "Confirm a proposed receipt/transaction match.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        transactionId: { type: "string" },
        receiptId: { type: "string" },
        confirmedBy: { type: "string" },
      },
      required: ["tenantId", "transactionId", "receiptId"],
    },
  },
  {
    name: "reject_match",
    description: "Reject a proposed receipt/transaction match.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        transactionId: { type: "string" },
        receiptId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["tenantId", "transactionId", "receiptId", "reason"],
    },
  },
  {
    name: "create_payment",
    description:
      "Create a SEPA credit transfer through the connected bank. Returns a payment id and a bank redirect URL where the user must authorize the payment. After authorization, call submit_payment to finalize.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        aspspName: { type: "string" },
        aspspCountry: { type: "string" },
        redirectUrl: { type: "string" },
        state: { type: "string" },
        creditorName: { type: "string" },
        creditorIban: { type: "string" },
        amountMinor: { type: "integer", minimum: 1 },
        currency: { type: "string" },
        paymentType: { type: "string" },
        remittance: { type: "string" },
      },
      required: [
        "tenantId",
        "aspspName",
        "aspspCountry",
        "redirectUrl",
        "state",
        "creditorName",
        "creditorIban",
        "amountMinor",
        "currency",
      ],
    },
  },
  {
    name: "list_payments",
    description:
      "List all payments created for a tenant. Each payment includes its current status (pending, authorized, submitted, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
      },
      required: ["tenantId"],
    },
  },
  {
    name: "get_payment",
    description:
      "Fetch a specific payment by id. Refreshes the status from the banking provider to ensure it's up to date.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        paymentId: { type: "string" },
      },
      required: ["tenantId", "paymentId"],
    },
  },
  {
    name: "submit_payment",
    description:
      "Finalize a payment after the user has authorized it at the bank. Must be called after create_payment and bank authorization.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        paymentId: { type: "string" },
      },
      required: ["tenantId", "paymentId"],
    },
  },
  {
    name: "delete_payment",
    description:
      "Cancel and delete a payment. Only payments that haven't been submitted yet can be deleted.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        paymentId: { type: "string" },
      },
      required: ["tenantId", "paymentId"],
    },
  },
  {
    name: "delete_bank_session",
    description:
      "Disconnect a tenant's bank account. Deletes both the local session record and the remote authorization at the banking provider. The tenant will need to re-authorize to reconnect.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
      },
      required: ["tenantId"],
    },
  },
  {
    name: "export_data",
    description:
      "Export all data for a tenant as JSON (transactions, receipts, accounts). For GDPR/data portability.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", description: "Unique tenant identifier" },
      },
      required: ["tenantId"],
    },
  },
  {
    name: "delete_account",
    description:
      "Permanently delete all data for a tenant (accounts, transactions, receipts, events). For GDPR right to erasure.",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", description: "Unique tenant identifier" },
        confirm: { type: "boolean", description: "Must be true to confirm deletion" },
      },
      required: ["tenantId", "confirm"],
    },
  },
  {
    name: "data_privacy",
    description:
      "Show what data is stored for a tenant and how to manage it (export, delete).",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string", description: "Unique tenant identifier" },
      },
      required: ["tenantId"],
    },
  },
]

const exportData = (args: unknown): Effect.Effect<
  {
    readonly accounts: readonly AccountRow[]
    readonly transactions: readonly TransactionRow[]
    readonly receipts: readonly ReceiptRow[]
  },
  ToolFailure,
  FinchMcpEnv
> =>
  Effect.gen(function* () {
    const input = yield* decodeInput(ExportDataInput, args)
    const accounts_ = yield* AccountRepository
    const txs = yield* TransactionRepository
    const { db } = yield* Db
    const [accountRows, transactionRows, receiptRows] = yield* Effect.all([
      accounts_.list(input.tenantId),
      txs.list(input.tenantId, {}),
      Effect.try({
        try: () => db.select().from(receipts).where(eq(receipts.tenantId, input.tenantId)).all(),
        catch: (cause) => new StorageUnavailable({ cause }),
      }),
    ])
    return { accounts: accountRows, transactions: transactionRows, receipts: receiptRows }
  })

const deleteAccount = (args: unknown): Effect.Effect<{ readonly deleted: true }, ToolFailure, FinchMcpEnv> =>
  Effect.gen(function* () {
    const input = yield* decodeInput(DeleteAccountInput, args)
    if (!input.confirm) {
      return yield* new ValidationFailed({ issues: ["confirm must be true to delete all data"] })
    }
    const { db } = yield* Db
    // Delete in FK-safe order: leaf tables first, then parents.
    // ponytail: manual cascade order, mirrors schema FKs at time of writing.
    yield* Effect.try({
      try: () => {
        db.delete(embeddings).where(eq(embeddings.tenantId, input.tenantId)).run()
        db.delete(reconciliations).where(eq(reconciliations.tenantId, input.tenantId)).run()
        db.delete(receipts).where(eq(receipts.tenantId, input.tenantId)).run()
        db.delete(searchDocuments).where(eq(searchDocuments.tenantId, input.tenantId)).run()
        db.delete(transactions).where(eq(transactions.tenantId, input.tenantId)).run()
        db.delete(summaries).where(eq(summaries.tenantId, input.tenantId)).run()
        db.delete(jobs).where(eq(jobs.tenantId, input.tenantId)).run()
        db.delete(events).where(eq(events.tenantId, input.tenantId)).run()
        db.delete(bankSessions).where(eq(bankSessions.tenantId, input.tenantId)).run()
        db.delete(bankAuthIntents).where(eq(bankAuthIntents.tenantId, input.tenantId)).run()
        db.delete(payments).where(eq(payments.tenantId, input.tenantId)).run()
        db.delete(accounts).where(eq(accounts.tenantId, input.tenantId)).run()
        db.delete(projectionCheckpoints).where(eq(projectionCheckpoints.tenantId, input.tenantId)).run()
      },
      catch: (cause) => new StorageUnavailable({ cause }),
    })
    return { deleted: true }
  })

const dataPrivacy = (args: unknown): Effect.Effect<
  {
    readonly tenantId: string
    readonly storedData: readonly string[]
    readonly exportTool: string
    readonly deleteTool: string
  },
  ToolFailure,
  FinchMcpEnv
> =>
  Effect.gen(function* () {
    const input = yield* decodeInput(DataPrivacyInput, args)
    return {
      tenantId: input.tenantId,
      storedData: [
        "accounts",
        "transactions",
        "receipts",
        "events",
        "bank_sessions",
        "search_documents",
        "embeddings",
        "summaries",
        "reconciliations",
        "jobs",
        "projection_checkpoints",
        "payments",
      ],
      exportTool: "export_data",
      deleteTool: "delete_account",
    }
  })

type ToolResult =
  | HybridSearchResult
  | TransactionRow
  | ReceiptRow
  | null
  | { readonly id: string; readonly duplicate: boolean }
  | { readonly id: string }
  | { readonly deleted: true }
  | readonly ReceiptRow[]
  | readonly BankAspsp[]
  | readonly BankPayment[]
  | BankAuthorization
  | BankSession
  | BankPayment
  | IngestStats
  | MatchStats
  | { readonly connected: boolean; readonly status?: BankSessionStatus; readonly sessionId?: string }
  | {
      readonly accounts: readonly AccountRow[]
      readonly transactions: readonly TransactionRow[]
      readonly receipts: readonly ReceiptRow[]
    }
  | {
      readonly tenantId: string
      readonly storedData: readonly string[]
      readonly exportTool: string
      readonly deleteTool: string
    }

const toolEffect = (name: string, args: unknown): Effect.Effect<ToolResult, ToolFailure, FinchMcpEnv> => {
  switch (name) {
    case "search_finances":
      return searchFinances(args)
    case "get_transaction":
      return getTransaction(args)
    case "get_receipt":
      return getReceipt(args)
    case "capture_receipt":
      return captureReceipt(args)
    case "list_unmatched_receipts":
      return listUnmatchedReceipts(args)
    case "list_aspsps":
      return listAspsps(args)
    case "start_bank_auth":
      return startBankAuth(args)
    case "authorize_bank_session":
      return authorizeBankSession(args)
    case "sync_bank":
      return syncBank(args)
    case "match_receipts":
      return matchReceipts(args)
    case "confirm_match":
      return confirmMatch(args)
    case "reject_match":
      return rejectMatch(args)
    case "create_payment":
      return createPayment(args)
    case "list_payments":
      return listPayments(args)
    case "get_payment":
      return getPayment(args)
    case "submit_payment":
      return submitPayment(args)
    case "delete_payment":
      return deletePayment(args)
    case "delete_bank_session":
      return deleteBankSession(args)
    case "get_bank_status":
      return getBankStatus(args)
    case "export_data":
      return exportData(args)
    case "delete_account":
      return deleteAccount(args)
    case "data_privacy":
      return dataPrivacy(args)
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
const SAFE_ERROR_FIELDS = [
  "issues",
  "message",
  "transactionId",
  "receiptId",
  "tenantId",
  "documentId",
  "reason",
  "paymentId",
] as const

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
