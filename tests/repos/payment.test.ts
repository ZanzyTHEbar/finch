import { Database } from "bun:sqlite"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { PaymentNotFound, TenantMismatch } from "../../packages/core/src/domain/errors.ts"
import { TenantId } from "../../packages/core/src/domain/tenant.ts"
import type { TenantId as TenantIdT } from "../../packages/core/src/domain/tenant.ts"
import { nowInstant } from "../../packages/core/src/domain/time.ts"
import { Db } from "../../packages/db/src/client.ts"
import { PaymentRepository } from "../../packages/db/src/repositories/payment.ts"
import { tenants } from "../../packages/db/src/schema/index.ts"
import { makeTestLayers, runTest } from "../setup.ts"

const TIDA = Schema.decodeUnknownSync(TenantId)("t-pay-a")
const TIDB = Schema.decodeUnknownSync(TenantId)("t-pay-b")

const seedTenant = (tid: TenantIdT) =>
  Effect.gen(function* () {
    const { db } = yield* Db
    yield* Effect.sync(() =>
      db.insert(tenants).values({ id: tid, name: tid, createdAt: nowInstant() }).run(),
    )
  })

const row = {
  paymentId: "pay-1",
  status: "PDNG",
  url: "https://bank.example/pay",
  aspspName: "Demo Bank",
  aspspCountry: "FI",
  amountMinor: 1500n,
  currency: "EUR",
  creditorName: "Acme",
  creditorIban: "FI2112345600000785",
  paymentType: "SEPA",
  remittance: null,
  state: "pay-state",
}

describe("PaymentRepository", () => {
  it("puts then gets the same payment", async () => {
    const sqlite = new Database(":memory:")
    try {
      const stored = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA)
          const payments = yield* PaymentRepository
          yield* payments.put(TIDA, row)
          return yield* payments.get(TIDA, "pay-1")
        }),
      )
      expect(stored.tenantId).toBe(TIDA)
      expect(stored.paymentId).toBe("pay-1")
      expect(stored.amountMinor).toBe(1500n)
    } finally {
      sqlite.close()
    }
  })

  it("rejects cross-tenant reuse of the same payment id", async () => {
    const sqlite = new Database(":memory:")
    try {
      const result = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA)
          yield* seedTenant(TIDB)
          const payments = yield* PaymentRepository
          yield* payments.put(TIDA, row)
          const rejected = yield* Effect.flip(payments.put(TIDB, row))
          const owner = yield* payments.get(TIDA, "pay-1")
          const stolen = yield* Effect.flip(payments.get(TIDB, "pay-1"))
          return { rejected, owner, stolen }
        }),
      )
      expect(result.rejected).toBeInstanceOf(TenantMismatch)
      expect(result.stolen).toBeInstanceOf(TenantMismatch)
      expect(result.owner.tenantId).toBe(TIDA)
    } finally {
      sqlite.close()
    }
  })

  it("lists by tenant and remove is PaymentNotFound", async () => {
    const sqlite = new Database(":memory:")
    try {
      const result = await runTest(
        makeTestLayers(sqlite),
        Effect.gen(function* () {
          yield* seedTenant(TIDA)
          const payments = yield* PaymentRepository
          yield* payments.put(TIDA, row)
          const listed = yield* payments.list(TIDA)
          yield* payments.remove(TIDA, "pay-1")
          const missing = yield* Effect.flip(payments.get(TIDA, "pay-1"))
          return { listed, missing }
        }),
      )
      expect(result.listed.map((item) => item.paymentId)).toEqual(["pay-1"])
      expect(result.missing).toBeInstanceOf(PaymentNotFound)
    } finally {
      sqlite.close()
    }
  })
})
