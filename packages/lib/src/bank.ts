import { Context, Data, Effect, Schema } from "effect"
import { ValidationFailed, WorkspaceId, type WorkspaceId as WorkspaceIdT } from "@finch/core/domain"
import { type PrincipalContext, WorkspaceAccess, type WorkspaceRole } from "./foundation.ts"

export interface Aspsp {
  readonly id: string
  readonly name: string
  readonly country: string
  readonly logoUrl?: string
}

export interface ProviderAspsp {
  readonly name: string
  readonly country: string
  readonly logoUrl?: string
}

export interface AspspIdentity {
  readonly country: string
  readonly name: string
}

export type BankConnectionStatus = "pending" | "active" | "expired" | "disconnected" | "failed"

export interface BankConnection {
  readonly id: string
  readonly aspsp: Aspsp
  readonly status: BankConnectionStatus
  readonly lastSyncedAt?: string
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export interface Job {
  readonly id: string
  readonly workspaceId: WorkspaceIdT
  readonly status: JobStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly failureReason?: string
}

export interface AuthorizationResponse {
  readonly authorizationUrl: string
  readonly connection: BankConnection
}

export interface DisconnectResponse {
  readonly disconnected: boolean
  readonly status: BankConnectionStatus
}

export interface BankPageRequest {
  readonly pageSize?: unknown
  readonly pageToken?: unknown
}

export interface BankPage {
  readonly pageSize: number
  readonly pageToken?: string
}

export interface ListAspspsDirectoryInput {
  readonly country?: string
  readonly page: BankPage
}

export interface ListAspspsDirectoryResult {
  readonly aspsps: readonly ProviderAspsp[]
  readonly nextPageToken?: string
}

export interface ListConnectionsPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly page: BankPage
}

export interface ListConnectionsResult {
  readonly connections: readonly BankConnection[]
  readonly nextPageToken?: string
}

export interface GetConnectionStatusPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly connectionId: string
}

export interface StartAuthorizationPortInput {
  readonly workspaceId: WorkspaceIdT
  readonly principal: PrincipalContext
  readonly aspsp: ProviderAspsp
  readonly returnPath: string
}

export interface QueueSyncPortInput extends GetConnectionStatusPortInput {
  readonly since?: Date
  readonly idempotencyKey: string
}

export interface DisconnectPortInput extends GetConnectionStatusPortInput {
  readonly principal: PrincipalContext
}

export class BankNotFound extends Data.TaggedError("BankNotFound")<{
  readonly resource: "aspsp" | "connection"
  readonly id: string
}> {}

export class BankUnavailable extends Data.TaggedError("BankUnavailable")<Record<never, never>> {}

export class BankConflict extends Data.TaggedError("BankConflict")<{
  readonly reason: string
}> {}

export class BankWriteDenied extends Data.TaggedError("BankWriteDenied")<{
  readonly workspaceId: WorkspaceIdT
}> {}

export class BankAssuranceRequired extends Data.TaggedError("BankAssuranceRequired")<{
  readonly required: "aal2"
  readonly actual: PrincipalContext["assurance"]
}> {}

export type BankPortError = BankNotFound | BankUnavailable | BankConflict
export type BankListError = ValidationFailed | BankUnavailable

export class AspspDirectory extends Context.Tag("AspspDirectory")<
  AspspDirectory,
  {
    readonly listAspsps: (
      input: ListAspspsDirectoryInput,
    ) => Effect.Effect<ListAspspsDirectoryResult, BankUnavailable>
    readonly resolveAspsp: (identity: AspspIdentity) => Effect.Effect<ProviderAspsp | null, BankUnavailable>
  }
>() {}

export class BankAuthorizationGateway extends Context.Tag("BankAuthorizationGateway")<
  BankAuthorizationGateway,
  {
    readonly startAuthorization: (input: {
      readonly aspsp: ProviderAspsp
      readonly state: string
      readonly redirectUrl: string
    }) => Effect.Effect<{ readonly url: string }, BankUnavailable>
    readonly deleteSession: (sessionId: string) => Effect.Effect<void, BankUnavailable>
  }
>() {}

