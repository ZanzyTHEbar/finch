import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  registerBankAdapter,
  resolveBankAdapter,
  resolveBankAdapterEffect,
} from "../../packages/enablebanking/src/adapter.ts"
import { registerBuiltinBankAdapters } from "../../packages/enablebanking/src/builtin-adapters.ts"

registerBuiltinBankAdapters()

describe("bank adapter registry", () => {
  it("resolves the builtin enablebanking adapter", () => {
    expect(typeof resolveBankAdapter("enablebanking")).toBe("function")
  })

  it("fails typed on unknown names", async () => {
    const error = await Effect.runPromiseExit(resolveBankAdapterEffect("nope"))
    expect(error._tag).toBe("Failure")
    if (error._tag === "Failure") {
      expect(error.cause._tag).toBe("Fail")
    }
    expect(() => resolveBankAdapter("nope")).toThrow(/Unknown bank adapter/)
  })

  it("supports custom registration", () => {
    registerBankAdapter("test-custom", (config) => resolveBankAdapter("enablebanking")(config))
    expect(typeof resolveBankAdapter("test-custom")).toBe("function")
  })
})
