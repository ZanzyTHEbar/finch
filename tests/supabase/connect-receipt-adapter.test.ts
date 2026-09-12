import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { createClient } from "@supabase/supabase-js"
import { Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ReceiptConflict,
  ReceiptHashMismatch,
  ReceiptMetadataMismatch,
  ReceiptPort,
  ReceiptWriteDenied,
  ValidationFailed,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceId,
  createReceiptUploadIntent,
  finalizeReceipt,
  getReceipt,
  getReceiptDownloadUrl,
  listReceipts,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"
import { makeSupabaseLedgerLayer, makeSupabaseReceiptLayer } from "../../packages/connect/src/index.ts"

const url = process.env.FINCH_TEST_SUPABASE_URL
const serviceKey = process.env.FINCH_TEST_SUPABASE_SERVICE_ROLE_KEY

if (url === undefined || serviceKey === undefined) {
  throw new Error("cloud tests require scripts/run-cloud-tests.mjs")
}

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000101")
const otherWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("bbbbbbbb-0000-4000-8000-000000000102")
const userId = "cccccccc-0000-4000-8000-000000000103"
const principal: PrincipalContext = {
  issuer: "https://id.example.test/application/o/finch/",
  subjectId: "authentik-receipt-subject-a",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const PostgresClient = createRequire(import.meta.url)("pg").Client
const layer = Layer.mergeAll(
  makeSupabaseLedgerLayer({
    supabaseUrl: url,
    serviceRoleKey: serviceKey,
    pageTokenHmacKey: "connect-receipt-adapter-dedicated-test-key",
  }),
  makeSupabaseReceiptLayer({
    supabaseUrl: url,
    serviceRoleKey: serviceKey,
    pageTokenHmacKey: "connect-receipt-adapter-dedicated-test-key",
  }),
)

const run = <A, E>(effect: Effect.Effect<A, E, WorkspaceAccess | ReceiptPort>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

const expectFailure = async (effect: Effect.Effect<unknown, { readonly _tag: string }, WorkspaceAccess | ReceiptPort>) => {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(layer)))
  expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail" } })
  return (exit as { readonly cause: { readonly error: { readonly _tag: string } } }).cause.error
}

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")

const upload = async (target: { readonly url: string; readonly requiredHeaders: readonly { readonly name: string; readonly value: string }[] }, value: Uint8Array) => {
  const response = await fetch(target.url, {
    method: "PUT",
    headers: new Headers(target.requiredHeaders.map((header) => [header.name, header.value])),
    body: value,
  })
  expect(response.ok).toBe(true)
}

beforeAll(async () => {
  const { error: userError } = await admin.auth.admin.createUser({
    id: userId,
    email: "connect-receipt-adapter@example.test",
    password: "A-strong-password-for-finch-tests!",
    email_confirm: true,
  })
  expect(userError).toBeNull()
  const { error: workspaceError } = await admin.from("workspaces").insert([
    { id: workspaceId, name: "Connect receipt workspace" },
    { id: otherWorkspaceId, name: "Other Connect receipt workspace" },
  ])
  expect(workspaceError).toBeNull()
  const { error: membershipError } = await admin.from("workspace_members").insert([
    { workspace_id: workspaceId, user_id: userId, role: "member" },
    { workspace_id: otherWorkspaceId, user_id: userId, role: "viewer" },
  ])
  expect(membershipError).toBeNull()
  const { error: linkError } = await admin.rpc("link_authentik_subject_profile", {
    p_issuer: principal.issuer,
    p_subject: principal.subjectId,
    p_profile_id: userId,
  })
  expect(linkError).toBeNull()
})

afterAll(async () => {
  const { data: receiptRows } = await admin
    .from("receipts")
    .select("object_key")
    .in("workspace_id", [workspaceId, otherWorkspaceId])
  const objectKeys = (receiptRows ?? [])
    .map((row) => row.object_key)
    .filter((key): key is string => typeof key === "string")
  if (objectKeys.length > 0) {
    await admin.storage.from("receipt-originals").remove(objectKeys)
  }

  // audit_events are intentionally immutable to application roles. The local
  // Supabase test database is resettable, so use its superuser only to remove
  // this test's audit rows and leave the shared test run clean.
  const db = new PostgresClient({
    connectionString: process.env.FINCH_TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  })
  await db.connect()
  try {
    await db.query("set session_replication_role = replica")
    await db.query("delete from public.audit_events where workspace_id = any($1::uuid[])", [[workspaceId, otherWorkspaceId]])
    await db.query("delete from public.finance_documents where workspace_id = any($1::uuid[])", [[workspaceId, otherWorkspaceId]])
    await db.query("delete from public.job_requests where workspace_id = any($1::uuid[])", [[workspaceId, otherWorkspaceId]])
    await db.query("delete from public.receipts where workspace_id = any($1::uuid[])", [[workspaceId, otherWorkspaceId]])
    await db.query("delete from public.workspace_members where workspace_id = any($1::uuid[])", [[workspaceId, otherWorkspaceId]])
    await db.query("delete from public.workspaces where id = any($1::uuid[])", [[workspaceId, otherWorkspaceId]])
    await db.query("delete from public.authentik_subject_profiles where profile_id = $1", [userId])
    await db.query("delete from public.profiles where id = $1", [userId])
    await db.query("delete from auth.identities where user_id = $1", [userId])
    await db.query("delete from auth.users where id = $1", [userId])
  } finally {
    await db.query("set session_replication_role = origin")
    await db.end()
  }
})

describe("Supabase ReceiptPort", () => {
  it("preserves receipt upload, finalization, download, idempotency, authorization, and cursor guarantees", async () => {
    const original = new Uint8Array([1, 2, 3])
    const createInput = {
      workspaceId,
      fileName: "finch-receipt.pdf",
      contentType: "application/pdf",
      contentLength: BigInt(original.byteLength),
      sha256: hash(original),
      idempotencyKey: "receipt-full-flow",
      merchant: "Finch Store",
      total: { minorUnits: "1250", currency: "EUR" },
      receiptDate: "2026-09-10",
    }
    const created = await run(createReceiptUploadIntent(principal, createInput))
    expect(created.receipt).toMatchObject({
      status: "pending",
      fileName: "finch-receipt.pdf",
      merchant: "Finch Store",
      total: { minorUnits: "1250", currency: "EUR" },
      receiptDate: "2026-09-10",
    })
    expect(created.upload.requiredHeaders).toEqual([{ name: "content-type", value: "application/pdf" }])
    expect(new URL(created.upload.url).pathname).toContain("/receipt-originals/")
    const replay = await run(createReceiptUploadIntent(principal, createInput))
    expect(replay.receipt.id).toBe(created.receipt.id)
    expect(replay.upload.requiredHeaders).toEqual([{ name: "content-type", value: "application/pdf" }])
    for (const changed of [
      { fileName: "other.pdf" },
      { contentType: "image/png" },
      { contentLength: 2n },
      { sha256: hash(new Uint8Array([1, 2, 4])) },
      { merchant: undefined },
      { merchant: "Other Store" },
      { total: undefined },
      { total: { minorUnits: "1251", currency: "EUR" } },
      { total: { minorUnits: "1250", currency: "USD" } },
      { receiptDate: undefined },
      { receiptDate: "2026-09-11" },
    ]) {
      expect(await expectFailure(createReceiptUploadIntent(principal, { ...createInput, ...changed }))).toMatchObject(
        new ReceiptConflict({ reason: "duplicate" }),
      )
    }
    await upload(replay.upload, original)

    const finalized = await run(finalizeReceipt(principal, { workspaceId, receiptId: created.receipt.id }))
    expect(finalized.status).toBe("ready")
    const repeatedFinalize = await run(finalizeReceipt(principal, { workspaceId, receiptId: created.receipt.id }))
    expect(repeatedFinalize).toMatchObject({ id: created.receipt.id, status: "ready" })

    const download = await run(getReceiptDownloadUrl(principal, { workspaceId, receiptId: created.receipt.id }))
    expect(new Date(download.expiresAt).getTime()).toBeGreaterThan(Date.now())
    const downloadResponse = await fetch(download.url)
    expect(downloadResponse.ok).toBe(true)
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(original)
    const { data: bucket, error: bucketError } = await admin.storage.getBucket("receipt-originals")
    expect(bucketError).toBeNull()
    expect(bucket?.public).toBe(false)

    const { data: document, error: documentError } = await admin
      .from("finance_documents")
      .select("content")
      .eq("workspace_id", workspaceId)
      .eq("source_type", "receipt")
      .eq("source_id", created.receipt.id)
      .single()
    expect(documentError).toBeNull()
    expect(document?.content).toBe("receipt Finch Store 2026-09-10 1250 EUR")
    const { data: jobs, error: jobError } = await admin
      .from("job_requests")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("kind", "search.embed")
    expect(jobError).toBeNull()
    expect(jobs).toHaveLength(1)

    const absent = await run(createReceiptUploadIntent(principal, {
      workspaceId,
      fileName: "absent.png",
      contentType: "image/png",
      contentLength: 1n,
      sha256: hash(new Uint8Array([4])),
      idempotencyKey: "receipt-absent-fields",
    }))
    expect(absent.receipt).not.toHaveProperty("merchant")
    expect(absent.receipt).not.toHaveProperty("total")
    expect(absent.receipt).not.toHaveProperty("receiptDate")
    expect((await run(getReceipt(principal, { workspaceId, receiptId: absent.receipt.id }))).fileName).toBe("absent.png")

    const firstPage = await run(listReceipts(principal, { workspaceId, page: { pageSize: 1 } }))
    expect(firstPage.nextPageToken).toEqual(expect.any(String))
    const token = firstPage.nextPageToken as string
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const lastCharacter = token.at(-1) as string
    const tampered = `${token.slice(0, -1)}${alphabet[alphabet.indexOf(lastCharacter) + 1]}`
    expect((await expectFailure(listReceipts(principal, { workspaceId, page: { pageSize: 1, pageToken: tampered } })))._tag)
      .toBe(new ValidationFailed({ issues: [] })._tag)
    expect((await expectFailure(listReceipts(principal, { workspaceId: otherWorkspaceId, page: { pageSize: 1, pageToken: token } })))._tag)
      .toBe(new ValidationFailed({ issues: [] })._tag)

    for (const invalid of [
      { contentType: "image/gif", contentLength: 1n, sha256: hash(new Uint8Array([5])) },
      { contentType: "application/pdf", contentLength: 0n, sha256: hash(new Uint8Array([5])) },
      { contentType: "application/pdf", contentLength: 10n * 1024n * 1024n + 1n, sha256: hash(new Uint8Array([5])) },
      { contentType: "application/pdf", contentLength: 1n, sha256: "A".repeat(64) },
    ]) {
      expect((await expectFailure(createReceiptUploadIntent(principal, {
        workspaceId,
        fileName: "invalid.pdf",
        idempotencyKey: `invalid-${invalid.contentType}-${invalid.contentLength}-${invalid.sha256.slice(0, 1)}`,
        ...invalid,
      })))._tag).toBe(new ValidationFailed({ issues: [] })._tag)
    }

    const tenMiB = new Uint8Array(10 * 1024 * 1024)
    tenMiB.fill(6)
    const maximum = await run(createReceiptUploadIntent(principal, {
      workspaceId,
      fileName: "maximum.jpg",
      contentType: "image/jpeg",
      contentLength: BigInt(tenMiB.byteLength),
      sha256: hash(tenMiB),
      idempotencyKey: "receipt-maximum-size",
    }))
    await upload(maximum.upload, tenMiB)
    expect((await run(finalizeReceipt(principal, { workspaceId, receiptId: maximum.receipt.id }))).status).toBe("ready")

    const mismatch = await run(createReceiptUploadIntent(principal, {
      workspaceId,
      fileName: "mismatch.pdf",
      contentType: "application/pdf",
      contentLength: 1n,
      sha256: hash(new Uint8Array([7])),
      idempotencyKey: "receipt-hash-mismatch",
    }))
    await upload(mismatch.upload, new Uint8Array([8]))
    expect((await expectFailure(finalizeReceipt(principal, { workspaceId, receiptId: mismatch.receipt.id })))._tag)
      .toBe(new ReceiptHashMismatch()._tag)
    expect((await run(getReceipt(principal, { workspaceId, receiptId: mismatch.receipt.id }))).status).toBe("failed")
    const { data: mismatchAudit, error: mismatchAuditError } = await admin
      .from("audit_events")
      .select("safe_error_code,metadata")
      .eq("workspace_id", workspaceId)
      .eq("resource_id", mismatch.receipt.id)
      .eq("action", "receipt.upload_failed")
      .single()
    expect(mismatchAuditError).toBeNull()
    expect(mismatchAudit).toMatchObject({ safe_error_code: "receipt_hash_mismatch", metadata: {} })

    const sizeMismatch = await run(createReceiptUploadIntent(principal, {
      workspaceId,
      fileName: "size-mismatch.pdf",
      contentType: "application/pdf",
      contentLength: 1n,
      sha256: hash(new Uint8Array([10])),
      idempotencyKey: "receipt-size-mismatch",
    }))
    await upload(sizeMismatch.upload, new Uint8Array([10, 11]))

    const contentTypeMismatch = await run(createReceiptUploadIntent(principal, {
      workspaceId,
      fileName: "content-type-mismatch.pdf",
      contentType: "application/pdf",
      contentLength: 1n,
      sha256: hash(new Uint8Array([12])),
      idempotencyKey: "receipt-content-type-mismatch",
    }))
    await upload({
      ...contentTypeMismatch.upload,
      requiredHeaders: [{ name: "content-type", value: "image/png" }],
    }, new Uint8Array([12]))

    for (const receipt of [sizeMismatch.receipt, contentTypeMismatch.receipt]) {
      expect((await expectFailure(finalizeReceipt(principal, { workspaceId, receiptId: receipt.id })))._tag)
        .toBe(new ReceiptMetadataMismatch()._tag)
      expect((await run(getReceipt(principal, { workspaceId, receiptId: receipt.id }))).status).toBe("failed")

      const { data: metadataDocument, error: metadataDocumentError } = await admin
        .from("finance_documents")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("source_type", "receipt")
        .eq("source_id", receipt.id)
        .maybeSingle()
      expect(metadataDocumentError).toBeNull()
      expect(metadataDocument).toBeNull()
      const { data: metadataJobs, error: metadataJobError } = await admin
        .from("job_requests")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("kind", "search.embed")
        .contains("payload", { source_type: "receipt", source_id: receipt.id })
      expect(metadataJobError).toBeNull()
      expect(metadataJobs).toEqual([])
      const { data: metadataAudit, error: metadataAuditError } = await admin
        .from("audit_events")
        .select("safe_error_code,metadata")
        .eq("workspace_id", workspaceId)
        .eq("resource_id", receipt.id)
        .eq("action", "receipt.upload_failed")
        .single()
      expect(metadataAuditError).toBeNull()
      expect(metadataAudit).toMatchObject({ safe_error_code: "receipt_metadata_mismatch", metadata: {} })
    }

    expect((await expectFailure(createReceiptUploadIntent(principal, {
      workspaceId: otherWorkspaceId,
      fileName: "viewer.pdf",
      contentType: "application/pdf",
      contentLength: 1n,
      sha256: hash(new Uint8Array([9])),
      idempotencyKey: "viewer-denied",
    })))._tag).toBe(new ReceiptWriteDenied({ workspaceId: otherWorkspaceId })._tag)
    expect((await expectFailure(listReceipts({ ...principal, subjectId: "unmapped-subject" }, { workspaceId })))._tag)
      .toBe(new WorkspaceAccessDenied({ workspaceId })._tag)

    const { error: revocationError } = await admin
      .from("workspace_members")
      .update({ revoked_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
    expect(revocationError).toBeNull()
    expect((await expectFailure(listReceipts(principal, { workspaceId })))._tag)
      .toBe(new WorkspaceAccessDenied({ workspaceId })._tag)
  }, 120_000)
})
