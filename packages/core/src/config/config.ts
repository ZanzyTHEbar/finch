import { secrets } from "bun"
import { Context, Effect, Layer } from "effect"
import { parse } from "smol-toml"
import { readFileSync } from "fs"

// ---------------------------------------------------------------------------
// TOML schema types
// ---------------------------------------------------------------------------

interface TomlDatabase {
  readonly url?: string
  readonly sqlite_vec_path?: string
}

interface TomlVoyage {
  readonly model?: string
}

interface TomlLlm {
  readonly adapter?: string
  readonly base_url?: string
  readonly model?: string
}

interface TomlBank {
  readonly adapter?: string
  readonly base_url?: string
  readonly application_id?: string
  readonly psu_ip?: string
  readonly psu_user_agent?: string
}

interface TomlFeatures {
  readonly distillation?: boolean
  readonly reranker?: boolean
  readonly enableSummaries?: boolean
  readonly enableEmbeddings?: boolean
}

interface TomlConfig {
  readonly database?: TomlDatabase
  readonly voyage?: TomlVoyage
  readonly llm?: TomlLlm
  readonly bank?: TomlBank
  readonly features?: TomlFeatures
}

// ---------------------------------------------------------------------------
// Defaults — everything enabled, sensible out-of-box values
// ---------------------------------------------------------------------------

const DEFAULTS = {
  database: {
    url: "file:./data/finch.db",
    sqlite_vec_path: "",
  },
  voyage: {
    model: "voyage-finance-2",
  },
  llm: {
    adapter: "opencode",
    base_url: "https://opencode.ai/zen/v1",
    model: "muse-spark-1.3-contributor",
  },
  bank: {
    adapter: "enablebanking",
    base_url: "https://api.enablebanking.com",
    application_id: "",
    psu_ip: "",
    psu_user_agent: "finch/0.1",
  },
  features: {
    distillation: true,
    reranker: true,
    enableSummaries: true,
    enableEmbeddings: true,
  },
} as const

// ---------------------------------------------------------------------------
// TOML file loading
// ---------------------------------------------------------------------------

const CONFIG_PATH = process.env["FINCH_CONFIG"] ?? "finch.toml"

function loadToml(): TomlConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8")
    return parse(raw) as TomlConfig
  } catch (err) {
    // Missing file is fine — use all defaults.
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return {}
    }
    // Malformed TOML is a hard error — surface the parse message.
    throw err
  }
}

function resolveConfig(raw: TomlConfig) {
  const db = { ...DEFAULTS.database, ...raw.database }
  const voyage = { ...DEFAULTS.voyage, ...raw.voyage }
  const llm = { ...DEFAULTS.llm, ...raw.llm }
  const bank = { ...DEFAULTS.bank, ...raw.bank }
  const features = { ...DEFAULTS.features, ...raw.features }

  return {
    databaseUrl: db.url ?? DEFAULTS.database.url,
    sqliteVecPath: db.sqlite_vec_path ?? DEFAULTS.database.sqlite_vec_path,
    voyageModel: voyage.model ?? DEFAULTS.voyage.model,
    llmAdapter: llm.adapter ?? DEFAULTS.llm.adapter,
    openCodeLlmBaseUrl: llm.base_url ?? DEFAULTS.llm.base_url,
    openCodeLlmModel: llm.model ?? DEFAULTS.llm.model,
    bankAdapter: bank.adapter ?? DEFAULTS.bank.adapter,
    enableBankingBaseUrl: bank.base_url ?? DEFAULTS.bank.base_url,
    enableBankingApplicationId: bank.application_id ?? DEFAULTS.bank.application_id,
    enableBankingPsuIp: bank.psu_ip ?? DEFAULTS.bank.psu_ip,
    enableBankingPsuUserAgent: bank.psu_user_agent ?? DEFAULTS.bank.psu_user_agent,
    enableDistillation: features.distillation ?? DEFAULTS.features.distillation,
    enableReranker: features.reranker ?? DEFAULTS.features.reranker,
    enableSummaries: features.enableSummaries ?? DEFAULTS.features.enableSummaries,
    enableEmbeddings: features.enableEmbeddings ?? DEFAULTS.features.enableEmbeddings,
  }
}

// ---------------------------------------------------------------------------
// Keyring loaders (Bun.secrets / libsecret schema com.oven-sh.bun.Secret)
// Sensitive keys stay in the system keyring, never in TOML.
// ---------------------------------------------------------------------------

export const FINCH_SECRET_SERVICE = "finch"
export const VOYAGE_API_KEY_SECRET_NAME = "VOYAGE_API_KEY"
export const OPENCODE_API_KEY_SECRET_NAME = "OPENCODE_API_KEY"
export const ENABLEBANKING_PRIVATE_KEY_SECRET_NAME = "ENABLEBANKING_PRIVATE_KEY"

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

export const loadOpenCodeApiKey = async (): Promise<string> => {
  const fromEnv = process.env["OPENCODE_API_KEY"]
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv
  }
  const fromKeyring = await secrets.get({
    service: FINCH_SECRET_SERVICE,
    name: OPENCODE_API_KEY_SECRET_NAME,
  })
  return fromKeyring ?? ""
}

// ---------------------------------------------------------------------------
// AppConfig — flat interface consumed by all packages
// ---------------------------------------------------------------------------

export interface AppConfig {
  readonly databaseUrl: string
  readonly sqliteVecPath: string
  readonly voyageApiKey: string
  readonly voyageModel: string
  readonly llmAdapter: string
  readonly openCodeApiKey: string
  readonly openCodeLlmBaseUrl: string
  readonly openCodeLlmModel: string
  readonly bankAdapter: string
  readonly enableBankingBaseUrl: string
  readonly enableBankingApplicationId: string
  readonly enableBankingPrivateKey: string
  readonly enableBankingPsuIp: string
  readonly enableBankingPsuUserAgent: string
  readonly enableDistillation: boolean
  readonly enableReranker: boolean
  readonly enableSummaries: boolean
  readonly enableEmbeddings: boolean
}

export const AppConfigTag = Context.GenericTag<AppConfig, AppConfig>("AppConfig")

export const AppConfigLive: Layer.Layer<AppConfig, Error> = Layer.effect(
  AppConfigTag,
  Effect.gen(function* () {
    const raw = loadToml()
    const base = resolveConfig(raw)

    const voyageApiKey = yield* Effect.tryPromise({
      try: loadVoyageApiKey,
      catch: () => new Error("failed to read Voyage API key from keyring"),
    })

    const enableBankingPrivateKey = yield* Effect.tryPromise({
      try: loadEnableBankingPrivateKey,
      catch: () => new Error("failed to read Enable Banking private key from keyring"),
    })

    const openCodeApiKey = yield* Effect.tryPromise({
      try: loadOpenCodeApiKey,
      catch: () => new Error("failed to read OpenCode API key from keyring"),
    })

    return { ...base, voyageApiKey, enableBankingPrivateKey, openCodeApiKey }
  }),
)
