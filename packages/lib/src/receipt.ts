import { Context, Data, Effect, Schema } from "effect"
import { ReceiptNotFound, ValidationFailed, WorkspaceId, type WorkspaceId as WorkspaceIdT } from "@finch/core/domain"
import { type PrincipalContext, WorkspaceAccess, type WorkspaceRole } from "./foundation.ts"

export type ReceiptStatus = "pending" | "ready" | "failed"

export interface ReceiptMoney {
  readonly minorUnits: string
  readonly currency: string
}

export interface Receipt {
  readonly id: string
  readonly status: ReceiptStatus
  readonly fileName?: string
  readonly contentType: string
  readonly merchant?: string
  readonly total?: ReceiptMoney
  readonly receiptDate?: string
  readonly createdAt: string
}

export interface ReceiptPageRequest {
  readonly pageSize?: unknown
  readonly pageToken?: unknown
}

export interface ReceiptPage {
  readonly pageSize: number
  readonly pageToken?: string
}

export interface ReceiptUploadTarget {
  readonly url: string
  readonly requiredHeaders: readonly { readonly name: string; readonly value: string }[]
}

export interface ReceiptDownloadTarget {
  readonly url: string
  readonly expiresAt: string
}

export interface ListReceiptsPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly page: ReceiptPage
}

export interface GetReceiptPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly receiptId: string
}

export interface CreateReceiptUploadIntentPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly principal: PrincipalContext
  readonly fileName: string
  readonly contentType: "image/jpeg" | "image/png" | "application/pdf"
  readonly contentLength: number
  readonly sha256: string
  readonly idempotencyKey: string
  readonly merchant?: string
  readonly total?: ReceiptMoney
  readonly receiptDate?: string
}

export interface FinalizeReceiptPortInput extends GetReceiptPortInput {
  readonly principal: PrincipalContext
}

export interface GetReceiptDownloadUrlPortInput extends GetReceiptPortInput {
  readonly principal: PrincipalContext
}

export interface ListReceiptsResult {
  readonly receipts: readonly Receipt[]
  readonly nextPageToken?: string
}

export interface CreateReceiptUploadIntentResult {
  readonly receipt: Receipt
  readonly upload: ReceiptUploadTarget
}

export class ReceiptUnavailable extends Data.TaggedError("ReceiptUnavailable")<Record<never, never>> {}

export class ReceiptConflict extends Data.TaggedError("ReceiptConflict")<{
  readonly reason: "failed" | "not_ready" | "duplicate"
}> {}

export class ReceiptHashMismatch extends Data.TaggedError("ReceiptHashMismatch")<Record<never, never>> {}

export class ReceiptMetadataMismatch extends Data.TaggedError("ReceiptMetadataMismatch")<Record<never, never>> {}

export class ReceiptWriteDenied extends Data.TaggedError("ReceiptWriteDenied")<{
  readonly workspaceId: WorkspaceIdT
}> {}

export type ReceiptPortError = ReceiptNotFound | ReceiptUnavailable | ReceiptConflict | ReceiptHashMismatch | ReceiptMetadataMismatch
export type ReceiptListError = ValidationFailed | ReceiptUnavailable

export class ReceiptPort extends Context.Tag("ReceiptPort")<
  ReceiptPort,
  {
    readonly listReceipts: (input: ListReceiptsPortInput) => Effect.Effect<ListReceiptsResult, ReceiptListError>
    readonly getReceipt: (input: GetReceiptPortInput) => Effect.Effect<Receipt, ReceiptNotFound | ReceiptUnavailable>
    readonly createReceiptUploadIntent: (
      input: CreateReceiptUploadIntentPortInput,
    ) => Effect.Effect<CreateReceiptUploadIntentResult, ReceiptPortError>
    readonly finalizeReceipt: (input: FinalizeReceiptPortInput) => Effect.Effect<Receipt, ReceiptPortError>
    readonly getReceiptDownloadUrl: (
      input: GetReceiptDownloadUrlPortInput,
    ) => Effect.Effect<ReceiptDownloadTarget, ReceiptPortError>
  }
>() {}

export interface ListReceiptsInput {
  readonly workspaceId: unknown
  readonly page?: ReceiptPageRequest
}

