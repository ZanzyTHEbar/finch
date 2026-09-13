import { byteaFromHex, randomState, requireSha256Hex, sha256Bytea } from "../_shared/crypto.ts";
import { ProviderError, startAuthorization } from "../_shared/enable-banking.ts";
import { errorResponse, HttpError, json, noContent, options, parseJson, requireString, requireUuid } from "../_shared/http.ts";
import { requireReturnPath } from "../_shared/return-path.ts";
import { assertNoError, requireUser, requireWorkspace, type WorkspaceContext } from "../_shared/supabase.ts";

const bankCallbackUrl = (): string => {
  const value = Deno.env.get("FINCH_BANK_CALLBACK_URL")?.trim();
  if (value === undefined || value === "") throw new Error("missing required FINCH_BANK_CALLBACK_URL");
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("FINCH_BANK_CALLBACK_URL must use https");
  return url.toString();
};

const audit = async (
  context: WorkspaceContext,
  action: string,
  resourceType: string,
  resourceId: string | null,
  outcome: "success" | "denied" | "failed",
  safeErrorCode?: string,
): Promise<void> => {
  const { error } = await context.admin.from("audit_events").insert({
    workspace_id: context.workspaceId,
    actor_id: context.userId,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    outcome,
    safe_error_code: safeErrorCode,
  });
  if (error !== null) throw new HttpError(500, "storage_unavailable");
};

const getRow = async <T>(
  context: WorkspaceContext,
  table: string,
  id: string,
): Promise<T> => {
  const { data, error } = await context.admin
    .from(table)
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (error !== null) throw new HttpError(500, "storage_unavailable");
  if (data === null) throw new HttpError(404, "resource_not_found");
  return data as T;
};

const createWorkspace = async (request: Request): Promise<Response> => {
  const body = await parseJson(request);
  const name = requireString(body.name, "name", 120);
  const { client } = await requireUser(request);
  const { data, error } = await client.rpc("create_workspace", { p_name: name });
  if (error !== null || typeof data !== "string") throw new HttpError(500, "workspace_creation_failed");
  return json({ workspaceId: data }, 201);
};

const listWorkspaces = async (request: Request): Promise<Response> => {
  const { client } = await requireUser(request);
  const { data, error } = await client.from("workspaces").select("id,name,created_at,updated_at").order("created_at");
  return json(assertNoError({ data, error }));
};

