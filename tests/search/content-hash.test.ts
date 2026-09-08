import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { contentHash } from "../../packages/search/src/content-hash.ts"

describe("contentHash", () => {
  it("is sha256 hex of the utf8 bytes", () => {
    expect(contentHash("Continente weekly shop")).toBe(
      createHash("sha256").update("Continente weekly shop", "utf8").digest("hex"),
    )
  })

  it("changes when content changes", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"))
  })
})
