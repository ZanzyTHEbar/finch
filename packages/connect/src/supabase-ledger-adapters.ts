import { createHmac, timingSafeEqual } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { Context, Effect, Layer } from "effect"
import {
  LedgerNotFound,
  LedgerPort,
  LedgerUnavailable,
  ValidationFailed,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceAccessUnavailable,
  type LedgerAccount,
  type GetAccountPortInput,
  type GetTransactionPortInput,
  type ListAccountsPortInput,
  type ListTransactionsPortInput,
  type LedgerMoney,
  type LedgerTransaction,
  type PrincipalContext,
  type AuthorizedWorkspace,
  type WorkspaceId,
} from "@finch/lib"

export interface SupabaseLedgerConfig {
  readonly supabaseUrl: string
  readonly serviceRoleKey: string
  readonly pageTokenHmacKey: string
}

type RecordValue = Record<string, unknown>

type AccountCursor = {
  readonly createdAt: string
  readonly id: string
}

type TransactionCursor = {
  readonly bookingDate: string
  readonly id: string
}

type WorkspaceAccessService = Context.Tag.Service<typeof WorkspaceAccess>
type LedgerPortService = Context.Tag.Service<typeof LedgerPort>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const INTEGER = /^-?\d+$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const exactKeys = (value: RecordValue, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const requiredString = (row: RecordValue, field: string) => {
  const value = row[field]
  if (typeof value !== "string") {
    throw new Error(`invalid ${field}`)
  }
  return value
}

const requiredUuid = (row: RecordValue, field: string) => {
  const value = requiredString(row, field)
  if (!UUID.test(value)) {
    throw new Error(`invalid ${field}`)
  }
  return value
}

const requiredDate = (row: RecordValue, field: string) => {
  const value = requiredString(row, field)
  if (!ISO_DATE.test(value)) {
    throw new Error(`invalid ${field}`)
  }
  return value
}

const requiredInteger = (row: RecordValue, field: string) => {
  const value = requiredString(row, field)
  if (!INTEGER.test(value)) {
    throw new Error(`invalid ${field}`)
  }
  return value
}

const invalidPageToken = () => new ValidationFailed({ issues: ["pageToken is invalid"] })

const readAccount = (value: unknown, workspaceId: WorkspaceId): { account: LedgerAccount; cursor: AccountCursor } => {
  if (!isRecord(value)) {
    throw new Error("invalid account row")
  }
  const id = requiredUuid(value, "id")
  if (requiredUuid(value, "workspace_id") !== workspaceId) {
    throw new Error("account workspace mismatch")
  }
  const createdAt = requiredString(value, "created_at")
  if (createdAt.trim() === "") {
    throw new Error("invalid created_at")
  }
  return {
    account: {
      id,
      name: requiredString(value, "name"),
      currency: requiredString(value, "currency"),
      accountType: requiredString(value, "account_type"),
    },
    cursor: { createdAt, id },
  }
}

const readTransaction = (
  value: unknown,
  workspaceId: WorkspaceId,
): { transaction: LedgerTransaction; cursor: TransactionCursor } => {
  if (!isRecord(value)) {
    throw new Error("invalid transaction row")
  }
  const id = requiredUuid(value, "id")
  if (requiredUuid(value, "workspace_id") !== workspaceId) {
    throw new Error("transaction workspace mismatch")
  }
  const accountId = requiredUuid(value, "account_id")
  const valueDate = value["value_date"]
  const merchant = value["merchant_name"]
  if (valueDate !== null && valueDate !== undefined && (typeof valueDate !== "string" || !ISO_DATE.test(valueDate))) {
    throw new Error("invalid value_date")
  }
  if (merchant !== null && merchant !== undefined && typeof merchant !== "string") {
    throw new Error("invalid merchant_name")
  }
  const amount: LedgerMoney = {
    // amount_minor is selected as text so large integer money values never enter JavaScript as numbers.
    minorUnits: requiredInteger(value, "amount_minor"),
    currency: requiredString(value, "currency"),
  }
  return {
    transaction: {
      id,
      accountId,
      amount,
      bookingDate: requiredDate(value, "booking_date"),
      ...(valueDate === null || valueDate === undefined ? {} : { valueDate }),
      description: requiredString(value, "raw_description"),
      ...(merchant === null || merchant === undefined ? {} : { merchant }),
      status: requiredString(value, "status"),
    },
    cursor: { bookingDate: requiredDate(value, "booking_date"), id },
  }
}

const encodePageToken = (payload: RecordValue, key: string) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", key).update(encoded).digest("base64url")
  return `${encoded}.${signature}`
}