const startBankAuthorization = async (request: Request): Promise<Response> => {
  const context = await requireWorkspace(request, ["owner", "admin"]);
  const body = await parseJson(request);
  const aspspName = requireString(body.aspspName, "aspsp_name", 200);
  const aspspCountry = requireString(body.aspspCountry, "aspsp_country", 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(aspspCountry)) throw new HttpError(400, "invalid_aspsp_country");
  const returnPath = requireReturnPath(body.returnPath);
  const state = randomState();
  const stateHash = await sha256Bytea(state);
  const { data: connection, error: connectionError } = await context.admin
    .from("bank_connections")
    .insert({
      workspace_id: context.workspaceId,
      provider: "enablebanking",
      aspsp_name: aspspName,
      aspsp_country: aspspCountry,
      created_by: context.userId,
    })
    .select("id")
    .single();
  if (connectionError !== null) throw new HttpError(500, "storage_unavailable");
  const connectionId = connection.id as string;
  const { error: authorizationError } = await context.admin.from("bank_authorizations").insert({
    workspace_id: context.workspaceId,
    connection_id: connectionId,
    user_id: context.userId,
    state_hash: stateHash,
    return_path: returnPath,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
  if (authorizationError !== null) throw new HttpError(500, "storage_unavailable");
  try {
    const url = await startAuthorization(context.admin, { aspspName, aspspCountry, redirectUrl: bankCallbackUrl(), state });
    await audit(context, "bank.authorization.started", "bank_connection", connectionId, "success");
    return json({ connectionId, url }, 201);
  } catch (cause) {
    const code = cause instanceof ProviderError ? cause.code : "provider_unavailable";
    await context.admin.from("bank_connections").update({ status: "error", safe_error_code: code }).eq("id", connectionId);
    await audit(context, "bank.authorization.failed", "bank_connection", connectionId, "failed", code);
    throw new HttpError(502, code);
  }
};

const listBankConnections = async (request: Request): Promise<Response> => {
  const context = await requireWorkspace(request);
  const { data, error } = await context.client
    .from("bank_connections_safe")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .order("created_at", { ascending: false });
  return json(assertNoError({ data, error }));
};

const queueBankSync = async (request: Request): Promise<Response> => {
  const context = await requireWorkspace(request, ["owner", "admin"]);
  const body = await parseJson(request);
  const connectionId = requireUuid(body.connectionId, "connection_id");
  const requestId = requireUuid(body.requestId, "request_id");
  const since = body.since === undefined ? undefined : requireString(body.since, "since", 10);
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new HttpError(400, "invalid_since");
  const connection = await getRow<{ status: string }>(context, "bank_connections", connectionId);
  if (connection.status !== "active") throw new HttpError(409, "bank_connection_not_active");
  const { data, error } = await context.admin.rpc("enqueue_finch_job", {
    p_workspace_id: context.workspaceId,
    p_kind: "bank.sync",
    p_payload: { connection_id: connectionId, ...(since === undefined ? {} : { since }) },
    p_idempotency_key: `manual:${requestId}`,
  });
  if (error !== null || typeof data !== "string") throw new HttpError(500, "job_enqueue_failed");
  await audit(context, "bank.sync.queued", "bank_connection", connectionId, "success");
  return json({ jobId: data }, 202);
};

type ReceiptUploadIntent = {
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly merchant: string | null;
  readonly totalMinor: string | null;
  readonly currency: string | null;
  readonly receiptDate: string | null;
};

type StoredReceiptUploadIntent = {
  readonly id: string;
  readonly object_key: string;
  readonly sha256: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly merchant: string | null;
  readonly total_minor: string | null;
  readonly currency: string | null;
  readonly receipt_date: string | null;
};

const matchesReceiptUploadIntent = (receipt: StoredReceiptUploadIntent, intent: ReceiptUploadIntent): boolean =>
  receipt.mime_type === intent.mimeType &&
  receipt.byte_size === intent.byteSize &&
  receipt.sha256.replace(/^\\x/, "").toLowerCase() === intent.sha256 &&
  receipt.merchant === intent.merchant &&
  receipt.total_minor === intent.totalMinor &&
  receipt.currency === intent.currency &&
  receipt.receipt_date === intent.receiptDate;

const findReceiptByIdempotencyKey = async (
  context: WorkspaceContext,
  idempotencyKey: string,
): Promise<StoredReceiptUploadIntent | null> => {
  const { data, error } = await context.admin
    .from("receipts")
    .select("id,object_key,sha256,mime_type,byte_size,total_minor::text,currency,merchant,receipt_date")
    .eq("workspace_id", context.workspaceId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error !== null) throw new HttpError(500, "storage_unavailable");
  return data as StoredReceiptUploadIntent | null;
};

const createReceiptUpload = async (request: Request): Promise<Response> => {
  const context = await requireWorkspace(request, ["owner", "admin", "member"]);
  const body = await parseJson(request);
  const mimeType = requireString(body.mimeType, "mime_type", 100);
  if (!new Set(["image/jpeg", "image/png", "application/pdf"]).has(mimeType)) throw new HttpError(400, "invalid_mime_type");
  if (!Number.isInteger(body.byteSize) || typeof body.byteSize !== "number" || body.byteSize < 1 || body.byteSize > 10 * 1024 * 1024) {
    throw new HttpError(400, "invalid_byte_size");
  }
  const hash = requireSha256Hex(body.sha256);
  const idempotencyKey = requireString(body.idempotencyKey, "idempotency_key", 200);
  const totalMinor = body.totalMinor === undefined ? null : requireString(body.totalMinor, "total_minor", 21);
  if (totalMinor !== null && !/^\d+$/.test(totalMinor)) throw new HttpError(400, "invalid_total_minor");
  const currency = body.currency === undefined ? null : requireString(body.currency, "currency", 3).toUpperCase();
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "invalid_currency");
  const intent: ReceiptUploadIntent = {
    mimeType,
    byteSize: body.byteSize,
    sha256: hash,
    merchant: body.merchant === undefined ? null : requireString(body.merchant, "merchant", 300),
    totalMinor,
    currency,
    receiptDate: body.receiptDate === undefined ? null : requireString(body.receiptDate, "receipt_date", 10),
  };
  let receipt = await findReceiptByIdempotencyKey(context, idempotencyKey);
  if (receipt === null) {
    const receiptId = crypto.randomUUID();
    const objectKey = `${context.workspaceId}/${receiptId}/${crypto.randomUUID()}`;
    const { data, error } = await context.admin
      .from("receipts")
      .insert({
        id: receiptId,
        workspace_id: context.workspaceId,
        idempotency_key: idempotencyKey,
        sha256: byteaFromHex(intent.sha256),
        object_key: objectKey,
        mime_type: intent.mimeType,
        byte_size: intent.byteSize,
        total_minor: intent.totalMinor,
        currency: intent.currency,
        merchant: intent.merchant,
        receipt_date: intent.receiptDate,
        upload_state: "pending",
        created_by: context.userId,
      })
      .select("id,object_key,sha256,mime_type,byte_size,total_minor::text,currency,merchant,receipt_date")
      .single();
    if (error !== null) {
      if (error.code !== "23505") throw new HttpError(500, "storage_unavailable");
      receipt = await findReceiptByIdempotencyKey(context, idempotencyKey);
      if (receipt === null) throw new HttpError(409, "duplicate_receipt");
    } else if (data === null) {
      throw new HttpError(500, "storage_unavailable");
    } else {
      receipt = data as StoredReceiptUploadIntent;
    }
  }
  if (!matchesReceiptUploadIntent(receipt, intent)) throw new HttpError(409, "receipt_idempotency_conflict");
  const { data: upload, error: uploadError } = await context.admin.storage.from("receipt-originals").createSignedUploadUrl(receipt.object_key);
  if (uploadError !== null || upload === null || typeof upload.signedUrl !== "string" || upload.signedUrl.trim() === "") {
    throw new HttpError(500, "upload_url_unavailable");
  }
  await audit(context, "receipt.upload_requested", "receipt", receipt.id, "success");
  return json({
    receiptId: receipt.id,
    upload: {
      url: upload.signedUrl,
      method: "PUT",
      requiredHeaders: [{ name: "content-type", value: intent.mimeType }],
    },
  }, 201);
};

const failPendingReceipt = async (
  context: WorkspaceContext,
  receiptId: string,
  objectKey: string,
  safeErrorCode: "receipt_hash_mismatch" | "receipt_metadata_mismatch",
): Promise<void> => {
  const { error: removeError } = await context.admin.storage.from("receipt-originals").remove([objectKey]);
  if (removeError !== null) throw new HttpError(500, "storage_unavailable");
  const { data, error } = await context.admin.rpc("fail_pending_receipt_upload", {
    p_workspace_id: context.workspaceId,
    p_receipt_id: receiptId,
    p_actor_id: context.userId,
    p_safe_error_code: safeErrorCode,
  });
  if (error !== null || (data !== "failed" && data !== "already_failed")) {
    throw new HttpError(500, "storage_unavailable");
  }
};

const finalizeReceiptUpload = async (request: Request, receiptId: string): Promise<Response> => {
  const context = await requireWorkspace(request, ["owner", "admin", "member"]);
  const receipt = await getRow<{
    id: string;
    object_key: string;
    sha256: string;
    byte_size: number;
    mime_type: string;
    upload_state: string;
    merchant: string | null;
    receipt_date: string | null;
    total_minor: string | null;
    currency: string | null;
  }>(context, "receipts", receiptId);
  if (receipt.upload_state === "failed") throw new HttpError(409, "receipt_upload_failed");
  if (receipt.upload_state === "pending") {
    const { data: object, error: objectError } = await context.admin.storage.from("receipt-originals").download(receipt.object_key);
    if (objectError !== null || object === null) throw new HttpError(409, "receipt_object_missing");
    if (object.size !== receipt.byte_size || object.type !== receipt.mime_type) {
      await failPendingReceipt(context, receiptId, receipt.object_key, "receipt_metadata_mismatch");
      throw new HttpError(422, "receipt_metadata_mismatch");
    }
    const actualHash = await sha256Bytea(await object.arrayBuffer());
    if (actualHash !== receipt.sha256) {
      await failPendingReceipt(context, receiptId, receipt.object_key, "receipt_hash_mismatch");
      throw new HttpError(422, "receipt_hash_mismatch");
    }
  }
  const content = ["receipt", receipt.merchant, receipt.receipt_date, receipt.total_minor, receipt.currency].filter((item): item is string => item !== null).join(" ");
  const contentHash = await sha256Bytea(content);
  const { error: documentError } = await context.admin.from("finance_documents").upsert(
    {
      workspace_id: context.workspaceId,
      source_type: "receipt",
      source_id: receiptId,
      content,
      content_hash: contentHash,
    },
    { onConflict: "workspace_id,source_type,source_id" },
  );
  if (documentError !== null) throw new HttpError(500, "storage_unavailable");
  if (receipt.upload_state === "pending") {
    const { error: finalizeError } = await context.admin.from("receipts").update({ upload_state: "ready" }).eq("id", receiptId).eq("upload_state", "pending");
    if (finalizeError !== null) throw new HttpError(500, "storage_unavailable");
  }
  const { error: embeddingError } = await context.admin.rpc("enqueue_finch_job", {
    p_workspace_id: context.workspaceId,
    p_kind: "search.embed",
    p_payload: { source_type: "receipt", source_id: receiptId },
    p_idempotency_key: `embed:receipt:${receiptId}:${contentHash}`,
  });
  if (embeddingError !== null) throw new HttpError(500, "job_enqueue_failed");
  await audit(context, "receipt.upload_finalized", "receipt", receiptId, "success");
  return json({ receiptId, uploadState: "ready" });
};

const signedReceiptDownload = async (request: Request, receiptId: string): Promise<Response> => {
  const context = await requireWorkspace(request);
  const receipt = await getRow<{ object_key: string; upload_state: string }>(context, "receipts", receiptId);
  if (receipt.upload_state !== "ready") throw new HttpError(409, "receipt_not_ready");
  const { data, error } = await context.admin.storage.from("receipt-originals").createSignedUrl(receipt.object_key, 60);
  if (error !== null || data === null) throw new HttpError(500, "download_url_unavailable");
  await audit(context, "receipt.download_url_issued", "receipt", receiptId, "success");
  return json({ url: data.signedUrl, expiresInSeconds: 60 });
};

const listReceipts = async (request: Request): Promise<Response> => {
  const context = await requireWorkspace(request);
  const { data, error } = await context.client
    .from("receipts_safe")
    .select("*")
    .eq("workspace_id", context.workspaceId)
    .order("created_at", { ascending: false });
  return json(assertNoError({ data, error }));
};

const searchFinances = async (request: Request): Promise<Response> => {
  const context = await requireWorkspace(request);
  const text = new URL(request.url).searchParams.get("q");
  if (text === null || text.trim() === "" || text.length > 500) throw new HttpError(400, "invalid_query");
  const limitRaw = new URL(request.url).searchParams.get("limit") ?? "20";
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, "invalid_limit");
  const { data, error } = await context.client.rpc("search_finances", {
    p_workspace_id: context.workspaceId,
    p_query: text,
    p_limit: limit,
  });
  return json(assertNoError({ data, error }));
};

