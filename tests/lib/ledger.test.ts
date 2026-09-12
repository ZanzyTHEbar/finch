import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  LedgerPort,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceId,
  getAccount,
  getTransaction,
  listAccounts,
  listTransactions,
  type LedgerAccount,
  type LedgerTransaction,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const authorizedWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("bbbbbbbb-0000-4000-8000-000000000002")
const principal: PrincipalContext = {
  issuer: "https://id.example.test",
  subjectId: "subject-1",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

const useCase = (
  workspaceAccess: WorkspaceAccess,
  ledgerPort: LedgerPort,
  input: Parameters<typeof listAccounts>[1],
) =>
  listAccounts(principal, input).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(WorkspaceAccess, workspaceAccess),
        Layer.succeed(LedgerPort, ledgerPort),
      ),
    ),
  )

describe("ledger read use cases", () => {
  it("allows provider records to omit unavailable balances, IBANs, and value dates", () => {
    const account = {
      id: "cccccccc-0000-4000-8000-000000000003",
      name: "Daily account",
      currency: "EUR",
      accountType: "CACC",
    } satisfies LedgerAccount
    const transaction = {
      id: "dddddddd-0000-4000-8000-000000000004",
      accountId: "cccccccc-0000-4000-8000-000000000003",
      amount: { minorUnits: "-266", currency: "EUR" },
      bookingDate: "2026-09-10",
      description: "Groceries",
      status: "booked",
    } satisfies LedgerTransaction

    expect(account).not.toHaveProperty("availableBalance")
    expect(account).not.toHaveProperty("currentBalance")
    expect(account).not.toHaveProperty("iban")
    expect(transaction).not.toHaveProperty("valueDate")
    expect(transaction).not.toHaveProperty("merchant")
  })

  it("authorizes the requested workspace before sending the normalized page to the port", async () => {
    const calls: string[] = []
    const workspaceAccess: WorkspaceAccess = {
      authorize: (receivedPrincipal, requestedWorkspace) =>
        Effect.sync(() => {
          calls.push("authorize")
          expect(receivedPrincipal).toBe(principal)
          expect(requestedWorkspace).toBe(workspaceId)
          return { workspaceId: authorizedWorkspaceId, role: "member" as const }
        }),
    }
    const ledgerPort: LedgerPort = {
      listAccounts: (input) =>
        Effect.sync(() => {
          calls.push("listAccounts")
          expect(input).toEqual({
            workspaceId: authorizedWorkspaceId,
            page: { pageSize: 50, pageToken: "opaque-page-token" },
          })
          return { accounts: [], nextPageToken: "next-page-token" }
        }),
      getAccount: () => Effect.die("not used"),
      listTransactions: () => Effect.die("not used"),
      getTransaction: () => Effect.die("not used"),
    }

    await expect(
      Effect.runPromise(useCase(workspaceAccess, ledgerPort, {
        workspaceId,
        page: { pageToken: "opaque-page-token" },
      })),
    ).resolves.toEqual({ accounts: [], nextPageToken: "next-page-token" })
    expect(calls).toEqual(["authorize", "listAccounts"])
  })

  it("rejects invalid page sizes before authorization or port work", async () => {
    let authorizations = 0
    let portCalls = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: () =>
        Effect.sync(() => {
          authorizations += 1
          return { workspaceId, role: "member" as const }
        }),
    }
    const ledgerPort: LedgerPort = {
      listAccounts: () =>
        Effect.sync(() => {
          portCalls += 1
          return { accounts: [] }
        }),
      getAccount: () => Effect.die("not used"),
      listTransactions: () => Effect.die("not used"),
      getTransaction: () => Effect.die("not used"),
    }

    for (const pageSize of [-1, 101, Number.POSITIVE_INFINITY]) {
      const exit = await Effect.runPromiseExit(
        useCase(workspaceAccess, ledgerPort, { workspaceId, page: { pageSize } }),
      )
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } },
      })
    }
    expect(authorizations).toBe(0)
    expect(portCalls).toBe(0)
  })

  it("rejects non-UUID account and transaction ids before authorization or port work", async () => {
    let authorizations = 0
    let portCalls = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: () =>
        Effect.sync(() => {
          authorizations += 1
          return { workspaceId, role: "member" as const }
        }),
    }
    const ledgerPort: LedgerPort = {
      listAccounts: () => Effect.die("not used"),
      getAccount: () => Effect.sync(() => {
        portCalls += 1
        return { id: "unused", name: "unused", currency: "EUR", accountType: "checking" }
      }),
      listTransactions: () => Effect.sync(() => {
        portCalls += 1
        return { transactions: [] }
      }),
      getTransaction: () => Effect.sync(() => {
        portCalls += 1
        return {
          id: "unused",
          accountId: "unused",
          amount: { minorUnits: "1", currency: "EUR" },
          bookingDate: "2026-09-10",
          description: "unused",
          status: "booked",
        }
      }),
    }
    const layer = Layer.mergeAll(
      Layer.succeed(WorkspaceAccess, workspaceAccess),
      Layer.succeed(LedgerPort, ledgerPort),
    )

    for (const effect of [
      getAccount(principal, { workspaceId, accountId: "not-a-uuid" }),
      listTransactions(principal, { workspaceId, accountId: "not-a-uuid" }),
      getTransaction(principal, { workspaceId, transactionId: "not-a-uuid" }),
    ]) {
      const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(layer)))
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } } })
    }
    expect(authorizations).toBe(0)
    expect(portCalls).toBe(0)
  })

  it("does not call the ledger port when workspace access is denied", async () => {
    let portCalls = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) =>
        Effect.fail(new WorkspaceAccessDenied({ workspaceId: requestedWorkspace })),
    }
    const ledgerPort: LedgerPort = {
      listAccounts: () =>
        Effect.sync(() => {
          portCalls += 1
          return { accounts: [] }
        }),
      getAccount: () => Effect.die("not used"),
      listTransactions: () => Effect.die("not used"),
      getTransaction: () => Effect.die("not used"),
    }

    const exit = await Effect.runPromiseExit(useCase(workspaceAccess, ledgerPort, { workspaceId }))
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail", error: { _tag: "WorkspaceAccessDenied", workspaceId } },
    })
    expect(portCalls).toBe(0)
  })
})
