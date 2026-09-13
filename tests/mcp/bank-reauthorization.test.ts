import { Database } from "bun:sqlite"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { TenantId } from "../../packages/core/src/domain/tenant.ts"
import { nowInstant } from "../../packages/core/src/domain/time.ts"
import { BankProvider } from "../../packages/core/src/ports/bank-provider.ts"
import { EventStore } from "../../packages/db/src/event-store.ts"
import { Db } from "../../packages/db/src/client.ts"
import { tenants } from "../../packages/db/src/schema/index.ts"
import {
  authorizeBankSession,
  deleteBankSession,
  startBankAuth,
} from "../../packages/lib-legacy/src/bank.ts"
import { makeTestLayers, runTest } from "../setup.ts"

const tenantId = Schema.decodeUnknownSync(TenantId)("t-bank-reauthorization")

describe("bank reauthorization", () => {
  it("does not delete an already-revoked provider session", async () => {
    const sqlite = new Database(":memory:")
    const deletedSessionIds: string[] = []
    let sessionNumber = 0
    const bank = Layer.succeed(
      BankProvider,
      BankProvider.of({
        listAspsps: () => Effect.succeed([]),
        startAuthorization: () => Effect.succeed({ url: "https://bank.example/authorize" }),
        createSession: () =>
          Effect.sync(() => ({ sessionId: `session-${++sessionNumber}`, accounts: [] })),
        listAccounts: () => Effect.succeed([]),
        listTransactions: () => Effect.succeed([]),
        deleteSession: (sessionId) =>
          Effect.sync(() => {
            deletedSessionIds.push(sessionId)
          }),
      }),
    )
    const base = makeTestLayers(sqlite)

    try {
      await runTest(
        base,
        Effect.gen(function* () {
          const { db } = yield* Db
          yield* Effect.sync(() =>
            db.insert(tenants).values({ id: tenantId, name: tenantId, createdAt: nowInstant() }).run(),
          )
        }),
      )
      const result = await runTest(
        Layer.mergeAll(base, bank),
        Effect.gen(function* () {
          yield* startBankAuth({
            tenantId,
            aspspName: "Demo Bank",
            aspspCountry: "FI",
            redirectUrl: "https://finch.example/callback",
            state: "state-1",
          })
          yield* authorizeBankSession({ tenantId, code: "code-1", state: "state-1" })
          yield* deleteBankSession({ tenantId })
          yield* startBankAuth({
            tenantId,
            aspspName: "Demo Bank",
            aspspCountry: "FI",
            redirectUrl: "https://finch.example/callback",
            state: "state-2",
          })
          const session = yield* authorizeBankSession({ tenantId, code: "code-2", state: "state-2" })
          const eventStore = yield* EventStore
          const events = yield* eventStore.readAggregate(tenantId, "account", "session-1")
          return { session, events }
        }),
      )

      expect(result.session.sessionId).toBe("session-2")
      expect(deletedSessionIds).toEqual(["session-1"])
      expect(result.events.map((event) => event.eventType)).toContain("BankConnectionRevoked")
    } finally {
      sqlite.close()
    }
  })
})
