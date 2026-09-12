import { Layer } from "effect"
import { AppConfigTag } from "@finch/core"
import { registerLlmAdapter } from "./adapter.ts"
import { OpenCodeLlmLive } from "./openai-compatible.ts"

/**
 * Register all built-in LLM adapters.
 * Call once at startup before resolving any adapter.
 */
export const registerBuiltinLlmAdapters = (): void => {
  registerLlmAdapter("opencode", (config) =>
    Layer.provide(OpenCodeLlmLive, Layer.succeed(AppConfigTag, config)),
  )
  // Add more adapters here:
  // registerLlmAdapter("openai", (config) =>
  //   makeOpenAiLlm("https://api.openai.com/v1", config.openCodeApiKey),
  // )
}
