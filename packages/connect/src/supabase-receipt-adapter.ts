import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { Context, Effect, Layer } from "effect"
import {
  ReceiptConflict,
  ReceiptHashMismatch,
  ReceiptMetadataMismatch,
  ReceiptNotFound,
  ReceiptPort,
  ReceiptUnavailable,
  ValidationFailed,
  type CreateReceiptUploadIntentPortInput,
  type CreateReceiptUploadIntentResult,
  type FinalizeReceiptPortInput,
  type GetReceiptDownloadUrlPortInput,
  type GetReceiptPortInput,
  type ListReceiptsPortInput,
  type ListReceiptsResult,
  type PrincipalContext,
  type Receipt,
  type ReceiptDownloadTarget,
  type WorkspaceId,
} from "@finch/lib"

export interface SupabaseReceiptConfig {
  readonly supabaseUrl: string
  readonly serviceRoleKey: string
  readonly pageTokenHmacKey: string
}

type RecordValue = Record<string, unknown>
type ReceiptPortService = Context.Tag.Service<typeof ReceiptPort>

type ReceiptCursor = {
  readonly createdAt: string
  readonly id: string
}

type StoredReceipt = {
  readonly receipt: Receipt
  readonly objectKey: string
  readonly sha256: string
  readonly byteSize: number
  readonly totalMinor?: string
  readonly currency?: string
}

const RECEIPT_COLUMNS = "id,workspace_id,file_name,mime_type,total_minor::text,currency,merchant,receipt_date,upload_state,created_at"
const STORED_RECEIPT_COLUMNS = `${RECEIPT_COLUMNS},object_key,sha256,byte_size`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64URL = /^[A-Za-z0-9_-]+$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const INTEGER = /^-?\d+$/
const SHA256 = /^[0-9a-f]{64}$/
const MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"])

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const exactKeys = (value: RecordValue, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const requiredString = (row: RecordValue, field: string) => {
  const value = row[field]
  if (typeof value !== "string") throw new Error(`invalid ${field}`)
  return value
}

const nullableString = (row: RecordValue, field: string) => {
  const value = row[field]
  if (value === null || value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`invalid ${field}`)
  return value
}

const requiredUuid = (row: RecordValue, field: string) => {
  const value = requiredString(row, field)
  if (!UUID.test(value)) throw new Error(`invalid ${field}`)
  return value
}

const nullableInteger = (row: RecordValue, field: string) => {
  const value = nullableString(row, field)
  if (value !== undefined && !INTEGER.test(value)) throw new Error(`invalid ${field}`)
  return value
}

const requiredByteSize = (row: RecordValue) => {
  const value = row["byte_size"]
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && INTEGER.test(value)
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("invalid byte_size")
  return parsed
}

const unavailable = () => new ReceiptUnavailable()
const invalidPageToken = () => new ValidationFailed({ issues: ["pageToken is invalid"] })

const readReceipt = (value: unknown, workspaceId: WorkspaceId): Receipt => {
  if (!isRecord(value)) throw new Error("invalid receipt row")
  const id = requiredUuid(value, "id")
  if (requiredUuid(value, "workspace_id") !== workspaceId) throw new Error("receipt workspace mismatch")
  const status = requiredString(value, "upload_state")
  if (status !== "pending" && status !== "ready" && status !== "failed") throw new Error("invalid upload_state")
  const contentType = requiredString(value, "mime_type")
  if (!MIME_TYPES.has(contentType)) throw new Error("invalid mime_type")
  const createdAt = requiredString(value, "created_at")
  if (createdAt.trim() === "") throw new Error("invalid created_at")
  const fileName = nullableString(value, "file_name")
  const merchant = nullableString(value, "merchant")
  const receiptDate = nullableString(value, "receipt_date")
  if (receiptDate !== undefined && !ISO_DATE.test(receiptDate)) throw new Error("invalid receipt_date")
  const totalMinor = nullableInteger(value, "total_minor")
  const currency = nullableString(value, "currency")
  if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) throw new Error("invalid currency")
  return {
    id,
    status,
    contentType,
    createdAt,
    ...(fileName === undefined ? {} : { fileName }),
    ...(merchant === undefined ? {} : { merchant }),
    // Legacy Edge rows can have only one half of Money. Preserve absence rather
    // than inventing a currency or a monetary amount for the protobuf response.
    ...(totalMinor === undefined || currency === undefined ? {} : { total: { minorUnits: totalMinor, currency } }),
    ...(receiptDate === undefined ? {} : { receiptDate }),
  }
}

