import { Database } from "bun:sqlite"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AmountMinor } from "../../packages/core/src/domain/money.ts"
import { CurrencyCode } from "../../packages/core/src/domain/money.ts"
import { TenantMismatch } from "../../packages/core/src/domain/errors.ts"
import { TenantId } from "../../packages/core/src/domain/tenant.ts"
import { nowInstant } from "../../packages/core/src/domain/time.ts"
import { BankProvider } from "../../packages/core/src/ports/bank-provider.ts"
import { Db } from "../../packages/db/src/client.ts"
import { PaymentRepository } from "../../packages/db/src/repositories/payment.ts"
import { tenants } from "../../packages/db/src/schema/index.ts"
import { BankPayments, BankPaymentsLive } from "../../packages/enablebanking/src/payments.ts"
import { makeTestLayers, runTest } from "../setup.ts"

const TIDA = Schema.decodeUnknownSync(TenantId)("t-pis-a")
const TIDB = Schema.decodeUnknownSync(TenantId)("t-pis-b")
const amountMinor = Schema.decodeUnknownSync(AmountMinor)(1500n)
const currency = Schema.decodeUnknownSync(CurrencyCode)("EUR")

const stubBank = Layer.succeed(
  BankProvider,
  BankProvider.of({
    listAspsps: () => Effect.succeed([]),
    startAuthorization: () => Effect.succeed({ url: "https://bank.example/authorize" }),
    createSession: () => Effect.succeed({ sessionId: "sess-1", accounts: [] }),
    listAccounts: () => Effect.succeed([]),
    listTransactions: () => Effect.succeed([]),
    deleteSession: () => Effect.void,
    createPayment: () =>
      Effect.succeed({ paymentId: "pay-1", status: "PDNG", url: "https://bank.example/pay" }),
    getPayment: () => Effect.succeed({ paymentId: "pay-1", status: "ACCC" }),
    submitPayment: () => Effect.succeed({ paymentId: "pay-1", status: "ACCC" }),
    deletePayment: () => Effect.void,
  }),
)

const input = {
  aspsp: { name: "Demo Bank", country: "FI" },
  redirectUrl: "https://finch.example/pay",
  state: "pay-state",
  paymentType: "SEPA",
  creditorName: "Acme",
  creditorIban: "FI2112345600000785",
  amountMinor,
  currency,
}

describe("BankPayments", () => {
  it("creates, lists, refreshes, and binds payments to a tenant", async () => {
    const sqlite = new Database(":memory:")
    try {
      const base = makeTestLayers(sqlite)
      const layer = Layer.mergeAll(base, stubBank, Layer.provide(BankPaymentsLive, Layer.mergeAll(base, stubBank)))
      const result = await runTest(
        layer,
        Effect.gen(function* () {
          const { db } = yield* Db
          yield* Effect.sync(() =>
            db.insert(tenants).values({ id: TIDA, name: TIDA, createdAt: nowInstant() }).run(),
          )
          yield* Effect.sync(() =>
            db.insert(tenants).values({ id: TIDB, name: TIDB, createdAt: nowInstant() }).run(),
          )
          const payments = yield* BankPayments
          const created = yield* payments.create(TIDA, input)
          const listed = yield* payments.list(TIDA)
          const empty = yield* payments.list(TIDB)
          const stolen = yield* Effect.flip(payments.get(TIDB, created.paymentId))
          const live = yield* payments.get(TIDA, created.paymentId)
          const repo = yield* PaymentRepository
          const stored = yield* repo.get(TIDA, created.paymentId)
          return { created, listed, empty, stolen, live, stored }
        }),
      )
      expect(result.created).toEqual({
        paymentId: "pay-1",
        status: "PDNG",
        url: "https://bank.example/pay",
      })
      expect(result.listed).toHaveLength(1)
      expect(result.empty).toEqual([])
      expect(result.stolen).toBeInstanceOf(TenantMismatch)
      expect(result.live.status).toBe("ACCC")
      expect(result.stored.status).toBe("ACCC")
    } finally {
      sqlite.close()
    }
  })
})
