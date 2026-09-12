import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Code, ConnectError, createClient } from "@connectrpc/connect"
import { connectNodeAdapter, createConnectTransport } from "@connectrpc/connect-node"
import { Effect, Layer, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SearchService } from "../../packages/contracts/src/index.ts"
import {
  SearchPort,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceAccessUnavailable,
  WorkspaceId,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"
import {
  HybridSearchPortLive,
  AuthentikPrincipalResolver,
  makeSearchService,
  type ConnectPrincipalResolver,
} from "../../packages/connect/src/index.ts"
import { HybridSearch, type HybridSearchResult } from "../../packages/search/src/hybrid.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const principal: PrincipalContext = {
  issuer: "https://id.example.test",
  subjectId: "subject-1",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

const trustedResolver: ConnectPrincipalResolver = { resolve: () => principal }
const oidcConfig = {
  discoveryUrl: "https://authentik.test/application/o/finch/.well-known/openid-configuration",
  issuer: "https://authentik.test/application/o/finch/",
  audience: "finch-connect",
  accessTokenClaimName: "token_use",
  accessTokenClaimValue: "access",
}
const structurallyValidAccessToken = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImtpZCJ9.e30.AA"

afterEach(() => vi.unstubAllGlobals())

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )

const serve = async (
  principalResolver: ConnectPrincipalResolver,
  workspaceAccess: WorkspaceAccess,
  searchPort: SearchPort,
) => {
  const handle = makeSearchService({
    principalResolver,
    layer: Layer.mergeAll(
      Layer.succeed(WorkspaceAccess, workspaceAccess),
      Layer.succeed(SearchPort, searchPort),
    ),
  })
  const server = createServer(
    connectNodeAdapter({ routes: (router) => router.service(SearchService, handle.impl) }),
  )
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  return {
    client: createClient(
      SearchService,
      createConnectTransport({ baseUrl: `http://127.0.0.1:${address.port}`, httpVersion: "1.1" }),
    ),
    close: async () => {
      await closeServer(server)
      await handle.dispose()
    },
  }
}

const expectAuthenticationUnavailable = async (principalResolver: ConnectPrincipalResolver) => {
  let authorizations = 0
  let searches = 0
  const { client, close } = await serve(
    principalResolver,
    {
      authorize: () =>
        Effect.sync(() => {
          authorizations += 1
          return { workspaceId, role: "member" as const }
        }),
    },
    {
      search: () =>
        Effect.sync(() => {
          searches += 1
          return { hits: [], diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 } }
        }),
    },
  )
  try {
    const failure = await client.searchFinance(
      { workspaceId, query: "groceries" },
      { headers: { authorization: `Bearer ${structurallyValidAccessToken}` } },
    ).then(
      () => null,
      (cause: unknown) => cause,
    )
    expect(failure).toBeInstanceOf(ConnectError)
    expect((failure as ConnectError).code).toBe(Code.Unavailable)
    expect(authorizations).toBe(0)
    expect(searches).toBe(0)
  } finally {
    await close()
  }
}

