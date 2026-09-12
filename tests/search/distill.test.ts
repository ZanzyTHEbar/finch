import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { AppConfigTag } from "../../packages/core/src/config/config.ts"
import { LlmProvider, LlmError } from "../../packages/core/src/ports/llm-provider.ts"
import { DistillerLive, Distiller } from "../../packages/search/src/distill.ts"

const testConfig = Layer.succeed(AppConfigTag, {
  databaseUrl: "file::memory:",
  sqliteVecPath: "",
  voyageApiKey: "",
  voyageModel: "voyage-finance-2",
  llmAdapter: "opencode",
  openCodeApiKey: "",
  openCodeLlmBaseUrl: "https://opencode.ai/zen/v1",
  openCodeLlmModel: "opencode/claude-sonnet-4-20250514",
  bankAdapter: "enablebanking",
  enableBankingBaseUrl: "https://api.enablebanking.com",
  enableBankingApplicationId: "",
  enableBankingPrivateKey: "",
  enableBankingPsuIp: "203.0.113.10",
  enableBankingPsuUserAgent: "finch-test",
  enableDistillation: true,
  enableReranker: true,
  enableSummaries: true,
  enableEmbeddings: true,
})

const cannedLlm = Layer.succeed(LlmProvider, {
  chat: (_model, _messages, _options) =>
    Effect.succeed("Grocery purchase at Continente for 42.80 EUR"),
})

const failingLlm = Layer.succeed(LlmProvider, {
  chat: (_model, _messages, _options) =>
    Effect.fail(new LlmError({ message: "boom" })),
})

const distillerLayer = (llm: Layer.Layer<LlmProvider, never, never>) =>
  Layer.provide(DistillerLive, Layer.mergeAll(llm, testConfig))

const runDistill = (llm: Layer.Layer<LlmProvider, never, never>, sourceType: string, content: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const distiller = yield* Distiller
        return yield* distiller.distill(sourceType, content)
      }),
      distillerLayer(llm),
    ),
  )

describe("DistillerLive", () => {
  it("distills a transaction description", async () => {
    const result = await runDistill(cannedLlm, "transaction", "POS 0901 CONTINENTE 42.80 PRT")
    expect(result).toBeTruthy()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("distills a receipt description", async () => {
    const result = await runDistill(
      cannedLlm,
      "receipt",
      "receipt from Continente 42.80 EUR on 2026-09-01, status captured.",
    )
    expect(result).toBeTruthy()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("returns original content on LLM failure", async () => {
    const input = "POS 0901 CONTINENTE 42.80 PRT"
    const result = await runDistill(failingLlm, "transaction", input)
    expect(result).toBe(input)
  })
})
