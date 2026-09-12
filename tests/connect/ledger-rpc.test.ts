import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Code, ConnectError, createClient } from "@connectrpc/connect"
import { connectNodeAdapter, createConnectTransport } from "@connectrpc/connect-node"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { LedgerService } from "../../packages/contracts/src/index.ts"
import {
  LedgerNotFound,
  LedgerPort,
  LedgerUnavailable,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceAccessUnavailable,
  WorkspaceId,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"
import { makeLedgerService, type ConnectPrincipalResolver } from "../../packages/connect/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const accountId = "bbbbbbbb-0000-4000-8000-000000000002"
const transactionId = "cccccccc-0000-4000-8000-000000000003"
const principal: PrincipalContext = {
  issuer: "https://id.example.test",
  subjectId: "subject-1",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

const trustedResolver: ConnectPrincipalResolver = { resolve: () => principal }

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )

const serve = async (
  principalResolver: ConnectPrincipalResolver,
  workspaceAccess: WorkspaceAccess,
  ledgerPort: LedgerPort,
) => {
  const handle = makeLedgerService({
    principalResolver,
    layer: Layer.mergeAll(
      Layer.succeed(WorkspaceAccess, workspaceAccess),
      Layer.succeed(LedgerPort, ledgerPort),
    ),
  })
  const server = createServer(
    connectNodeAdapter({ routes: (router) => router.service(LedgerService, handle.impl) }),
  )
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  return {
    client: createClient(
      LedgerService,
      createConnectTransport({ baseUrl: `http://127.0.0.1:${address.port}`, httpVersion: "1.1" }),
    ),
    close: async () => {
      await closeServer(server)
      await handle.dispose()
    },
  }
}

const deterministicLedgerPort = (overrides: Partial<LedgerPort>): LedgerPort => ({
  listAccounts: () => Effect.die("not used"),
  getAccount: () => Effect.die("not used"),
  listTransactions: () => Effect.die("not used"),
  getTransaction: () => Effect.die("not used"),
  ...overrides,
})

describe("canonical LedgerService RPC", () => {
  it("uses finch.v1 over HTTP and round-trips opaque pagination through the injected port", async () => {
    const pages: unknown[] = []
    const account = {
      id: accountId,
      name: "Daily account",
      currency: "EUR",
      availableBalance: { minorUnits: "1234", currency: "EUR" },
      currentBalance: { minorUnits: "1500", currency: "EUR" },
      iban: "PT50000201231234567890154",
      accountType: "CACC",
    }
    const transaction = {
      id: transactionId,
      accountId,
      amount: { minorUnits: "-266", currency: "EUR" },
      bookingDate: "2026-09-10",
      valueDate: "2026-09-10",
      description: "Groceries",
      merchant: "Continente",
      status: "booked",
    }
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) => Effect.succeed({ workspaceId: requestedWorkspace, role: "member" }),
    }
    const ledgerPort = deterministicLedgerPort({
      listAccounts: (input) =>
        Effect.sync(() => {
          pages.push(input.page)
          return input.page.pageToken === undefined
            ? {
              accounts: [account],
              nextPageToken: "opaque-next-token",
            }
            : { accounts: [] }
        }),
      getAccount: () => Effect.succeed(account),
      listTransactions: () => Effect.succeed({ transactions: [transaction] }),
      getTransaction: () => Effect.succeed(transaction),
    })
    const { client, close } = await serve(trustedResolver, workspaceAccess, ledgerPort)
    try {
      expect(LedgerService.typeName).toBe("finch.v1.LedgerService")
      const first = await client.listAccounts({ workspaceId, page: { pageSize: 1 } })
      expect(first).toMatchObject({
        accounts: [
          {
            id: accountId,
            name: "Daily account",
            currency: "EUR",
            availableBalance: { minorUnits: "1234", currency: "EUR" },
            currentBalance: { minorUnits: "1500", currency: "EUR" },
            iban: "PT50000201231234567890154",
            accountType: "CACC",
          },
        ],
        page: { nextPageToken: "opaque-next-token" },
      })
      await client.listAccounts({
        workspaceId,
        page: { pageSize: 1, pageToken: first.page?.nextPageToken },
      })
      const accountResponse = await client.getAccount({ workspaceId, accountId })
      expect(accountResponse.account).toMatchObject({ id: accountId, accountType: "CACC" })
      const transactions = await client.listTransactions({ workspaceId, accountId })
      expect(transactions.transactions).toMatchObject([{ id: transactionId, merchant: "Continente" }])
      const transactionResponse = await client.getTransaction({ workspaceId, transactionId })
      expect(transactionResponse.transaction).toMatchObject({
        id: transactionId,
        accountId,
        amount: { minorUnits: "-266", currency: "EUR" },
        bookingDate: "2026-09-10",
        valueDate: "2026-09-10",
        description: "Groceries",
        merchant: "Continente",
        status: "booked",
      })
      expect(pages).toEqual([
        { pageSize: 1 },
        { pageSize: 1, pageToken: "opaque-next-token" },
      ])
    } finally {
      await close()
    }
  })

  it("preserves absent provider account and transaction details", async () => {
    const account = {
      id: accountId,
      name: "Daily account",
      currency: "EUR",
      accountType: "CACC",
    }
    const transaction = {
      id: transactionId,
      accountId,
      amount: { minorUnits: "-266", currency: "EUR" },
      bookingDate: "2026-09-10",
      description: "Groceries",
      status: "booked",
    }
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) => Effect.succeed({ workspaceId: requestedWorkspace, role: "member" }),
    }
    const ledgerPort = deterministicLedgerPort({
      listAccounts: () => Effect.succeed({ accounts: [account] }),
      getAccount: () => Effect.succeed(account),
      listTransactions: () => Effect.succeed({ transactions: [transaction] }),
      getTransaction: () => Effect.succeed(transaction),
    })
    const { client, close } = await serve(trustedResolver, workspaceAccess, ledgerPort)
    try {
      const accounts = await client.listAccounts({ workspaceId })
      expect(accounts.accounts[0]?.availableBalance).toBeUndefined()
      expect(accounts.accounts[0]?.currentBalance).toBeUndefined()
      expect(accounts.accounts[0]?.iban).toBeUndefined()

      const transactions = await client.listTransactions({ workspaceId, accountId })
      expect(transactions.transactions[0]?.valueDate).toBeUndefined()
      expect(transactions.transactions[0]?.merchant).toBeUndefined()
    } finally {
      await close()
    }
  })

  it("maps missing principals to Unauthenticated without authorization or port work", async () => {
    let authorizations = 0
    let portCalls = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: () =>
        Effect.sync(() => {
          authorizations += 1
          return { workspaceId, role: "member" as const }
        }),
    }
    const ledgerPort = deterministicLedgerPort({
      listAccounts: () =>
        Effect.sync(() => {
          portCalls += 1
          return { accounts: [] }
        }),
    })
    const { client, close } = await serve({ resolve: () => undefined }, workspaceAccess, ledgerPort)
    try {
      const failure = await client.listAccounts({ workspaceId }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(ConnectError)
      expect((failure as ConnectError).code).toBe(Code.Unauthenticated)
      expect(authorizations).toBe(0)
      expect(portCalls).toBe(0)
    } finally {
      await close()
    }
  })

  it("maps denied workspace access to PermissionDenied without ledger port work", async () => {
    let portCalls = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) =>
        Effect.fail(new WorkspaceAccessDenied({ workspaceId: requestedWorkspace })),
    }
    const ledgerPort = deterministicLedgerPort({
      listAccounts: () =>
        Effect.sync(() => {
          portCalls += 1
          return { accounts: [] }
        }),
    })
    const { client, close } = await serve(trustedResolver, workspaceAccess, ledgerPort)
    try {
      const failure = await client.listAccounts({ workspaceId }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(ConnectError)
      expect((failure as ConnectError).code).toBe(Code.PermissionDenied)
      expect(portCalls).toBe(0)
    } finally {
      await close()
    }
  })

  it("maps unavailable workspace access to Unavailable without ledger port work", async () => {
    let portCalls = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: () => Effect.fail(new WorkspaceAccessUnavailable()),
    }
    const ledgerPort = deterministicLedgerPort({
      listAccounts: () =>
        Effect.sync(() => {
          portCalls += 1
          return { accounts: [] }
        }),
    })
    const { client, close } = await serve(trustedResolver, workspaceAccess, ledgerPort)
    try {
      const failure = await client.listAccounts({ workspaceId }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(ConnectError)
      expect((failure as ConnectError).code).toBe(Code.Unavailable)
      expect(portCalls).toBe(0)
    } finally {
      await close()
    }
  })

  it("maps invalid, missing, and unavailable ledger results to canonical Connect errors", async () => {
    let portCalls = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) => Effect.succeed({ workspaceId: requestedWorkspace, role: "member" }),
    }
    const ledgerPort = deterministicLedgerPort({
      listAccounts: () =>
        Effect.sync(() => {
          portCalls += 1
          return { accounts: [] }
        }),
      getAccount: (input) => Effect.fail(new LedgerNotFound({ resource: "account", id: input.accountId })),
      getTransaction: () => Effect.fail(new LedgerUnavailable()),
    })
    const { client, close } = await serve(trustedResolver, workspaceAccess, ledgerPort)
    try {
      const invalid = await client.listAccounts({ workspaceId, page: { pageSize: 101 } }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(invalid).toBeInstanceOf(ConnectError)
      expect((invalid as ConnectError).code).toBe(Code.InvalidArgument)
      expect(portCalls).toBe(0)

      const missing = await client.getAccount({ workspaceId, accountId: "dddddddd-0000-4000-8000-000000000004" }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(missing).toBeInstanceOf(ConnectError)
      expect((missing as ConnectError).code).toBe(Code.NotFound)

      const unavailable = await client.getTransaction({ workspaceId, transactionId }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(unavailable).toBeInstanceOf(ConnectError)
      expect((unavailable as ConnectError).code).toBe(Code.Unavailable)
    } finally {
      await close()
    }
  })
})
