import { tarGzip, type ArchiveFile } from "../_shared/archive.ts";
import { bytea, hex, sha256, sha256Bytea } from "../_shared/crypto.ts";
import { deleteSession, getPayment, listAccounts, listTransactions, paymentStatusFromProvider, ProviderError, type BankAccountSnapshot } from "../_shared/enable-banking.ts";
import { errorResponse, HttpError, json, options, requireString, requireUuid } from "../_shared/http.ts";
import { adminClient } from "../_shared/supabase.ts";

type Job = {
  readonly message_id: number;
  readonly job_id: string;
  readonly workspace_id: string;
  readonly kind: "bank.sync" | "search.embed" | "ai.summary" | "payment.status.poll" | "export.create" | "workspace.purge" | "storage.cleanup";
  readonly payload: unknown;
  readonly attempts: number;
};

class WorkerError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

const requireWorker = (request: Request): void => {
  const expected = Deno.env.get("FINCH_WORKER_TOKEN");
  const actual = request.headers.get("x-worker-token");
  if (expected === undefined || expected.length < 32 || actual === null || actual.length !== expected.length) {
    throw new HttpError(401, "worker_authentication_required");
  }
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  if (mismatch !== 0) throw new HttpError(401, "worker_authentication_required");
};

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WorkerError("invalid_job_payload", false);
  return value as Record<string, unknown>;
};

const audit = async (workspaceId: string, action: string, resourceType: string, resourceId: string, outcome: "success" | "failed", safeErrorCode?: string) => {
  const admin = adminClient();
  const { error } = await admin.from("audit_events").insert({
    workspace_id: workspaceId,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    outcome,
    safe_error_code: safeErrorCode,
  });
  if (error !== null) throw new WorkerError("storage_unavailable", true);
};

const appendEvent = async (
  workspaceId: string,
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
  dedupeKey: string,
) => {
  const admin = adminClient();
  const serialized = JSON.stringify(payload);
  const { error } = await admin.rpc("append_domain_event", {
    p_workspace_id: workspaceId,
    p_aggregate_type: aggregateType,
    p_aggregate_id: aggregateId,
    p_event_type: eventType,
    p_schema_version: 1,
    p_payload: payload,
    p_payload_hash: await sha256Bytea(serialized),
    p_actor_id: null,
    p_correlation_id: null,
    p_dedupe_key: dedupeKey,
  });
  if (error !== null) throw new WorkerError("storage_unavailable", true);
};

const accountId = async (workspaceId: string, connectionId: string, account: BankAccountSnapshot): Promise<string> => {
  const admin = adminClient();
  const { data, error } = await admin
    .from("accounts")
    .upsert(
      {
        workspace_id: workspaceId,
        bank_connection_id: connectionId,
        external_ref: account.externalRef,
        name: account.name,
        account_type: account.accountType,
        currency: account.currency,
        status: account.status,
      },
      { onConflict: "bank_connection_id,external_ref" },
    )
    .select("id")
    .single();
  if (error !== null || data === null || typeof data.id !== "string") throw new WorkerError("storage_unavailable", true);
  return data.id;
};

const enqueueEmbedding = async (workspaceId: string, sourceType: string, sourceId: string, content: string): Promise<void> => {
  const admin = adminClient();
  const { data: policy, error: policyError } = await admin
    .from("workspace_ai_policies")
    .select("mode,policy_version")
    .eq("workspace_id", workspaceId)
    .single();
  if (policyError !== null || policy === null) throw new WorkerError("storage_unavailable", true);
  if (policy.mode === "disabled") return;
  const contentHash = await hex(await sha256(content));
  const { error } = await admin.rpc("enqueue_finch_job", {
    p_workspace_id: workspaceId,
    p_kind: "search.embed",
    p_payload: { source_type: sourceType, source_id: sourceId },
    p_idempotency_key: `embed:${sourceType}:${sourceId}:${contentHash}`,
  });
  if (error !== null) throw new WorkerError("storage_unavailable", true);
};

