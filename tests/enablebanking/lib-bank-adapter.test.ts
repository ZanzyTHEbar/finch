import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { BankProvider, ProviderUnavailable, type BankAspsp } from "../../packages/core/src/ports/bank-provider.ts"
import {
  AspspDirectory,
  BankAuthorizationGateway,
  BankUnavailable,
  type ProviderAspsp,
} from "../../packages/lib/src/index.ts"
import { EnableBankingLibLive } from "../../packages/enablebanking/src/lib-bank-adapter.ts"

interface ProviderOptions {
  readonly aspsps?: readonly BankAspsp[]
  readonly listError?: ProviderUnavailable
  readonly authorizationUrl?: string
  readonly authorizationError?: ProviderUnavailable
  readonly deleteError?: ProviderUnavailable
  readonly onStartAuthorization?: (input: {
    readonly aspsp: BankAspsp
    readonly redirectUrl: string
    readonly state: string
  }) => void
  readonly onDeleteSession?: (sessionId: string) => void
}

const providerUnavailable = (message: string, status?: number) =>
  new ProviderUnavailable({ message, ...(status === undefined ? {} : { status }) })

const fakeProvider = (options: ProviderOptions = {}) =>
  BankProvider.of({
    listAspsps: () =>
      options.listError === undefined
        ? Effect.succeed(options.aspsps ?? [])
        : Effect.fail(options.listError),
    startAuthorization: (input) => {
      options.onStartAuthorization?.(input)
      return options.authorizationError === undefined
        ? Effect.succeed({ url: options.authorizationUrl ?? "https://bank.example.test/authorize" })
        : Effect.fail(options.authorizationError)
    },
    createSession: () => Effect.die("not used"),
    listAccounts: () => Effect.die("not used"),
    listTransactions: () => Effect.die("not used"),
    deleteSession: (sessionId) => {
      options.onDeleteSession?.(sessionId)
      return options.deleteError === undefined ? Effect.void : Effect.fail(options.deleteError)
    },
    createPayment: () => Effect.die("not used"),
    getPayment: () => Effect.die("not used"),
    submitPayment: () => Effect.die("not used"),
    deletePayment: () => Effect.die("not used"),
  })

const adapterLayer = (provider = fakeProvider()) =>
  Layer.provide(EnableBankingLibLive, Layer.succeed(BankProvider, provider))

const withDirectory = <A>(
  provider: ReturnType<typeof fakeProvider>,
  operation: (directory: AspspDirectory) => Effect.Effect<A, BankUnavailable>,
) =>
  Effect.gen(function* () {
    return yield* operation(yield* AspspDirectory)
  }).pipe(Effect.provide(adapterLayer(provider)))

const withGateway = <A>(
  provider: ReturnType<typeof fakeProvider>,
  operation: (gateway: BankAuthorizationGateway) => Effect.Effect<A, BankUnavailable>,
) =>
  Effect.gen(function* () {
    return yield* operation(yield* BankAuthorizationGateway)
  }).pipe(Effect.provide(adapterLayer(provider)))