const decodePageToken = (token: string, key: string): Effect.Effect<RecordValue, ValidationFailed> =>
  Effect.try({
    try: () => {
      const [encoded, signature, ...rest] = token.split(".")
      if (
        rest.length !== 0 ||
        encoded === undefined ||
        signature === undefined ||
        !BASE64URL.test(encoded) ||
        !BASE64URL.test(signature)
      ) {
        throw new Error("invalid page token")
      }
      const expected = createHmac("sha256", key).update(encoded).digest("base64url")
      const actual = Buffer.from(signature)
      const expectedBytes = Buffer.from(expected)
      if (actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes)) {
        throw new Error("invalid page token signature")
      }
      const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
      if (!isRecord(payload)) {
        throw new Error("invalid page token payload")
      }
      return payload
    },
    catch: invalidPageToken,
  })

const decodeAccountCursor = (
  token: string | undefined,
  workspaceId: WorkspaceId,
  key: string,
): Effect.Effect<AccountCursor | undefined, ValidationFailed> => {
  if (token === undefined) {
    return Effect.succeed(undefined)
  }
  return decodePageToken(token, key).pipe(
    Effect.flatMap((payload) => {
      const order = payload["o"]
      if (
        !exactKeys(payload, ["v", "r", "w", "o"]) ||
        payload["v"] !== 1 ||
        payload["r"] !== "accounts" ||
        payload["w"] !== workspaceId ||
        !isRecord(order) ||
        !exactKeys(order, ["createdAt", "id"]) ||
        typeof order["createdAt"] !== "string" ||
        order["createdAt"].trim() === "" ||
        typeof order["id"] !== "string" ||
        !UUID.test(order["id"])
      ) {
        return Effect.fail(invalidPageToken())
      }
      return Effect.succeed({ createdAt: order["createdAt"], id: order["id"] })
    }),
  )
}

const decodeTransactionCursor = (
  token: string | undefined,
  workspaceId: WorkspaceId,
  accountId: string,
  key: string,
): Effect.Effect<TransactionCursor | undefined, ValidationFailed> => {
  if (token === undefined) {
    return Effect.succeed(undefined)
  }
  return decodePageToken(token, key).pipe(
    Effect.flatMap((payload) => {
      const order = payload["o"]
      if (
        !exactKeys(payload, ["v", "r", "w", "a", "o"]) ||
        payload["v"] !== 1 ||
        payload["r"] !== "transactions" ||
        payload["w"] !== workspaceId ||
        payload["a"] !== accountId ||
        !isRecord(order) ||
        !exactKeys(order, ["bookingDate", "id"]) ||
        typeof order["bookingDate"] !== "string" ||
        !ISO_DATE.test(order["bookingDate"]) ||
        typeof order["id"] !== "string" ||
        !UUID.test(order["id"])
      ) {
        return Effect.fail(invalidPageToken())
      }
      return Effect.succeed({ bookingDate: order["bookingDate"], id: order["id"] })
    }),
  )
}

const unavailable = () => new LedgerUnavailable()

const mapRows = <A>(
  data: unknown,
  map: (row: unknown) => A,
): Effect.Effect<readonly A[], LedgerUnavailable> =>
  Effect.try({
    try: () => {
      if (!Array.isArray(data)) {
        throw new Error("invalid list response")
      }
      return data.map(map)
    },
    catch: unavailable,
  })