const syncBank = async (job: Job): Promise<void> => {
  const payload = object(job.payload);
  const connectionId = requireUuid(payload.connection_id, "connection_id");
  const since = payload.since === undefined ? undefined : requireString(payload.since, "since", 10);
  if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new WorkerError("invalid_job_payload", false);
  const admin = adminClient();
  const { data: connection, error: connectionError } = await admin
    .from("bank_connections")
    .select("id,status,consent_expires_at")
    .eq("id", connectionId)
    .eq("workspace_id", job.workspace_id)
    .maybeSingle();
  if (connectionError !== null) throw new WorkerError("storage_unavailable", true);
  if (connection === null || connection.status !== "active") throw new WorkerError("bank_connection_not_active", false);
  if (connection.consent_expires_at !== null && Date.parse(connection.consent_expires_at as string) <= Date.now()) {
    await admin.from("bank_connections").update({ status: "expired", safe_error_code: "consent_expired" }).eq("id", connectionId);
    throw new WorkerError("consent_expired", false);
  }
  let sessionId: string;
  try {
    const { data, error } = await admin.rpc("read_bank_connection_secret", { p_connection_id: connectionId });
    if (error !== null || typeof data !== "string") throw new WorkerError("bank_connection_secret_unavailable", false);
    sessionId = data;
  } catch (cause) {
    if (cause instanceof WorkerError) throw cause;
    throw new WorkerError("bank_connection_secret_unavailable", false);
  }

  try {
    const accounts = await listAccounts(admin, sessionId);
    let transactionsObserved = 0;
    for (const account of accounts) {
      const localAccountId = await accountId(job.workspace_id, connectionId, account);
      await appendEvent(job.workspace_id, "account", localAccountId, "AccountObserved", {
        account_hash: await hex(await sha256(account.externalRef)),
        currency: account.currency,
      }, `account-observed:${localAccountId}`);
      const transactions = await listTransactions(admin, sessionId, account.externalRef, since);
      for (const transaction of transactions) {
        const fingerprint = await hex(
          await sha256(
            JSON.stringify([
              connectionId,
              account.externalRef,
              transaction.externalRef,
            ]),
          ),
        );
        const { data: stored, error: storedError } = await admin
          .from("transactions")
          .upsert(
            {
              workspace_id: job.workspace_id,
              bank_connection_id: connectionId,
              account_id: localAccountId,
              source_fingerprint: fingerprint,
              external_transaction_id: transaction.externalRef ?? null,
              amount_minor: transaction.amountMinor,
              currency: transaction.currency,
              booking_date: transaction.bookingDate,
              value_date: transaction.valueDate ?? null,
              raw_description: transaction.rawDescription,
              merchant_name: transaction.merchantName ?? null,
              counterparty_name: transaction.counterpartyName ?? null,
              status: transaction.status,
            },
            { onConflict: "bank_connection_id,source_fingerprint" },
          )
          .select("id")
          .single();
        if (storedError !== null || stored === null || typeof stored.id !== "string") throw new WorkerError("storage_unavailable", true);
        const observationHash = await sha256Bytea(
          JSON.stringify([transaction.bookingDate, transaction.amountMinor, transaction.currency, transaction.rawDescription, transaction.status]),
        );
        const { data: observation, error: observationError } = await admin
          .from("transaction_observations")
          .insert({
            workspace_id: job.workspace_id,
            transaction_id: stored.id,
            bank_connection_id: connectionId,
            source_fingerprint: fingerprint,
            payload_hash: observationHash,
            provider_event_ref: transaction.externalRef ?? null,
          })
          .select("id")
          .maybeSingle();
        if (observationError !== null && observationError.code !== "23505") throw new WorkerError("storage_unavailable", true);
        if (observation !== null) {
          transactionsObserved += 1;
          await appendEvent(job.workspace_id, "transaction", stored.id, "TransactionObserved", {
            source_fingerprint: fingerprint,
            observation_hash: observationHash.slice(2),
          }, `transaction-observed:${observation.id as string}`);
        }
        const content = ["transaction", transaction.bookingDate, transaction.amountMinor, transaction.currency, transaction.merchantName, transaction.counterpartyName, transaction.rawDescription]
          .filter((item): item is string => item !== undefined && item !== "")
          .join(" ");
        const { error: documentError } = await admin.from("finance_documents").upsert(
          {
            workspace_id: job.workspace_id,
            source_type: "transaction",
            source_id: stored.id,
            content,
            content_hash: await sha256Bytea(content),
          },
          { onConflict: "workspace_id,source_type,source_id" },
        );
        if (documentError !== null) throw new WorkerError("storage_unavailable", true);
        await enqueueEmbedding(job.workspace_id, "transaction", stored.id, content);
      }
    }
    const { data: updatedConnection, error: updateError } = await admin
      .from("bank_connections")
      .update({ last_synced_at: new Date().toISOString(), safe_error_code: null })
      .eq("id", connectionId)
      .eq("workspace_id", job.workspace_id)
      .eq("status", "active")
      .select("id")
      .maybeSingle();
    if (updateError !== null) throw new WorkerError("storage_unavailable", true);
    if (updatedConnection === null) throw new WorkerError("bank_connection_not_active", false);
    await audit(job.workspace_id, "bank.sync.completed", "bank_connection", connectionId, "success");
    // One durable future job per UTC day. PGMQ owns the delay; no process timer is state.
    const nextDay = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { error: scheduleError } = await admin.rpc("enqueue_finch_job", {
      p_workspace_id: job.workspace_id,
      p_kind: "bank.sync",
      p_payload: { connection_id: connectionId },
      p_idempotency_key: `scheduled:${connectionId}:${nextDay}`,
      p_delay_seconds: 24 * 60 * 60,
    });
    if (scheduleError !== null) throw new WorkerError("storage_unavailable", true);
  } catch (cause) {
    if (cause instanceof ProviderError && (cause.code === "provider_http_401" || cause.code === "provider_http_403")) {
      await admin.from("bank_connections").update({ status: "expired", safe_error_code: cause.code }).eq("id", connectionId);
      throw new WorkerError(cause.code, false);
    }
    if (cause instanceof ProviderError) throw new WorkerError(cause.code, cause.retryable);
    throw cause;
  }
};

