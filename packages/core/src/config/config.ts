import { Config, Context, Layer } from "effect"
import type { ConfigError } from "effect"

export const DatabaseUrl = Config.string("DATABASE_URL").pipe(
  Config.withDefault("file:./data/finch.db"),
)

export const SqliteVecPath = Config.string("SQLITE_VEC_PATH").pipe(Config.withDefault(""))

export interface AppConfig {
  readonly databaseUrl: string
  readonly sqliteVecPath: string
}

export const AppConfigTag = Context.GenericTag<AppConfig, AppConfig>("AppConfig")

export const AppConfigLive: Layer.Layer<AppConfig, ConfigError.ConfigError> = Layer.effect(
  AppConfigTag,
  Config.all({
    databaseUrl: DatabaseUrl,
    sqliteVecPath: SqliteVecPath,
  }),
)
