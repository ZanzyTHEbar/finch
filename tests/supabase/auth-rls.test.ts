import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.FINCH_TEST_SUPABASE_URL;
const anonKey = process.env.FINCH_TEST_SUPABASE_ANON_KEY;
const serviceKey = process.env.FINCH_TEST_SUPABASE_SERVICE_ROLE_KEY;
const workerToken = process.env.FINCH_TEST_WORKER_TOKEN;

if (url === undefined || anonKey === undefined || serviceKey === undefined || workerToken === undefined) {
  throw new Error("cloud tests require scripts/run-cloud-tests.mjs");
}

type ReceiptUploadTarget = {
  receiptId: string;
  upload: {
    url: string;
    method: "PUT";
    requiredHeaders: Array<{ name: string; value: string }>;
  };
};

const uploadReceipt = async (target: ReceiptUploadTarget["upload"], body: Uint8Array): Promise<void> => {
  const signedUploadUrl = new URL(target.url);
  const localApiUrl = new URL(url);
  signedUploadUrl.protocol = localApiUrl.protocol;
  signedUploadUrl.host = localApiUrl.host;
  const response = await fetch(signedUploadUrl, {
    method: target.method,
    headers: new Headers(target.requiredHeaders.map((header) => [header.name, header.value])),
    body,
  });
  expect(response.ok).toBe(true);
};

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const PostgresClient = createRequire(import.meta.url)("pg").Client;
const createdUsers: string[] = [];
const stateHash = (state: string): string => `\\x${createHash("sha256").update(state).digest("hex")}`;

const createUserClient = async (name: string): Promise<SupabaseClient> => {
  const email = `${name}-${crypto.randomUUID()}@finch.test`;
  const password = "A-strong-password-for-finch-tests!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error !== null || data.user === null) throw error ?? new Error("user creation failed");
  createdUsers.push(data.user.id);
  const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError !== null) throw signInError;
  return client;
};

const accessToken = async (client: SupabaseClient): Promise<string> => {
  const { data, error } = await client.auth.getSession();
  if (error !== null || data.session === null) throw error ?? new Error("session missing");
  return data.session.access_token;
};

afterAll(async () => {
  await Promise.all(createdUsers.map((id) => admin.auth.admin.deleteUser(id)));
});

