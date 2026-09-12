import { createHash } from "node:crypto"
import { Effect, Layer, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BankAuthorizationGateway,
  BankConflict,
  BankPort,
  BankUnavailable,
  ValidationFailed,
  WorkspaceId,
  type BankAuthorizationGateway as BankAuthorizationGatewayService,
  type ProviderAspsp,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"
import { makeSupabaseBankLayer } from "../../packages/connect/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const otherWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("bbbbbbbb-0000-4000-8000-000000000002")
const connectionId = "cccccccc-0000-4000-8000-000000000003"
const jobId = "dddddddd-0000-4000-8000-000000000004"
const actorId = "eeeeeeee-0000-4000-8000-000000000005"
const principal: PrincipalContext = {
  issuer: "https://id.example.test/application/o/finch/",
  subjectId: "bank-subject-a",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}
const aspsp: ProviderAspsp = { name: "Demo Bank", country: "PT" }
const config = {
  supabaseUrl: "https://supabase.example.test",
  serviceRoleKey: "service-role-key",
  pageTokenHmacKey: "dedicated-bank-test-hmac-key",
  callbackUrl: "https://finch.example.test/bank/callback",
}

afterEach(() => vi.unstubAllGlobals())

const expectFailure = async (effect: Effect.Effect<unknown, { readonly _tag: string }>) => {
  const exit = await Effect.runPromiseExit(effect)
  expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail" } })
  return (exit as { readonly cause: { readonly error: { readonly _tag: string } } }).cause.error
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

const connectionRow = (status: string, overrides: Record<string, unknown> = {}) => ({
  id: connectionId,
  workspace_id: workspaceId,
  provider: "enablebanking",
  provider_connection_ref: "provider-session-reference",
  vault_secret_id: "ffffffff-0000-4000-8000-000000000006",
  aspsp_name: aspsp.name,
  aspsp_country: aspsp.country,
  status,
  last_synced_at: "2026-09-10T12:00:00+00:00",
  created_at: "2026-09-10T12:00:00+00:00",
  ...overrides,
})

const gateway = (options: { readonly startUnavailable?: boolean; readonly deleteUnavailable?: boolean } = {}) => {
  const starts: { readonly aspsp: ProviderAspsp; readonly state: string; readonly redirectUrl: string }[] = []
  const deletes: string[] = []
  const service: BankAuthorizationGatewayService = {
    startAuthorization: (input) => {
      starts.push(input)
      return options.startUnavailable
        ? Effect.fail(new BankUnavailable())
        : Effect.succeed({ url: "https://bank.example.test/authorize" })
    },
    deleteSession: (sessionId) => {
      deletes.push(sessionId)
      return options.deleteUnavailable ? Effect.fail(new BankUnavailable()) : Effect.void
    },
  }
  return { service, starts, deletes }
}

const bank = (authorizationGateway: BankAuthorizationGatewayService) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* BankPort
    }).pipe(
      Effect.provide(
        Layer.provide(
          makeSupabaseBankLayer(config),
          Layer.succeed(BankAuthorizationGateway, authorizationGateway),
        ),
      ),
    ),
  )

const requestBody = (init?: RequestInit) => JSON.parse(init?.body as string) as Record<string, unknown>