export interface GetReceiptInput {
  readonly workspaceId: unknown
  readonly receiptId: unknown
}

export interface CreateReceiptUploadIntentInput {
  readonly workspaceId: unknown
  readonly fileName: unknown
  readonly contentType: unknown
  readonly contentLength: unknown
  readonly sha256: unknown
  readonly idempotencyKey: unknown
  readonly merchant?: unknown
  readonly total?: unknown
  readonly receiptDate?: unknown
}

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const MAX_RECEIPT_SIZE = 10 * 1024 * 1024
const MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"])
const UUID_ISSUE = "workspace_id must be a UUID"
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const SHA256 = /^[0-9a-f]{64}$/
const ISO_CURRENCY = /^[A-Z]{3}$/
const MINOR_UNITS = /^\d{1,20}$/

const invalid = (issue: string) => new ValidationFailed({ issues: [issue] })

const decodeWorkspaceId = (scope: unknown) =>
  Schema.decodeUnknown(WorkspaceId)(scope).pipe(
    Effect.mapError(() => invalid(UUID_ISSUE)),
  )

const decodeReceiptId = (value: unknown) =>
  Schema.decodeUnknown(Schema.UUID)(value).pipe(
    Effect.mapError(() => invalid("receipt_id must be a UUID")),
  )

const decodePage = (input: unknown): Effect.Effect<ReceiptPage, ValidationFailed> => {
  if (input === undefined) {
    return Effect.succeed({ pageSize: DEFAULT_PAGE_SIZE })
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Effect.fail(invalid("page must be an object"))
  }
  const page = input as { readonly pageSize?: unknown; readonly pageToken?: unknown }
  const pageSize = page.pageSize === undefined || page.pageSize === 0 ? DEFAULT_PAGE_SIZE : page.pageSize
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
    return Effect.fail(invalid(`pageSize must be a positive integer no greater than ${MAX_PAGE_SIZE}`))
  }
  if (page.pageToken !== undefined && typeof page.pageToken !== "string") {
    return Effect.fail(invalid("pageToken must be a string"))
  }
  return Effect.succeed({
    pageSize,
    ...(page.pageToken === undefined || page.pageToken === "" ? {} : { pageToken: page.pageToken }),
  })
}

const validReceiptDate = (value: string) => {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const decodeCreate = (
  input: CreateReceiptUploadIntentInput,
): Effect.Effect<Omit<CreateReceiptUploadIntentPortInput, "workspaceId" | "principal">, ValidationFailed> => {
  const issues: string[] = []
  const fileName = input.fileName
  if (
    typeof fileName !== "string" ||
    fileName.trim() === "" ||
    fileName.length > 255 ||
    /[\u0000-\u001f\u007f/\\]/.test(fileName) ||
    fileName === "." ||
    fileName === ".."
  ) {
    issues.push("file_name must be a sane nonblank filename no longer than 255 characters")
  }

  const contentType = input.contentType
  if (typeof contentType !== "string" || !MIME_TYPES.has(contentType)) {
    issues.push("content_type must be image/jpeg, image/png, or application/pdf")
  }

  const contentLength = input.contentLength
  const normalizedLength = typeof contentLength === "bigint"
    ? contentLength
    : typeof contentLength === "number" && Number.isSafeInteger(contentLength)
      ? BigInt(contentLength)
      : undefined
  if (normalizedLength === undefined || normalizedLength < 1n || normalizedLength > BigInt(MAX_RECEIPT_SIZE)) {
    issues.push(`content_length must be between 1 and ${MAX_RECEIPT_SIZE}`)
  }

  const sha256 = input.sha256
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    issues.push("sha256 must be 64 lowercase hexadecimal characters")
  }

  const idempotencyKey = input.idempotencyKey
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "" || idempotencyKey.length > 200) {
    issues.push("idempotency_key must be nonblank and no longer than 200 characters")
  }

  const merchant = input.merchant
  if (merchant !== undefined && (typeof merchant !== "string" || merchant.length > 300)) {
    issues.push("merchant must be a string no longer than 300 characters")
  }

  const receiptDate = input.receiptDate
  if (receiptDate !== undefined && (typeof receiptDate !== "string" || !validReceiptDate(receiptDate))) {
    issues.push("receipt_date must be a valid YYYY-MM-DD date")
  }

  let total: ReceiptMoney | undefined
  if (input.total !== undefined) {
    if (typeof input.total !== "object" || input.total === null || Array.isArray(input.total)) {
      issues.push("total must contain non-negative minor_units and uppercase currency")
    } else {
      const money = input.total as { readonly minorUnits?: unknown; readonly currency?: unknown }
      if (typeof money.minorUnits !== "string" || !MINOR_UNITS.test(money.minorUnits)) {
        issues.push("total.minor_units must be a non-negative integer no longer than 20 digits")
      }
      if (typeof money.currency !== "string" || !ISO_CURRENCY.test(money.currency)) {
        issues.push("total.currency must be an uppercase ISO currency")
      }
      if (typeof money.minorUnits === "string" && MINOR_UNITS.test(money.minorUnits) && typeof money.currency === "string" && ISO_CURRENCY.test(money.currency)) {
        total = { minorUnits: money.minorUnits, currency: money.currency }
      }
    }
  }

  if (issues.length > 0 || normalizedLength === undefined || typeof fileName !== "string" || typeof contentType !== "string" || typeof sha256 !== "string" || typeof idempotencyKey !== "string") {
    return Effect.fail(new ValidationFailed({ issues }))
  }
  return Effect.succeed({
    fileName,
    contentType: contentType as CreateReceiptUploadIntentPortInput["contentType"],
    contentLength: Number(normalizedLength),
    sha256,
    idempotencyKey,
    ...(merchant === undefined ? {} : { merchant: merchant as string }),
    ...(total === undefined ? {} : { total }),
    ...(receiptDate === undefined ? {} : { receiptDate: receiptDate as string }),
  })
}