const setAiPolicy = async (request: Request): Promise<Response> => {
  const context = await requireWorkspace(request, ["owner", "admin"]);
  const body = await parseJson(request);
  const mode = requireString(body.mode, "mode", 20);
  if (!new Set(["disabled", "embeddings", "assistant"]).has(mode)) throw new HttpError(400, "invalid_mode");
  const { error } = await context.client.rpc("set_workspace_ai_policy", {
    p_workspace_id: context.workspaceId,
    p_mode: mode,
    p_embedding_provider: body.embeddingProvider ?? null,
    p_embedding_model: body.embeddingModel ?? null,
    p_assistant_provider: body.assistantProvider ?? null,
    p_assistant_model: body.assistantModel ?? null,
  });
  if (error !== null) throw new HttpError(400, "invalid_ai_policy");
  await audit(context, "ai.policy.updated", "workspace_ai_policy", context.workspaceId, "success");
  return noContent();
};

const queueSummary = async (request: Request): Promise<Response> => {
  const context = await requireWorkspace(request, ["owner", "admin"]);
  const body = await parseJson(request);
  const periodStart = requireString(body.periodStart, "period_start", 10);
  const periodEnd = requireString(body.periodEnd, "period_end", 10);
  const requestId = requireUuid(body.requestId, "request_id");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || periodEnd < periodStart) {
    throw new HttpError(400, "invalid_summary_period");
  }
  const { data: policy, error: policyError } = await context.client
    .from("workspace_ai_policies")
    .select("mode")
    .eq("workspace_id", context.workspaceId)
    .single();
  if (policyError !== null) throw new HttpError(500, "storage_unavailable");
  if (policy?.mode !== "assistant") throw new HttpError(409, "assistant_ai_not_enabled");
  const { data, error } = await context.admin.rpc("enqueue_finch_job", {
    p_workspace_id: context.workspaceId,
    p_kind: "ai.summary",
    p_payload: { period_start: periodStart, period_end: periodEnd },
    p_idempotency_key: `summary:${requestId}`,
  });
  if (error !== null || typeof data !== "string") throw new HttpError(500, "job_enqueue_failed");
  await audit(context, "ai.summary.queued", "workspace", context.workspaceId, "success");
  return json({ jobId: data }, 202);
};