export class BankPort extends Context.Tag("BankPort")<
  BankPort,
  {
    readonly startAuthorization: (
      input: StartAuthorizationPortInput,
    ) => Effect.Effect<AuthorizationResponse, BankUnavailable | BankConflict>
    readonly listConnections: (
      input: ListConnectionsPortInput,
    ) => Effect.Effect<ListConnectionsResult, BankListError>
    readonly getConnectionStatus: (
      input: GetConnectionStatusPortInput,
    ) => Effect.Effect<BankConnection, BankNotFound | BankUnavailable>
    readonly queueSync: (input: QueueSyncPortInput) => Effect.Effect<Job, BankPortError>
    readonly disconnect: (input: DisconnectPortInput) => Effect.Effect<DisconnectResponse, BankPortError>
  }
>() {}

export interface ListAspspsInput {
  readonly country?: unknown
  readonly page?: BankPageRequest
}

export interface StartAuthorizationInput {
  readonly workspaceId: unknown
  readonly aspspId: unknown
  readonly returnPath: unknown
}

export interface ListConnectionsInput {
  readonly workspaceId: unknown
  readonly page?: BankPageRequest
}

export interface GetConnectionStatusInput {
  readonly workspaceId: unknown
  readonly connectionId: unknown
}

export interface QueueSyncInput extends GetConnectionStatusInput {
  readonly since?: unknown
  readonly idempotencyKey: unknown
}

export interface DisconnectInput extends GetConnectionStatusInput {}

const ASPSP_ID_PREFIX = "enablebanking:v1:"
const BASE64URL = /^[A-Za-z0-9_-]+$/
const COUNTRY = /^[A-Z]{2}$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/
const RETURN_PATH_BASE = "https://finch.invalid"
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

const invalid = (issue: string) => new ValidationFailed({ issues: [issue] })

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const decodeEnvelope = <T extends object>(value: unknown): Effect.Effect<T, ValidationFailed> =>
  isObject(value)
    ? Effect.succeed(value as T)
    : Effect.fail(invalid("input must be an object"))

const decodeWorkspaceId = (scope: unknown) =>
  Schema.decodeUnknown(WorkspaceId)(scope).pipe(
    Effect.mapError(() => invalid("workspace_id must be a UUID")),
  )

const decodeConnectionId = (value: unknown) =>
  Schema.decodeUnknown(Schema.UUID)(value).pipe(
    Effect.mapError(() => invalid("connection_id must be a UUID")),
  )

const decodePage = (input: unknown): Effect.Effect<BankPage, ValidationFailed> => {
  if (input === undefined) {
    return Effect.succeed({ pageSize: DEFAULT_PAGE_SIZE })
  }
  if (!isObject(input)) {
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

const decodeCountry = (value: unknown): Effect.Effect<string | undefined, ValidationFailed> => {
  if (value === undefined || value === "") {
    return Effect.succeed(undefined)
  }
  if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value)) {
    return Effect.fail(invalid("country must be a two-letter ISO country code"))
  }
  return Effect.succeed(value.toUpperCase())
}

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

const base64UrlDecode = (value: string): Uint8Array => {
  if (value.length % 4 === 1) {
    throw new Error("invalid base64url")
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

const normalizeAspspName = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const name = value.trim()
  return name === "" || /[\u0000-\u001f\u007f]/.test(name) ? undefined : name
}

const normalizeAspspCountry = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const country = value.trim().toUpperCase()
  return COUNTRY.test(country) ? country : undefined
}

const normalizeLogoUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export const encodeAspspId = (value: unknown): string => {
  if (!isObject(value)) {
    throw new Error("invalid ASPSP ID identity")
  }
  const country = normalizeAspspCountry(value.country)
  const name = normalizeAspspName(value.name)
  if (country === undefined || country !== value.country || name === undefined || name !== value.name) {
    throw new Error("invalid ASPSP ID identity")
  }
  return `${ASPSP_ID_PREFIX}${base64UrlEncode(new TextEncoder().encode(JSON.stringify([country, name])))}`
}

export const decodeAspspId = (value: unknown): Effect.Effect<AspspIdentity, ValidationFailed> =>
  Effect.try({
    try: () => {
      if (typeof value !== "string" || !value.startsWith(ASPSP_ID_PREFIX)) {
        throw new Error("invalid ASPSP ID")
      }
      const payload = value.slice(ASPSP_ID_PREFIX.length)
      if (!BASE64URL.test(payload)) {
        throw new Error("invalid ASPSP ID")
      }
      const bytes = base64UrlDecode(payload)
      if (base64UrlEncode(bytes) !== payload) {
        throw new Error("invalid ASPSP ID")
      }
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      const identity = JSON.parse(decoded)
      if (
        !Array.isArray(identity) ||
        identity.length !== 2 ||
        typeof identity[0] !== "string" ||
        typeof identity[1] !== "string"
      ) {
        throw new Error("invalid ASPSP ID")
      }
      const [country, name] = identity
      const normalizedCountry = normalizeAspspCountry(country)
      const normalizedName = normalizeAspspName(name)
      if (normalizedCountry === undefined || normalizedCountry !== country || normalizedName === undefined || normalizedName !== name) {
        throw new Error("invalid ASPSP ID")
      }
      const result = { country: normalizedCountry, name }
      if (encodeAspspId(result) !== value) {
        throw new Error("invalid ASPSP ID")
      }
      return result
    },
    catch: () => invalid("aspsp_id must be a canonical Enable Banking ASPSP ID"),
  })

