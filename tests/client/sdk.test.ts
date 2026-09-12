import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { createFinchClient } from "../../packages/client/src/index.ts"
import { createConnectServer } from "../../packages/connect/src/main.ts"
import {
  LedgerPort,
  ReceiptPort,
  SearchPort,
  WorkspaceAccess,
  WorkspaceId,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const principal: PrincipalContext = {
  issuer: "https://id.example.test",
  subjectId: "subject-1",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )

describe("createFinchClient", () => {
  it("exposes only canonical search, ledger, and receipt clients", async () => {
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) => Effect.succeed({ workspaceId: requestedWorkspace, role: "member" }),
    }
    const searchPort: SearchPort = {
      search: () =>
        Effect.succeed({
          hits: [
            {
              entityId: "tx-1",
              entityType: "transaction",
              title: "transaction:tx-1",
              snippet: "",
              fusedScore: 1,
              sources: ["dense"],
            },
          ],
          diagnostics: { denseCandidates: 1, lexicalCandidates: 0, fusedCandidates: 1 },
        }),
    }
    const ledgerPort: LedgerPort = {
      listAccounts: () =>
        Effect.succeed({
          accounts: [
            {
                id: "bbbbbbbb-0000-4000-8000-000000000002",
              name: "Daily account",
              currency: "EUR",
              availableBalance: { minorUnits: "1234", currency: "EUR" },
              currentBalance: { minorUnits: "1234", currency: "EUR" },
              iban: "PT50000201231234567890154",
              accountType: "CACC",
            },
          ],
        }),
      getAccount: () => Effect.die("not used"),
      listTransactions: () => Effect.die("not used"),
      getTransaction: () => Effect.die("not used"),
    }
    const handle = createConnectServer({
      allowedOrigins: ["http://127.0.0.1:5173"],
      principalResolver: {
        resolve: (context) => {
          expect(context.requestHeader.get("authorization")).toBe("Bearer access-token")
          expect(context.requestHeader.get("x-finch-workspace")).toBe(workspaceId)
          return principal
        },
      },
      layer: Layer.mergeAll(
        Layer.succeed(WorkspaceAccess, workspaceAccess),
        Layer.succeed(SearchPort, searchPort),
        Layer.succeed(LedgerPort, ledgerPort),
        Layer.succeed(ReceiptPort, {
          listReceipts: () => Effect.succeed({ receipts: [] }),
          getReceipt: () => Effect.die("not used"),
          createReceiptUploadIntent: () => Effect.die("not used"),
          finalizeReceipt: () => Effect.die("not used"),
          getReceiptDownloadUrl: () => Effect.die("not used"),
        }),
      ),
    })
    const server = handle.server
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as AddressInfo
    try {
      const client = createFinchClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        bearerToken: "access-token",
        headers: { "x-finch-workspace": workspaceId },
      })
      const response = await client.search.searchFinance({ workspaceId, query: "groceries" })
      expect(response.hits[0]).toMatchObject({ entityId: "tx-1", entityType: "transaction" })
      const accounts = await client.ledger.listAccounts({ workspaceId })
      expect(accounts.accounts[0]).toMatchObject({ id: "bbbbbbbb-0000-4000-8000-000000000002", currency: "EUR" })
      const receipts = await client.receipts.listReceipts({ workspaceId })
      expect(receipts.receipts).toEqual([])
      expect(Object.keys(client).sort()).toEqual(["ledger", "receipts", "search"])
      expect(client).not.toHaveProperty("bank")
    } finally {
      await closeServer(server)
      await handle.dispose()
    }
  })
})
