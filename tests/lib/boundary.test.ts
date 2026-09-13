import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "../..")
const checker = resolve(root, "scripts/check-lib-boundary.mjs")
const forbiddenFixture = resolve(root, "tests/fixtures/lib-boundary/forbidden-adapter")
const cleanFixture = resolve(root, "tests/fixtures/lib-boundary/comments-and-strings")

describe("lib boundary checker", () => {
  it("rejects direct, re-export, dynamic, and CommonJS adapter imports", () => {
    const result = spawnSync(process.execPath, [checker, forbiddenFixture], { encoding: "utf8" })
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain("adapter boundary verification passed")
    expect(result.stderr).toContain("has forbidden dependency: @finch/db")
    expect(result.stderr).toContain("must not expose legacy subpaths")
    expect(result.stderr).toContain("imports bare @finch/core; use @finch/core/domain")
    expect(result.stderr).toContain("imports forbidden adapter or external package: @finch/db")
    expect(result.stderr).toContain("imports forbidden adapter or external package: @finch/search")
    expect(result.stderr).toContain("imports forbidden adapter or external package: @finch/enablebanking")
    expect(result.stderr).toContain("imports unsafe domain barrel path: ../config/config.ts")
    expect(result.stderr).toContain("imports @finch/lib-legacy outside a legacy implementation seam")
  })

  it("ignores import-like comments and strings", () => {
    const result = spawnSync(process.execPath, [checker, cleanFixture], { encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("adapter boundary verification passed")
  })
})
