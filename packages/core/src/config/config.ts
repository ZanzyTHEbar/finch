import { Config, Context, Layer } from "effect"
import type { ConfigError } from "effect"

export const DatabaseUrl = Config.string("DATABASE_URL").pipe(
  Config.withDefault("file:./data/finch.db"),
)

export const SqliteVecPath = Config.string("SQLITE_VEC_PATH").pipe(Config.withDefault(""))

export const VoyageApiKey = Config.string("VOYAGE_API_KEY").pipe(Config.withDefault(""))

export const VoyageModel = Config.string("VOYAGE_MODEL").pipe(Config.withDefault("voyage-finance-2"))

export interface AppConfig {
  readonly databaseUrl: string
  readonly sqliteVecPath: string
  readonly voyageApiKey: string
  readonly voyageModel: string
}

export const AppConfigTag = Context.GenericTag<AppConfig, AppConfig>("AppConfig")

export const AppConfigLive: Layer.Layer<AppConfig, ConfigError.ConfigError> = Layer.effect(
  AppConfigTag,
  Config.all({
    databaseUrl: DatabaseUrl,
    sqliteVecPath: SqliteVecPath,
    voyageApiKey: VoyageApiKey,
    voyageModel: VoyageModel,
  }),
)
