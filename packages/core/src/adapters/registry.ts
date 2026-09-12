import { Effect } from "effect"
import { ValidationFailed } from "../domain/errors.ts"
import type { AppConfig } from "../config/config.ts"

/**
 * Generic adapter registry factory. LLM and bank adapters share this so
 * registration/resolution behavior (including error strings) stays identical.
 */
export const makeAdapterRegistry = <F extends (config: AppConfig) => unknown>(kind: string) => {
  const adapters: Record<string, F> = {}

  const register = (name: string, factory: F): void => {
    adapters[name] = factory
  }

  const resolve = (name: string): F => {
    const factory = adapters[name]
    if (!factory) {
      const available = Object.keys(adapters).join(", ")
      throw new Error(`Unknown ${kind} adapter "${name}". Available: ${available}`)
    }
    return factory
  }

  const resolveEffect = (name: string): Effect.Effect<F, ValidationFailed> => {
    const factory = adapters[name]
    if (!factory) {
      const available = Object.keys(adapters).join(", ")
      return Effect.fail(
        new ValidationFailed({ issues: [`Unknown ${kind} adapter "${name}". Available: ${available}`] }),
      )
    }
    return Effect.succeed(factory)
  }

  const createFromConfig = (config: AppConfig, name: string): ReturnType<F> =>
    resolve(name)(config) as ReturnType<F>

  return { adapters, register, resolve, resolveEffect, createFromConfig }
}