const decodeReturnPath = (value: unknown): Effect.Effect<string, ValidationFailed> => {
  if (
    typeof value !== "string" ||
    value === "" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return Effect.fail(invalid("return_path must be a safe relative path"))
  }
  try {
    if (new URL(value, RETURN_PATH_BASE).origin !== RETURN_PATH_BASE) {
      return Effect.fail(invalid("return_path must be a safe relative path"))
    }
  } catch {
    return Effect.fail(invalid("return_path must be a safe relative path"))
  }
  return Effect.succeed(value)
}

const isLeapYear = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)

const daysInMonth = (year: number, month: number) =>
  month === 2 ? (isLeapYear(year) ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31

const decodeSince = (value: unknown): Effect.Effect<Date | undefined, ValidationFailed> => {
  if (value === undefined) {
    return Effect.succeed(undefined)
  }
  if (typeof value !== "string") {
    return Effect.fail(invalid("since must be a valid RFC 3339 timestamp"))
  }
  const match = RFC3339.exec(value)
  if (match === null) {
    return Effect.fail(invalid("since must be a valid RFC 3339 timestamp"))
  }
  const [, year, month, day, hour, minute, second, zone, offsetHour, offsetMinute] = match
  const numbers = [year, month, day, hour, minute, second].map(Number)
  const [yearNumber, monthNumber, dayNumber, hourNumber, minuteNumber, secondNumber] = numbers
  if (
    yearNumber === undefined || monthNumber === undefined || dayNumber === undefined || hourNumber === undefined ||
    minuteNumber === undefined || secondNumber === undefined || zone === undefined ||
    yearNumber < 0 || monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > daysInMonth(yearNumber, monthNumber) ||
    hourNumber > 23 || minuteNumber > 59 || secondNumber > 59 ||
    (zone !== "Z" && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))
  ) {
    return Effect.fail(invalid("since must be a valid RFC 3339 timestamp"))
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? Effect.fail(invalid("since must be a valid RFC 3339 timestamp"))
    : Effect.succeed(date)
}

const decodeIdempotencyKey = (value: unknown): Effect.Effect<string, ValidationFailed> =>
  typeof value === "string" && value.trim() !== "" && value.length <= 200
    ? Effect.succeed(value)
    : Effect.fail(invalid("idempotency_key must be nonblank and no longer than 200 characters"))

const decodeProviderAspsp = (value: unknown): Effect.Effect<ProviderAspsp, BankUnavailable> => {
  if (!isObject(value)) {
    return Effect.fail(new BankUnavailable())
  }
  const name = normalizeAspspName(value.name)
  const country = normalizeAspspCountry(value.country)
  const logoUrl = value.logoUrl === undefined ? undefined : normalizeLogoUrl(value.logoUrl)
  if (name === undefined || country === undefined || (value.logoUrl !== undefined && logoUrl === undefined)) {
    return Effect.fail(new BankUnavailable())
  }
  return Effect.succeed({ name, country, ...(logoUrl === undefined ? {} : { logoUrl }) })
}

const decodeListAspspsResult = (value: unknown): Effect.Effect<ListAspspsDirectoryResult, BankUnavailable> => {
  if (!isObject(value) || !Array.isArray(value.aspsps)) {
    return Effect.fail(new BankUnavailable())
  }
  const nextPageToken = value.nextPageToken
  if (nextPageToken !== undefined && typeof nextPageToken !== "string") {
    return Effect.fail(new BankUnavailable())
  }
  return Effect.forEach(value.aspsps, decodeProviderAspsp).pipe(
    Effect.map((aspsps) => ({ aspsps, ...(nextPageToken === undefined ? {} : { nextPageToken }) })),
  )
}

const toAspsp = (aspsp: ProviderAspsp): Aspsp => {
  return {
    id: encodeAspspId(aspsp),
    name: aspsp.name,
    country: aspsp.country,
    ...(aspsp.logoUrl === undefined ? {} : { logoUrl: aspsp.logoUrl }),
  }
}

const requireWriteRole = (role: WorkspaceRole, workspaceId: WorkspaceIdT) =>
  role === "owner" || role === "admin"
    ? Effect.void
    : Effect.fail(new BankWriteDenied({ workspaceId }))

const requireAal2 = (principal: PrincipalContext) =>
  principal.assurance === "aal2"
    ? Effect.void
    : Effect.fail(new BankAssuranceRequired({ required: "aal2", actual: principal.assurance }))

export const listAspsps = (principal: PrincipalContext, input: unknown) => {
  void principal
  return Effect.gen(function* () {
    const request = yield* decodeEnvelope<ListAspspsInput>(input)
    const country = yield* decodeCountry(request.country)
    const page = yield* decodePage(request.page)
    const directory = yield* AspspDirectory
    const result = yield* directory.listAspsps({ page, ...(country === undefined ? {} : { country }) }).pipe(
      Effect.flatMap(decodeListAspspsResult),
    )
    return {
      aspsps: result.aspsps.map(toAspsp),
      ...(result.nextPageToken === undefined ? {} : { nextPageToken: result.nextPageToken }),
    }
  })
}

export const startAuthorization = (principal: PrincipalContext, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* decodeEnvelope<StartAuthorizationInput>(input)
    const workspaceId = yield* decodeWorkspaceId(request.workspaceId)
    const aspspIdentity = yield* decodeAspspId(request.aspspId)
    const returnPath = yield* decodeReturnPath(request.returnPath)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    yield* requireWriteRole(authorized.role, authorized.workspaceId)
    const directory = yield* AspspDirectory
    const resolvedAspsp = yield* directory.resolveAspsp(aspspIdentity)
    if (resolvedAspsp === null) {
      return yield* Effect.fail(new BankNotFound({ resource: "aspsp", id: encodeAspspId(aspspIdentity) }))
    }
    const aspsp = yield* decodeProviderAspsp(resolvedAspsp)
    if (aspsp.name !== aspspIdentity.name || aspsp.country !== aspspIdentity.country) {
      return yield* Effect.fail(new BankNotFound({ resource: "aspsp", id: encodeAspspId(aspspIdentity) }))
    }
    const bank = yield* BankPort
    return yield* bank.startAuthorization({ workspaceId: authorized.workspaceId, principal, aspsp, returnPath })
  })

