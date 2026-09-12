import type { HandlerContext } from "@connectrpc/connect"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AuthentikPrincipalResolver,
  IdentityProviderUnavailableError,
} from "../../packages/connect/src/index.ts"

const discoveryUrl = "https://authentik.test/application/o/finch/.well-known/openid-configuration"
const issuer = "https://authentik.test/application/o/finch/"
const jwksUrl = "https://authentik.test/application/o/finch/jwks/"
const audience = "finch-connect"
const accessTokenClaim = { name: "token_use", value: "access" }
const structurallyValidAccessToken = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImtpZCJ9.e30.AA"

const config = {
  discoveryUrl,
  issuer,
  audience,
  accessTokenClaimName: accessTokenClaim.name,
  accessTokenClaimValue: accessTokenClaim.value,
  aal2AcrValues: ["urn:finch:aal2"],
}

const resolve = (resolver: AuthentikPrincipalResolver, token?: string) =>
  resolver.resolve({
    requestHeader: new Headers(token === undefined ? undefined : { authorization: `Bearer ${token}` }),
  } as HandlerContext)

const fetchUrl = (input: unknown): string => {
  if (typeof input === "string") {
    return input
  }
  if (input instanceof URL) {
    return input.href
  }
  if (input instanceof Request) {
    return input.url
  }
  throw new Error("unexpected fetch input")
}

