import { Effect, Either, Layer, Schema } from "effect"
import {
  AppConfigTag,
  BankProvider,
  IsoDate,
  ProviderUnavailable,
  ValidationFailed,
  normalizeCurrency,
  toMajor,
  type AppConfig,
  type BankAccountSnapshot,
  type BankAspsp,
  type BankPayment,
  type BankProviderConfig,
  type BankTransactionSnapshot,
  type CreateBankPaymentInput,
  type CurrencyCode,
} from "@finch/core"
import { signEnableBankingJwt } from "./jwt.ts"
import { mapStatus, signedAmount } from "./map.ts"

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const originOf = (baseUrl: string): string => baseUrl.replace(/\/$/, "")

const parseHttpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

const parseCurrency = (raw: unknown): CurrencyCode | undefined => {
  const text = asString(raw)
  if (text === undefined) {
    return undefined
  }
  try {
    return normalizeCurrency(text)
  } catch {
    return undefined
  }
}

const parseIsoDate = (raw: unknown): Schema.Schema.Type<typeof IsoDate> | undefined => {
  const decoded = Schema.decodeUnknownEither(IsoDate)(raw)
  return Either.isRight(decoded) ? decoded.right : undefined
}

const remittanceText = (raw: unknown): string => {
  if (typeof raw === "string") {
    return raw
  }
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string").join(" ")
  }
  const record = asRecord(raw)
  if (record !== null && "unstructured" in record) {
    return remittanceText(record["unstructured"])
  }
  return ""
}

const partyName = (raw: unknown): string | undefined => asString(asRecord(raw)?.["name"])

