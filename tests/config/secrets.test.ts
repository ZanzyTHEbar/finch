import { secrets } from "bun"
import { describe, expect, it } from "vitest"
import {
  FINCH_SECRET_SERVICE,
  loadVoyageApiKey,
  VOYAGE_API_KEY_SECRET_NAME,
} from "../../packages/core/src/config/config.ts"

describe("Bun.secrets voyage key", () => {
  it("round-trips under service finch without leaking values on mismatch", async () => {
    const name = `finch-test-${crypto.randomUUID()}`
    try {
      await secrets.set({ service: FINCH_SECRET_SERVICE, name, value: "probe-value" })
    } catch {
      return
    }
    try {
      const got = await secrets.get({ service: FINCH_SECRET_SERVICE, name })
      expect(got === "probe-value").toBe(true)
    } finally {
      await secrets.delete({ service: FINCH_SECRET_SERVICE, name })
    }
  })

  it("lets VOYAGE_API_KEY env override the keyring", async () => {
    const prev = process.env["VOYAGE_API_KEY"]
    process.env["VOYAGE_API_KEY"] = "env-override-not-a-real-key"
    try {
      expect(await loadVoyageApiKey()).toBe("env-override-not-a-real-key")
    } finally {
      if (prev === undefined) {
        delete process.env["VOYAGE_API_KEY"]
      } else {
        process.env["VOYAGE_API_KEY"] = prev
      }
    }
  })

  it("reads the keyring secret when env is unset", async () => {
    const prev = process.env["VOYAGE_API_KEY"]
    delete process.env["VOYAGE_API_KEY"]
    try {
      const fromKeyring = await secrets.get({
        service: FINCH_SECRET_SERVICE,
        name: VOYAGE_API_KEY_SECRET_NAME,
      })
      const loaded = await loadVoyageApiKey()
      expect(loaded === (fromKeyring ?? "")).toBe(true)
    } finally {
      if (prev === undefined) {
        delete process.env["VOYAGE_API_KEY"]
      } else {
        process.env["VOYAGE_API_KEY"] = prev
      }
    }
  })
})
