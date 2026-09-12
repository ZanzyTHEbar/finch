import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  registerLlmAdapter,
  resolveLlmAdapter,
  resolveLlmAdapterEffect,
} from "../../packages/llm/src/adapter.ts"
import { registerBuiltinLlmAdapters } from "../../packages/llm/src/builtin-adapters.ts"

registerBuiltinLlmAdapters()

describe("LLM adapter registry", () => {
  it("resolves the builtin opencode adapter", () => {
    expect(typeof resolveLlmAdapter("opencode")).toBe("function")
  })

  it("fails typed on unknown names", async () => {
    const error = await Effect.runPromiseExit(resolveLlmAdapterEffect("nope"))
    expect(error._tag).toBe("Failure")
    if (error._tag === "Failure") {
      expect(error.cause._tag).toBe("Fail")
    }
    expect(() => resolveLlmAdapter("nope")).toThrow(/Unknown LLM adapter/)
  })

  it("supports custom registration", () => {
    registerLlmAdapter("test-custom", (config) => resolveLlmAdapter("opencode")(config))
    expect(typeof resolveLlmAdapter("test-custom")).toBe("function")
  })
})
