import { Effect, Layer } from "effect"
import { ValidationFailed, type AppConfig, type BankProvider } from "@finch/core"
import { makeAdapterRegistry } from "../../core/src/adapters/registry.ts"

/**
 * Banking adapter factory: takes AppConfig value, returns a fully-satisfied Layer.
 * The factory provides all context internally — callers get a Layer<BankProvider, never, never>.
 */
export type BankAdapterFactory = (config: AppConfig) => Layer.Layer<BankProvider, ValidationFailed>

const registry = makeAdapterRegistry<BankAdapterFactory>("bank")

/**
 * Registry of available banking adapters.
 */
export const BankAdapters: Record<string, BankAdapterFactory> = registry.adapters

/**
 * Register a banking adapter by name.
 */
export const registerBankAdapter: (name: string, factory: BankAdapterFactory) => void =
  registry.register

/**
 * Resolve a banking adapter by name. Throws if unknown.
 */
export const resolveBankAdapter: (name: string) => BankAdapterFactory = registry.resolve

/**
 * Effect version: fails with ValidationFailed instead of throwing.
 */
export const resolveBankAdapterEffect: (
  name: string,
) => Effect.Effect<BankAdapterFactory, ValidationFailed> = registry.resolveEffect

/**
 * Create a BankProvider layer from config. Reads config.bankAdapter.
 */
export const createBankProvider = (config: AppConfig): Layer.Layer<BankProvider, ValidationFailed> =>
  registry.createFromConfig(config, config.bankAdapter)

/**
 * Effect version of createBankProvider.
 */
export const createBankProviderEffect = (
  config: AppConfig,
): Effect.Effect<Layer.Layer<BankProvider, ValidationFailed>, ValidationFailed> =>
  Effect.map(registry.resolveEffect(config.bankAdapter), (factory) => factory(config))