export const listConnections = (principal: PrincipalContext, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* decodeEnvelope<ListConnectionsInput>(input)
    const page = yield* decodePage(request.page)
    const workspaceId = yield* decodeWorkspaceId(request.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    const bank = yield* BankPort
    return yield* bank.listConnections({ workspaceId: authorized.workspaceId, page })
  })

export const getConnectionStatus = (principal: PrincipalContext, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* decodeEnvelope<GetConnectionStatusInput>(input)
    const connectionId = yield* decodeConnectionId(request.connectionId)
    const workspaceId = yield* decodeWorkspaceId(request.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    const bank = yield* BankPort
    return yield* bank.getConnectionStatus({ workspaceId: authorized.workspaceId, connectionId })
  })

export const queueSync = (principal: PrincipalContext, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* decodeEnvelope<QueueSyncInput>(input)
    const connectionId = yield* decodeConnectionId(request.connectionId)
    const since = yield* decodeSince(request.since)
    const idempotencyKey = yield* decodeIdempotencyKey(request.idempotencyKey)
    const workspaceId = yield* decodeWorkspaceId(request.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    yield* requireWriteRole(authorized.role, authorized.workspaceId)
    const bank = yield* BankPort
    return yield* bank.queueSync({
      workspaceId: authorized.workspaceId,
      connectionId,
      idempotencyKey,
      ...(since === undefined ? {} : { since }),
    })
  })

export const disconnect = (principal: PrincipalContext, input: unknown) =>
  Effect.gen(function* () {
    const request = yield* decodeEnvelope<DisconnectInput>(input)
    const connectionId = yield* decodeConnectionId(request.connectionId)
    const workspaceId = yield* decodeWorkspaceId(request.workspaceId)
    const access = yield* WorkspaceAccess
    const authorized = yield* access.authorize(principal, workspaceId)
    yield* requireWriteRole(authorized.role, authorized.workspaceId)
    yield* requireAal2(principal)
    const bank = yield* BankPort
    return yield* bank.disconnect({ workspaceId: authorized.workspaceId, connectionId, principal })
  })