describe("canonical SearchService RPC", () => {
  it("maps legacy hybrid ranking fields to the canonical finance hit", async () => {
    const result: HybridSearchResult = {
      hits: [
        {
          documentId: "transaction:tx-groceries",
          fusedScore: 2 / 61,
          denseRank: 1,
          lexicalRank: 1,
          denseSimilarity: 0.876,
          lexicalScore: -1.2,
          sources: ["dense", "lexical"],
        },
      ],
      diagnostics: { denseCandidates: 3, lexicalCandidates: 1, fusedCandidates: 3 },
    }
    const hybrid: HybridSearch = {
      hybridSearch: () => Effect.succeed(result),
    }
    const port = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* SearchPort
      }).pipe(
        Effect.provide(
          Layer.provide(HybridSearchPortLive, Layer.succeed(HybridSearch, hybrid)),
        ),
      ),
    )

    await expect(Effect.runPromise(port.search({ workspaceId, query: "groceries" }))).resolves.toEqual({
      hits: [
        {
          entityId: "tx-groceries",
          entityType: "transaction",
          title: "transaction:tx-groceries",
          snippet: "",
          fusedScore: 2 / 61,
          denseRank: 1,
          lexicalRank: 1,
          denseSimilarity: 0.876,
          lexicalScore: -1.2,
          sources: ["dense", "lexical"],
        },
      ],
      diagnostics: { denseCandidates: 3, lexicalCandidates: 1, fusedCandidates: 3 },
    })
  })

  it("uses finch.v1 over HTTP with an injected trusted principal and membership", async () => {
    const calls: string[] = []
    const workspaceAccess: WorkspaceAccess = {
      authorize: (receivedPrincipal, requestedWorkspace) =>
        Effect.sync(() => {
          calls.push("authorize")
          expect(receivedPrincipal).toBe(principal)
          expect(requestedWorkspace).toBe(workspaceId)
          return { workspaceId: requestedWorkspace, role: "member" as const }
        }),
    }
    const searchPort: SearchPort = {
      search: (input) =>
        Effect.sync(() => {
          expect(calls).toEqual(["authorize"])
          calls.push("search")
          expect(input).toMatchObject({ workspaceId, query: "Continente groceries", topK: 5 })
          return {
            hits: [
              {
                entityId: "tx-groceries",
                entityType: "transaction",
                title: "transaction:tx-groceries",
                snippet: "",
                fusedScore: 2 / 61,
                denseRank: 1,
                lexicalRank: 1,
                denseSimilarity: 0.876,
                lexicalScore: -1.2,
                sources: ["dense", "lexical"],
              },
            ],
            diagnostics: { denseCandidates: 3, lexicalCandidates: 1, fusedCandidates: 3 },
          }
        }),
    }
    const { client, close } = await serve(trustedResolver, workspaceAccess, searchPort)
    try {
      expect(SearchService.typeName).toBe("finch.v1.SearchService")
      const response = await client.searchFinance({
        workspaceId,
        query: "Continente groceries",
        topK: 5,
      })
      expect(response.hits).toMatchObject([
        {
          entityId: "tx-groceries",
          entityType: "transaction",
          fusedScore: 2 / 61,
          denseRank: 1,
          lexicalRank: 1,
          sources: ["dense", "lexical"],
        },
      ])
      expect(response.diagnostics).toMatchObject({
        denseCandidates: 3,
        lexicalCandidates: 1,
        fusedCandidates: 3,
      })
      expect(calls).toEqual(["authorize", "search"])
    } finally {
      await close()
    }
  })

  it("rejects oversized HTTP search input before authorization or the search port", async () => {
    const calls: string[] = []
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) =>
        Effect.sync(() => {
          calls.push("authorize")
          return { workspaceId: requestedWorkspace, role: "member" as const }
        }),
    }
    const searchPort: SearchPort = {
      search: () =>
        Effect.sync(() => {
          calls.push("search")
          return { hits: [], diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 } }
        }),
    }
    const { client, close } = await serve(trustedResolver, workspaceAccess, searchPort)
    try {
      const failure = await client.searchFinance({ workspaceId, query: "groceries", topK: 101 }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(ConnectError)
      expect((failure as ConnectError).code).toBe(Code.InvalidArgument)
      expect(calls).toEqual([])
    } finally {
      await close()
    }
  })

  it("maps no principal to Unauthenticated without calling the search port", async () => {
    let authorizations = 0
    let searches = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: () =>
        Effect.sync(() => {
          authorizations += 1
          return { workspaceId, role: "member" as const }
        }),
    }
    const searchPort: SearchPort = {
      search: () =>
        Effect.sync(() => {
          searches += 1
          return { hits: [], diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 } }
        }),
    }
    const { client, close } = await serve({ resolve: () => undefined }, workspaceAccess, searchPort)
    try {
      const failure = await client.searchFinance({ workspaceId, query: "groceries" }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(ConnectError)
      expect((failure as ConnectError).code).toBe(Code.Unauthenticated)
      expect(authorizations).toBe(0)
      expect(searches).toBe(0)
    } finally {
      await close()
    }
  })

  it.each([
    ["a 4xx response", () => new Response(null, { status: 404 })],
    ["a 5xx response", () => new Response(null, { status: 503 })],
    ["an invalid JSON response", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["malformed metadata", () => Response.json([])],
    ["missing issuer metadata", () => Response.json({ jwks_uri: "https://authentik.test/jwks" })],
    ["missing JWKS URI metadata", () => Response.json({ issuer: oidcConfig.issuer })],
    [
      "mismatched issuer metadata",
      () => Response.json({ issuer: "https://authentik.test/application/o/other/", jwks_uri: "https://authentik.test/jwks" }),
    ],
    ["invalid JWKS URI metadata", () => Response.json({ issuer: oidcConfig.issuer, jwks_uri: "not a URL" })],
    ["non-HTTPS JWKS URI metadata", () => Response.json({ issuer: oidcConfig.issuer, jwks_uri: "http://authentik.test/jwks" })],
  ])("maps OIDC discovery %s to Unavailable", async (_name, discovery) => {
    vi.stubGlobal("fetch", vi.fn(async () => discovery()))
    await expectAuthenticationUnavailable(new AuthentikPrincipalResolver(oidcConfig))
  })

  it("maps OIDC discovery timeout to Unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("timed out")
        error.name = "TimeoutError"
        throw error
      }),
    )
    await expectAuthenticationUnavailable(new AuthentikPrincipalResolver(oidcConfig))
  })

  it("maps malformed JWKS to Unavailable", async () => {
    let fetches = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetches += 1
        return fetches === 1
          ? Response.json({ issuer: oidcConfig.issuer, jwks_uri: "https://authentik.test/jwks" })
          : new Response("{", { headers: { "content-type": "application/json" } })
      }),
    )
    await expectAuthenticationUnavailable(new AuthentikPrincipalResolver(oidcConfig))
    expect(fetches).toBe(2)
  })

  it("maps denied workspace access to PermissionDenied without calling the search port", async () => {
    let searches = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) =>
        Effect.fail(new WorkspaceAccessDenied({ workspaceId: requestedWorkspace })),
    }
    const searchPort: SearchPort = {
      search: () =>
        Effect.sync(() => {
          searches += 1
          return { hits: [], diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 } }
        }),
    }
    const { client, close } = await serve(trustedResolver, workspaceAccess, searchPort)
    try {
      const failure = await client.searchFinance({ workspaceId, query: "groceries" }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(ConnectError)
      expect((failure as ConnectError).code).toBe(Code.PermissionDenied)
      expect(searches).toBe(0)
    } finally {
      await close()
    }
  })

  it("maps unavailable workspace access to Unavailable without calling the search port", async () => {
    let searches = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: () => Effect.fail(new WorkspaceAccessUnavailable()),
    }
    const searchPort: SearchPort = {
      search: () =>
        Effect.sync(() => {
          searches += 1
          return { hits: [], diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 } }
        }),
    }
    const { client, close } = await serve(trustedResolver, workspaceAccess, searchPort)
    try {
      const failure = await client.searchFinance({ workspaceId, query: "groceries" }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(ConnectError)
      expect((failure as ConnectError).code).toBe(Code.Unavailable)
      expect(searches).toBe(0)
    } finally {
      await close()
    }
  })

  it("rejects canonical page input instead of ignoring it", async () => {
    let searches = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) => Effect.succeed({ workspaceId: requestedWorkspace, role: "member" }),
    }
    const searchPort: SearchPort = {
      search: () =>
        Effect.sync(() => {
          searches += 1
          return { hits: [], diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 } }
        }),
    }
    const { client, close } = await serve(trustedResolver, workspaceAccess, searchPort)
    try {
      const failure = await client.searchFinance({
        workspaceId,
        query: "groceries",
        page: { pageSize: 10 },
      }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(ConnectError)
      expect((failure as ConnectError).code).toBe(Code.InvalidArgument)
      expect(searches).toBe(0)
    } finally {
      await close()
    }
  })
})
