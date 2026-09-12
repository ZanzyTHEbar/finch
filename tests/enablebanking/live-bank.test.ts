import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { loadEnableBankingPrivateKey } from "../../packages/core/src/config/config.ts"
import { makeEnableBankingService } from "../../packages/enablebanking/src/client.ts"

// Live EnableBanking test — read-only (listAspsps), no sessions, no money movement.
// Skipped by default so `bun run test` stays fully offline.
// Opt in: FINCH_LIVE_BANK=1 ENABLEBANKING_APPLICATION_ID=<id> bun run test tests/enablebanking/live-bank.test.ts
// Private key comes from ENABLEBANKING_PRIVATE_KEY env or the finch keyring.
const LIVE = process.env["FINCH_LIVE_BANK"] === "1"

const maybe = LIVE ? describe : describe.skip

maybe("live EnableBanking (opt-in)", () => {
  it("lists ASPSPs from the real API", async () => {
    const applicationId = process.env["ENABLEBANKING_APPLICATION_ID"] ?? ""
    const privateKeyPem = await loadEnableBankingPrivateKey()
    if (applicationId === "" || privateKeyPem === "") {
      throw new Error(
        "FINCH_LIVE_BANK=1 needs ENABLEBANKING_APPLICATION_ID + ENABLEBANKING_PRIVATE_KEY (env or keyring service=finch)",
      )
    }
    const bank = makeEnableBankingService({
      baseUrl: process.env["ENABLEBANKING_BASE_URL"] ?? "https://api.enablebanking.com",
      applicationId,
      privateKeyPem,
      psuIp: process.env["ENABLEBANKING_PSU_IP"] ?? "",
      psuUserAgent: "finch-live-test/0.1",
    })
    const aspsps = await Effect.runPromise(bank.listAspsps())
    expect(Array.isArray(aspsps)).toBe(true)
    expect(aspsps.length).toBeGreaterThan(0)
  }, 30_000)
})