describe("Supabase Auth and RLS", () => {
  it("derives workspace access from the verified user and rejects forged workspace context", async () => {
    const alice = await createUserClient("alice");
    const bob = await createUserClient("bob");
    const { data: workspaceId, error: workspaceError } = await alice.rpc("create_workspace", { p_name: "Alice finance" });
    expect(workspaceError).toBeNull();
    expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/i);

    const aliceToken = await accessToken(alice);
    const bobToken = await accessToken(bob);
    const aliceResponse = await fetch(`${url}/functions/v1/api/workspaces`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(aliceResponse.status).toBe(200);
    const aliceWorkspaces = (await aliceResponse.json()) as Array<{ id: string }>;
    expect(aliceWorkspaces.map((workspace) => workspace.id)).toContain(workspaceId);

    const forged = await fetch(`${url}/functions/v1/api/bank/connections`, {
      headers: {
        authorization: `Bearer ${bobToken}`,
        "x-finch-workspace": workspaceId,
      },
    });
    expect(forged.status).toBe(404);
    expect(await forged.json()).toEqual({ error: "workspace_not_found" });

    const { data: directRead, error: directError } = await bob
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId);
    expect(directError).toBeNull();
    expect(directRead).toEqual([]);

    const { error: directWriteError } = await alice.from("workspaces").insert({ name: "forged direct write" });
    expect(directWriteError?.code).toBe("42501");

    const { error: deletingError } = await admin.from("workspaces").update({ state: "deleting", deletion_requested_at: new Date().toISOString() }).eq("id", workspaceId);
    expect(deletingError).toBeNull();
    const writeAfterDeletionRequest = await fetch(`${url}/functions/v1/api/receipts/upload-intents`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}`, "x-finch-workspace": workspaceId, "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/png", byteSize: 1, sha256: "0".repeat(64), idempotencyKey: "deleted-workspace-receipt" }),
    });
    expect(writeAfterDeletionRequest.status).toBe(404);
  });

  it("keeps Storage private and runs stateless workers only with their deployment token", async () => {
    const alice = await createUserClient("storage");
    const { data: workspaceId, error } = await alice.rpc("create_workspace", { p_name: "Storage finance" });
    expect(error).toBeNull();
    const token = await accessToken(alice);
    const receiptBytes = new TextEncoder().encode("receipt image bytes");
    const sha256 = createHash("sha256").update(receiptBytes).digest("hex");
    const receiptIntent = {
      mimeType: "image/png",
      byteSize: receiptBytes.byteLength,
      sha256,
      idempotencyKey: "storage-receipt-intent",
      merchant: "Finch Store",
      totalMinor: "1234",
      currency: "EUR",
      receiptDate: "2026-09-10",
    };
    const receiptHeaders = {
      authorization: `Bearer ${token}`,
      "x-finch-workspace": workspaceId,
      "content-type": "application/json",
    };
    const createReceiptIntent = (body: Record<string, unknown>) => fetch(`${url}/functions/v1/api/receipts/upload-intents`, {
      method: "POST",
      headers: receiptHeaders,
      body: JSON.stringify(body),
    });
    for (const idempotencyKey of ["", " ", "x".repeat(201)]) {
      const invalidIntent = await createReceiptIntent({ ...receiptIntent, idempotencyKey });
      expect(invalidIntent.status).toBe(400);
      expect(await invalidIntent.json()).toEqual({ error: "invalid_idempotency_key" });
    }
    const uploadIntent = await createReceiptIntent(receiptIntent);
    const uploadIntentBody = await uploadIntent.text();
    expect(uploadIntent.status, uploadIntentBody).toBe(201);
    const intent = JSON.parse(uploadIntentBody) as ReceiptUploadTarget;
    expect(intent).toMatchObject({
      receiptId: expect.any(String),
      upload: {
        url: expect.any(String),
        method: "PUT",
        requiredHeaders: [{ name: "content-type", value: "image/png" }],
      },
    });
    expect(intent).not.toHaveProperty("uploadUrl");
    const replay = await createReceiptIntent(receiptIntent);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({
      receiptId: intent.receiptId,
      upload: {
        url: expect.any(String),
        method: "PUT",
        requiredHeaders: [{ name: "content-type", value: "image/png" }],
      },
    });
    for (const changed of [
      { mimeType: "application/pdf" },
      { byteSize: receiptBytes.byteLength + 1 },
      { sha256: createHash("sha256").update("other receipt").digest("hex") },
      { merchant: undefined },
      { merchant: "Other Store" },
      { totalMinor: undefined },
      { totalMinor: "1235" },
      { currency: undefined },
      { currency: "USD" },
      { receiptDate: undefined },
      { receiptDate: "2026-09-11" },
    ]) {
      const conflict = await createReceiptIntent({ ...receiptIntent, ...changed });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: "receipt_idempotency_conflict" });
    }
    await uploadReceipt(intent.upload, receiptBytes);
    const finalized = await fetch(`${url}/functions/v1/api/receipts/${intent.receiptId}/finalize`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-finch-workspace": workspaceId },
    });
    expect(finalized.status).toBe(200);
    const finalizedAgain = await fetch(`${url}/functions/v1/api/receipts/${intent.receiptId}/finalize`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-finch-workspace": workspaceId },
    });
    expect(finalizedAgain.status).toBe(200);
    const { data: documents, error: documentError } = await alice
      .from("finance_documents")
      .select("id")
      .eq("source_type", "receipt")
      .eq("source_id", intent.receiptId);
    expect(documentError).toBeNull();
    expect(documents).toHaveLength(1);
    const receipts = await fetch(`${url}/functions/v1/api/receipts`, {
      headers: { authorization: `Bearer ${token}`, "x-finch-workspace": workspaceId },
    });
    expect(receipts.status).toBe(200);
    expect(await receipts.json()).toMatchObject([{ id: intent.receiptId, upload_state: "ready" }]);
    const { error: rawReceiptError } = await alice.from("receipts").select("object_key");
    expect(rawReceiptError).not.toBeNull();
    const { error: rawPaymentError } = await alice.from("payment_orders").select("provider_payment_ref,state_hash");
    expect(rawPaymentError).not.toBeNull();
    const { error: uploadError } = await alice.storage
      .from("receipt-originals")
      .upload(`${workspaceId}/${crypto.randomUUID()}/${crypto.randomUUID()}`, new Blob(["forged"]), { contentType: "image/png" });
    expect(uploadError).not.toBeNull();

    const mcpReceiptBytes = new Uint8Array([9, 8, 7]);
    const mcpUploadIntentResponse = await fetch(`${url}/functions/v1/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "receipt-upload-intent",
        method: "tools/call",
        params: {
          name: "create_receipt_upload_intent",
          arguments: {
            workspaceId,
            mimeType: "application/pdf",
            byteSize: mcpReceiptBytes.byteLength,
            sha256: createHash("sha256").update(mcpReceiptBytes).digest("hex"),
            idempotencyKey: "mcp-receipt-upload-intent",
          },
        },
      }),
    });
    expect(mcpUploadIntentResponse.status).toBe(200);
    const mcpUploadIntent = await mcpUploadIntentResponse.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(mcpUploadIntent.result.isError).not.toBe(true);
    const mcpTarget = JSON.parse(mcpUploadIntent.result.content[0]?.text ?? "") as ReceiptUploadTarget;
    expect(mcpTarget).toMatchObject({
      receiptId: expect.any(String),
      upload: {
        url: expect.any(String),
        method: "PUT",
        requiredHeaders: [{ name: "content-type", value: "application/pdf" }],
      },
    });
    expect(mcpTarget).not.toHaveProperty("uploadUrl");
    await uploadReceipt(mcpTarget.upload, mcpReceiptBytes);

    const metadataBytes = new Uint8Array([1, 2]);
    const metadataIntentResponse = await createReceiptIntent({
      mimeType: "application/pdf",
      byteSize: 1,
      sha256: createHash("sha256").update(metadataBytes).digest("hex"),
      idempotencyKey: "receipt-metadata-mismatch",
    });
    expect(metadataIntentResponse.status).toBe(201);
    const metadataIntent = await metadataIntentResponse.json() as ReceiptUploadTarget;
    await uploadReceipt(metadataIntent.upload, metadataBytes);
    const metadataFinalize = await fetch(`${url}/functions/v1/api/receipts/${metadataIntent.receiptId}/finalize`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-finch-workspace": workspaceId },
    });
    expect(metadataFinalize.status).toBe(422);
    expect(await metadataFinalize.json()).toEqual({ error: "receipt_metadata_mismatch" });
    const { data: metadataReceipt, error: metadataReceiptError } = await admin
      .from("receipts")
      .select("object_key,upload_state")
      .eq("id", metadataIntent.receiptId)
      .single();
    expect(metadataReceiptError).toBeNull();
    expect(metadataReceipt).toMatchObject({ upload_state: "failed" });
    const { data: removedObject, error: removedObjectError } = await admin.storage.from("receipt-originals").download(metadataReceipt?.object_key ?? "");
    expect(removedObject).toBeNull();
    expect(removedObjectError).not.toBeNull();
    const { data: metadataDocuments, error: metadataDocumentError } = await admin
      .from("finance_documents")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("source_type", "receipt")
      .eq("source_id", metadataIntent.receiptId);
    expect(metadataDocumentError).toBeNull();
    expect(metadataDocuments).toEqual([]);
    const { data: metadataJobs, error: metadataJobError } = await admin
      .from("job_requests")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("kind", "search.embed")
      .contains("payload", { source_type: "receipt", source_id: metadataIntent.receiptId });
    expect(metadataJobError).toBeNull();
    expect(metadataJobs).toEqual([]);
    const { data: metadataAudit, error: metadataAuditError } = await admin
      .from("audit_events")
      .select("safe_error_code,metadata")
      .eq("workspace_id", workspaceId)
      .eq("resource_id", metadataIntent.receiptId)
      .eq("action", "receipt.upload_failed")
      .single();
    expect(metadataAuditError).toBeNull();
    expect(metadataAudit).toEqual({ safe_error_code: "receipt_metadata_mismatch", metadata: {} });

    const deleteFailureBytes = new Uint8Array([3]);
    const deleteFailureIntentResponse = await createReceiptIntent({
      mimeType: "application/pdf",
      byteSize: deleteFailureBytes.byteLength,
      sha256: createHash("sha256").update(new Uint8Array([4])).digest("hex"),
      idempotencyKey: "receipt-delete-failure",
    });
    expect(deleteFailureIntentResponse.status).toBe(201);
    const deleteFailureIntent = await deleteFailureIntentResponse.json() as ReceiptUploadTarget;
    await uploadReceipt(deleteFailureIntent.upload, deleteFailureBytes);

    const db = new PostgresClient({
      connectionString: process.env.FINCH_TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });
    await db.connect();
    try {
      await db.query(`
        create function public.finch_test_reject_receipt_delete()
        returns trigger
        language plpgsql
        as $$
        begin
          if old.bucket_id = 'receipt-originals' then
            raise exception 'test receipt delete failure';
          end if;
          return old;
        end;
        $$;
        create trigger finch_test_reject_receipt_delete
        before delete on storage.objects
        for each row execute function public.finch_test_reject_receipt_delete();
      `);
      const deleteFailureFinalize = await fetch(`${url}/functions/v1/api/receipts/${deleteFailureIntent.receiptId}/finalize`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-finch-workspace": workspaceId },
      });
      expect(deleteFailureFinalize.status).toBe(500);
      expect(await deleteFailureFinalize.json()).toEqual({ error: "storage_unavailable" });
    } finally {
      await db.query("drop trigger if exists finch_test_reject_receipt_delete on storage.objects");
      await db.query("drop function if exists public.finch_test_reject_receipt_delete()");
      await db.end();
    }
    const { data: deleteFailureReceipt, error: deleteFailureReceiptError } = await admin
      .from("receipts")
      .select("upload_state")
      .eq("id", deleteFailureIntent.receiptId)
      .single();
    expect(deleteFailureReceiptError).toBeNull();
    expect(deleteFailureReceipt).toEqual({ upload_state: "pending" });
    const { data: deleteFailureDocuments, error: deleteFailureDocumentError } = await admin
      .from("finance_documents")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("source_type", "receipt")
      .eq("source_id", deleteFailureIntent.receiptId);
    expect(deleteFailureDocumentError).toBeNull();
    expect(deleteFailureDocuments).toEqual([]);
    const { data: deleteFailureJobs, error: deleteFailureJobError } = await admin
      .from("job_requests")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("kind", "search.embed")
      .contains("payload", { source_type: "receipt", source_id: deleteFailureIntent.receiptId });
    expect(deleteFailureJobError).toBeNull();
    expect(deleteFailureJobs).toEqual([]);
    const { data: deleteFailureAudit, error: deleteFailureAuditError } = await admin
      .from("audit_events")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("resource_id", deleteFailureIntent.receiptId)
      .eq("action", "receipt.upload_failed");
    expect(deleteFailureAuditError).toBeNull();
    expect(deleteFailureAudit).toEqual([]);

    const auditFailureBytes = new Uint8Array([5]);
    const auditFailureIntentResponse = await createReceiptIntent({
      mimeType: "application/pdf",
      byteSize: auditFailureBytes.byteLength,
      sha256: createHash("sha256").update(new Uint8Array([6])).digest("hex"),
      idempotencyKey: "receipt-audit-failure",
    });
    expect(auditFailureIntentResponse.status).toBe(201);
    const auditFailureIntent = await auditFailureIntentResponse.json() as ReceiptUploadTarget;
    await uploadReceipt(auditFailureIntent.upload, auditFailureBytes);

    const auditDb = new PostgresClient({
      connectionString: process.env.FINCH_TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    });
    await auditDb.connect();
    try {
      await auditDb.query(`
        create function public.finch_test_reject_receipt_upload_failure_audit()
        returns trigger
        language plpgsql
        as $$
        begin
          if new.action = 'receipt.upload_failed' then
            raise exception 'test receipt upload failure audit rejection';
          end if;
          return new;
        end;
        $$;
        create trigger finch_test_reject_receipt_upload_failure_audit
        before insert on public.audit_events
        for each row execute function public.finch_test_reject_receipt_upload_failure_audit();
      `);
      const auditFailureFinalize = await fetch(`${url}/functions/v1/api/receipts/${auditFailureIntent.receiptId}/finalize`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-finch-workspace": workspaceId },
      });
      expect(auditFailureFinalize.status).toBe(500);
      expect(await auditFailureFinalize.json()).toEqual({ error: "storage_unavailable" });
    } finally {
      await auditDb.query("drop trigger if exists finch_test_reject_receipt_upload_failure_audit on public.audit_events");
      await auditDb.query("drop function if exists public.finch_test_reject_receipt_upload_failure_audit()");
      await auditDb.end();
    }
    const { data: auditFailureReceipt, error: auditFailureReceiptError } = await admin
      .from("receipts")
      .select("object_key,upload_state")
      .eq("id", auditFailureIntent.receiptId)
      .single();
    expect(auditFailureReceiptError).toBeNull();
    expect(auditFailureReceipt).toMatchObject({ upload_state: "pending" });
    const { data: auditFailureObject, error: auditFailureObjectError } = await admin.storage
      .from("receipt-originals")
      .download(auditFailureReceipt?.object_key ?? "");
    expect(auditFailureObject).toBeNull();
    expect(auditFailureObjectError).not.toBeNull();
    const { data: auditFailureAudit, error: auditFailureAuditError } = await admin
      .from("audit_events")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("resource_id", auditFailureIntent.receiptId)
      .eq("action", "receipt.upload_failed");
    expect(auditFailureAuditError).toBeNull();
    expect(auditFailureAudit).toEqual([]);

    const deniedWorker = await fetch(`${url}/functions/v1/worker-run`, { method: "POST" });
    expect(deniedWorker.status).toBe(401);
    const allowedWorker = await fetch(`${url}/functions/v1/worker-run`, {
      method: "POST",
      headers: { "x-worker-token": workerToken },
    });
    expect(allowedWorker.status).toBe(200);
    expect(await allowedWorker.json()).toMatchObject({ processed: 1, succeeded: 1, retried: 0, dead: 0 });
  });

  it("requires recent MFA for payments, exports, and irreversible deletion", async () => {
    const alice = await createUserClient("mfa");
    const { data: workspaceId, error } = await alice.rpc("create_workspace", { p_name: "MFA finance" });
    expect(error).toBeNull();
    const token = await accessToken(alice);
    const headers = { authorization: `Bearer ${token}`, "x-finch-workspace": workspaceId, "content-type": "application/json" };
    const [payment, exportRequest, deletion] = await Promise.all([
      fetch(`${url}/functions/v1/api/payments`, { method: "POST", headers, body: JSON.stringify({ returnPath: "/payments/complete" }) }),
      fetch(`${url}/functions/v1/api/exports`, { method: "POST", headers }),
      fetch(`${url}/functions/v1/api/deletion-requests`, { method: "POST", headers, body: JSON.stringify({ confirm: true }) }),
    ]);
    expect(payment.status).toBe(403);
    expect(exportRequest.status).toBe(403);
    expect(deletion.status).toBe(403);
  });

  it("recovers an uploaded export archive when its metadata write is interrupted", async () => {
    const alice = await createUserClient("export-recovery");
    const { data: workspaceId, error: workspaceError } = await alice.rpc("create_workspace", { p_name: "Export recovery" });
    expect(workspaceError).toBeNull();
    const { data: userData, error: userError } = await alice.auth.getUser();
    expect(userError).toBeNull();
    if (userData.user === null) throw new Error("test user missing");

    const { data: exportRow, error: exportError } = await admin
      .from("data_exports")
      .insert({ workspace_id: workspaceId, requested_by: userData.user.id })
      .select("id")
      .single();
    expect(exportError).toBeNull();
    if (exportRow === null) throw new Error("export creation failed");

    const enqueue = async () => {
      const { error } = await admin.rpc("enqueue_finch_job", {
        p_workspace_id: workspaceId,
        p_kind: "export.create",
        p_payload: { export_id: exportRow.id },
        p_idempotency_key: exportRow.id,
      });
      expect(error).toBeNull();
    };
    const runWorker = async () => {
      const response = await fetch(`${url}/functions/v1/worker-run`, {
        method: "POST",
        headers: { "x-worker-token": workerToken },
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(JSON.parse(body)).toMatchObject({ processed: 1, succeeded: 1, retried: 0, dead: 0 });
    };

    await enqueue();
    await runWorker();
    const { data: originalParts, error: originalPartsError } = await admin
      .from("data_export_parts")
      .select("object_key,byte_size,sha256")
      .eq("export_id", exportRow.id)
      .order("ordinal");
    expect(originalPartsError).toBeNull();
    expect(originalParts).toHaveLength(1);
    const originalPart = originalParts?.[0];
    if (originalPart === undefined) throw new Error("export part missing");
    const { data: originalObject, error: originalObjectError } = await admin.storage.from("exports").download(originalPart.object_key);
    expect(originalObjectError).toBeNull();
    if (originalObject === null) throw new Error("export object missing");
    const originalBytes = new Uint8Array(await originalObject.arrayBuffer());

    const { error: runningError } = await admin.from("data_exports").update({ status: "running", expires_at: null }).eq("id", exportRow.id);
    expect(runningError).toBeNull();
    const { error: deletePartsError } = await admin.from("data_export_parts").delete().eq("export_id", exportRow.id);
    expect(deletePartsError).toBeNull();
    const { error: deleteJobError } = await admin
      .from("job_requests")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("kind", "export.create")
      .eq("idempotency_key", exportRow.id);
    expect(deleteJobError).toBeNull();

    await enqueue();
    await runWorker();
    const { data: recoveredParts, error: recoveredPartsError } = await admin
      .from("data_export_parts")
      .select("object_key,byte_size,sha256")
      .eq("export_id", exportRow.id)
      .order("ordinal");
    expect(recoveredPartsError).toBeNull();
    expect(recoveredParts).toEqual(originalParts);
    const { data: recoveredObject, error: recoveredObjectError } = await admin.storage.from("exports").download(originalPart.object_key);
    expect(recoveredObjectError).toBeNull();
    if (recoveredObject === null) throw new Error("recovered export object missing");
    expect(new Uint8Array(await recoveredObject.arrayBuffer())).toEqual(originalBytes);
  });

  it("dead-letters malformed worker payloads without retrying", async () => {
    const alice = await createUserClient("invalid-job-payload");
    const { data: workspaceId, error: workspaceError } = await alice.rpc("create_workspace", { p_name: "Invalid job payload" });
    expect(workspaceError).toBeNull();
    const { data: jobId, error: enqueueError } = await admin.rpc("enqueue_finch_job", {
      p_workspace_id: workspaceId,
      p_kind: "export.create",
      p_payload: { export_id: "not-a-uuid" },
      p_idempotency_key: "invalid-job-payload",
    });
    expect(enqueueError).toBeNull();

    const response = await fetch(`${url}/functions/v1/worker-run`, {
      method: "POST",
      headers: { "x-worker-token": workerToken },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 1, succeeded: 0, retried: 0, dead: 1 });
    const { data: job, error: jobError } = await admin
      .from("job_requests")
      .select("status,safe_error_code")
      .eq("id", jobId)
      .single();
    expect(jobError).toBeNull();
    expect(job).toEqual({ status: "dead", safe_error_code: "invalid_job_payload" });
  });

  it("accepts only relative provider return paths and redirects callbacks through the configured app origin", async () => {
    const alice = await createUserClient("redirects");
    const { data: workspaceId, error } = await alice.rpc("create_workspace", { p_name: "Redirect finance" });
    expect(error).toBeNull();
    const token = await accessToken(alice);
    const headers = { authorization: `Bearer ${token}`, "x-finch-workspace": workspaceId, "content-type": "application/json" };
    const returnPath = "/bank/complete?source=provider#done";

    const accepted = await fetch(`${url}/functions/v1/api/bank/authorizations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ aspspName: "Example Bank", aspspCountry: "PT", returnPath }),
    });
    expect(accepted.status).toBe(502);
    const { data: authorization, error: authorizationError } = await admin
      .from("bank_authorizations")
      .select("return_path")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    expect(authorizationError).toBeNull();
    expect(authorization).toEqual({ return_path: returnPath });

    for (const invalidPath of [
      "https://attacker.test/return",
      "//attacker.test/return",
      "/%2f%2fattacker.test/return",
      "/%5c%5cattacker.test/return",
      "/\\attacker.test/return",
      "/return%",
      "/return\u0000",
    ]) {
      const rejected = await fetch(`${url}/functions/v1/api/bank/authorizations`, {
        method: "POST",
        headers,
        body: JSON.stringify({ aspspName: "Example Bank", aspspCountry: "PT", returnPath: invalidPath }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: "invalid_return_path" });
    }

    const validPaymentPath = await fetch(`${url}/functions/v1/api/payments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ returnPath: "/payments/complete?source=provider#done" }),
    });
    expect(validPaymentPath.status).toBe(403);
    const rejectedPaymentPath = await fetch(`${url}/functions/v1/api/payments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ returnPath: "https://attacker.test/return" }),
    });
    expect(rejectedPaymentPath.status).toBe(400);
    expect(await rejectedPaymentPath.json()).toEqual({ error: "invalid_return_path" });

    const callbackState = `bank-callback-${crypto.randomUUID()}`;
    const { data: connection, error: connectionError } = await admin
      .from("bank_connections")
      .insert({ workspace_id: workspaceId, provider: "enablebanking", aspsp_name: "Example Bank", aspsp_country: "PT", created_by: (await alice.auth.getUser()).data.user?.id })
      .select("id")
      .single();
    expect(connectionError).toBeNull();
    const { data: userData, error: userError } = await alice.auth.getUser();
    expect(userError).toBeNull();
    if (userData.user === null) throw new Error("test user missing");
    const { error: callbackAuthorizationError } = await admin.from("bank_authorizations").insert({
      workspace_id: workspaceId,
      connection_id: connection?.id,
      user_id: userData.user.id,
      state_hash: stateHash(callbackState),
      return_path: returnPath,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(callbackAuthorizationError).toBeNull();

    const callback = await fetch(`${url}/functions/v1/bank-callback?state=${encodeURIComponent(callbackState)}&error=access_denied`, { redirect: "manual" });
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("https://app.finch.test/bank/complete?source=provider&bank=failed#done");
    const reused = await fetch(`${url}/functions/v1/bank-callback?state=${encodeURIComponent(callbackState)}&error=access_denied`, { redirect: "manual" });
    expect(reused.status).toBe(400);

    const paymentState = `payment-callback-${crypto.randomUUID()}`;
    const paymentId = crypto.randomUUID();
    const { error: paymentInsertError } = await admin.from("payment_orders").insert({
      id: paymentId,
      workspace_id: workspaceId,
      bank_connection_id: connection?.id,
      client_request_id: crypto.randomUUID(),
      status: "authorization_pending",
      creditor_name: "Example Creditor",
      creditor_iban: "PT50000201231234567890154",
      amount_minor: "100",
      currency: "EUR",
      state_hash: stateHash(paymentState),
      return_path: "/payments/complete?source=provider#done",
      state_expires_at: new Date(Date.now() + 60_000).toISOString(),
      created_by: userData.user.id,
    });
    expect(paymentInsertError).toBeNull();
    const paymentCallback = await fetch(`${url}/functions/v1/bank-callback?state=${encodeURIComponent(paymentState)}&error=access_denied`, { redirect: "manual" });
    expect(paymentCallback.status).toBe(303);
    expect(paymentCallback.headers.get("location")).toBe("https://app.finch.test/payments/complete?source=provider&payment=failed#done");
    const { data: rejectedPayment, error: rejectedPaymentError } = await admin
      .from("payment_orders")
      .select("status,state_used_at")
      .eq("id", paymentId)
      .single();
    expect(rejectedPaymentError).toBeNull();
    expect(rejectedPayment).toMatchObject({ status: "rejected" });
    expect(rejectedPayment?.state_used_at).not.toBeNull();
    const reusedPayment = await fetch(`${url}/functions/v1/bank-callback?state=${encodeURIComponent(paymentState)}&error=access_denied`, { redirect: "manual" });
    expect(reusedPayment.status).toBe(400);

    const unverifiedState = `payment-unverified-${crypto.randomUUID()}`;
    const unverifiedPaymentId = crypto.randomUUID();
    const { error: unverifiedPaymentError } = await admin.from("payment_orders").insert({
      id: unverifiedPaymentId,
      workspace_id: workspaceId,
      bank_connection_id: connection?.id,
      provider_payment_ref: `forged-provider-payment-ref-${crypto.randomUUID()}`,
      client_request_id: crypto.randomUUID(),
      status: "authorization_pending",
      creditor_name: "Example Creditor",
      creditor_iban: "PT50000201231234567890154",
      amount_minor: "100",
      currency: "EUR",
      state_hash: stateHash(unverifiedState),
      return_path: "/payments/complete?source=provider#done",
      state_expires_at: new Date(Date.now() + 60_000).toISOString(),
      created_by: userData.user.id,
    });
    expect(unverifiedPaymentError).toBeNull();
    const unverifiedCallback = await fetch(`${url}/functions/v1/bank-callback?state=${encodeURIComponent(unverifiedState)}`, { redirect: "manual" });
    expect(unverifiedCallback.status).toBe(303);
    expect(unverifiedCallback.headers.get("location")).toBe("https://app.finch.test/payments/complete?source=provider&payment=unknown#done");
    const { data: unverifiedPayment, error: unverifiedPaymentStatusError } = await admin
      .from("payment_orders")
      .select("status,state_used_at")
      .eq("id", unverifiedPaymentId)
      .single();
    expect(unverifiedPaymentStatusError).toBeNull();
    expect(unverifiedPayment).toMatchObject({ status: "submission_unknown" });
    expect(unverifiedPayment?.state_used_at).not.toBeNull();
    const { data: unverifiedEvents, error: unverifiedEventsError } = await admin
      .from("payment_provider_events")
      .select("id")
      .eq("payment_id", unverifiedPaymentId);
    expect(unverifiedEventsError).toBeNull();
    expect(unverifiedEvents).toEqual([]);
  });

  it("requires a user token for remote MCP initialization", async () => {
    const alice = await createUserClient("mcp");
    const token = await accessToken(alice);
    const denied = await fetch(`${url}/functions/v1/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(denied.status).toBe(200);
    expect(await denied.json()).toMatchObject({ error: { message: "authentication_required" } });

    const initialized = await fetch(`${url}/functions/v1/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({ result: { serverInfo: { name: "finch" }, capabilities: { tools: {} } } });
    const listed = await fetch(`${url}/functions/v1/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    const tools = (await listed.json()) as { result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> } };
    const bankAuthorization = tools.result.tools.find((tool) => tool.name === "start_bank_authorization");
    const payment = tools.result.tools.find((tool) => tool.name === "create_payment");
    expect(bankAuthorization?.inputSchema.required).toContain("returnPath");
    expect(bankAuthorization?.inputSchema.required).not.toContain("redirectUrl");
    expect(payment?.inputSchema.required).toContain("returnPath");
    expect(payment?.inputSchema.required).not.toContain("redirectUrl");
    expect(tools.result.tools.find((tool) => tool.name === "submit_payment")).toBeUndefined();
    const invalidBankCallback = await fetch(`${url}/functions/v1/bank-callback?state=invalid&code=invalid`);
    expect(invalidBankCallback.status).toBe(400);
  });
});
