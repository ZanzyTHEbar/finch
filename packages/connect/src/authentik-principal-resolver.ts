import { createRemoteJWKSet, customFetch, errors, jwtVerify, type RemoteJWKSet } from "jose"
import type { HandlerContext } from "@connectrpc/connect"
import type { PrincipalContext } from "@finch/lib"
import { IdentityProviderUnavailableError, type ConnectPrincipalResolver } from "./principal.ts"

const CACHE_MAX_AGE_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 5_000

export interface AuthentikPrincipalResolverConfig {
  readonly discoveryUrl: string
  readonly issuer: string
  readonly audience: string
  readonly accessTokenClaimName: string
  readonly accessTokenClaimValue: string
  readonly aal2AcrValues?: readonly string[]
}

const nonblank = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a nonblank string`)
  }
  return value
}

const httpsUrl = (value: unknown, name: string): URL => {
  const url = new URL(nonblank(value, name))
  if (url.protocol !== "https:") {
    throw new Error(`${name} must be an HTTPS URL`)
  }
  return url
}

const bearerToken = (authorization: string | null): string | undefined => {
  const match = /^Bearer\s+([^\s]+)$/.exec(authorization ?? "")
  return match?.[1]
}

const invalidJwks = (error: unknown): boolean =>
  error instanceof errors.JWKInvalid ||
  error instanceof errors.JWKSInvalid ||
  (error instanceof errors.JOSEError && error.code === "ERR_JOSE_GENERIC") ||
  error instanceof TypeError ||
  error instanceof DOMException

/** Verifies Authentik OIDC access tokens before creating a trusted principal. */
export class AuthentikPrincipalResolver implements ConnectPrincipalResolver {
  readonly #discoveryUrl: URL
  readonly #issuer: string
  readonly #audience: string
  readonly #accessTokenClaimName: string
  readonly #accessTokenClaimValue: string
  readonly #aal2AcrValues: ReadonlySet<string>
  #jwks: RemoteJWKSet | undefined
  #jwksExpiresAt = 0
  #jwksLoading: Promise<RemoteJWKSet> | undefined

  constructor(config: AuthentikPrincipalResolverConfig) {
    this.#discoveryUrl = httpsUrl(config.discoveryUrl, "discoveryUrl")
    this.#issuer = nonblank(config.issuer, "issuer")
    httpsUrl(this.#issuer, "issuer")
    this.#audience = nonblank(config.audience, "audience")
    this.#accessTokenClaimName = nonblank(config.accessTokenClaimName, "accessTokenClaimName")
    this.#accessTokenClaimValue = nonblank(config.accessTokenClaimValue, "accessTokenClaimValue")
    this.#aal2AcrValues = new Set(
      (config.aal2AcrValues ?? []).map((value) => nonblank(value, "aal2AcrValues entry")),
    )
  }

  readonly resolve = async (context: HandlerContext): Promise<PrincipalContext | undefined> => {
    try {
      const token = bearerToken(context.requestHeader.get("authorization"))
      if (token === undefined) {
        return undefined
      }

      const { payload } = await jwtVerify(token, await this.#remoteJwks(), {
        algorithms: ["RS256"],
        issuer: this.#issuer,
        audience: this.#audience,
        requiredClaims: ["exp", "auth_time", this.#accessTokenClaimName],
      })
      if (payload[this.#accessTokenClaimName] !== this.#accessTokenClaimValue) {
        return undefined
      }
      if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
        return undefined
      }
      if (typeof payload.auth_time !== "number" || !Number.isFinite(payload.auth_time)) {
        return undefined
      }

      const authenticatedAt = new Date(payload.auth_time * 1000)
      if (Number.isNaN(authenticatedAt.getTime()) || payload.iss !== this.#issuer) {
        return undefined
      }

      return {
        issuer: payload.iss,
        subjectId: payload.sub,
        assurance:
          typeof payload.acr === "string" && this.#aal2AcrValues.has(payload.acr) ? "aal2" : "aal1",
        authenticatedAt,
      }
    } catch (error) {
      if (error instanceof IdentityProviderUnavailableError || invalidJwks(error)) {
        throw new IdentityProviderUnavailableError()
      }
      return undefined
    }
  }

  async #remoteJwks(): Promise<RemoteJWKSet> {
    if (this.#jwks !== undefined && Date.now() < this.#jwksExpiresAt) {
      return this.#jwks
    }
    if (this.#jwksLoading !== undefined) {
      return this.#jwksLoading
    }

    const loading = this.#discoverJwks()
    this.#jwksLoading = loading
    try {
      return await loading
    } finally {
      if (this.#jwksLoading === loading) {
        this.#jwksLoading = undefined
      }
    }
  }

  async #discoverJwks(): Promise<RemoteJWKSet> {
    try {
      const response = await fetch(this.#discoveryUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      })
      if (!response.ok) {
        throw new IdentityProviderUnavailableError()
      }

      const metadata: unknown = await response.json()
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        (metadata as { readonly issuer?: unknown }).issuer !== this.#issuer
      ) {
        throw new Error("OIDC discovery issuer does not match configured issuer")
      }
      const jwksUrl = httpsUrl((metadata as { readonly jwks_uri?: unknown }).jwks_uri, "jwks_uri")
      const jwks = createRemoteJWKSet(jwksUrl, {
        cacheMaxAge: CACHE_MAX_AGE_MS,
        cooldownDuration: 30_000,
        timeoutDuration: REQUEST_TIMEOUT_MS,
        [customFetch]: async (url, options) => {
          try {
            const response = await fetch(url, options)
            if (response.status !== 200) {
              throw new IdentityProviderUnavailableError()
            }
            return response
          } catch (error) {
            if (error instanceof IdentityProviderUnavailableError) {
              throw error
            }
            throw new IdentityProviderUnavailableError()
          }
        },
      })
      this.#jwks = jwks
      this.#jwksExpiresAt = Date.now() + CACHE_MAX_AGE_MS
      return jwks
    } catch (error) {
      if (error instanceof IdentityProviderUnavailableError) {
        throw error
      }
      throw new IdentityProviderUnavailableError()
    }
  }
}
