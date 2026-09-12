import { Effect, Layer } from "effect"
import { BankProvider } from "@finch/core"
import {
  AspspDirectory,
  BankAuthorizationGateway,
  BankUnavailable,
  type ProviderAspsp,
} from "@finch/lib"

const CONTROL = /[\p{Cc}]/u
const COUNTRY = /^[A-Z]{2}$/
const BASE64URL = /^[A-Za-z0-9_-]+$/

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const normalizeName = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const name = value.trim()
  return name === "" || CONTROL.test(name) ? undefined : name
}

const normalizeCountry = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const country = value.trim().toUpperCase()
  return COUNTRY.test(country) ? country : undefined
}

const normalizeAspsps = (value: unknown): Effect.Effect<readonly ProviderAspsp[], BankUnavailable> => {
  if (!Array.isArray(value)) {
    return Effect.fail(new BankUnavailable())
  }

  const aspsps: ProviderAspsp[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const record = asRecord(item)
    const name = normalizeName(record?.name)
    const country = normalizeCountry(record?.country)
    if (name === undefined || country === undefined) {
      return Effect.fail(new BankUnavailable())
    }
    const identity = `${country}\u0000${name}`
    if (!seen.has(identity)) {
      seen.add(identity)
      aspsps.push({ name, country })
    }
  }
  aspsps.sort((left, right) =>
    left.country === right.country
      ? left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      : left.country < right.country ? -1 : 1,
  )
  return Effect.succeed(aspsps)
}

const encodePageToken = (country: string | undefined, offset: number): string =>
  btoa(JSON.stringify([country ?? null, offset]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

const decodePageToken = (
  value: string | undefined,
  country: string | undefined,
): Effect.Effect<number, BankUnavailable> => {
  if (value === undefined || value === "") {
    return Effect.succeed(0)
  }
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    return Effect.fail(new BankUnavailable())
  }
  return Effect.try({
    try: () => {
      const decoded = atob(
        value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "="),
      )
      if (btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== value) {
        throw new Error("invalid page token")
      }
      const token = JSON.parse(decoded)
      if (
        !Array.isArray(token) ||
        token.length !== 2 ||
        (token[0] !== null && typeof token[0] !== "string") ||
        token[0] !== (country ?? null) ||
        typeof token[1] !== "number" ||
        !Number.isSafeInteger(token[1]) ||
        token[1] <= 0 ||
        encodePageToken(country, token[1]) !== value
      ) {
        throw new Error("invalid page token")
      }
      return token[1]
    },
    catch: () => new BankUnavailable(),
  })
}

const authorizationUrl = (value: unknown): Effect.Effect<{ readonly url: string }, BankUnavailable> =>
  Effect.try({
    try: () => {
      const url = asRecord(value)?.url
      if (typeof url !== "string") {
        throw new Error("authorization URL is missing")
      }
      const parsed = new URL(url)
      if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
        throw new Error("authorization URL is unsafe")
      }
      return { url: parsed.toString() }
    },
    catch: () => new BankUnavailable(),
  })

const listProviderAspsps = (provider: ReturnType<typeof BankProvider.of>) =>
  provider.listAspsps().pipe(
    Effect.mapError(() => new BankUnavailable()),
    Effect.flatMap(normalizeAspsps),
  )

export const EnableBankingLibLive = Layer.mergeAll(
  Layer.effect(
    AspspDirectory,
    Effect.gen(function* () {
      const provider = yield* BankProvider
      return AspspDirectory.of({
        listAspsps: (input) =>
          Effect.gen(function* () {
            const country = input.country === undefined ? undefined : normalizeCountry(input.country)
            if (input.country !== undefined && country === undefined) {
              return yield* new BankUnavailable()
            }
            if (!Number.isSafeInteger(input.page.pageSize) || input.page.pageSize <= 0) {
              return yield* new BankUnavailable()
            }
            const offset = yield* decodePageToken(input.page.pageToken, country)
            const aspsps = yield* listProviderAspsps(provider)
            const matching = country === undefined ? aspsps : aspsps.filter((aspsp) => aspsp.country === country)
            const page = matching.slice(offset, offset + input.page.pageSize)
            const nextOffset = offset + page.length
            return {
              aspsps: page,
              ...(nextOffset < matching.length ? { nextPageToken: encodePageToken(country, nextOffset) } : {}),
            }
          }),
        resolveAspsp: (identity) =>
          listProviderAspsps(provider).pipe(
            Effect.map((aspsps) =>
              aspsps.find((aspsp) => aspsp.country === identity.country && aspsp.name === identity.name) ?? null),
          ),
      })
    }),
  ),
  Layer.effect(
    BankAuthorizationGateway,
    Effect.gen(function* () {
      const provider = yield* BankProvider
      return BankAuthorizationGateway.of({
        startAuthorization: (input) =>
          provider.startAuthorization(input).pipe(
            Effect.flatMap(authorizationUrl),
            Effect.mapError(() => new BankUnavailable()),
          ),
        deleteSession: (sessionId) =>
          provider.deleteSession(sessionId).pipe(
            Effect.catchAll((error) =>
              error.status === 404 ? Effect.void : Effect.fail(new BankUnavailable())),
          ),
      })
    }),
  ),
)