const requestExport = async (request: Request): Promise<Response> => {
  const context = await requireWorkspace(request, ["owner"]);
  const { data, error } = await context.client.rpc("request_data_export", { p_workspace_id: context.workspaceId });
  if (error !== null || typeof data !== "string") throw new HttpError(403, "recent_mfa_required");
  return json({ exportId: data }, 202);
};

const exportDownloadUrls = async (request: Request, exportId: string): Promise<Response> => {
  const context = await requireWorkspace(request, ["owner"]);
  const exportRow = await getRow<{ status: string; expires_at: string | null }>(context, "data_exports", exportId);
  if (exportRow.status !== "ready" || exportRow.expires_at === null || Date.parse(exportRow.expires_at) <= Date.now()) {
    throw new HttpError(409, "export_not_available");
  }
  const { data: parts, error } = await context.admin
    .from("data_export_parts")
    .select("ordinal,object_key")
    .eq("export_id", exportId)
    .eq("workspace_id", context.workspaceId)
    .order("ordinal");
  if (error !== null || parts === null) throw new HttpError(500, "storage_unavailable");
  const output = await Promise.all(
    parts.map(async (part) => {
      const { data, error: signedError } = await context.admin.storage.from("exports").createSignedUrl(part.object_key as string, 60);
      if (signedError !== null || data === null) throw new HttpError(500, "download_url_unavailable");
      return { ordinal: part.ordinal, url: data.signedUrl, expiresInSeconds: 60 };
    }),
  );
  await audit(context, "export.download_urls_issued", "data_export", exportId, "success");
  return json({ parts: output });
};

