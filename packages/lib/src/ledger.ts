import { Context, Data, Effect, Schema } from "effect"
import { ValidationFailed, WorkspaceId, type WorkspaceId as WorkspaceIdT } from "@finch/core/domain"
import { type PrincipalContext, WorkspaceAccess } from "./foundation.ts"

export interface LedgerMoney {
  readonly minorUnits: string
  readonly currency: string
}

export interface LedgerAccount {
  readonly id: string
  readonly name: string
  readonly currency: string
  readonly availableBalance?: LedgerMoney
  readonly currentBalance?: LedgerMoney
  readonly iban?: string
  readonly accountType: string
}

export interface LedgerTransaction {
  readonly id: string
  readonly accountId: string
  readonly amount: LedgerMoney
  readonly bookingDate: string
  readonly valueDate?: string
  readonly description: string
  readonly merchant?: string
  readonly status: string
}

export interface LedgerPageRequest {
  readonly pageSize?: number
  readonly pageToken?: string
}

export interface LedgerPage {
  readonly pageSize: number
  readonly pageToken?: string
}

export interface ListAccountsPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly page: LedgerPage
}

export interface GetAccountPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly accountId: string
}

export interface ListTransactionsPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly accountId: string
  readonly page: LedgerPage
}

export interface GetTransactionPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly transactionId: string
}

export interface ListAccountsResult {
  readonly accounts: readonly LedgerAccount[]
  readonly nextPageToken?: string
}

export interface ListTransactionsResult {
  readonly transactions: readonly LedgerTransaction[]
  readonly nextPageToken?: string
}

export class LedgerNotFound extends Data.TaggedError("LedgerNotFound")<{
  readonly resource: "account" | "transaction"
  readonly id: string
}> {}

export class LedgerUnavailable extends Data.TaggedError("LedgerUnavailable")<Record<never, never>> {}

export type LedgerPortError = LedgerNotFound | LedgerUnavailable
export type LedgerListError = ValidationFailed | LedgerUnavailable

export class LedgerPort extends Context.Tag("LedgerPort")<
  LedgerPort,
  {
    readonly listAccounts: (input: ListAccountsPortInput) => Effect.Effect<ListAccountsResult, LedgerListError>
    readonly getAccount: (input: GetAccountPortInput) => Effect.Effect<LedgerAccount, LedgerPortError>
    readonly listTransactions: (
      input: ListTransactionsPortInput,
    ) => Effect.Effect<ListTransactionsResult, LedgerListError>
    readonly getTransaction: (input: GetTransactionPortInput) => Effect.Effect<LedgerTransaction, LedgerPortError>
  }
>() {}

export interface ListAccountsInput {
  readonly workspaceId: unknown
  readonly page?: LedgerPageRequest
}

export interface GetAccountInput {
  readonly workspaceId: unknown
  readonly accountId: unknown
}

export interface ListTransactionsInput {
  readonly workspaceId: unknown
  readonly accountId: unknown
  readonly page?: LedgerPageRequest
}

export interface GetTransactionInput {
  readonly workspaceId: unknown
  readonly transactionId: unknown
}

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

const decodeWorkspaceId = (scope: unknown) =>
  Schema.decodeUnknown(WorkspaceId)(scope).pipe(
    Effect.mapError(
      () => new ValidationFailed({ issues: ["workspace_id must be a UUID"] }),
    ),
  )

const decodeIdentifier = (value: unknown, field: string) =>
  Schema.decodeUnknown(Schema.UUID)(value).pipe(
    Effect.mapError(() => new ValidationFailed({ issues: [`${field} must be a UUID`] })),
  )

const decodePage = (input: unknown): Effect.Effect<LedgerPage, ValidationFailed> => {
  if (input === undefined) {
    return Effect.succeed({ pageSize: DEFAULT_PAGE_SIZE })
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Effect.fail(new ValidationFailed({ issues: ["page must be an object"] }))
  }

  const page = input as { readonly pageSize?: unknown; readonly pageToken?: unknown }
  const pageSize = page.pageSize === undefined || page.pageSize === 0 ? DEFAULT_PAGE_SIZE : page.pageSize
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
    return Effect.fail(
      new ValidationFailed({
        issues: [`pageSize must be a positive integer no greater than ${MAX_PAGE_SIZE}, got ${String(page.pageSize)}`],
      }),
    )
  }
  if (page.pageToken !== undefined && typeof page.pageToken !== "string") {
    return Effect.fail(new ValidationFailed({ issues: ["pageToken must be a string"] }))
  }
  return Effect.succeed({
    pageSize,
    ...(page.pageToken === undefined || page.pageToken === "" ? {} : { pageToken: page.pageToken }),
  })
}

export const listAccounts = (principal: PrincipalContext, input: ListAccountsInput) =>
  Effect.gen(function* () {
    const page = yield* decodePage(input.page)
    const workspaceId = yield* decodeWorkspaceId(input.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    const ledger = yield* LedgerPort
    return yield* ledger.listAccounts({ workspaceId: authorized.workspaceId, page })
  })

export const getAccount = (principal: PrincipalContext, input: GetAccountInput) =>
  Effect.gen(function* () {
    const accountId = yield* decodeIdentifier(input.accountId, "accountId")
    const workspaceId = yield* decodeWorkspaceId(input.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    const ledger = yield* LedgerPort
    return yield* ledger.getAccount({ workspaceId: authorized.workspaceId, accountId })
  })

export const listTransactions = (principal: PrincipalContext, input: ListTransactionsInput) =>
  Effect.gen(function* () {
    const accountId = yield* decodeIdentifier(input.accountId, "accountId")
    const page = yield* decodePage(input.page)
    const workspaceId = yield* decodeWorkspaceId(input.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    const ledger = yield* LedgerPort
    return yield* ledger.listTransactions({ workspaceId: authorized.workspaceId, accountId, page })
  })

export const getTransaction = (principal: PrincipalContext, input: GetTransactionInput) =>
  Effect.gen(function* () {
    const transactionId = yield* decodeIdentifier(input.transactionId, "transactionId")
    const workspaceId = yield* decodeWorkspaceId(input.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    const ledger = yield* LedgerPort
    return yield* ledger.getTransaction({ workspaceId: authorized.workspaceId, transactionId })
  })