const mapAccount = (raw: unknown, fallbackId?: string): BankAccountSnapshot | undefined => {
  const record = asRecord(raw)
  if (record === null) {
    return undefined
  }
  const accountId = asRecord(record["account_id"])
  const iban = asString(accountId?.["iban"])
  const externalAccountId = asString(record["uid"]) ?? iban ?? fallbackId
  if (externalAccountId === undefined) {
    return undefined
  }
  const name = asString(record["name"]) ?? asString(record["product"])
  const currency = parseCurrency(record["currency"])
  const cashAccountType = asString(record["cash_account_type"])
  return {
    externalAccountId,
    ...(name !== undefined ? { name } : {}),
    ...(iban !== undefined ? { iban } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(cashAccountType !== undefined ? { cashAccountType } : {}),
  }
}

const mapTransaction = (raw: unknown): BankTransactionSnapshot | undefined => {
  const record = asRecord(raw)
  if (record === null) {
    return undefined
  }
  const bookingDate = parseIsoDate(record["booking_date"])
  if (bookingDate === undefined) {
    return undefined
  }
  const indicator = record["credit_debit_indicator"]
  if (indicator !== "CRDT" && indicator !== "DBIT") {
    return undefined
  }
  const status = mapStatus(asString(record["status"]))
  if (status !== "booked") {
    return undefined
  }
  const amount = asRecord(record["transaction_amount"])
  const amountDecimal = asString(amount?.["amount"])
  const currency = parseCurrency(amount?.["currency"])
  if (amountDecimal === undefined || currency === undefined) {
    return undefined
  }
  let amountMinor: BankTransactionSnapshot["amountMinor"]
  try {
    amountMinor = signedAmount(amountDecimal, currency, indicator)
  } catch {
    return undefined
  }
  const valueDate = parseIsoDate(record["value_date"])
  const creditor = partyName(record["creditor"])
  const debtor = partyName(record["debtor"])
  const rawDescription = remittanceText(record["remittance_information"]) || creditor || debtor || ""
  const counterpartyName = indicator === "DBIT" ? creditor : debtor
  const externalTransactionId = asString(record["transaction_id"])
  const entryReference = asString(record["entry_reference"])
  const merchantName = asString(asRecord(record["merchant"])?.["name"])
  return {
    bookingDate,
    amountMinor,
    currency,
    creditDebitIndicator: indicator,
    rawDescription,
    status,
    ...(valueDate !== undefined ? { valueDate } : {}),
    ...(merchantName !== undefined ? { merchantName } : {}),
    ...(counterpartyName !== undefined ? { counterpartyName } : {}),
    ...(externalTransactionId !== undefined ? { externalTransactionId } : {}),
    ...(entryReference !== undefined ? { entryReference } : {}),
  }
}

export const makeEnableBankingService = (config: BankProviderConfig) => {
  const origin = originOf(config.baseUrl)

  const credentialsMissing = (): ProviderUnavailable | null =>
    config.applicationId.trim() === "" || config.privateKeyPem.trim() === ""
      ? new ProviderUnavailable({ message: "Enable Banking credentials missing" })
      : null

  const request = (
    method: string,
    path: string,
    options?: {
      readonly body?: unknown
      readonly psu?: boolean
      readonly parseJson?: boolean
    },
  ): Effect.Effect<unknown, ProviderUnavailable> =>
    Effect.gen(function* () {
      const missing = credentialsMissing()
      if (missing !== null) {
        return yield* missing
      }
      const jwt = yield* Effect.tryPromise({
        try: () => signEnableBankingJwt(config.applicationId, config.privateKeyPem),
        catch: (cause) =>
          new ProviderUnavailable({ message: "Enable Banking JWT signing failed", cause }),
      })
      const headers: Record<string, string> = {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      }
      if (options?.psu === true) {
        if (config.psuIp === "") {
          return yield* new ProviderUnavailable({
            message: "ENABLEBANKING_PSU_IP is required for AIS requests",
          })
        }
        headers["Psu-Ip-Address"] = config.psuIp
        headers["Psu-User-Agent"] = config.psuUserAgent
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${origin}${path}`, {
            method,
            headers,
            signal: AbortSignal.timeout(30_000),
            ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          }),
        catch: (cause) =>
          new ProviderUnavailable({
            message: `Enable Banking request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      })
      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new ProviderUnavailable({
            message: `Enable Banking response read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      })
      if (response.status < 200 || response.status >= 300) {
        return yield* new ProviderUnavailable({
          message: `Enable Banking ${String(response.status)}`,
          status: response.status,
        })
      }
      if (options?.parseJson === false) {
        return undefined
      }
      return yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (cause) =>
          new ProviderUnavailable({ message: "Enable Banking response is not JSON", cause }),
      })
    })

  const listAspsps = (): Effect.Effect<readonly BankAspsp[], ProviderUnavailable> =>
    Effect.gen(function* () {
      const body = yield* request("GET", "/aspsps")
      const aspsps = asRecord(body)?.["aspsps"]
      if (!Array.isArray(aspsps)) {
        return yield* new ProviderUnavailable({ message: "Enable Banking ASPSP response missing aspsps" })
      }
      const mapped: BankAspsp[] = []
      for (const item of aspsps) {
        const record = asRecord(item)
        const name = asString(record?.["name"])
        const country = asString(record?.["country"])
        if (name === undefined || country === undefined) {
          return yield* new ProviderUnavailable({ message: "Enable Banking ASPSP response contains invalid ASPSP" })
        }
        mapped.push({ name, country })
      }
      return mapped
    })

  const startAuthorization = (input: {
    readonly aspsp: BankAspsp
    readonly redirectUrl: string
    readonly state: string
  }): Effect.Effect<{ readonly url: string }, ProviderUnavailable> =>
    Effect.gen(function* () {
      const validUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
      const body = yield* request(
        "POST",
        "/auth",
        {
          psu: true,
          body: {
            access: { valid_until: validUntil },
            aspsp: input.aspsp,
            state: input.state,
            redirect_url: input.redirectUrl,
            psu_type: "personal",
          },
        },
      )
      const url = parseHttpsUrl(asRecord(body)?.["url"])
      if (url === undefined) {
        return yield* new ProviderUnavailable({ message: "Enable Banking auth response missing url" })
      }
      return { url }
    })

  const createSession = (code: string): Effect.Effect<
    { readonly sessionId: string; readonly accounts: readonly BankAccountSnapshot[] },
    ProviderUnavailable
  > =>
    Effect.gen(function* () {
      const body = yield* request("POST", "/sessions", { psu: true, body: { code } })
      const record = asRecord(body)
      const sessionId = asString(record?.["session_id"])
      if (sessionId === undefined) {
        return yield* new ProviderUnavailable({
          message: "Enable Banking session response missing session_id",
        })
      }
      const rawAccounts = record?.["accounts"]
      const accounts: BankAccountSnapshot[] = []
      if (Array.isArray(rawAccounts)) {
        for (const item of rawAccounts) {
          const mapped = mapAccount(item)
          if (mapped !== undefined) {
            accounts.push(mapped)
          }
        }
      }
      return { sessionId, accounts }
    })

  const sessionAccountUids = (
    sessionId: string,
  ): Effect.Effect<readonly string[], ProviderUnavailable> =>
    Effect.gen(function* () {
      const body = yield* request("GET", `/sessions/${encodeURIComponent(sessionId)}`)
      const rawAccounts = asRecord(body)?.["accounts"]
      return Array.isArray(rawAccounts)
        ? rawAccounts.filter((item): item is string => typeof item === "string")
        : []
    })

  const listAccounts = (
    sessionId: string,
  ): Effect.Effect<readonly BankAccountSnapshot[], ProviderUnavailable> =>
    Effect.gen(function* () {
      const uids = yield* sessionAccountUids(sessionId)
      // ponytail: unbounded forEach is fibers
      return yield* Effect.forEach(
        uids,
        (uid) =>
          Effect.gen(function* () {
            const details = yield* request("GET", `/accounts/${encodeURIComponent(uid)}/details`, {
              psu: true,
            })
            return mapAccount(details, uid) ?? { externalAccountId: uid }
          }),
        { concurrency: "unbounded" },
      )
    })

  const listTransactions = (
    sessionId: string,
    accountExternalId: string,
    since?: Schema.Schema.Type<typeof IsoDate>,
  ): Effect.Effect<readonly BankTransactionSnapshot[], ProviderUnavailable> =>
    Effect.gen(function* () {
      const uids = yield* sessionAccountUids(sessionId)
      if (!uids.includes(accountExternalId)) {
        return yield* new ProviderUnavailable({
          message: "account is not in the Enable Banking session",
        })
      }
      const collected: BankTransactionSnapshot[] = []
      let continuation: string | undefined
      for (;;) {
        const query = new URLSearchParams()
        query.set("transaction_status", "BOOK")
        if (since !== undefined) {
          query.set("date_from", since)
        }
        if (continuation !== undefined) {
          query.set("continuation_key", continuation)
        }
        const qs = query.toString()
        const path = `/accounts/${encodeURIComponent(accountExternalId)}/transactions${qs === "" ? "" : `?${qs}`}`
        const body = yield* request("GET", path, { psu: true })
        const record = asRecord(body)
        const rows = record?.["transactions"]
        if (Array.isArray(rows)) {
          for (const item of rows) {
            const mapped = mapTransaction(item)
            if (mapped !== undefined) {
              collected.push(mapped)
            }
          }
        }
        const next = asString(record?.["continuation_key"])
        if (next === undefined || next === continuation) {
          break
        }
        continuation = next
      }
      return collected
    })

  const deleteSession = (sessionId: string): Effect.Effect<void, ProviderUnavailable> =>
    request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`, { parseJson: false, psu: true }).pipe(
      Effect.asVoid,
    )

  const mapPayment = (raw: unknown): BankPayment | undefined => {
    const record = asRecord(raw)
    const paymentId = asString(record?.["payment_id"])
    const status = asString(record?.["status"])
    if (paymentId === undefined || status === undefined) {
      return undefined
    }
    const rawUrl = record?.["url"]
    const url = rawUrl === undefined ? undefined : parseHttpsUrl(rawUrl)
    if (rawUrl !== undefined && url === undefined) {
      return undefined
    }
    return { paymentId, status, ...(url === undefined ? {} : { url }) }
  }

  const requirePayment = (raw: unknown, action: string): Effect.Effect<BankPayment, ProviderUnavailable> => {
    const mapped = mapPayment(raw)
    if (mapped === undefined) {
      return Effect.fail(new ProviderUnavailable({ message: `Enable Banking ${action} returned no payment` }))
    }
    return Effect.succeed(mapped)
  }

  const createPayment = (
    input: CreateBankPaymentInput,
  ): Effect.Effect<BankPayment, ProviderUnavailable> =>
    request("POST", "/payments", {
      psu: true,
      body: {
        aspsp: { name: input.aspsp.name, country: input.aspsp.country },
        redirect_url: input.redirectUrl,
        state: input.state,
        payment_type: input.paymentType,
        payment_request: {
          credit_transfer_transaction: [
            {
              beneficiary: {
                creditor: { name: input.creditorName },
                creditor_account: { identification: input.creditorIban, scheme_name: "IBAN" },
              },
              instructed_amount: {
                amount: toMajor(input.amountMinor, input.currency),
                currency: input.currency,
              },
              ...(input.remittance === undefined
                ? {}
                : { remittance_information: [input.remittance] }),
            },
          ],
        },
      },
    }).pipe(Effect.flatMap((raw) => requirePayment(raw, "createPayment")))

  const getPayment = (paymentId: string): Effect.Effect<BankPayment, ProviderUnavailable> =>
    request("GET", `/payments/${encodeURIComponent(paymentId)}`).pipe(
      Effect.flatMap((raw) => requirePayment(raw, "getPayment")),
    )

  const submitPayment = (paymentId: string): Effect.Effect<BankPayment, ProviderUnavailable> =>
    request("POST", `/payments/${encodeURIComponent(paymentId)}/submit`, { psu: true }).pipe(
      Effect.flatMap((raw) => requirePayment(raw, "submitPayment")),
    )

  const deletePayment = (paymentId: string): Effect.Effect<void, ProviderUnavailable> =>
    request("DELETE", `/payments/${encodeURIComponent(paymentId)}`, { parseJson: false }).pipe(Effect.asVoid)

  return BankProvider.of({
    listAspsps,
    startAuthorization,
    createSession,
    listAccounts,
    listTransactions,
    deleteSession,
    createPayment,
    getPayment,
    submitPayment,
    deletePayment,
  })
}

export const EnableBankingLive: Layer.Layer<BankProvider, ValidationFailed, AppConfig> = Layer.effect(
  BankProvider,
  Effect.gen(function* () {
    const config = yield* AppConfigTag
    if (config.enableBankingApplicationId.trim() === "") {
      return yield* new ValidationFailed({
        issues: [
          "Enable Banking applicationId is empty (config.enableBankingApplicationId). Set bank.application_id in finch.toml or ENABLEBANKING_APPLICATION_ID env.",
        ],
      })
    }
    if (config.enableBankingPrivateKey.trim() === "") {
      return yield* new ValidationFailed({
        issues: [
          "Enable Banking privateKeyPem is empty (config.enableBankingPrivateKey). Set ENABLEBANKING_PRIVATE_KEY env or keyring service=finch name=ENABLEBANKING_PRIVATE_KEY.",
        ],
      })
    }
    return makeEnableBankingService({
      baseUrl: config.enableBankingBaseUrl,
      applicationId: config.enableBankingApplicationId,
      privateKeyPem: config.enableBankingPrivateKey,
      psuIp: config.enableBankingPsuIp,
      psuUserAgent: config.enableBankingPsuUserAgent,
    })
  }),
)
