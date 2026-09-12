import { create } from "@bufbuild/protobuf"
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import {
  GetAccountResponseSchema,
  GetTransactionResponseSchema,
  LedgerAccountSchema,
  LedgerService,
  LedgerTransactionSchema,
  ListAccountsResponseSchema,
  ListTransactionsResponseSchema,
  MoneySchema,
  PageResponseSchema,
} from "@finch/contracts"
import {
  LedgerNotFound,
  LedgerPort,
  LedgerUnavailable,
  ValidationFailed,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceAccessUnavailable,
  getAccount,
  getTransaction,
  listAccounts,
  listTransactions,
  type LedgerAccount as LedgerAccountRecord,
  type LedgerMoney,
  type LedgerTransaction as LedgerTransactionRecord,
} from "@finch/lib"
import { requireConnectPrincipal, type ConnectPrincipalResolver } from "./principal.ts"

const toMoney = (money: LedgerMoney) =>
  create(MoneySchema, { minorUnits: money.minorUnits, currency: money.currency })

const toLedgerAccount = (account: LedgerAccountRecord) =>
  create(LedgerAccountSchema, {
    id: account.id,
    name: account.name,
    currency: account.currency,
    ...(account.availableBalance === undefined ? {} : { availableBalance: toMoney(account.availableBalance) }),
    ...(account.currentBalance === undefined ? {} : { currentBalance: toMoney(account.currentBalance) }),
    ...(account.iban === undefined ? {} : { iban: account.iban }),
    accountType: account.accountType,
  })

const toLedgerTransaction = (transaction: LedgerTransactionRecord) =>
  create(LedgerTransactionSchema, {
    id: transaction.id,
    accountId: transaction.accountId,
    amount: toMoney(transaction.amount),
    bookingDate: transaction.bookingDate,
    ...(transaction.valueDate === undefined ? {} : { valueDate: transaction.valueDate }),
    description: transaction.description,
    ...(transaction.merchant === undefined ? {} : { merchant: transaction.merchant }),
    status: transaction.status,
  })

const toPage = (nextPageToken: string | undefined) =>
  create(PageResponseSchema, { nextPageToken: nextPageToken ?? "" })

const toPageInput = (page: { readonly pageSize: number; readonly pageToken: string } | undefined) =>
  page === undefined ? undefined : { pageSize: page.pageSize, pageToken: page.pageToken }

export const toLedgerConnectError = (cause: unknown): ConnectError => {
  if (cause instanceof ConnectError) {
    return cause
  }
  if (cause instanceof WorkspaceAccessDenied) {
    return new ConnectError("workspace access denied", Code.PermissionDenied)
  }
  if (cause instanceof WorkspaceAccessUnavailable) {
    return new ConnectError("workspace access unavailable", Code.Unavailable)
  }
  if (cause instanceof ValidationFailed) {
    return new ConnectError(`invalid ledger request: ${cause.issues.join("; ")}`, Code.InvalidArgument)
  }
  if (cause instanceof LedgerNotFound) {
    return new ConnectError(`${cause.resource} not found`, Code.NotFound)
  }
  if (cause instanceof LedgerUnavailable) {
    return new ConnectError("ledger unavailable", Code.Unavailable)
  }
  return new ConnectError("ledger failed", Code.Internal)
}

export interface LedgerServiceDependencies<E> {
  readonly principalResolver: ConnectPrincipalResolver
  readonly layer: Layer.Layer<LedgerPort | WorkspaceAccess, E>
}

export interface LedgerServiceHandle {
  readonly impl: ServiceImpl<typeof LedgerService>
  readonly dispose: () => Promise<void>
}

type LedgerUseCaseError =
  | LedgerNotFound
  | LedgerUnavailable
  | ValidationFailed
  | WorkspaceAccessDenied
  | WorkspaceAccessUnavailable

export const makeLedgerService = <E>(
  dependencies: LedgerServiceDependencies<E>,
  runtime: ManagedRuntime.ManagedRuntime<LedgerPort | WorkspaceAccess, E> = ManagedRuntime.make(dependencies.layer),
): LedgerServiceHandle => {
  const run = <A>(effect: Effect.Effect<A, LedgerUseCaseError, LedgerPort | WorkspaceAccess>) =>
    runtime.runPromiseExit(effect).then((exit) => {
      if (Exit.isSuccess(exit)) {
        return exit.value
      }
      throw toLedgerConnectError(Cause.squash(exit.cause))
    })

  return {
    impl: {
      listAccounts: async (request, context) => {
        const principal = await requireConnectPrincipal(dependencies.principalResolver, context)
        const result = await run(listAccounts(principal, {
          workspaceId: request.workspaceId,
          page: toPageInput(request.page),
        }))
        return create(ListAccountsResponseSchema, {
          accounts: result.accounts.map(toLedgerAccount),
          page: toPage(result.nextPageToken),
        })
      },
      getAccount: async (request, context) => {
        const principal = await requireConnectPrincipal(dependencies.principalResolver, context)
        const account = await run(getAccount(principal, {
          workspaceId: request.workspaceId,
          accountId: request.accountId,
        }))
        return create(GetAccountResponseSchema, { account: toLedgerAccount(account) })
      },
      listTransactions: async (request, context) => {
        const principal = await requireConnectPrincipal(dependencies.principalResolver, context)
        const result = await run(listTransactions(principal, {
          workspaceId: request.workspaceId,
          accountId: request.accountId,
          page: toPageInput(request.page),
        }))
        return create(ListTransactionsResponseSchema, {
          transactions: result.transactions.map(toLedgerTransaction),
          page: toPage(result.nextPageToken),
        })
      },
      getTransaction: async (request, context) => {
        const principal = await requireConnectPrincipal(dependencies.principalResolver, context)
        const transaction = await run(getTransaction(principal, {
          workspaceId: request.workspaceId,
          transactionId: request.transactionId,
        }))
        return create(GetTransactionResponseSchema, { transaction: toLedgerTransaction(transaction) })
      },
    },
    dispose: () => runtime.dispose(),
  }
}