describe("Supabase BankPort adapter", () => {
  it("rejects callback URLs that are non-HTTPS or contain credentials", () => {
    for (const callbackUrl of ["http://finch.example.test/bank/callback", "https://user:password@finch.example.test/bank/callback"]) {
      expect(() => makeSupabaseBankLayer({ ...config, callbackUrl })).toThrow(
        "callbackUrl must be an HTTPS URL without credentials",
      )
    }
  })

  it("uses safe workspace-scoped reads, maps every storage status, and rejects tampered or swapped cursors", async () => {
    const requests: URL[] = []
    const rows = [
      connectionRow("authorization_pending"),
      connectionRow("revocation_pending", { id: "11111111-0000-4000-8000-000000000001" }),
      connectionRow("active", { id: "22222222-0000-4000-8000-000000000002" }),
      connectionRow("expired", { id: "33333333-0000-4000-8000-000000000003" }),
      connectionRow("revoked", { id: "44444444-0000-4000-8000-000000000004" }),
      connectionRow("error", { id: "55555555-0000-4000-8000-000000000005" }),
      connectionRow("active", { id: "66666666-0000-4000-8000-000000000006" }),
    ]
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      requests.push(url)
      if (url.pathname.endsWith("/bank_connections")) {
        return Response.json(url.searchParams.has("id") ? rows[0] : rows)
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const connections = await bank(gateway().service)

    const first = await Effect.runPromise(connections.listConnections({ workspaceId, page: { pageSize: 6 } }))
    expect(first.connections.map((connection) => connection.status)).toEqual([
      "pending",
      "pending",
      "active",
      "expired",
      "disconnected",
      "failed",
    ])
    expect(first.connections[0]).toMatchObject({
      id: connectionId,
      aspsp: { id: "enablebanking:v1:WyJQVCIsIkRlbW8gQmFuayJd", name: "Demo Bank", country: "PT" },
    })
    expect(JSON.stringify(first)).not.toContain("provider-session-reference")
    expect(JSON.stringify(first)).not.toContain("ffffffff-0000-4000-8000-000000000006")
    expect(first.nextPageToken).toEqual(expect.any(String))
    expect(requests[0]?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`)
    expect(requests[0]?.searchParams.get("order")).toBe("created_at.desc,id.desc")
    expect(requests[0]?.searchParams.get("limit")).toBe("7")
    expect(requests[0]?.searchParams.get("select")).not.toContain("vault_secret_id")
    expect(requests[0]?.searchParams.get("select")).not.toContain("provider_connection_ref")

    const token = first.nextPageToken as string
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const lastCharacter = token.at(-1) as string
    const tampered = `${token.slice(0, -1)}${alphabet[(alphabet.indexOf(lastCharacter) + 1) % alphabet.length]}`
    expect((await expectFailure(connections.listConnections({ workspaceId, page: { pageSize: 6, pageToken: tampered } })))._tag)
      .toBe(new ValidationFailed({ issues: [] })._tag)
    expect((await expectFailure(connections.listConnections({ workspaceId: otherWorkspaceId, page: { pageSize: 6, pageToken: token } })))._tag)
      .toBe(new ValidationFailed({ issues: [] })._tag)

    const active = await Effect.runPromise(connections.getConnectionStatus({ workspaceId, connectionId }))
    expect(active).toMatchObject({ id: connectionId, status: "pending" })
    expect(JSON.stringify(active)).not.toContain("provider-session-reference")
    expect(requests.at(-1)?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`)
    expect(requests.at(-1)?.searchParams.get("id")).toBe(`eq.${connectionId}`)
  })

  it("maps the Authentik principal, stores only a SHA-256 state hash, and starts the authorization gateway", async () => {
    const writes: Record<string, unknown>[] = []
    const audits: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const method = init?.method ?? "GET"
      if (url.pathname.endsWith("/authentik_subject_profiles")) {
        expect(url.searchParams.get("issuer")).toBe(`eq.${principal.issuer}`)
        expect(url.searchParams.get("subject")).toBe(`eq.${principal.subjectId}`)
        return Response.json({ profile_id: actorId })
      }
      if (url.pathname.endsWith("/bank_connections") && method === "POST") {
        writes.push(requestBody(init))
        return Response.json(connectionRow("authorization_pending"))
      }
      if (url.pathname.endsWith("/bank_authorizations")) {
        writes.push(requestBody(init))
        return Response.json({})
      }
      if (url.pathname.endsWith("/audit_events")) {
        audits.push(requestBody(init))
        return Response.json({})
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const provider = gateway()
    const connections = await bank(provider.service)

    const result = await Effect.runPromise(connections.startAuthorization({
      workspaceId,
      principal,
      aspsp,
      returnPath: "/connections",
    }))
    expect(result).toEqual({
      authorizationUrl: "https://bank.example.test/authorize",
      connection: {
        id: connectionId,
        aspsp: { id: "enablebanking:v1:WyJQVCIsIkRlbW8gQmFuayJd", name: "Demo Bank", country: "PT" },
        status: "pending",
        lastSyncedAt: "2026-09-10T12:00:00+00:00",
      },
    })
    expect(provider.starts).toHaveLength(1)
    expect(provider.starts[0]).toMatchObject({ aspsp, redirectUrl: config.callbackUrl })
    expect(provider.starts[0]?.state).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(writes.find((write) => Object.hasOwn(write, "provider"))).toMatchObject({
      workspace_id: workspaceId,
      provider: "enablebanking",
      aspsp_name: aspsp.name,
      aspsp_country: aspsp.country,
      created_by: actorId,
    })
    const authorization = writes.find((write) => Object.hasOwn(write, "state_hash")) as Record<string, unknown>
    expect(authorization).toMatchObject({
      workspace_id: workspaceId,
      connection_id: connectionId,
      user_id: actorId,
      return_path: "/connections",
      state_hash: `\\x${hash(provider.starts[0]?.state as string)}`,
    })
    expect(JSON.stringify(writes)).not.toContain(provider.starts[0]?.state as string)
    expect(audits).toEqual([expect.objectContaining({ workspace_id: workspaceId, actor_id: actorId, outcome: "success" })])
  })

  it("marks and audits a failed authorization without returning provider internals", async () => {
    const updates: Record<string, unknown>[] = []
    const audits: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const method = init?.method ?? "GET"
      if (url.pathname.endsWith("/authentik_subject_profiles")) return Response.json({ profile_id: actorId })
      if (url.pathname.endsWith("/bank_connections") && method === "POST") return Response.json(connectionRow("authorization_pending"))
      if (url.pathname.endsWith("/bank_authorizations")) return Response.json({})
      if (url.pathname.endsWith("/bank_connections") && method === "PATCH") {
        updates.push(requestBody(init))
        return Response.json(connectionRow("error"))
      }
      if (url.pathname.endsWith("/audit_events")) {
        audits.push(requestBody(init))
        return Response.json({})
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const provider = gateway({ startUnavailable: true })
    const connections = await bank(provider.service)

    expect((await expectFailure(connections.startAuthorization({ workspaceId, principal, aspsp, returnPath: "/connections" })))._tag)
      .toBe(new BankUnavailable()._tag)
    expect(updates).toEqual([expect.objectContaining({ status: "error" })])
    expect(audits).toEqual([expect.objectContaining({ workspace_id: workspaceId, actor_id: actorId, outcome: "failed" })])
    expect(JSON.stringify(audits)).not.toContain(provider.starts[0]?.state as string)
  })

  it("marks and audits a newly created connection when saving its authorization fails", async () => {
    const updates: Record<string, unknown>[] = []
    const audits: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const method = init?.method ?? "GET"
      if (url.pathname.endsWith("/authentik_subject_profiles")) return Response.json({ profile_id: actorId })
      if (url.pathname.endsWith("/bank_connections") && method === "POST") return Response.json(connectionRow("authorization_pending"))
      if (url.pathname.endsWith("/bank_authorizations") && method === "POST") {
        return Response.json({ code: "P0001", message: "authorization write failed" }, { status: 500 })
      }
      if (url.pathname.endsWith("/bank_connections") && method === "PATCH") {
        updates.push(requestBody(init))
        return Response.json(connectionRow("error"))
      }
      if (url.pathname.endsWith("/audit_events")) {
        audits.push(requestBody(init))
        return Response.json({})
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const provider = gateway()
    const connections = await bank(provider.service)

    expect((await expectFailure(connections.startAuthorization({ workspaceId, principal, aspsp, returnPath: "/connections" })))._tag)
      .toBe(new BankUnavailable()._tag)
    expect(provider.starts).toEqual([])
    expect(updates).toEqual([expect.objectContaining({ status: "error" })])
    expect(audits).toEqual([expect.objectContaining({
      workspace_id: workspaceId,
      actor_id: actorId,
      action: "bank.authorization.failed",
      outcome: "failed",
    })])
  })

  it("queues only active connections with a hashed idempotency key, a UTC date, and the durable job", async () => {
    const rpcPayloads: Record<string, unknown>[] = []
    const requests: URL[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      requests.push(url)
      if (url.pathname.endsWith("/bank_connections")) return Response.json(connectionRow("active"))
      if (url.pathname.endsWith("/rpc/enqueue_finch_job")) {
        rpcPayloads.push(requestBody(init))
        return Response.json(jobId)
      }
      if (url.pathname.endsWith("/job_requests")) {
        return Response.json({
          id: jobId,
          workspace_id: workspaceId,
          payload: { connection_id: connectionId, since: "2026-09-09" },
          status: "queued",
          created_at: "2026-09-10T12:00:00+00:00",
          updated_at: "2026-09-10T12:00:00+00:00",
          safe_error_code: null,
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const connections = await bank(gateway().service)

    const job = await Effect.runPromise(connections.queueSync({
      workspaceId,
      connectionId,
      since: new Date("2026-09-10T00:30:00+01:00"),
      idempotencyKey: "manual-sync-request",
    }))
    expect(rpcPayloads).toEqual([{
      p_workspace_id: workspaceId,
      p_kind: "bank.sync",
      p_payload: { connection_id: connectionId, since: "2026-09-09" },
      p_idempotency_key: hash("manual-sync-request"),
    }])
    expect((rpcPayloads[0]?.p_idempotency_key as string).length).toBeLessThanOrEqual(200)
    expect(job).toEqual({
      id: jobId,
      workspaceId,
      status: "queued",
      createdAt: "2026-09-10T12:00:00+00:00",
      updatedAt: "2026-09-10T12:00:00+00:00",
    })
    const connectionRequest = requests.find((request) => request.pathname.endsWith("/bank_connections"))
    expect(connectionRequest?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`)
    expect(connectionRequest?.searchParams.get("id")).toBe(`eq.${connectionId}`)
    const jobRequest = requests.find((request) => request.pathname.endsWith("/job_requests"))
    expect(jobRequest?.searchParams.get("workspace_id"))
      .toBe(`eq.${workspaceId}`)
    expect(jobRequest?.searchParams.get("id")).toBe(`eq.${jobId}`)
  })

  it("rejects sync for a nonactive connection before enqueueing", async () => {
    let enqueueCalls = 0
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      if (url.pathname.endsWith("/bank_connections")) return Response.json(connectionRow("expired"))
      if (url.pathname.endsWith("/rpc/enqueue_finch_job")) enqueueCalls += 1
      throw new Error(`unexpected request: ${url}`)
    }))
    const connections = await bank(gateway().service)

    expect((await expectFailure(connections.queueSync({ workspaceId, connectionId, idempotencyKey: "expired-sync" })))._tag)
      .toBe(new BankConflict({ reason: "connection is not active" })._tag)
    expect(enqueueCalls).toBe(0)
  })

  it("resolves the principal and atomically completes a remote bank disconnect", async () => {
    const requests: { readonly url: URL; readonly method: string; readonly body?: Record<string, unknown> }[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const method = init?.method ?? "GET"
      const body = method === "GET" ? undefined : requestBody(init)
      requests.push({ url, method, ...(body === undefined ? {} : { body }) })
      if (url.pathname.endsWith("/authentik_subject_profiles")) return Response.json({ profile_id: actorId })
      if (url.pathname.endsWith("/bank_connections") && method === "GET") return Response.json(connectionRow("active"))
      if (url.pathname.endsWith("/bank_authorizations") && method === "PATCH") return Response.json([])
      if (url.pathname.endsWith("/bank_connections") && method === "PATCH") return Response.json(connectionRow("revocation_pending"))
      if (url.pathname.endsWith("/rpc/read_bank_connection_secret")) return Response.json("provider-session-secret")
      if (url.pathname.endsWith("/rpc/complete_bank_disconnect")) return Response.json(true)
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const provider = gateway()
    const connections = await bank(provider.service)

    await expect(Effect.runPromise(connections.disconnect({ workspaceId, connectionId, principal }))).resolves.toEqual({
      disconnected: true,
      status: "disconnected",
    })
    expect(provider.deletes).toEqual(["provider-session-secret"])
    const invalidation = requests.find((request) => request.url.pathname.endsWith("/bank_authorizations"))
    expect(invalidation).toMatchObject({ body: { used_at: expect.any(String) } })
    expect(invalidation?.url.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`)
    expect(invalidation?.url.searchParams.get("connection_id")).toBe(`eq.${connectionId}`)
    expect(invalidation?.url.searchParams.get("used_at")).toBe("is.null")
    expect(requests.filter((request) => request.url.pathname.endsWith("/bank_connections") && request.method === "PATCH")
      .map((request) => request.body)).toEqual([
      { status: "revocation_pending" },
    ])
    const actorLookup = requests.find((request) => request.url.pathname.endsWith("/authentik_subject_profiles"))
    expect(actorLookup?.url.searchParams.get("issuer")).toBe(`eq.${principal.issuer}`)
    expect(actorLookup?.url.searchParams.get("subject")).toBe(`eq.${principal.subjectId}`)
    expect(requests.find((request) => request.url.pathname.endsWith("/rpc/complete_bank_disconnect"))?.body).toEqual({
      p_workspace_id: workspaceId,
      p_connection_id: connectionId,
      p_actor_id: actorId,
    })
    expect(requests.some((request) => request.url.pathname.endsWith("/rpc/destroy_bank_connection_secret"))).toBe(false)
    expect(requests.some((request) => request.url.pathname.endsWith("/audit_events"))).toBe(false)
    expect(requests.some((request) => request.url.pathname.includes("vault"))).toBe(false)
  })

  it("returns unavailable without faking a completed disconnect when atomic completion fails", async () => {
    const statusUpdates: Record<string, unknown>[] = []
    const requests: { readonly url: URL; readonly method: string; readonly body?: Record<string, unknown> }[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const method = init?.method ?? "GET"
      const body = method === "GET" ? undefined : requestBody(init)
      requests.push({ url, method, ...(body === undefined ? {} : { body }) })
      if (url.pathname.endsWith("/authentik_subject_profiles")) return Response.json({ profile_id: actorId })
      if (url.pathname.endsWith("/bank_connections") && method === "GET") return Response.json(connectionRow("active"))
      if (url.pathname.endsWith("/bank_authorizations") && method === "PATCH") return Response.json([])
      if (url.pathname.endsWith("/bank_connections") && method === "PATCH") {
        statusUpdates.push(requestBody(init))
        return Response.json(connectionRow("revocation_pending"))
      }
      if (url.pathname.endsWith("/rpc/read_bank_connection_secret")) return Response.json("provider-session-secret")
      if (url.pathname.endsWith("/rpc/complete_bank_disconnect")) {
        return Response.json({ code: "P0001", message: "completion failed" }, { status: 500 })
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const provider = gateway()
    const connections = await bank(provider.service)

    expect((await expectFailure(connections.disconnect({ workspaceId, connectionId, principal })))._tag)
      .toBe(new BankUnavailable()._tag)
    expect(provider.deletes).toEqual(["provider-session-secret"])
    expect(statusUpdates).toEqual([{ status: "revocation_pending" }])
    expect(requests.find((request) => request.url.pathname.endsWith("/rpc/complete_bank_disconnect"))?.body).toEqual({
      p_workspace_id: workspaceId,
      p_connection_id: connectionId,
      p_actor_id: actorId,
    })
    expect(requests.some((request) => request.url.pathname.endsWith("/rpc/destroy_bank_connection_secret"))).toBe(false)
    expect(requests.filter((request) => request.url.pathname.endsWith("/bank_connections") && request.method === "PATCH")
      .map((request) => request.body)).toEqual([{ status: "revocation_pending" }])
  })

  it.each(["expired", "error"] as const)("revokes %s connections through the pending lifecycle", async (initialStatus) => {
    const statusUpdates: { readonly body: Record<string, unknown>; readonly url: URL }[] = []
    const requests: { readonly url: URL; readonly method: string; readonly body?: Record<string, unknown> }[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const method = init?.method ?? "GET"
      const body = method === "GET" ? undefined : requestBody(init)
      requests.push({ url, method, ...(body === undefined ? {} : { body }) })
      if (url.pathname.endsWith("/authentik_subject_profiles")) return Response.json({ profile_id: actorId })
      if (url.pathname.endsWith("/bank_connections") && method === "GET") return Response.json(connectionRow(initialStatus))
      if (url.pathname.endsWith("/bank_authorizations") && method === "PATCH") return Response.json([])
      if (url.pathname.endsWith("/bank_connections") && method === "PATCH") {
        statusUpdates.push({ body: requestBody(init), url })
        return Response.json(connectionRow("revocation_pending"))
      }
      if (url.pathname.endsWith("/rpc/read_bank_connection_secret")) return Response.json("provider-session-secret")
      if (url.pathname.endsWith("/rpc/complete_bank_disconnect")) return Response.json(true)
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const provider = gateway()
    const connections = await bank(provider.service)

    await expect(Effect.runPromise(connections.disconnect({ workspaceId, connectionId, principal }))).resolves.toEqual({
      disconnected: true,
      status: "disconnected",
    })
    expect(provider.deletes).toEqual(["provider-session-secret"])
    expect(statusUpdates).toEqual([expect.objectContaining({ body: { status: "revocation_pending" } })])
    expect(statusUpdates[0]?.url.searchParams.get("status")).toBe(`eq.${initialStatus}`)
    expect(requests.find((request) => request.url.pathname.endsWith("/rpc/complete_bank_disconnect"))?.body).toEqual({
      p_workspace_id: workspaceId,
      p_connection_id: connectionId,
      p_actor_id: actorId,
    })
    expect(requests.some((request) => request.url.pathname.endsWith("/rpc/destroy_bank_connection_secret"))).toBe(false)
  })

  it("atomically completes an error disconnect without a Vault secret", async () => {
    const statusUpdates: { readonly body: Record<string, unknown>; readonly url: URL }[] = []
    const requests: { readonly url: URL; readonly method: string; readonly body?: Record<string, unknown> }[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const method = init?.method ?? "GET"
      const body = method === "GET" ? undefined : requestBody(init)
      requests.push({ url, method, ...(body === undefined ? {} : { body }) })
      if (url.pathname.endsWith("/authentik_subject_profiles")) return Response.json({ profile_id: actorId })
      if (url.pathname.endsWith("/bank_connections") && method === "GET") {
        return Response.json(connectionRow("error", { vault_secret_id: null }))
      }
      if (url.pathname.endsWith("/bank_authorizations") && method === "PATCH") return Response.json([])
      if (url.pathname.endsWith("/bank_connections") && method === "PATCH") {
        statusUpdates.push({ body: requestBody(init), url })
        return Response.json(connectionRow("revocation_pending", { vault_secret_id: null }))
      }
      if (url.pathname.endsWith("/rpc/complete_bank_disconnect")) return Response.json(true)
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const provider = gateway()
    const connections = await bank(provider.service)

    await expect(Effect.runPromise(connections.disconnect({ workspaceId, connectionId, principal }))).resolves.toEqual({
      disconnected: true,
      status: "disconnected",
    })
    expect(statusUpdates).toEqual([expect.objectContaining({ body: { status: "revocation_pending" } })])
    expect(statusUpdates[0]?.url.searchParams.get("status")).toBe("eq.error")
    expect(requests.find((request) => request.url.pathname.endsWith("/rpc/complete_bank_disconnect"))?.body).toEqual({
      p_workspace_id: workspaceId,
      p_connection_id: connectionId,
      p_actor_id: actorId,
    })
    expect(provider.deletes).toEqual([])
    expect(requests.some((request) => request.url.pathname.endsWith("/rpc/read_bank_connection_secret"))).toBe(false)
  })

  it("keeps authorization-pending connections non-revocable", async () => {
    const requests: { readonly url: URL; readonly method: string }[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const method = init?.method ?? "GET"
      requests.push({ url, method })
      if (url.pathname.endsWith("/authentik_subject_profiles")) return Response.json({ profile_id: actorId })
      if (url.pathname.endsWith("/bank_connections") && method === "GET") return Response.json(connectionRow("authorization_pending"))
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const provider = gateway()
    const connections = await bank(provider.service)

    expect((await expectFailure(connections.disconnect({ workspaceId, connectionId, principal })))._tag)
      .toBe(new BankConflict({ reason: "connection is not revocable" })._tag)
    expect(provider.deletes).toEqual([])
    expect(requests.filter((request) => request.method !== "GET")).toEqual([])
  })

  it("leaves a revocation pending and audits it with the actor when the provider is unavailable", async () => {
    const statusUpdates: Record<string, unknown>[] = []
    const audits: Record<string, unknown>[] = []
    const requests: URL[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const method = init?.method ?? "GET"
      requests.push(url)
      if (url.pathname.endsWith("/authentik_subject_profiles")) return Response.json({ profile_id: actorId })
      if (url.pathname.endsWith("/bank_connections") && method === "GET") return Response.json(connectionRow("active"))
      if (url.pathname.endsWith("/bank_authorizations") && method === "PATCH") return Response.json([])
      if (url.pathname.endsWith("/bank_connections") && method === "PATCH") {
        statusUpdates.push(requestBody(init))
        return Response.json(connectionRow("revocation_pending"))
      }
      if (url.pathname.endsWith("/rpc/read_bank_connection_secret")) return Response.json("provider-session-secret")
      if (url.pathname.endsWith("/audit_events")) {
        audits.push(requestBody(init))
        return Response.json({})
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const provider = gateway({ deleteUnavailable: true })
    const connections = await bank(provider.service)

    await expect(Effect.runPromise(connections.disconnect({ workspaceId, connectionId, principal }))).resolves.toEqual({
      disconnected: false,
      status: "pending",
    })
    expect(provider.deletes).toEqual(["provider-session-secret"])
    expect(statusUpdates).toEqual([{ status: "revocation_pending" }])
    expect(audits).toEqual([expect.objectContaining({
      workspace_id: workspaceId,
      actor_id: actorId,
      action: "bank.connection.disconnected",
      outcome: "failed",
      safe_error_code: "bank_revocation_pending",
    })])
    expect(requests.some((request) => request.pathname.endsWith("/rpc/complete_bank_disconnect"))).toBe(false)
  })

  it.each([
    ["connection", { connection_id: "11111111-0000-4000-8000-000000000001", since: "2026-09-09" }],
    ["since", { connection_id: connectionId, since: "2026-09-08" }],
  ] as const)("rejects a reused sync idempotency key when the durable %s payload differs", async (_field, durablePayload) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      if (url.pathname.endsWith("/bank_connections")) return Response.json(connectionRow("active"))
      if (url.pathname.endsWith("/rpc/enqueue_finch_job")) return Response.json(jobId)
      if (url.pathname.endsWith("/job_requests")) {
        return Response.json({
          id: jobId,
          workspace_id: workspaceId,
          ...(url.searchParams.get("select")?.split(",").includes("payload") ? { payload: durablePayload } : {}),
          status: "queued",
          created_at: "2026-09-10T12:00:00+00:00",
          updated_at: "2026-09-10T12:00:00+00:00",
          safe_error_code: null,
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const connections = await bank(gateway().service)

    expect((await expectFailure(connections.queueSync({
      workspaceId,
      connectionId,
      since: new Date("2026-09-10T00:30:00+01:00"),
      idempotencyKey: "reused-sync-request",
    })))._tag).toBe(new BankConflict({ reason: "idempotency key is already used for another sync" })._tag)
  })

  it("rejects a reused sync idempotency key when an undated request has a durable date", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      if (url.pathname.endsWith("/bank_connections")) return Response.json(connectionRow("active"))
      if (url.pathname.endsWith("/rpc/enqueue_finch_job")) return Response.json(jobId)
      if (url.pathname.endsWith("/job_requests")) {
        return Response.json({
          id: jobId,
          workspace_id: workspaceId,
          payload: { connection_id: connectionId, since: "2026-09-09" },
          status: "queued",
          created_at: "2026-09-10T12:00:00+00:00",
          updated_at: "2026-09-10T12:00:00+00:00",
          safe_error_code: null,
        })
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const connections = await bank(gateway().service)

    const failure = await expectFailure(connections.queueSync({
      workspaceId,
      connectionId,
      idempotencyKey: "reused-undated-sync-request",
    }))
    expect(failure._tag).toBe(new BankConflict({ reason: "idempotency key is already used for another sync" })._tag)
    expect(JSON.stringify(failure)).not.toContain("reused-undated-sync-request")
  })
})