const requireWriteRole = (role: WorkspaceRole, workspaceId: WorkspaceIdT) =>
  role === "viewer"
    ? Effect.fail(new ReceiptWriteDenied({ workspaceId }))
    : Effect.void

export const listReceipts = (principal: PrincipalContext, input: ListReceiptsInput) =>
  Effect.gen(function* () {
    const page = yield* decodePage(input.page)
    const workspaceId = yield* decodeWorkspaceId(input.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    const receipts = yield* ReceiptPort
    return yield* receipts.listReceipts({ workspaceId: authorized.workspaceId, page })
  })

export const getReceipt = (principal: PrincipalContext, input: GetReceiptInput) =>
  Effect.gen(function* () {
    const receiptId = yield* decodeReceiptId(input.receiptId)
    const workspaceId = yield* decodeWorkspaceId(input.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    const receipts = yield* ReceiptPort
    return yield* receipts.getReceipt({ workspaceId: authorized.workspaceId, receiptId })
  })

export const createReceiptUploadIntent = (principal: PrincipalContext, input: CreateReceiptUploadIntentInput) =>
  Effect.gen(function* () {
    const create = yield* decodeCreate(input)
    const workspaceId = yield* decodeWorkspaceId(input.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    yield* requireWriteRole(authorized.role, authorized.workspaceId)
    const receipts = yield* ReceiptPort
    return yield* receipts.createReceiptUploadIntent({ workspaceId: authorized.workspaceId, principal, ...create })
  })

export const finalizeReceipt = (principal: PrincipalContext, input: GetReceiptInput) =>
  Effect.gen(function* () {
    const receiptId = yield* decodeReceiptId(input.receiptId)
    const workspaceId = yield* decodeWorkspaceId(input.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    yield* requireWriteRole(authorized.role, authorized.workspaceId)
    const receipts = yield* ReceiptPort
    return yield* receipts.finalizeReceipt({ workspaceId: authorized.workspaceId, receiptId, principal })
  })

export const getReceiptDownloadUrl = (principal: PrincipalContext, input: GetReceiptInput) =>
  Effect.gen(function* () {
    const receiptId = yield* decodeReceiptId(input.receiptId)
    const workspaceId = yield* decodeWorkspaceId(input.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    const receipts = yield* ReceiptPort
    return yield* receipts.getReceiptDownloadUrl({ workspaceId: authorized.workspaceId, receiptId, principal })
  })
