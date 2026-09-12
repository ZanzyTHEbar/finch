import { Layer } from "effect"
import { AppConfigTag } from "@finch/core"
import { registerBankAdapter } from "./adapter.ts"
import { EnableBankingLive } from "./client.ts"

/**
 * Register all built-in banking adapters.
 * Call once at startup before resolving any adapter.
 */
export const registerBuiltinBankAdapters = (): void => {
  registerBankAdapter("enablebanking", (config) =>
    Layer.provide(EnableBankingLive, Layer.succeed(AppConfigTag, config)),
  )
  // Add more adapters here:
  // registerBankAdapter("plaid", (config) => makePlaidAdapter(config.plaidApiKey))
  // registerBankAdapter("gocardless", (config) => makeGoCardlessAdapter(config.gocardlessToken))
}