const readStoredReceipt = (value: unknown, workspaceId: WorkspaceId): StoredReceipt => {
  if (!isRecord(value)) throw new Error("invalid receipt row")
  const sha256 = requiredString(value, "sha256").replace(/^\\x/, "")
  if (!SHA256.test(sha256)) throw new Error("invalid sha256")
  const totalMinor = nullableInteger(value, "total_minor")
  const currency = nullableString(value, "currency")
  return {
    receipt: readReceipt(value, workspaceId),
    objectKey: requiredString(value, "object_key"),
    sha256,
    byteSize: requiredByteSize(value),
    ...(totalMinor === undefined ? {} : { totalMinor }),
    ...(currency === undefined ? {} : { currency }),
  }
}

const encodePageToken = (payload: RecordValue, key: string) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", key).update(encoded).digest("base64url")
  return `${encoded}.${signature}`
}

const decodePageToken = (token: string, key: string): ReceiptCursor => {
  const [encoded, signature, ...rest] = token.split(".")
  if (
    rest.length !== 0 ||
    encoded === undefined ||
    signature === undefined ||
    !BASE64URL.test(encoded) ||
    !BASE64URL.test(signature)
  ) {
    throw invalidPageToken()
  }
  const expected = createHmac("sha256", key).update(encoded).digest("base64url")
  const actualBytes = Buffer.from(signature, "utf8")
  const expectedBytes = Buffer.from(expected, "utf8")
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw invalidPageToken()
  }
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch {
    throw invalidPageToken()
  }
  if (!isRecord(payload)) throw invalidPageToken()
  const order = payload["o"]
  if (
    !exactKeys(payload, ["v", "r", "w", "o"]) ||
    payload["v"] !== 1 ||
    payload["r"] !== "receipts" ||
    !isRecord(order) ||
    !exactKeys(order, ["createdAt", "id"]) ||
    typeof order["createdAt"] !== "string" ||
    order["createdAt"].trim() === "" ||
    typeof order["id"] !== "string" ||
    !UUID.test(order["id"])
  ) {
    throw invalidPageToken()
  }
  return { createdAt: order["createdAt"], id: order["id"] }
}

const decodeReceiptCursor = (token: string | undefined, workspaceId: WorkspaceId, key: string) => {
  if (token === undefined) return undefined
  const cursor = decodePageToken(token, key)
  if (cursor === undefined) throw invalidPageToken()
  // The HMAC protects this payload; checking its scope still prevents a token
  // minted for one workspace from advancing another workspace's result set.
  const encoded = token.split(".")[0] as string
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as RecordValue
  if (payload["w"] !== workspaceId) throw invalidPageToken()
  return cursor
}

const codeOf = (error: unknown) =>
  isRecord(error) && typeof error["code"] === "string" ? error["code"] : undefined

const createBytea = (hex: string) => `\\x${hex}`

const receiptContent = (receipt: StoredReceipt) =>
  ["receipt", receipt.receipt.merchant, receipt.receipt.receiptDate, receipt.totalMinor, receipt.currency]
    .filter((item): item is string => item !== undefined)
    .join(" ")

const matchesCreateIntent = (receipt: StoredReceipt, input: CreateReceiptUploadIntentPortInput) =>
  receipt.receipt.fileName === input.fileName &&
  receipt.receipt.contentType === input.contentType &&
  receipt.byteSize === input.contentLength &&
  receipt.sha256 === input.sha256 &&
  receipt.receipt.merchant === input.merchant &&
  receipt.totalMinor === input.total?.minorUnits &&
  receipt.currency === input.total?.currency &&
  receipt.receipt.receiptDate === input.receiptDate

