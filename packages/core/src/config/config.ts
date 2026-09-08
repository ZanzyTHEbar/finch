import { secrets } from "bun"
import { Config, ConfigError, Context, Effect, Layer } from "effect"

export const DatabaseUrl = Config.string("DATABASE_URL").pipe(
  Config.withDefault("file:./data/finch.db"),
)

export const SqliteVecPath = Config.string("SQLITE_VEC_PATH").pipe(Config.withDefault(""))

export const VoyageModel = Config.string("VOYAGE_MODEL").pipe(Config.withDefault("voyage-finance-2"))

export const EnableBankingBaseUrl = Config.string("ENABLEBANKING_BASE_URL").pipe(
  Config.withDefault("https://api.enablebanking.com"),
)

export const EnableBankingApplicationId = Config.string("ENABLEBANKING_APPLICATION_ID").pipe(
  Config.withDefault(""),
)

export const EnableBankingPsuIp = Config.string("ENABLEBANKING_PSU_IP").pipe(Config.withDefault(""))

export const EnableBankingPsuUserAgent = Config.string("ENABLEBANKING_PSU_USER_AGENT").pipe(
  Config.withDefault("finch/0.1"),
)

export const FINCH_SECRET_SERVICE = "finch"
export const VOYAGE_API_KEY_SECRET_NAME = "VOYAGE_API_KEY"
export const ENABLEBANKING_PRIVATE_KEY_SECRET_NAME = "ENABLEBANKING_PRIVATE_KEY"

// Keyring (Bun.secrets / libsecret schema com.oven-sh.bun.Secret) is the
// source of truth. VOYAGE_API_KEY in the environment wins when set so tests
// can inject a canned key without touching the keyring.
export const loadVoyageApiKey = async (): Promise<string> => {
  const fromEnv = process.env["VOYAGE_API_KEY"]
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv
  }
  const fromKeyring = await secrets.get({
    service: FINCH_SECRET_SERVICE,
    name: VOYAGE_API_KEY_SECRET_NAME,
  })
  return fromKeyring ?? ""
}

export const loadEnableBankingPrivateKey = async (): Promise<string> => {
  const fromEnv = process.env["ENABLEBANKING_PRIVATE_KEY"]
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv
  }
  const fromKeyring = await secrets.get({
    service: FINCH_SECRET_SERVICE,
    name: ENABLEBANKING_PRIVATE_KEY_SECRET_NAME,
  })
  return fromKeyring ?? ""
}

export interface AppConfig {
  readonly databaseUrl: string
  readonly sqliteVecPath: string
  readonly voyageApiKey: string
  readonly voyageModel: string
  readonly enableBankingBaseUrl: string
  readonly enableBankingApplicationId: string
  readonly enableBankingPrivateKey: string
  readonly enableBankingPsuIp: string
  readonly enableBankingPsuUserAgent: string
}

export const AppConfigTag = Context.GenericTag<AppConfig, AppConfig>("AppConfig")

export const AppConfigLive: Layer.Layer<AppConfig, ConfigError.ConfigError> = Layer.effect(
  AppConfigTag,
  Effect.gen(function* () {
    const base = yield* Config.all({
      databaseUrl: DatabaseUrl,
      sqliteVecPath: SqliteVecPath,
      voyageModel: VoyageModel,
      enableBankingBaseUrl: EnableBankingBaseUrl,
      enableBankingApplicationId: EnableBankingApplicationId,
      enableBankingPsuIp: EnableBankingPsuIp,
      enableBankingPsuUserAgent: EnableBankingPsuUserAgent,
    })
    const voyageApiKey = yield* Effect.tryPromise({
      try: loadVoyageApiKey,
      catch: () =>
        ConfigError.InvalidData(["VOYAGE_API_KEY"], "failed to read Voyage API key from keyring"),
    })
    const enableBankingPrivateKey = yield* Effect.tryPromise({
      try: loadEnableBankingPrivateKey,
      catch: () =>
        ConfigError.InvalidData(
          ["ENABLEBANKING_PRIVATE_KEY"],
          "failed to read Enable Banking private key from keyring",
        ),
    })
    return { ...base, voyageApiKey, enableBankingPrivateKey }
  }),
)
