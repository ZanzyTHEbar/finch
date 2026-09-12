import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ReceiptConflict,
  ReceiptHashMismatch,
  ReceiptNotFound,
  ReceiptPort,
  ReceiptUnavailable,
  ValidationFailed,
  WorkspaceId,
} from "../../packages/lib/src/index.ts"
import { makeSupabaseReceiptLayer } from "../../packages/connect/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const otherWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("bbbbbbbb-0000-4000-8000-000000000002")
const receiptId = "cccccccc-0000-4000-8000-000000000003"
const actorId = "dddddddd-0000-4000-8000-000000000004"
const principal = {
  issuer: "https://id.example.test",
  subjectId: "receipt-subject-a",
  assurance: "aal2" as const,
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

afterEach(() => vi.unstubAllGlobals())

const expectFailure = async (effect: Effect.Effect<unknown, { readonly _tag: string }>) => {
  const exit = await Effect.runPromiseExit(effect)
  expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail" } })
  return (exit as { readonly cause: { readonly error: { readonly _tag: string } } }).cause.error
}

const services = async () => {
  const layer = makeSupabaseReceiptLayer({
    supabaseUrl: "https://supabase.example.test",
    serviceRoleKey: "service-role-key",
    pageTokenHmacKey: "dedicated-receipt-test-hmac-key",
  })
  return Effect.runPromise(Effect.gen(function* () { return yield* ReceiptPort }).pipe(Effect.provide(layer)))
}

const receiptRow = (id: string, createdAt: string) => ({
  id,
  workspace_id: workspaceId,
  file_name: null,
  mime_type: "application/pdf",
  total_minor: null,
  currency: null,
  merchant: null,
  receipt_date: null,
  upload_state: "pending",
  created_at: createdAt,
})

const storedReceiptRow = (overrides: Record<string, unknown> = {}) => ({
  ...receiptRow(receiptId, "2026-09-10T12:00:00+00:00"),
  file_name: "receipt.pdf",
  byte_size: 1,
  total_minor: "1250",
  currency: "EUR",
  merchant: "Finch Store",
  receipt_date: "2026-09-10",
  object_key: `${workspaceId}/${receiptId}/eeeeeeee-0000-4000-8000-000000000005`,
  sha256: "a".repeat(64),
  ...overrides,
})

describe("Supabase receipt adapter", () => {
  it("uses canonical HMAC keyset tokens and rejects tampering or scope swaps", async () => {
    const requests: URL[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      requests.push(url)
      if (url.pathname.endsWith("/receipts")) {
        return Response.json([
          receiptRow(receiptId, "2026-09-10T12:00:00+00:00"),
          receiptRow("dddddddd-0000-4000-8000-000000000004", "2026-09-09T12:00:00+00:00"),
        ])
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const receipts = await services()

    const first = await Effect.runPromise(receipts.listReceipts({ workspaceId, page: { pageSize: 1 } }))
    expect(first.receipts).toMatchObject([{ id: receiptId, status: "pending" }])
    expect(first.receipts[0]).not.toHaveProperty("fileName")
    expect(first.nextPageToken).toEqual(expect.any(String))
    expect(requests.at(-1)?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`)
    expect(requests.at(-1)?.searchParams.get("order")).toBe("created_at.desc,id.desc")
    expect(requests.at(-1)?.searchParams.get("limit")).toBe("2")

    const token = first.nextPageToken as string
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const lastCharacter = token.at(-1) as string
    const tampered = `${token.slice(0, -1)}${alphabet[alphabet.indexOf(lastCharacter) + 1]}`
    expect((await expectFailure(receipts.listReceipts({ workspaceId, page: { pageSize: 1, pageToken: tampered } })))._tag)
      .toBe(new ValidationFailed({ issues: [] })._tag)
    expect((await expectFailure(receipts.listReceipts({ workspaceId: otherWorkspaceId, page: { pageSize: 1, pageToken: token } })))._tag)
      .toBe(new ValidationFailed({ issues: [] })._tag)
  })

  it("maps malformed rows and transport failures to unavailable without leaking receipt internals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "database unavailable" }, { status: 500 })))
    const receipts = await services()
    expect((await expectFailure(receipts.listReceipts({ workspaceId, page: { pageSize: 1 } })))._tag)
      .toBe(new ReceiptUnavailable()._tag)

    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{
      ...receiptRow(receiptId, "2026-09-10T12:00:00+00:00"),
      mime_type: "image/gif",
    }])))
    expect((await expectFailure(receipts.listReceipts({ workspaceId, page: { pageSize: 1 } })))._tag)
      .toBe(new ReceiptUnavailable()._tag)
  })

  it("maps an absent scoped receipt to a typed not-found error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(null)))
    const receipts = await services()
    expect((await expectFailure(receipts.getReceipt({ workspaceId, receiptId })))._tag)
      .toBe(new ReceiptNotFound({ receiptId })._tag)
  })

  it("rejects any changed idempotent create intent before issuing an upload URL", async () => {
    const input = {
      workspaceId,
      principal,
      fileName: "receipt.pdf",
      contentType: "application/pdf" as const,
      contentLength: 1,
      sha256: "a".repeat(64),
      idempotencyKey: "receipt-create-intent",
      merchant: "Finch Store",
      total: { minorUnits: "1250", currency: "EUR" },
      receiptDate: "2026-09-10",
    }

    for (const changed of [
      { fileName: "other.pdf" },
      { contentType: "image/png" as const },
      { contentLength: 2 },
      { sha256: "b".repeat(64) },
      { merchant: undefined },
      { merchant: "Other Store" },
      { total: undefined },
      { total: { minorUnits: "1251", currency: "EUR" } },
      { total: { minorUnits: "1250", currency: "USD" } },
      { receiptDate: undefined },
      { receiptDate: "2026-09-11" },
    ]) {
      let signedUploadRequests = 0
      vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
        const url = new URL(request.toString())
        if (url.pathname.endsWith("/authentik_subject_profiles")) {
          return Response.json({ profile_id: actorId })
        }
        if (url.pathname.endsWith("/receipts")) return Response.json(storedReceiptRow())
        if (url.pathname.includes("/storage/v1/object/upload/sign/")) {
          signedUploadRequests += 1
          return Response.json({ url: "/unused", token: "unused" })
        }
        throw new Error(`unexpected request: ${url}`)
      }))
      const receipts = await services()

      expect(await expectFailure(receipts.createReceiptUploadIntent({ ...input, ...changed }))).toMatchObject(
        new ReceiptConflict({ reason: "duplicate" }),
      )
      expect(signedUploadRequests).toBe(0)
    }
  })

  it("leaves a receipt pending when hash-mismatch deletion fails", async () => {
    let failedStateUpdates = 0
    let audits = 0
    let removeAttempts = 0
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request.toString())
      const method = init?.method ?? "GET"
      if (url.pathname.endsWith("/authentik_subject_profiles")) {
        return Response.json({ profile_id: actorId })
      }
      if (url.pathname.endsWith("/receipts") && method === "GET") return Response.json(storedReceiptRow())
      if (url.pathname.endsWith("/receipts") && method === "PATCH") {
        failedStateUpdates += 1
        return Response.json(storedReceiptRow({ upload_state: "failed" }))
      }
      if (url.pathname.includes("/storage/v1/object/receipt-originals") && method === "GET") {
        return new Response(new Uint8Array([1]), { headers: { "content-type": "application/pdf" } })
      }
      if (url.pathname.includes("/storage/v1/object/receipt-originals") && method === "DELETE") {
        removeAttempts += 1
        return Response.json({ message: "delete failed" }, { status: 500 })
      }
      if (url.pathname.endsWith("/audit_events")) {
        audits += 1
        return Response.json({})
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const receipts = await services()

    expect((await expectFailure(receipts.finalizeReceipt({ workspaceId, receiptId, principal })))._tag)
      .toBe(new ReceiptUnavailable()._tag)
    expect(removeAttempts).toBe(1)
    expect(failedStateUpdates).toBe(0)
    expect(audits).toBe(0)
  })

  it("uses the service failure RPC after deleting a mismatched object", async () => {
    let failedStateUpdates = 0
    let audits = 0
    let removeAttempts = 0
    const rpcPayloads: unknown[] = []
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request.toString())
      const method = init?.method ?? "GET"
      if (url.pathname.endsWith("/authentik_subject_profiles")) {
        return Response.json({ profile_id: actorId })
      }
      if (url.pathname.endsWith("/receipts") && method === "GET") return Response.json(storedReceiptRow())
      if (url.pathname.endsWith("/receipts") && method === "PATCH") {
        failedStateUpdates += 1
        return Response.json(storedReceiptRow({ upload_state: "failed" }))
      }
      if (url.pathname.includes("/storage/v1/object/receipt-originals") && method === "GET") {
        return new Response(new Uint8Array([1]), { headers: { "content-type": "application/pdf" } })
      }
      if (url.pathname.includes("/storage/v1/object/receipt-originals") && method === "DELETE") {
        removeAttempts += 1
        return Response.json({})
      }
      if (url.pathname.includes("/rpc/fail_pending_receipt_upload")) {
        rpcPayloads.push(JSON.parse(init?.body as string))
        return Response.json("failed")
      }
      if (url.pathname.endsWith("/audit_events")) {
        audits += 1
        return Response.json({})
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const receipts = await services()

    expect((await expectFailure(receipts.finalizeReceipt({ workspaceId, receiptId, principal })))._tag)
      .toBe(new ReceiptHashMismatch()._tag)
    expect(removeAttempts).toBe(1)
    expect(rpcPayloads).toEqual([{
      p_workspace_id: workspaceId,
      p_receipt_id: receiptId,
      p_actor_id: actorId,
      p_safe_error_code: "receipt_hash_mismatch",
    }])
    expect(failedStateUpdates).toBe(0)
    expect(audits).toBe(0)
  })

  it("leaves a receipt pending when the failure RPC rejects after object deletion", async () => {
    let failedStateUpdates = 0
    let audits = 0
    let removeAttempts = 0
    let rpcCalls = 0
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request.toString())
      const method = init?.method ?? "GET"
      if (url.pathname.endsWith("/authentik_subject_profiles")) {
        return Response.json({ profile_id: actorId })
      }
      if (url.pathname.endsWith("/receipts") && method === "GET") return Response.json(storedReceiptRow())
      if (url.pathname.endsWith("/receipts") && method === "PATCH") {
        failedStateUpdates += 1
        return Response.json(storedReceiptRow({ upload_state: "failed" }))
      }
      if (url.pathname.includes("/storage/v1/object/receipt-originals") && method === "GET") {
        return new Response(new Uint8Array([1]), { headers: { "content-type": "application/pdf" } })
      }
      if (url.pathname.includes("/storage/v1/object/receipt-originals") && method === "DELETE") {
        removeAttempts += 1
        return Response.json({})
      }
      if (url.pathname.includes("/rpc/fail_pending_receipt_upload")) {
        rpcCalls += 1
        return Response.json({ message: "audit unavailable" }, { status: 500 })
      }
      if (url.pathname.endsWith("/audit_events")) {
        audits += 1
        return Response.json({})
      }
      throw new Error(`unexpected request: ${method} ${url}`)
    }))
    const receipts = await services()

    expect((await expectFailure(receipts.finalizeReceipt({ workspaceId, receiptId, principal })))._tag)
      .toBe(new ReceiptUnavailable()._tag)
    expect(removeAttempts).toBe(1)
    expect(rpcCalls).toBe(1)
    expect(failedStateUpdates).toBe(0)
    expect(audits).toBe(0)
  })
})