const embedDocument = async (job: Job): Promise<void> => {
  const payload = object(job.payload);
  const sourceType = requireString(payload.source_type, "source_type", 30);
  const sourceId = requireUuid(payload.source_id, "source_id");
  const admin = adminClient();
  const { data: policy, error: policyError } = await admin
    .from("workspace_ai_policies")
    .select("mode,embedding_provider,embedding_model,policy_version")
    .eq("workspace_id", job.workspace_id)
    .single();
  if (policyError !== null || policy === null) throw new WorkerError("storage_unavailable", true);
  const { data: document, error: documentError } = await admin
    .from("finance_documents")
    .select("id,content")
    .eq("workspace_id", job.workspace_id)
    .eq("source_type", sourceType)
    .eq("source_id", sourceId)
    .maybeSingle();
  if (documentError !== null) throw new WorkerError("storage_unavailable", true);
  if (document === null) return;
  if (policy.mode === "disabled") {
    const { error } = await admin.from("finance_documents").update({ embedding: null, embedding_model: null, embedding_policy_version: null }).eq("id", document.id);
    if (error !== null) throw new WorkerError("storage_unavailable", true);
    return;
  }
  if (policy.embedding_provider !== "voyage" || typeof policy.embedding_model !== "string") throw new WorkerError("unsupported_embedding_policy", false);
  const { data: apiKey, error: keyError } = await admin.rpc("get_worker_secret", { p_name: "voyage_api_key" });
  if (keyError !== null || typeof apiKey !== "string") throw new WorkerError("ai_configuration_unavailable", false);
  let response: Response;
  try {
    response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: policy.embedding_model, input: [document.content], input_type: "document" }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new WorkerError("ai_network_failure", true);
  }
  if (!response.ok) throw new WorkerError(`ai_http_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
  const parsed = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
  const vector = parsed.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== 1024 || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new WorkerError("ai_invalid_embedding", false);
  }
  const { data: freshPolicy, error: freshPolicyError } = await admin
    .from("workspace_ai_policies")
    .select("mode,policy_version")
    .eq("workspace_id", job.workspace_id)
    .single();
  if (freshPolicyError !== null || freshPolicy === null) throw new WorkerError("storage_unavailable", true);
  if (freshPolicy.mode === "disabled" || freshPolicy.policy_version !== policy.policy_version) return;
  const { error: updateError } = await admin
    .from("finance_documents")
    .update({ embedding: `[${vector.join(",")}]`, embedding_model: policy.embedding_model, embedding_policy_version: policy.policy_version })
    .eq("id", document.id);
  if (updateError !== null) throw new WorkerError("storage_unavailable", true);
  await audit(job.workspace_id, "ai.embedding.completed", "finance_document", document.id as string, "success");
};

const readAll = async (table: string, workspaceId: string): Promise<Record<string, unknown>[]> => {
  const admin = adminClient();
  const rows: Record<string, unknown>[] = [];
  const orderColumn = table === "workspace_ai_policies" ? "workspace_id" : "id";
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.from(table).select("*").eq("workspace_id", workspaceId).order(orderColumn).range(offset, offset + 999);
    if (error !== null || data === null) throw new WorkerError("storage_unavailable", true);
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < 1000) return rows;
  }
};

const archiveExtension = (mimeType: unknown): string =>
  mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : "pdf";

type ExportPart = {
  readonly object_key: unknown;
  readonly byte_size: unknown;
  readonly sha256: unknown;
};

const readExportPart = async (admin: ReturnType<typeof adminClient>, exportId: string, ordinal: number): Promise<ExportPart | null> => {
  const { data, error } = await admin
    .from("data_export_parts")
    .select("object_key,byte_size,sha256")
    .eq("export_id", exportId)
    .eq("ordinal", ordinal)
    .maybeSingle();
  if (error !== null) throw new WorkerError("storage_unavailable", true);
  return data as ExportPart | null;
};

const sameArchive = (stored: Uint8Array, archive: Uint8Array): boolean =>
  stored.byteLength === archive.byteLength && stored.every((byte, index) => byte === archive[index]);

const verifyExportArchive = async (admin: ReturnType<typeof adminClient>, objectKey: string, archive: Uint8Array): Promise<void> => {
  const { data, error } = await admin.storage.from("exports").download(objectKey);
  if (error !== null || data === null) throw new WorkerError("storage_unavailable", true);
  if (!sameArchive(new Uint8Array(await data.arrayBuffer()), archive)) throw new WorkerError("export_archive_conflict", false);
};

const recordExportPart = async (
  admin: ReturnType<typeof adminClient>,
  exportId: string,
  workspaceId: string,
  ordinal: number,
  objectKey: string,
  archive: Uint8Array,
): Promise<void> => {
  const checksum = bytea(await sha256(archive.buffer as ArrayBuffer));
  const hasExpectedMetadata = (part: ExportPart): boolean =>
    part.object_key === objectKey && String(part.byte_size) === String(archive.byteLength) && part.sha256 === checksum;
  const existing = await readExportPart(admin, exportId, ordinal);
  if (existing !== null) {
    if (!hasExpectedMetadata(existing)) throw new WorkerError("export_archive_conflict", false);
    await verifyExportArchive(admin, objectKey, archive);
    return;
  }

  const { error: uploadError } = await admin.storage
    .from("exports")
    .upload(objectKey, new Blob([archive]), { contentType: "application/gzip", upsert: false });
  if (uploadError !== null) {
    const conflict = uploadError as { status?: unknown; statusCode?: unknown };
    if (String(conflict.status) !== "409" && String(conflict.statusCode) !== "409") throw new WorkerError("storage_unavailable", true);
    await verifyExportArchive(admin, objectKey, archive);
  }

  const { error: insertError } = await admin.from("data_export_parts").insert({
    export_id: exportId,
    workspace_id: workspaceId,
    ordinal,
    object_key: objectKey,
    byte_size: archive.byteLength,
    sha256: checksum,
  });
  if (insertError === null) return;
  if (insertError.code !== "23505") throw new WorkerError("storage_unavailable", true);
  const concurrent = await readExportPart(admin, exportId, ordinal);
  if (concurrent === null) throw new WorkerError("storage_unavailable", true);
  if (!hasExpectedMetadata(concurrent)) throw new WorkerError("export_archive_conflict", false);
  await verifyExportArchive(admin, objectKey, archive);
};

const exportWorkspace = async (job: Job): Promise<void> => {
  const payload = object(job.payload);
  const exportId = requireUuid(payload.export_id, "export_id");
  const admin = adminClient();
  const { data: exportRow, error: exportError } = await admin
    .from("data_exports")
    .select("id,status,created_at")
    .eq("id", exportId)
    .eq("workspace_id", job.workspace_id)
    .maybeSingle();
  if (exportError !== null) throw new WorkerError("storage_unavailable", true);
  if (exportRow === null || exportRow.status === "expired") return;
  if (typeof exportRow.created_at !== "string") throw new WorkerError("storage_unavailable", true);
  const { error: runningError } = await admin.from("data_exports").update({ status: "running", safe_error_code: null }).eq("id", exportId);
  if (runningError !== null) throw new WorkerError("storage_unavailable", true);

  try {
    const [accounts, transactions, receipts, matches, payments, summaries, policy, connections] = await Promise.all([
      readAll("accounts", job.workspace_id),
      readAll("transactions", job.workspace_id),
      readAll("receipts", job.workspace_id),
      readAll("receipt_matches", job.workspace_id),
      readAll("payment_orders", job.workspace_id),
      readAll("finance_summaries", job.workspace_id),
      readAll("workspace_ai_policies", job.workspace_id),
      readAll("bank_connections", job.workspace_id),
    ]);
    const receiptFiles = await Promise.all(
      receipts
        .filter((receipt) => receipt.upload_state === "ready")
        .map(async (receipt) => {
          const { data, error } = await admin.storage.from("receipt-originals").download(receipt.object_key as string);
          if (error !== null || data === null) throw new WorkerError("receipt_object_missing", true);
          return {
            name: `receipts/${receipt.id as string}.${archiveExtension(receipt.mime_type)}`,
            bytes: new Uint8Array(await data.arrayBuffer()),
          } satisfies ArchiveFile;
        }),
    );
    const safeAccounts = accounts.map(({ external_ref: _externalRef, ...account }) => account);
    const safeTransactions = transactions.map(({ external_transaction_id: _externalTransactionId, source_fingerprint: _sourceFingerprint, ...transaction }) => transaction);
    const safePayments = payments.map(({ provider_payment_ref: _providerPaymentRef, state_hash: _stateHash, return_path: _returnPath, state_expires_at: _stateExpiresAt, state_used_at: _stateUsedAt, ...payment }) => payment);
    const safeConnections = connections.map(({ vault_secret_id: _vaultSecretId, provider_connection_ref: _providerConnectionRef, ...connection }) => connection);
    const safeReceipts = receipts.map(({ object_key: _objectKey, ...receipt }) => ({
      ...receipt,
      original_file: `receipts/${receipt.id as string}.${archiveExtension(receipt.mime_type)}`,
    }));
    const datasets: Record<string, readonly Record<string, unknown>[]> = {
      accounts: safeAccounts,
      transactions: safeTransactions,
      receipts: safeReceipts,
      receipt_matches: matches,
      payment_orders: safePayments,
      finance_summaries: summaries,
      workspace_ai_policies: policy,
      bank_connections: safeConnections,
    };
    const files: ArchiveFile[] = [
      {
        name: "manifest.json",
        bytes: new TextEncoder().encode(JSON.stringify({ format: "finch-export-v1", workspace_id: job.workspace_id, generated_at: exportRow.created_at })),
      },
    ];
    for (const [name, rows] of Object.entries(datasets)) {
      let part = 1;
      let buffer = "";
      for (const row of rows) {
        const line = `${JSON.stringify(row)}\n`;
        if (new TextEncoder().encode(line).byteLength > 80 * 1024 * 1024) throw new WorkerError("export_record_too_large", false);
        if (new TextEncoder().encode(buffer).byteLength + new TextEncoder().encode(line).byteLength > 80 * 1024 * 1024) {
          files.push({ name: `data/${name}-${String(part).padStart(4, "0")}.ndjson`, bytes: new TextEncoder().encode(buffer) });
          buffer = "";
          part += 1;
        }
        buffer += line;
      }
      if (buffer !== "") files.push({ name: `data/${name}-${String(part).padStart(4, "0")}.ndjson`, bytes: new TextEncoder().encode(buffer) });
    }
    files.push(...receiptFiles);

    const maxPartBytes = 80 * 1024 * 1024;
    let ordinal = 1;
    let partFiles: ArchiveFile[] = [];
    let partSize = 0;
    const flush = async () => {
      if (partFiles.length === 0) return;
      const archive = await tarGzip(partFiles);
      const objectKey = `${job.workspace_id}/${exportId}/${String(ordinal).padStart(4, "0")}.tar.gz`;
      await recordExportPart(admin, exportId, job.workspace_id, ordinal, objectKey, archive);
      ordinal += 1;
      partFiles = [];
      partSize = 0;
    };
    for (const file of files) {
      if (file.bytes.byteLength > maxPartBytes) throw new WorkerError("export_file_too_large", false);
      if (partSize + file.bytes.byteLength > maxPartBytes) await flush();
      partFiles.push(file);
      partSize += file.bytes.byteLength;
    }
    await flush();
    const { data: extraParts, error: extraPartsError } = await admin
      .from("data_export_parts")
      .select("ordinal")
      .eq("export_id", exportId)
      .gte("ordinal", ordinal)
      .limit(1);
    if (extraPartsError !== null) throw new WorkerError("storage_unavailable", true);
    if ((extraParts ?? []).length > 0) throw new WorkerError("export_archive_conflict", false);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { error: readyError } = await admin.from("data_exports").update({ status: "ready", expires_at: expiresAt }).eq("id", exportId);
    if (readyError !== null) throw new WorkerError("storage_unavailable", true);
    const { error: cleanupError } = await admin.rpc("enqueue_finch_job", {
      p_workspace_id: job.workspace_id,
      p_kind: "storage.cleanup",
      p_payload: { export_id: exportId },
      p_idempotency_key: `export-cleanup:${exportId}`,
      p_delay_seconds: 24 * 60 * 60,
    });
    if (cleanupError !== null) throw new WorkerError("storage_unavailable", true);
    await audit(job.workspace_id, "export.completed", "data_export", exportId, "success");
  } catch (cause) {
    const code = cause instanceof WorkerError ? cause.code : "export_failed";
    await admin.from("data_exports").update({ status: "failed", safe_error_code: code, expires_at: null }).eq("id", exportId);
    throw cause;
  }
};

const removeWorkspaceStorage = async (admin: ReturnType<typeof adminClient>, bucket: "receipt-originals" | "exports", workspaceId: string): Promise<void> => {
  const keys: string[] = [];
  const visit = async (prefix: string): Promise<void> => {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000, offset });
      if (error !== null || data === null) throw new WorkerError("storage_unavailable", true);
      for (const entry of data) {
        const name = typeof entry.name === "string" ? entry.name : "";
        if (name === "") continue;
        const key = `${prefix}/${name}`;
        if (entry.id === null) await visit(key);
        else keys.push(key);
      }
      if (data.length < 1000) return;
    }
  };
  await visit(workspaceId);
  for (let start = 0; start < keys.length; start += 1000) {
    const { error } = await admin.storage.from(bucket).remove(keys.slice(start, start + 1000));
    if (error !== null) throw new WorkerError("storage_unavailable", true);
  }
};

const cleanupExport = async (job: Job): Promise<void> => {
  const payload = object(job.payload);
  const admin = adminClient();
  if (payload.workspace_storage_cleanup === true) {
    await removeWorkspaceStorage(admin, "receipt-originals", job.workspace_id);
    await removeWorkspaceStorage(admin, "exports", job.workspace_id);
    return;
  }
  const exportId = requireUuid(payload.export_id, "export_id");
  const { data: parts, error } = await admin.from("data_export_parts").select("object_key").eq("export_id", exportId).eq("workspace_id", job.workspace_id);
  if (error !== null) throw new WorkerError("storage_unavailable", true);
  if ((parts ?? []).length > 0) {
    const { error: storageError } = await admin.storage.from("exports").remove((parts ?? []).map((part) => part.object_key as string));
    if (storageError !== null) throw new WorkerError("storage_unavailable", true);
  }
  const { error: deletePartsError } = await admin.from("data_export_parts").delete().eq("export_id", exportId);
  if (deletePartsError !== null) throw new WorkerError("storage_unavailable", true);
  const { error: expireError } = await admin.from("data_exports").update({ status: "expired", expires_at: null }).eq("id", exportId);
  if (expireError !== null) throw new WorkerError("storage_unavailable", true);
};

const pollPaymentStatus = async (job: Job): Promise<void> => {
  const payload = object(job.payload);
  const paymentId = requireUuid(payload.payment_id, "payment_id");
  const admin = adminClient();
  const { data: payment, error: paymentError } = await admin
    .from("payment_orders")
    .select("id,provider_payment_ref,status")
    .eq("id", paymentId)
    .eq("workspace_id", job.workspace_id)
    .maybeSingle();
  if (paymentError !== null) throw new WorkerError("storage_unavailable", true);
  if (payment === null || payment.provider_payment_ref === null || ["accepted", "rejected", "submission_unknown"].includes(payment.status as string)) return;
  try {
    const providerPayment = await getPayment(admin, payment.provider_payment_ref as string);
    if (providerPayment.providerPaymentRef !== payment.provider_payment_ref) {
      throw new WorkerError("payment_provider_reference_mismatch", false);
    }
    const status = paymentStatusFromProvider(providerPayment.status);
    const payloadHash = await sha256Bytea(JSON.stringify([providerPayment.providerPaymentRef, providerPayment.status]));
    const { error: eventError } = await admin.from("payment_provider_events").upsert(
      {
        workspace_id: job.workspace_id,
        payment_id: paymentId,
        provider_event_ref: `${providerPayment.providerPaymentRef}:${providerPayment.status}`,
        status: providerPayment.status,
        payload_hash: payloadHash,
      },
      { onConflict: "payment_id,provider_event_ref" },
    );
    if (eventError !== null) throw new WorkerError("storage_unavailable", true);
    const { data: updated, error: updateError } = await admin
      .from("payment_orders")
      .update({ status, safe_error_code: null })
      .eq("id", paymentId)
      .eq("workspace_id", job.workspace_id)
      .in("status", ["created", "authorization_pending", "submitting", "submitted"])
      .select("status")
      .maybeSingle();
    if (updateError !== null) throw new WorkerError("storage_unavailable", true);
    if (updated === null) return;
    await appendEvent(job.workspace_id, "payment", paymentId, "PaymentStatusObserved", { status }, `payment-status:${paymentId}:${providerPayment.status}`);
    if (!["accepted", "rejected"].includes(status)) {
      const { error: queueError } = await admin.rpc("enqueue_finch_job", {
        p_workspace_id: job.workspace_id,
        p_kind: "payment.status.poll",
        p_payload: { payment_id: paymentId },
        p_idempotency_key: `payment-status:${paymentId}:${new Date(Date.now() + 300_000).toISOString()}`,
        p_delay_seconds: 300,
      });
      if (queueError !== null) throw new WorkerError("storage_unavailable", true);
    }
    await audit(job.workspace_id, "payment.status_reconciled", "payment_order", paymentId, "success");
  } catch (cause) {
    if (cause instanceof ProviderError) throw new WorkerError(cause.code, cause.retryable);
    throw cause;
  }
};

const summarize = async (job: Job): Promise<void> => {
  const payload = object(job.payload);
  const periodStart = requireString(payload.period_start, "period_start", 10);
  const periodEnd = requireString(payload.period_end, "period_end", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || periodEnd < periodStart) {
    throw new WorkerError("invalid_job_payload", false);
  }
  const admin = adminClient();
  const { data: policy, error: policyError } = await admin
    .from("workspace_ai_policies")
    .select("mode,assistant_provider,assistant_model,policy_version")
    .eq("workspace_id", job.workspace_id)
    .single();
  if (policyError !== null || policy === null) throw new WorkerError("storage_unavailable", true);
  if (policy.mode !== "assistant") return;
  if (policy.assistant_provider !== "opencode" || typeof policy.assistant_model !== "string") throw new WorkerError("unsupported_assistant_policy", false);
  const { data: transactions, error: transactionsError } = await admin
    .from("transactions")
    .select("currency,amount_minor")
    .eq("workspace_id", job.workspace_id)
    .gte("booking_date", periodStart)
    .lte("booking_date", periodEnd);
  if (transactionsError !== null) throw new WorkerError("storage_unavailable", true);
  const totals = new Map<string, bigint>();
  for (const transaction of transactions ?? []) {
    const currency = transaction.currency as string;
    totals.set(currency, (totals.get(currency) ?? 0n) + BigInt(transaction.amount_minor as string));
  }
  const aggregate = Array.from(totals, ([currency, amountMinor]) => ({ currency, net_amount_minor: amountMinor.toString() }));
  const { data: key, error: keyError } = await admin.rpc("get_worker_secret", { p_name: "opencode_api_key" });
  if (keyError !== null || typeof key !== "string") throw new WorkerError("ai_configuration_unavailable", false);
  const baseUrl = Deno.env.get("OPENCODE_LLM_BASE_URL")?.replace(/\/$/, "");
  if (baseUrl === undefined || baseUrl === "") throw new WorkerError("ai_configuration_unavailable", false);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: policy.assistant_model,
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: "system", content: "Summarize the supplied aggregate finances. Do not infer transactions, recommend payments, or expose data not provided." },
          { role: "user", content: JSON.stringify({ period_start: periodStart, period_end: periodEnd, totals: aggregate }) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new WorkerError("ai_network_failure", true);
  }
  if (!response.ok) throw new WorkerError(`ai_http_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
  const result = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "" || content.length > 12000) throw new WorkerError("ai_invalid_response", false);
  const { data: freshPolicy, error: freshPolicyError } = await admin
    .from("workspace_ai_policies")
    .select("mode,policy_version")
    .eq("workspace_id", job.workspace_id)
    .single();
  if (freshPolicyError !== null || freshPolicy === null) throw new WorkerError("storage_unavailable", true);
  if (freshPolicy.mode !== "assistant" || freshPolicy.policy_version !== policy.policy_version) return;
  const contentHash = await sha256Bytea(content);
  const { data: summary, error: summaryError } = await admin
    .from("finance_summaries")
    .upsert(
      {
        workspace_id: job.workspace_id,
        period_start: periodStart,
        period_end: periodEnd,
        content,
        content_hash: contentHash,
        policy_version: policy.policy_version,
        model: policy.assistant_model,
      },
      { onConflict: "workspace_id,period_start,period_end,policy_version" },
    )
    .select("id")
    .single();
  if (summaryError !== null || summary === null) throw new WorkerError("storage_unavailable", true);
  const document = `summary ${periodStart} ${periodEnd} ${content}`;
  const { error: documentError } = await admin.from("finance_documents").upsert(
    { workspace_id: job.workspace_id, source_type: "summary", source_id: summary.id, content: document, content_hash: await sha256Bytea(document) },
    { onConflict: "workspace_id,source_type,source_id" },
  );
  if (documentError !== null) throw new WorkerError("storage_unavailable", true);
  await enqueueEmbedding(job.workspace_id, "summary", summary.id as string, document);
  await audit(job.workspace_id, "ai.summary.completed", "finance_summary", summary.id as string, "success");
};

