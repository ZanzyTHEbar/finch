import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, Schema } from "effect"
import { exportPKCS8, generateKeyPair } from "jose"
import { BankProvider, BankSessionMissing, TenantId, nowInstant } from "../../packages/core/src/index.ts"
import { AccountRepository } from "../../packages/db/src/repositories/account.ts"
import { BankSessionRepository, BankSessionRepositoryLive } from "../../packages/db/src/repositories/bank-session.ts"
import { TransactionRepository } from "../../packages/db/src/repositories/transaction.ts"
import { Db } from "../../packages/db/src/client.ts"
import { tenants } from "../../packages/db/src/schema/index.ts"
import { makeEnableBankingService } from "../../packages/enablebanking/src/client.ts"
import { BankIngest, BankIngestLive } from "../../packages/enablebanking/src/ingest.ts"
import { makeTestLayers, runTest } from "../setup.ts"

const tenantA = Schema.decodeUnknownSync(TenantId)("t-bank-a")
const tenantB = Schema.decodeUnknownSync(TenantId)("t-bank-b")
const SESSION_ID = "sess-eb-1"
const ACCOUNT_UID = "acc-eb-1"

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

describe("BankIngest", () => {
  let server: Server
  let baseUrl = ""
  let privateKeyPem = ""

  beforeAll(async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true })
    privateKeyPem = await exportPKCS8(privateKey)
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1")
        await readBody(req)
        const method = req.method ?? ""
        const pathname = url.pathname
        let payload: unknown = { error: "not found" }
        let status = 404
        if (method === "GET" && pathname === `/sessions/${SESSION_ID}`) {
          status = 200
          payload = { accounts: [ACCOUNT_UID] }
        } else if (method === "GET" && pathname === `/accounts/${ACCOUNT_UID}/details`) {
          status = 200
          payload = {
            uid: ACCOUNT_UID,
            name: "Current",
            currency: "EUR",
            cash_account_type: "CACC",
            account_id: { iban: "FI2112345600000785" },
          }
        } else if (method === "GET" && pathname === `/accounts/${ACCOUNT_UID}/transactions`) {
          status = 200
          if (url.searchParams.get("continuation_key") === "page-2") {
            payload = {
              transactions: [
                {
                  transaction_id: "tx-debit",
                  booking_date: "2026-09-02",
                  credit_debit_indicator: "DBIT",
                  status: "BOOK",
                  transaction_amount: { amount: "1.23", currency: "EUR" },
                  remittance_information: ["Coffee"],
                },
              ],
            }
          } else {
            payload = {
              continuation_key: "page-2",
              transactions: [
                {
                  transaction_id: "tx-credit",
                  booking_date: "2026-09-01",
                  credit_debit_indicator: "CRDT",
                  status: "BOOK",
                  transaction_amount: { amount: "10.00", currency: "EUR" },
                  remittance_information: ["Salary"],
                },
                {
                  transaction_id: "tx-pending",
                  booking_date: "2026-09-01",
                  credit_debit_indicator: "DBIT",
                  status: "PDNG",
                  transaction_amount: { amount: "9.00", currency: "EUR" },
                  remittance_information: ["Hold"],
                },
                {
                  transaction_id: "tx-zero",
                  booking_date: "2026-09-01",
                  credit_debit_indicator: "CRDT",
                  status: "BOOK",
                  transaction_amount: { amount: "0.00", currency: "EUR" },
                  remittance_information: ["Zero"],
                },
              ],
            }
          }
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
      server?.close((error) => (error ? reject(error) : resolve()))
    })
  })

  const makeLayer = (sqlite: Database) => {
    const base = makeTestLayers(sqlite)
    const sessions = Layer.provide(BankSessionRepositoryLive, base)
    const bank = Layer.succeed(
      BankProvider,
      makeEnableBankingService({
        baseUrl,
        applicationId: "app-1",
        privateKeyPem,
        psuIp: "203.0.113.10",
        psuUserAgent: "finch-test",
      }),
    )
    const ingest = Layer.provide(BankIngestLive, Layer.mergeAll(base, sessions, bank))
    return Layer.mergeAll(base, sessions, bank, ingest)
  }

  const seed = Effect.gen(function* () {
    const { db } = yield* Db
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tenantA, name: "Bank A", createdAt: nowInstant() }).run(),
    )
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tenantB, name: "Bank B", createdAt: nowInstant() }).run(),
    )
  })

  it("syncs accounts and transactions, skips zeros, and isolates tenants", async () => {
    const sqlite = new Database(":memory:")
    try {
    const layer = makeLayer(sqlite)
    const program = Effect.gen(function* () {
      yield* seed
      const sessions = yield* BankSessionRepository
      const ingest = yield* BankIngest
      const accountRepo = yield* AccountRepository
      const txRepo = yield* TransactionRepository
      yield* sessions.upsert(tenantA, SESSION_ID)

      const first = yield* ingest.sync(tenantA)
      expect(first.accountsObserved).toBe(1)
      expect(first.transactionsObserved).toBe(2)
      expect(first.zerosSkipped).toBe(1)
      expect(first.duplicatesSkipped).toBe(0)

      const listed = yield* accountRepo.list(tenantA)
      expect(listed).toHaveLength(1)
      expect(listed[0]?.externalRef).toBe(ACCOUNT_UID)
      expect(listed[0]?.type).toBe("checking")

      const txs = yield* txRepo.list(tenantA, {})
      expect(txs).toHaveLength(2)
      const debit = txs.find((row) => row.externalId === "tx-debit")
      expect(debit?.amountMinor).toBe(-123n)
      const credit = txs.find((row) => row.externalId === "tx-credit")
      expect(credit?.amountMinor).toBe(1000n)

      const second = yield* ingest.sync(tenantA)
      expect(second.transactionsObserved).toBe(0)
      expect(second.duplicatesSkipped).toBeGreaterThan(0)
      expect(second.zerosSkipped).toBe(1)

      const foreign = yield* accountRepo.findByExternalRef(tenantB, ACCOUNT_UID)
      expect(foreign).toBeNull()

      const missing = yield* ingest.sync(tenantB).pipe(Effect.flip)
      expect(missing).toBeInstanceOf(BankSessionMissing)
    })
    await runTest(layer, program)
    } finally {
      sqlite.close()
    }
  })
})