export const makeSupabaseLedgerLayer = (
  config: SupabaseLedgerConfig,
): Layer.Layer<WorkspaceAccess | LedgerPort> => {
  if (config.pageTokenHmacKey.trim() === "") {
    throw new Error("pageTokenHmacKey must not be blank")
  }
  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })

  const query = <A>(request: () => PromiseLike<{ data: A; error: unknown }>): Effect.Effect<A, LedgerUnavailable> =>
    Effect.tryPromise({
      try: request,
      catch: unavailable,
    }).pipe(
      Effect.flatMap(({ data, error }): Effect.Effect<A, LedgerUnavailable> =>
        error === null ? Effect.succeed(data) : Effect.fail(unavailable())),
    )

  const workspaceAccess: WorkspaceAccessService = {
    authorize: (
      principal: PrincipalContext,
      workspaceId: WorkspaceId,
    ): Effect.Effect<AuthorizedWorkspace, WorkspaceAccessDenied | WorkspaceAccessUnavailable> =>
      Effect.tryPromise({
        try: () => client.rpc("resolve_authentik_workspace_access", {
          p_issuer: principal.issuer,
          p_subject: principal.subjectId,
          p_workspace_id: workspaceId,
        }),
        catch: () => new WorkspaceAccessUnavailable(),
      }).pipe(
        Effect.flatMap(({ data, error }): Effect.Effect<AuthorizedWorkspace, WorkspaceAccessDenied | WorkspaceAccessUnavailable> => {
          if (error !== null || !Array.isArray(data)) {
            return Effect.fail(new WorkspaceAccessUnavailable())
          }
          if (data.length === 0) {
            return Effect.fail(new WorkspaceAccessDenied({ workspaceId }))
          }
          if (
            data.length !== 1 ||
            !isRecord(data[0]) ||
            !exactKeys(data[0], ["role"]) ||
            !["owner", "admin", "member", "viewer"].includes(data[0]["role"] as string)
          ) {
            return Effect.fail(new WorkspaceAccessUnavailable())
          }
          return Effect.succeed({
            workspaceId,
            role: data[0]["role"] as "owner" | "admin" | "member" | "viewer",
          })
        }),
      ),
  }

  const ledger: LedgerPortService = {
    listAccounts: (input: ListAccountsPortInput) =>
      Effect.gen(function* () {
        const cursor = yield* decodeAccountCursor(input.page.pageToken, input.workspaceId, config.pageTokenHmacKey)
        const base = client
          .from("accounts")
          .select("id,workspace_id,name,currency,account_type,created_at")
          .eq("workspace_id", input.workspaceId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
        const response = cursor === undefined
          ? base.limit(input.page.pageSize + 1)
          : base
            .or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)
            .limit(input.page.pageSize + 1)
        const rows = yield* mapRows(yield* query(() => response), (row) => readAccount(row, input.workspaceId))
        const page = rows.slice(0, input.page.pageSize)
        const last = page.at(-1)
        return {
          accounts: page.map((row) => row.account),
          ...(rows.length > input.page.pageSize && last !== undefined
            ? {
              nextPageToken: encodePageToken(
                { v: 1, r: "accounts", w: input.workspaceId, o: last.cursor },
                config.pageTokenHmacKey,
              ),
            }
            : {}),
        }
      }),
    getAccount: (input: GetAccountPortInput): Effect.Effect<LedgerAccount, LedgerNotFound | LedgerUnavailable> =>
      query(() =>
        client
          .from("accounts")
          .select("id,workspace_id,name,currency,account_type,created_at")
          .eq("workspace_id", input.workspaceId)
          .eq("id", input.accountId)
          .maybeSingle(),
      ).pipe(
        Effect.flatMap((row): Effect.Effect<LedgerAccount, LedgerNotFound | LedgerUnavailable> => row === null
          ? Effect.fail(new LedgerNotFound({ resource: "account", id: input.accountId }))
          : Effect.try({
            try: () => readAccount(row, input.workspaceId).account,
            catch: unavailable,
          })),
      ),
    listTransactions: (input: ListTransactionsPortInput) =>
      Effect.gen(function* () {
        const cursor = yield* decodeTransactionCursor(
          input.page.pageToken,
          input.workspaceId,
          input.accountId,
          config.pageTokenHmacKey,
        )
        const base = client
          .from("transactions")
          .select("id,workspace_id,account_id,amount_minor::text,currency,booking_date,value_date,raw_description,merchant_name,status")
          .eq("workspace_id", input.workspaceId)
          .eq("account_id", input.accountId)
          .order("booking_date", { ascending: false })
          .order("id", { ascending: false })
        const response = cursor === undefined
          ? base.limit(input.page.pageSize + 1)
          : base
            .or(`booking_date.lt.${cursor.bookingDate},and(booking_date.eq.${cursor.bookingDate},id.lt.${cursor.id})`)
            .limit(input.page.pageSize + 1)
        const rows = yield* mapRows(yield* query(() => response), (row) => readTransaction(row, input.workspaceId))
        const page = rows.slice(0, input.page.pageSize)
        const last = page.at(-1)
        return {
          transactions: page.map((row) => row.transaction),
          ...(rows.length > input.page.pageSize && last !== undefined
            ? {
              nextPageToken: encodePageToken(
                { v: 1, r: "transactions", w: input.workspaceId, a: input.accountId, o: last.cursor },
                config.pageTokenHmacKey,
              ),
            }
            : {}),
        }
      }),
    getTransaction: (input: GetTransactionPortInput): Effect.Effect<LedgerTransaction, LedgerNotFound | LedgerUnavailable> =>
      query(() =>
        client
          .from("transactions")
          .select("id,workspace_id,account_id,amount_minor::text,currency,booking_date,value_date,raw_description,merchant_name,status")
          .eq("workspace_id", input.workspaceId)
          .eq("id", input.transactionId)
          .maybeSingle(),
      ).pipe(
        Effect.flatMap((row): Effect.Effect<LedgerTransaction, LedgerNotFound | LedgerUnavailable> => row === null
          ? Effect.fail(new LedgerNotFound({ resource: "transaction", id: input.transactionId }))
          : Effect.try({
            try: () => readTransaction(row, input.workspaceId).transaction,
            catch: unavailable,
          })),
      ),
  }

  return Layer.mergeAll(
    Layer.succeed(WorkspaceAccess, workspaceAccess),
    Layer.succeed(LedgerPort, ledger),
  )
}