const purgeWorkspace = async (job: Job): Promise<void> => {
  const payload = object(job.payload);
  const deletionId = requireUuid(payload.deletion_id, "deletion_id");
  const admin = adminClient();
  const { data: deletion, error: deletionError } = await admin
    .from("deletion_requests")
    .select("id,status")
    .eq("id", deletionId)
    .eq("workspace_id", job.workspace_id)
    .maybeSingle();
  if (deletionError !== null) throw new WorkerError("storage_unavailable", true);
  if (deletion === null || deletion.status === "completed") return;
  await admin.from("deletion_requests").update({ status: "running", safe_error_code: null }).eq("id", deletionId);
  const { data: connections, error: connectionsError } = await admin
    .from("bank_connections")
    .select("id,status,vault_secret_id")
    .eq("workspace_id", job.workspace_id);
  if (connectionsError !== null) throw new WorkerError("storage_unavailable", true);
  for (const connection of connections ?? []) {
    if (connection.status === "revoked") continue;
    if (connection.vault_secret_id === null) {
      if (connection.status !== "revocation_pending") {
        const { error } = await admin.from("bank_connections").update({ status: "revocation_pending" }).eq("id", connection.id);
        if (error !== null) throw new WorkerError("storage_unavailable", true);
      }
      const { error: revokeError } = await admin.from("bank_connections").update({ status: "revoked", safe_error_code: null }).eq("id", connection.id);
      if (revokeError !== null) throw new WorkerError("storage_unavailable", true);
      continue;
    }
    if (connection.status !== "revocation_pending") {
      const { error } = await admin.from("bank_connections").update({ status: "revocation_pending" }).eq("id", connection.id);
      if (error !== null) throw new WorkerError("storage_unavailable", true);
    }
    try {
      const { data: sessionId, error: sessionError } = await admin.rpc("read_bank_connection_secret", { p_connection_id: connection.id });
      if (sessionError !== null || typeof sessionId !== "string") throw new WorkerError("remote_revocation_blocked", true);
      try {
        await deleteSession(admin, sessionId);
      } catch (cause) {
        if (!(cause instanceof ProviderError) || cause.code !== "provider_http_404") throw cause;
      }
      const { error: destroyError } = await admin.rpc("destroy_bank_connection_secret", { p_connection_id: connection.id });
      if (destroyError !== null) throw new WorkerError("remote_revocation_blocked", true);
      const { error: revokeError } = await admin.from("bank_connections").update({ status: "revoked", safe_error_code: null }).eq("id", connection.id);
      if (revokeError !== null) throw new WorkerError("storage_unavailable", true);
    } catch (cause) {
      const code = cause instanceof ProviderError ? cause.code : cause instanceof WorkerError ? cause.code : "remote_revocation_blocked";
      await admin.from("bank_connections").update({ status: "error", safe_error_code: code }).eq("id", connection.id);
      await admin.from("deletion_requests").update({ status: "blocked", safe_error_code: code }).eq("id", deletionId);
      throw new WorkerError(code, cause instanceof ProviderError ? cause.retryable : true);
    }
  }
  const [receiptRows, exportParts] = await Promise.all([
    admin.from("receipts").select("object_key").eq("workspace_id", job.workspace_id),
    admin.from("data_export_parts").select("object_key").eq("workspace_id", job.workspace_id),
  ]);
  if (receiptRows.error !== null || exportParts.error !== null) throw new WorkerError("storage_unavailable", true);
  if ((receiptRows.data ?? []).length > 0) {
    const { error } = await admin.storage.from("receipt-originals").remove((receiptRows.data ?? []).map((row) => row.object_key as string));
    if (error !== null) throw new WorkerError("storage_unavailable", true);
  }
  if ((exportParts.data ?? []).length > 0) {
    const { error } = await admin.storage.from("exports").remove((exportParts.data ?? []).map((row) => row.object_key as string));
    if (error !== null) throw new WorkerError("storage_unavailable", true);
  }
  const deleteFrom = async (table: string) => {
    const { error } = await admin.from(table).delete().eq("workspace_id", job.workspace_id);
    if (error !== null) throw new WorkerError("storage_unavailable", true);
  };
  const { error: cancelError } = await admin.rpc("cancel_workspace_jobs", { p_workspace_id: job.workspace_id, p_exclude_job_id: job.job_id });
  if (cancelError !== null) throw new WorkerError("storage_unavailable", true);
  const { error: eventEraseError } = await admin.rpc("erase_workspace_domain_events", { p_workspace_id: job.workspace_id });
  if (eventEraseError !== null) throw new WorkerError("storage_unavailable", true);
  for (const table of ["payment_provider_events", "receipt_matches", "transaction_observations", "finance_documents", "finance_summaries", "data_export_parts", "data_exports", "payment_orders", "receipts", "transactions", "accounts", "bank_authorizations", "bank_connections", "workspace_ai_policies", "aggregate_sequences", "workspace_members"]) {
    await deleteFrom(table);
  }
  const { error: completeDeletionError } = await admin
    .from("deletion_requests")
    .update({ status: "completed", remote_revocation_complete: true, completed_at: new Date().toISOString() })
    .eq("id", deletionId);
  if (completeDeletionError !== null) throw new WorkerError("storage_unavailable", true);
  const { error: workspaceError } = await admin.from("workspaces").update({ state: "deleted", deleted_at: new Date().toISOString() }).eq("id", job.workspace_id);
  if (workspaceError !== null) throw new WorkerError("storage_unavailable", true);
  const { error: cleanupError } = await admin.rpc("enqueue_finch_job", {
    p_workspace_id: job.workspace_id,
    p_kind: "storage.cleanup",
    p_payload: { workspace_storage_cleanup: true },
    p_idempotency_key: `workspace-storage-cleanup:${job.workspace_id}`,
    p_delay_seconds: 3 * 60 * 60,
  });
  if (cleanupError !== null) throw new WorkerError("storage_unavailable", true);
  await audit(job.workspace_id, "workspace.deleted", "workspace", job.workspace_id, "success");
};

