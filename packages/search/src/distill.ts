import { Context, Effect, Layer } from "effect"
import { type AppConfig, LlmProvider, AppConfigTag } from "@finch/core"

const SYSTEM_PROMPT = `You are a financial transaction distiller. Rewrite the following bank transaction or receipt description into a clean, semantic text suitable for embedding and semantic search. Preserve the key information: date, amount, merchant, category. Remove bank-specific codes, transaction IDs, and noise. Output ONLY the distilled text, no explanation.`

const TRANSACTION_EXAMPLES = [
  { input: "POS 0901 CONTINENTE 42.80 PRT", output: "Grocery purchase at Continente for 42.80 EUR on September 1, 2026" },
  { input: "TFR JSMITH SALARY 2500.00", output: "Salary transfer from JSmith for 2500.00 EUR" },
  { input: "DD NETFLIX.COM SUBS 15.99", output: "Netflix subscription payment of 15.99 EUR" },
]

const RECEIPT_EXAMPLES = [
  { input: "receipt from Continente 42.80 EUR on 2026-09-01, status captured.", output: "Grocery receipt from Continente supermarket for 42.80 EUR on September 1, 2026" },
  { input: "receipt from Uber 25.50 EUR on 2026-09-02, status captured.", output: "Ride receipt from Uber for 25.50 EUR on September 2, 2026" },
]

const buildPrompt = (sourceType: string, content: string): string => {
  const examples = sourceType === "receipt" ? RECEIPT_EXAMPLES : TRANSACTION_EXAMPLES
  const exampleBlock = examples
    .map((e) => `Input: "${e.input}"\nOutput: "${e.output}"`)
    .join("\n\n")
  return `${exampleBlock}\n\nInput: "${content}"\nOutput:`
}

export interface Distiller {
  readonly distill: (
    sourceType: string,
    content: string,
  ) => Effect.Effect<string, never>
}

export const Distiller = Context.GenericTag<Distiller, Distiller>("Distiller")

export const DistillerLive: Layer.Layer<Distiller, never, LlmProvider | AppConfig> = Layer.effect(
  Distiller,
  Effect.gen(function* () {
    const llm = yield* LlmProvider
    const config = yield* AppConfigTag
    const model = config.openCodeLlmModel

    return {
      distill: (sourceType, content) =>
        Effect.gen(function* () {
          const prompt = buildPrompt(sourceType, content)
          const result = yield* llm.chat(model, [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ], { maxTokens: 256, temperature: 0.2 })
          return result.trim() || content
        }).pipe(Effect.catchAll(() => Effect.succeed(content))),
    }
  }),
)

export const NoopDistillerLive: Layer.Layer<Distiller> = Layer.succeed(Distiller, {
  distill: (_sourceType, content) => Effect.succeed(content),
})
