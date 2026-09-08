import { generateKeyPairSync } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { TenantId } from "../../packages/core/src/domain/tenant.ts"
import { nowInstant } from "../../packages/core/src/domain/time.ts"
import { EmbeddingProvider } from "../../packages/core/src/ports/embedding-provider.ts"
import { BankProvider } from "../../packages/core/src/ports/bank-provider.ts"
import { Db } from "../../packages/db/src/client.ts"
import { LexicalIndexLive } from "../../packages/db/src/lexical/lexical-index.ts"
import { VectorIndexLive } from "../../packages/db/src/vector-index.ts"
import { tenants } from "../../packages/db/src/schema/index.ts"
import { makeEnableBankingService } from "../../packages/enablebanking/src/client.ts"
import { BankIngestLive } from "../../packages/enablebanking/src/ingest.ts"
import { HybridSearchLive } from "../../packages/search/src/hybrid.ts"
import { connectInProcess } from "../../packages/mcp/src/testing.ts"
import { makeTestLayers, runTest } from "../setup.ts"

const TID = Schema.decodeUnknownSync(TenantId)("t-mcp-bank")
const TIDB = Schema.decodeUnknownSync(TenantId)("t-mcp-bank-b")
const TEST_PEM = (() => {
  const exported = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  })
  return typeof exported === "string" ? exported : exported.toString()
})()

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

describe("MCP bank tools", () => {
  let server: Server
  let baseUrl = ""

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1")
        await readBody(req)
        const method = req.method ?? ""
        const pathname = url.pathname
        let payload: unknown = { error: "not found" }
        let status = 404
        if (method === "POST" && pathname === "/auth") {
          status = 200
          payload = { url: "https://bank.example/authorize" }
        } else if (method === "POST" && pathname === "/sessions") {
          status = 200
          payload = {
            session_id: "sess-mcp-1",
            accounts: [{ uid: "acc-mcp-1", name: "Current", currency: "EUR", cash_account_type: "CACC" }],
          }
        } else if (method === "GET" && pathname === "/sessions/sess-mcp-1") {
          status = 200
          payload = { accounts: ["acc-mcp-1"] }
        } else if (method === "GET" && pathname === "/accounts/acc-mcp-1/details") {
          status = 200
          payload = {
            uid: "acc-mcp-1",
            name: "Current",
            currency: "EUR",
            cash_account_type: "CACC",
          }
        } else if (method === "GET" && pathname === "/accounts/acc-mcp-1/transactions") {
          status = 200
          payload = {
            transactions: [
              {
                transaction_id: "tx-mcp-bank-1",
                booking_date: "2026-09-01",
                credit_debit_indicator: "DBIT",
                status: "BOOK",
                transaction_amount: { amount: "1.23", currency: "EUR" },
                remittance_information: ["Coffee"],
              },
            ],
          }
        } else if (method === "DELETE" && pathname === "/sessions/sess-mcp-1") {
          status = 204
          res.writeHead(status)
          res.end()
          return
        }
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(payload))
      })()
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  const makeLayers = (sqlite: Database) => {
    const base = makeTestLayers(sqlite)
    const cannedEmbeddings = Layer.succeed(
      EmbeddingProvider,
      EmbeddingProvider.of({
        embedDocuments: () => Effect.succeed([]),
        embedQuery: () =>
          Effect.succeed({
            model: "voyage-finance-2",
            dims: 1024,
            vector: new Float32Array(1024),
          }),
      }),
    )
    const indexes = Layer.mergeAll(
      Layer.provide(VectorIndexLive, base),
      Layer.provide(LexicalIndexLive, base),
    )
    const hybrid = Layer.provide(HybridSearchLive, Layer.mergeAll(base, indexes, cannedEmbeddings))
    const bank = Layer.succeed(
      BankProvider,
      makeEnableBankingService({
        baseUrl,
        applicationId: "app-mcp-bank",
        privateKeyPem: TEST_PEM,
        psuIp: "203.0.113.10",
        psuUserAgent: "finch-test",
      }),
    )
    const ingest = Layer.provide(BankIngestLive, Layer.mergeAll(base, bank))
    return Layer.mergeAll(base, indexes, cannedEmbeddings, hybrid, bank, ingest)
  }

  it("binds auth state to tenant, syncs booked txs, and deletes the session", async () => {
    const sqlite = new Database(":memory:")
    try {
      const layer = makeLayers(sqlite)
      await runTest(
        layer,
        Effect.gen(function* () {
          const { db } = yield* Db
          yield* Effect.sync(() =>
            db.insert(tenants).values({ id: TID, name: TID, createdAt: nowInstant() }).run(),
          )
          yield* Effect.sync(() =>
            db.insert(tenants).values({ id: TIDB, name: TIDB, createdAt: nowInstant() }).run(),
          )
        }),
      )
      const mcp = await connectInProcess(layer)
      try {
        const started = await mcp.callTool("start_bank_auth", {
          tenantId: TID,
          aspspName: "Demo Bank",
          aspspCountry: "FI",
          redirectUrl: "https://finch.example/callback",
          state: "state-mcp-1",
        })
        expect(started.isError).not.toBe(true)
        expect(JSON.parse(started.text)).toEqual({ url: "https://bank.example/authorize" })

        const wrongTenant = await mcp.callTool("authorize_bank_session", {
          tenantId: TIDB,
          code: "auth-code",
          state: "state-mcp-1",
        })
        expect(wrongTenant.isError).toBe(true)
        expect(JSON.parse(wrongTenant.text)).toEqual({ error: "TenantMismatch" })

        const authorized = await mcp.callTool("authorize_bank_session", {
          tenantId: TID,
          code: "auth-code",
          state: "state-mcp-1",
        })
        expect(authorized.isError).not.toBe(true)
        expect(JSON.parse(authorized.text).sessionId).toBe("sess-mcp-1")

        const synced = await mcp.callTool("sync_bank", { tenantId: TID })
        expect(synced.isError).not.toBe(true)
        const stats = JSON.parse(synced.text) as { transactionsObserved: number }
        expect(stats.transactionsObserved).toBe(1)

        const deleted = await mcp.callTool("delete_bank_session", { tenantId: TID })
        expect(deleted.isError).not.toBe(true)
        expect(JSON.parse(deleted.text)).toEqual({ deleted: true })
      } finally {
        await mcp.close()
      }
    } finally {
      sqlite.close()
    }
  })
})