const preserveListFailure = (cause: unknown): ValidationFailed | ReceiptUnavailable =>
  cause instanceof ValidationFailed ? cause : unavailable()

const preserveReadFailure = (cause: unknown): ReceiptNotFound | ReceiptUnavailable =>
  cause instanceof ReceiptNotFound ? cause : unavailable()

const preservePortFailure = (cause: unknown) =>
  cause instanceof ReceiptNotFound ||
  cause instanceof ReceiptConflict ||
  cause instanceof ReceiptHashMismatch ||
  cause instanceof ReceiptMetadataMismatch ||
  cause instanceof ReceiptUnavailable
    ? cause
    : unavailable()

export const makeSupabaseReceiptLayer = (
  config: SupabaseReceiptConfig,
): Layer.Layer<ReceiptPort> => {
  if (config.pageTokenHmacKey.trim() === "") {
    throw new Error("pageTokenHmacKey must not be blank")
  }
  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })

  const resolveActorId = async (principal: PrincipalContext) => {
    const { data, error } = await client
      .from("authentik_subject_profiles")
      .select("profile_id")
      .eq("issuer", principal.issuer)
      .eq("subject", principal.subjectId)
      .maybeSingle()
    if (error !== null || !isRecord(data) || typeof data["profile_id"] !== "string" || !UUID.test(data["profile_id"])) {
      throw unavailable()
    }
    return data["profile_id"]
  }

  const audit = async (
    workspaceId: WorkspaceId,
    actorId: string,
    action: string,
    receiptId: string,
    outcome: "success" | "failed",
    safeErrorCode?: string,
  ) => {
    const { error } = await client.from("audit_events").insert({
      workspace_id: workspaceId,
      actor_id: actorId,
      action,
      resource_type: "receipt",
      resource_id: receiptId,
      outcome,
      ...(safeErrorCode === undefined ? {} : { safe_error_code: safeErrorCode }),
    })
    if (error !== null) throw unavailable()
  }

  const findReceipt = async (input: GetReceiptPortInput) => {
    const { data, error } = await client
      .from("receipts")
      .select(RECEIPT_COLUMNS)
      .eq("workspace_id", input.workspaceId)
      .eq("id", input.receiptId)
      .maybeSingle()
    if (error !== null) throw unavailable()
    if (data === null) throw new ReceiptNotFound({ receiptId: input.receiptId })
    return readReceipt(data, input.workspaceId)
  }

  const findStoredReceipt = async (input: GetReceiptPortInput) => {
    const { data, error } = await client
      .from("receipts")
      .select(STORED_RECEIPT_COLUMNS)
      .eq("workspace_id", input.workspaceId)
      .eq("id", input.receiptId)
      .maybeSingle()
    if (error !== null) throw unavailable()
    if (data === null) throw new ReceiptNotFound({ receiptId: input.receiptId })
    return readStoredReceipt(data, input.workspaceId)
  }

  const findByIdempotencyKey = async (workspaceId: WorkspaceId, idempotencyKey: string) => {
    const { data, error } = await client
      .from("receipts")
      .select(STORED_RECEIPT_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle()
    if (error !== null) throw unavailable()
    return data === null ? undefined : readStoredReceipt(data, workspaceId)
  }

  const uploadTarget = async (receipt: StoredReceipt) => {
    const { data, error } = await client.storage.from("receipt-originals").createSignedUploadUrl(receipt.objectKey)
    if (error !== null || data === null || typeof data.signedUrl !== "string" || data.signedUrl.trim() === "") {
      throw unavailable()
    }
    return {
      url: data.signedUrl,
      requiredHeaders: [{ name: "content-type", value: receipt.receipt.contentType }],
    }
  }

  const failPendingReceipt = async (
    input: FinalizeReceiptPortInput,
    actorId: string,
    objectKey: string,
    safeErrorCode: "receipt_hash_mismatch" | "receipt_metadata_mismatch",
  ) => {
    const { error: removeError } = await client.storage.from("receipt-originals").remove([objectKey])
    if (removeError !== null) throw unavailable()
    const { data, error } = await client.rpc("fail_pending_receipt_upload", {
      p_workspace_id: input.workspaceId,
      p_receipt_id: input.receiptId,
      p_actor_id: actorId,
      p_safe_error_code: safeErrorCode,
    })
    if (error !== null || (data !== "failed" && data !== "already_failed")) throw unavailable()
  }

  const listReceipts = (input: ListReceiptsPortInput): Effect.Effect<ListReceiptsResult, ValidationFailed | ReceiptUnavailable> =>
    Effect.tryPromise({
      try: async () => {
        const cursor = decodeReceiptCursor(input.page.pageToken, input.workspaceId, config.pageTokenHmacKey)
        const base = client
          .from("receipts")
          .select(RECEIPT_COLUMNS)
          .eq("workspace_id", input.workspaceId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
        const response = cursor === undefined
          ? await base.limit(input.page.pageSize + 1)
          : await base
            .or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)
            .limit(input.page.pageSize + 1)
        if (response.error !== null || !Array.isArray(response.data)) throw unavailable()
        const rows = response.data.map((row) => readReceipt(row, input.workspaceId))
        const receipts = rows.slice(0, input.page.pageSize)
        const last = receipts.at(-1)
        return {
          receipts,
          ...(rows.length > input.page.pageSize && last !== undefined
            ? {
              nextPageToken: encodePageToken(
                { v: 1, r: "receipts", w: input.workspaceId, o: { createdAt: last.createdAt, id: last.id } },
                config.pageTokenHmacKey,
              ),
            }
            : {}),
        }
      },
      catch: preserveListFailure,
    })

  const getReceipt = (input: GetReceiptPortInput): Effect.Effect<Receipt, ReceiptNotFound | ReceiptUnavailable> =>
    Effect.tryPromise({ try: () => findReceipt(input), catch: preserveReadFailure })

  const createReceiptUploadIntent = (
    input: CreateReceiptUploadIntentPortInput,
  ): Effect.Effect<CreateReceiptUploadIntentResult, ReceiptNotFound | ReceiptConflict | ReceiptHashMismatch | ReceiptMetadataMismatch | ReceiptUnavailable> =>
    Effect.tryPromise({
      try: async () => {
        const actorId = await resolveActorId(input.principal)
        let receipt = await findByIdempotencyKey(input.workspaceId, input.idempotencyKey)
        if (receipt === undefined) {
          const receiptId = randomUUID()
          const objectKey = `${input.workspaceId}/${receiptId}/${randomUUID()}`
          const { data, error } = await client
            .from("receipts")
            .insert({
              id: receiptId,
              workspace_id: input.workspaceId,
              file_name: input.fileName,
              idempotency_key: input.idempotencyKey,
              sha256: createBytea(input.sha256),
              object_key: objectKey,
              mime_type: input.contentType,
              byte_size: input.contentLength,
              total_minor: input.total?.minorUnits ?? null,
              currency: input.total?.currency ?? null,
              merchant: input.merchant ?? null,
              receipt_date: input.receiptDate ?? null,
              upload_state: "pending",
              created_by: actorId,
            })
            .select(STORED_RECEIPT_COLUMNS)
            .single()
          if (error !== null) {
            if (codeOf(error) === "23505") {
              receipt = await findByIdempotencyKey(input.workspaceId, input.idempotencyKey)
              if (receipt === undefined) throw new ReceiptConflict({ reason: "duplicate" })
            } else {
              throw unavailable()
            }
          } else if (data === null) {
            throw unavailable()
          } else {
            receipt = readStoredReceipt(data, input.workspaceId)
          }
        }
        if (receipt === undefined) throw unavailable()
        if (!matchesCreateIntent(receipt, input)) throw new ReceiptConflict({ reason: "duplicate" })
        const upload = await uploadTarget(receipt)
        await audit(input.workspaceId, actorId, "receipt.upload_requested", receipt.receipt.id, "success")
        return { receipt: receipt.receipt, upload }
      },
      catch: preservePortFailure,
    })

  const finalizeReceipt = (
    input: FinalizeReceiptPortInput,
  ): Effect.Effect<Receipt, ReceiptNotFound | ReceiptConflict | ReceiptHashMismatch | ReceiptMetadataMismatch | ReceiptUnavailable> =>
    Effect.tryPromise({
      try: async () => {
        const actorId = await resolveActorId(input.principal)
        const stored = await findStoredReceipt(input)
        if (stored.receipt.status === "failed") throw new ReceiptConflict({ reason: "failed" })

        if (stored.receipt.status === "pending") {
          const { data: object, error: objectError } = await client.storage.from("receipt-originals").download(stored.objectKey)
          if (objectError !== null || object === null) throw unavailable()
          const bytes = Buffer.from(await object.arrayBuffer())
          if (bytes.byteLength !== stored.byteSize || object.type !== stored.receipt.contentType) {
            await failPendingReceipt(input, actorId, stored.objectKey, "receipt_metadata_mismatch")
            throw new ReceiptMetadataMismatch()
          }
          const actualHash = createHash("sha256").update(bytes).digest("hex")
          if (actualHash !== stored.sha256) {
            await failPendingReceipt(input, actorId, stored.objectKey, "receipt_hash_mismatch")
            throw new ReceiptHashMismatch()
          }
        }

        const content = receiptContent(stored)
        const contentHash = createHash("sha256").update(content).digest("hex")
        const { error: documentError } = await client.from("finance_documents").upsert(
          {
            workspace_id: input.workspaceId,
            source_type: "receipt",
            source_id: input.receiptId,
            content,
            content_hash: createBytea(contentHash),
          },
          { onConflict: "workspace_id,source_type,source_id" },
        )
        if (documentError !== null) throw unavailable()

        if (stored.receipt.status === "pending") {
          const { error: finalizeError } = await client
            .from("receipts")
            .update({ upload_state: "ready" })
            .eq("workspace_id", input.workspaceId)
            .eq("id", input.receiptId)
            .eq("upload_state", "pending")
          if (finalizeError !== null) throw unavailable()
        }

        const { data: jobId, error: embeddingError } = await client.rpc("enqueue_finch_job", {
          p_workspace_id: input.workspaceId,
          p_kind: "search.embed",
          p_payload: { source_type: "receipt", source_id: input.receiptId },
          p_idempotency_key: `embed:receipt:${input.receiptId}:${createBytea(contentHash)}`,
        })
        if (embeddingError !== null || typeof jobId !== "string") throw unavailable()
        const receipt = stored.receipt.status === "pending" ? await findReceipt(input) : stored.receipt
        if (receipt.status !== "ready") throw new ReceiptConflict({ reason: receipt.status === "failed" ? "failed" : "not_ready" })
        await audit(input.workspaceId, actorId, "receipt.upload_finalized", input.receiptId, "success")
        return receipt
      },
      catch: preservePortFailure,
    })

  const getReceiptDownloadUrl = (
    input: GetReceiptDownloadUrlPortInput,
  ): Effect.Effect<ReceiptDownloadTarget, ReceiptNotFound | ReceiptConflict | ReceiptHashMismatch | ReceiptMetadataMismatch | ReceiptUnavailable> =>
    Effect.tryPromise({
      try: async () => {
        const actorId = await resolveActorId(input.principal)
        const stored = await findStoredReceipt(input)
        if (stored.receipt.status !== "ready") {
          throw new ReceiptConflict({ reason: stored.receipt.status === "failed" ? "failed" : "not_ready" })
        }
        const expiresAt = new Date(Date.now() + 60_000).toISOString()
        const { data, error } = await client.storage.from("receipt-originals").createSignedUrl(stored.objectKey, 60)
        if (error !== null || data === null || typeof data.signedUrl !== "string" || data.signedUrl.trim() === "") {
          throw unavailable()
        }
        await audit(input.workspaceId, actorId, "receipt.download_url_issued", input.receiptId, "success")
        return { url: data.signedUrl, expiresAt }
      },
      catch: preservePortFailure,
    })

  const receiptPort: ReceiptPortService = {
    listReceipts,
    getReceipt,
    createReceiptUploadIntent,
    finalizeReceipt,
    getReceiptDownloadUrl,
  }

  return Layer.succeed(ReceiptPort, receiptPort)
}