const handle = async (job: Job): Promise<void> => {
  switch (job.kind) {
    case "bank.sync":
      return await syncBank(job);
    case "search.embed":
      return await embedDocument(job);
    case "export.create":
      return await exportWorkspace(job);
    case "storage.cleanup":
      return await cleanupExport(job);
    case "workspace.purge":
      return await purgeWorkspace(job);
    case "payment.status.poll":
      return await pollPaymentStatus(job);
    case "ai.summary":
      return await summarize(job);
    default:
      throw new WorkerError("unsupported_job_kind", false);
  }
};

const leaseHeartbeat = (admin: ReturnType<typeof adminClient>, workerId: string, job: Job) => {
  let failure: WorkerError | undefined;
  let renewing = false;
  const renew = async (): Promise<void> => {
    if (renewing || failure !== undefined) return;
    renewing = true;
    try {
      const { data, error } = await admin.rpc("renew_finch_job", {
        p_worker_id: workerId,
        p_message_id: job.message_id,
        p_job_id: job.job_id,
        p_lease_seconds: 300,
      });
      if (error !== null || data !== true) failure = new WorkerError("job_lease_lost", true);
    } catch {
      failure = new WorkerError("job_lease_lost", true);
    } finally {
      renewing = false;
    }
  };
  const timer = setInterval(() => void renew(), 60_000);
  return {
    assert: (): void => {
      if (failure !== undefined) throw failure;
    },
    stop: (): void => clearInterval(timer),
  };
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return options();
  try {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    requireWorker(request);
    const workerId = crypto.randomUUID();
    const admin = adminClient();
    const { data, error } = await admin.rpc("claim_finch_jobs", { p_worker_id: workerId, p_limit: 1 });
    if (error !== null || !Array.isArray(data)) throw new HttpError(500, "job_claim_failed");
    let succeeded = 0;
    let retried = 0;
    let dead = 0;
    for (const item of data as Job[]) {
      const heartbeat = leaseHeartbeat(admin, workerId, item);
      try {
        await handle(item);
        heartbeat.assert();
        const { data: completed, error: completeError } = await admin.rpc("complete_finch_job", {
          p_worker_id: workerId,
          p_message_id: item.message_id,
          p_job_id: item.job_id,
        });
        if (completeError !== null || completed !== true) throw new WorkerError("job_lease_lost", true);
        succeeded += 1;
      } catch (cause) {
        const failure = cause instanceof WorkerError
          ? cause
          : cause instanceof ProviderError
          ? new WorkerError(cause.code, cause.retryable)
          : cause instanceof HttpError
          ? new WorkerError("invalid_job_payload", false)
          : new WorkerError("worker_failure", true);
        const { data: status, error: failError } = await admin.rpc("fail_finch_job", {
          p_worker_id: workerId,
          p_message_id: item.message_id,
          p_job_id: item.job_id,
          p_retryable: failure.retryable,
          p_safe_error_code: failure.code,
        });
        if (failError !== null) throw new HttpError(500, "job_failure_record_failed");
        if (status === "retry") retried += 1;
        if (status === "dead") dead += 1;
        await audit(item.workspace_id, "job.failed", "job_request", item.job_id, "failed", failure.code);
      } finally {
        heartbeat.stop();
      }
    }
    return json({ processed: data.length, succeeded, retried, dead });
  } catch (cause) {
    return errorResponse(cause);
  }
});