const requestDeletion = async (request: Request): Promise<Response> => {
  const context = await requireWorkspace(request, ["owner"]);
  const body = await parseJson(request);
  if (body.confirm !== true) throw new HttpError(400, "deletion_confirmation_required");
  const { data, error } = await context.client.rpc("request_workspace_deletion", {
    p_workspace_id: context.workspaceId,
    p_confirm: true,
  });
  if (error !== null || typeof data !== "string") throw new HttpError(403, "recent_mfa_required");
  return json({ deletionId: data }, 202);
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return options();
  try {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/api/workspaces") return await createWorkspace(request);
    if (request.method === "GET" && pathname === "/api/workspaces") return await listWorkspaces(request);
    if (request.method === "POST" && pathname === "/api/bank/authorizations") return await startBankAuthorization(request);
    if (request.method === "GET" && pathname === "/api/bank/connections") return await listBankConnections(request);
    if (request.method === "POST" && pathname === "/api/bank/sync") return await queueBankSync(request);
    if (request.method === "POST" && pathname === "/api/receipts/upload-intents") return await createReceiptUpload(request);
    const finalize = pathname.match(/^\/api\/receipts\/([0-9a-f-]{36})\/finalize$/i);
    if (request.method === "POST" && finalize?.[1] !== undefined) return await finalizeReceiptUpload(request, requireUuid(finalize[1], "receipt_id"));
    const download = pathname.match(/^\/api\/receipts\/([0-9a-f-]{36})\/download-url$/i);
    if (request.method === "POST" && download?.[1] !== undefined) return await signedReceiptDownload(request, requireUuid(download[1], "receipt_id"));
    if (request.method === "GET" && pathname === "/api/receipts") return await listReceipts(request);
    if (request.method === "GET" && pathname === "/api/search") return await searchFinances(request);
    if (request.method === "POST" && pathname === "/api/ai-policy") return await setAiPolicy(request);
    if (request.method === "POST" && pathname === "/api/ai-summaries") return await queueSummary(request);
    if (request.method === "POST" && pathname === "/api/exports") return await requestExport(request);
    const exportUrls = pathname.match(/^\/api\/exports\/([0-9a-f-]{36})\/download-urls$/i);
    if (request.method === "GET" && exportUrls?.[1] !== undefined) return await exportDownloadUrls(request, requireUuid(exportUrls[1], "export_id"));
    if (request.method === "POST" && pathname === "/api/deletion-requests") return await requestDeletion(request);
    throw new HttpError(404, "not_found");
  } catch (cause) {
    return errorResponse(cause);
  }
});