describe("Enable Banking lib adapter", () => {
  it("normalizes ASPSPs, filters uppercase countries, and returns deterministic opaque pages", async () => {
    const provider = fakeProvider({
      aspsps: [
        { name: " Zeta Bank ", country: "fi" },
        { name: " Beta Bank ", country: "pt" },
        { name: "Alpha Bank", country: "PT" },
        { name: "Other Bank", country: "DE" },
      ],
    })
    const page = { country: "PT", page: { pageSize: 1 } }

    const first = await Effect.runPromise(withDirectory(provider, (directory) => directory.listAspsps(page)))
    expect(first).toEqual({
      aspsps: [{ name: "Alpha Bank", country: "PT" }],
      nextPageToken: expect.any(String),
    })
    if (first.nextPageToken === undefined) {
      throw new Error("expected an opaque nextPageToken")
    }

    const repeated = await Effect.runPromise(withDirectory(provider, (directory) => directory.listAspsps(page)))
    expect(repeated).toEqual(first)
    await expect(
      Effect.runPromise(
        withDirectory(provider, (directory) =>
          directory.listAspsps({ country: "PT", page: { pageSize: 1, pageToken: first.nextPageToken } }),
        ),
      ),
    ).resolves.toEqual({ aspsps: [{ name: "Beta Bank", country: "PT" }] })
  })

  it("resolves only the exact normalized ASPSP identifier", async () => {
    const provider = fakeProvider({
      aspsps: [{ name: "  Demo Bank  ", country: "pt" }],
    })

    await expect(
      Effect.runPromise(
        withDirectory(provider, (directory) => directory.resolveAspsp({ name: "Demo Bank", country: "PT" })),
      ),
    ).resolves.toEqual({ name: "Demo Bank", country: "PT" } satisfies ProviderAspsp)
    await expect(
      Effect.runPromise(
        withDirectory(provider, (directory) => directory.resolveAspsp({ name: "demo bank", country: "PT" })),
      ),
    ).resolves.toBeNull()
  })

  it("maps provider failures and malformed provider ASPSPs to BankUnavailable", async () => {
    const providerFailure = fakeProvider({ listError: providerUnavailable("Enable Banking 503") })
    const malformedProvider = fakeProvider({
      aspsps: [{ name: "\u0000", country: "PT" }] as never,
    })

    for (const provider of [providerFailure, malformedProvider]) {
      const exit = await Effect.runPromiseExit(
        withDirectory(provider, (directory) => directory.listAspsps({ page: { pageSize: 1 } })),
      )
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: { _tag: "Fail", error: { _tag: "BankUnavailable" } },
      })
    }
  })

  it("starts authorization with the supplied canonical ASPSP, state, and redirect URL", async () => {
    const calls: unknown[] = []
    const provider = fakeProvider({
      onStartAuthorization: (input) => calls.push(input),
      authorizationUrl: "https://bank.example.test/authorize?state=opaque-state",
    })
    const input = {
      aspsp: { name: "Demo Bank", country: "PT" },
      state: "opaque-state",
      redirectUrl: "https://finch.example.test/bank/callback",
    }

    await expect(
      Effect.runPromise(withGateway(provider, (gateway) => gateway.startAuthorization(input))),
    ).resolves.toEqual({ url: "https://bank.example.test/authorize?state=opaque-state" })
    expect(calls).toEqual([input])
  })

  it("returns only credential-free HTTPS authorization URLs and maps provider failures", async () => {
    const input = {
      aspsp: { name: "Demo Bank", country: "PT" },
      state: "opaque-state",
      redirectUrl: "https://finch.example.test/bank/callback",
    }

    for (const provider of [
      fakeProvider({ authorizationUrl: "http://bank.example.test/authorize" }),
      fakeProvider({ authorizationUrl: "https://client:secret@bank.example.test/authorize" }),
      fakeProvider({ authorizationUrl: "not a URL" }),
      fakeProvider({ authorizationError: providerUnavailable("Enable Banking 503") }),
    ]) {
      const exit = await Effect.runPromiseExit(
        withGateway(provider, (gateway) => gateway.startAuthorization(input)),
      )
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: { _tag: "Fail", error: { _tag: "BankUnavailable" } },
      })
    }
  })

  it("treats a provider 404 remote deletion as idempotent and maps other provider errors", async () => {
    const deleted: string[] = []
    const missing = fakeProvider({
      deleteError: providerUnavailable("session missing", 404),
      onDeleteSession: (sessionId) => deleted.push(sessionId),
    })

    await expect(
      Effect.runPromise(withGateway(missing, (gateway) => gateway.deleteSession("already-deleted"))),
    ).resolves.toBeUndefined()
    expect(deleted).toEqual(["already-deleted"])

    for (const error of [providerUnavailable("Enable Banking 404"), providerUnavailable("unavailable", 503)]) {
      const unavailable = fakeProvider({ deleteError: error })
      const exit = await Effect.runPromiseExit(
        withGateway(unavailable, (gateway) => gateway.deleteSession("unavailable-session")),
      )
      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: { _tag: "Fail", error: { _tag: "BankUnavailable" } },
      })
    }
  })
})