const installOidcFetch = (metadata: object, jwks: readonly object[] | (() => Response)) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      switch (fetchUrl(input)) {
        case discoveryUrl:
          expect(init).toMatchObject({ redirect: "error" })
          return Response.json(metadata)
        case jwksUrl:
        case "http://authentik.test/application/o/finch/jwks/":
          return typeof jwks === "function" ? jwks() : Response.json({ keys: jwks })
        default:
          return new Response(null, { status: 404 })
      }
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("AuthentikPrincipalResolver", () => {
  it("rejects non-HTTPS configuration URLs", () => {
    expect(() => new AuthentikPrincipalResolver({ ...config, discoveryUrl: "http://authentik.test/openid" })).toThrow(
      "discoveryUrl must be an HTTPS URL",
    )
    expect(() => new AuthentikPrincipalResolver({ ...config, issuer: "http://authentik.test/issuer" })).toThrow(
      "issuer must be an HTTPS URL",
    )
    expect(() => new AuthentikPrincipalResolver({ ...config, accessTokenClaimName: " " })).toThrow(
      "accessTokenClaimName must be a nonblank string",
    )
    expect(() => new AuthentikPrincipalResolver({ ...config, accessTokenClaimValue: " " })).toThrow(
      "accessTokenClaimValue must be a nonblank string",
    )
  })

  it.each([
    ["malformed metadata", []],
    ["missing issuer metadata", { jwks_uri: jwksUrl }],
    ["missing JWKS URI metadata", { issuer }],
    ["mismatched issuer metadata", { issuer: "https://authentik.test/application/o/other/", jwks_uri: jwksUrl }],
    ["invalid JWKS URI metadata", { issuer, jwks_uri: "not a URL" }],
    ["non-HTTPS JWKS URI metadata", { issuer, jwks_uri: "http://authentik.test/application/o/finch/jwks/" }],
  ])("surfaces %s as an identity-provider outage", async (_name, metadata) => {
    installOidcFetch(metadata, [])
    await expect(
      resolve(new AuthentikPrincipalResolver(config), structurallyValidAccessToken),
    ).rejects.toBeInstanceOf(IdentityProviderUnavailableError)
  })

  it.each([
    ["a 4xx response", () => new Response(null, { status: 404 })],
    ["a 5xx response", () => new Response(null, { status: 503 })],
    [
      "an invalid JSON response",
      () => new Response("{", { headers: { "content-type": "application/json" } }),
    ],
  ])("surfaces OIDC discovery %s as an identity-provider outage", async (_name, discovery) => {
    vi.stubGlobal("fetch", vi.fn(async () => discovery()))
    await expect(
      resolve(new AuthentikPrincipalResolver(config), structurallyValidAccessToken),
    ).rejects.toBeInstanceOf(IdentityProviderUnavailableError)
  })

  it.each([
    ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["missing keys", () => Response.json({})],
    ["an invalid key", () => Response.json({ keys: [{ kid: "kid", kty: "RSA" }] })],
  ])("surfaces JWKS with %s as an identity-provider outage", async (_name, jwks) => {
    installOidcFetch({ issuer, jwks_uri: jwksUrl }, jwks)
    await expect(
      resolve(new AuthentikPrincipalResolver(config), structurallyValidAccessToken),
    ).rejects.toBeInstanceOf(IdentityProviderUnavailableError)
  })

  it("verifies HTTPS JWKS signatures and rejects invalid or non-access tokens", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true })
    const publicJwk = await exportJWK(publicKey)
    const key = { ...publicJwk, alg: "RS256", kid: "authentik-test-key", use: "sig" }
    installOidcFetch({ issuer, jwks_uri: jwksUrl }, [key])

    const resolver = new AuthentikPrincipalResolver(config)
    const resolveToken = (token?: string) => resolve(resolver, token)
    const now = Math.floor(Date.now() / 1000)
    const issue = async (
      claims: Record<string, unknown>,
      options: {
        readonly issuer?: string
        readonly audience?: string
        readonly subject?: string
        readonly expiration?: number
        readonly notBefore?: number
      } = {},
    ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "authentik-test-key" })
        .setIssuer(options.issuer ?? issuer)
        .setSubject(options.subject ?? "authentik-subject")
        .setAudience(options.audience ?? audience)
        .setIssuedAt(now)
        .setNotBefore(options.notBefore ?? now - 1)
        .setExpirationTime(options.expiration ?? now + 60)
        .sign(privateKey)

    const authenticatedAt = now - 30
    await expect(
      resolveToken(await issue({ auth_time: authenticatedAt, token_use: "access", acr: "unconfigured" })),
    ).resolves.toEqual({
      issuer,
      subjectId: "authentik-subject",
      assurance: "aal1",
      authenticatedAt: new Date(authenticatedAt * 1000),
    })
    await expect(
      resolveToken(await issue({ auth_time: authenticatedAt, token_use: "access", acr: "urn:finch:aal2" })),
    ).resolves.toEqual({
      issuer,
      subjectId: "authentik-subject",
      assurance: "aal2",
      authenticatedAt: new Date(authenticatedAt * 1000),
    })
    await expect(resolveToken(await issue({ auth_time: authenticatedAt, token_use: "access" }))).resolves.toMatchObject({
      assurance: "aal1",
    })

    const { privateKey: unknownPrivateKey } = await generateKeyPair("RS256")
    const unknownKeyToken = await new SignJWT({ auth_time: authenticatedAt, token_use: "access" })
      .setProtectedHeader({ alg: "RS256", kid: "unknown-key" })
      .setIssuer(issuer)
      .setSubject("authentik-subject")
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(unknownPrivateKey)

    await expect(resolveToken()).resolves.toBeUndefined()
    await expect(resolveToken("not-a-jwt")).resolves.toBeUndefined()
    await expect(resolveToken(await issue({ auth_time: authenticatedAt, token_use: "access" }, { expiration: now - 1 }))).resolves.toBeUndefined()
    await expect(resolveToken(await issue({ auth_time: authenticatedAt, token_use: "access" }, { notBefore: now + 60 }))).resolves.toBeUndefined()
    await expect(resolveToken(await issue({ auth_time: authenticatedAt, token_use: "access" }, { audience: "other-service" }))).resolves.toBeUndefined()
    await expect(resolveToken(await issue({ auth_time: authenticatedAt, token_use: "access" }, { issuer: `${issuer}other` }))).resolves.toBeUndefined()
    await expect(resolveToken(unknownKeyToken)).resolves.toBeUndefined()
    await expect(resolveToken(await issue({ auth_time: authenticatedAt }))).resolves.toBeUndefined()
    await expect(resolveToken(await issue({ auth_time: authenticatedAt, token_use: "id" }))).resolves.toBeUndefined()
    await expect(resolveToken(await issue({ token_use: "access" }))).resolves.toBeUndefined()
    await expect(resolveToken(await issue({ auth_time: authenticatedAt, token_use: "access" }, { subject: " " }))).resolves.toBeUndefined()
    await expect(resolveToken(await issue({ auth_time: "not-a-number", token_use: "access" }))).resolves.toBeUndefined()
  })
})
