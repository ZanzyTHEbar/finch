import { Effect, Layer } from "effect"
import { ValidationFailed, type AppConfig, type LlmProvider } from "@finch/core"
import { makeAdapterRegistry } from "../../core/src/adapters/registry.ts"

/**
 * LLM adapter factory: takes AppConfig value, returns a fully-satisfied Layer.
 * The factory provides all context internally — callers get a Layer<Provider, never, never>.
 */
export type LlmAdapterFactory = (config: AppConfig) => Layer.Layer<LlmProvider, ValidationFailed>

const registry = makeAdapterRegistry<LlmAdapterFactory>("LLM")

/**
 * Registry of available LLM adapters. Add new adapters here.
 */
export const LlmAdapters: Record<string, LlmAdapterFactory> = registry.adapters

/**
 * Register an adapter by name.
 */
export const registerLlmAdapter: (name: string, factory: LlmAdapterFactory) => void =
  registry.register

/**
 * Resolve an adapter by name from config. Throws if unknown.
 */
export const resolveLlmAdapter: (name: string) => LlmAdapterFactory = registry.resolve

/**
 * Effect version: fails with ValidationFailed instead of throwing.
 */
export const resolveLlmAdapterEffect: (
  name: string,
) => Effect.Effect<LlmAdapterFactory, ValidationFailed> = registry.resolveEffect

/**
 * Create an LlmProvider layer from config. Reads config.llmAdapter.
 */
export const createLlmProvider = (config: AppConfig): Layer.Layer<LlmProvider, ValidationFailed> =>
  registry.createFromConfig(config, config.llmAdapter)

/**
 * Effect version of createLlmProvider.
 */
export const createLlmProviderEffect = (
  config: AppConfig,
): Effect.Effect<Layer.Layer<LlmProvider, ValidationFailed>, ValidationFailed> =>
  Effect.map(registry.resolveEffect(config.llmAdapter), (factory) => factory(config))
