import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { Effect, Layer } from "effect"
import {
  BankAuthorizationGateway,
  BankConflict,
  BankNotFound,
  BankPort,
  BankUnavailable,
  ValidationFailed,
  encodeAspspId,
  type BankConnection,
  type BankConnectionStatus,
  type Job,
  type JobStatus,
  type WorkspaceId,
} from "@finch/lib"

export interface SupabaseBankConfig {
  readonly supabaseUrl: string
  readonly serviceRoleKey: string
  readonly pageTokenHmacKey: string
  readonly callbackUrl: string
}

type RecordValue = Record<string, unknown>
type BankPortService = typeof BankPort.Service

type ConnectionCursor = {
  readonly createdAt: string
  readonly id: string
}

type StoredConnection = {
  readonly connection: BankConnection
  readonly cursor: ConnectionCursor
  readonly dbStatus: string
}

type StoredJob = {
  readonly job: Job
  readonly payload: RecordValue | undefined
}

const CONNECTION_COLUMNS = "id,workspace_id,provider,aspsp_name,aspsp_country,status,last_synced_at,created_at"
const JOB_COLUMNS = "id,workspace_id,status,created_at,updated_at,safe_error_code,payload"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BASE64URL = /^[A-Za-z0-9_-]+$/

const CONNECTION_STATUSES: Readonly<Record<string, BankConnectionStatus>> = {
  authorization_pending: "pending",
  active: "active",
  expired: "expired",
  revocation_pending: "pending",
  revoked: "disconnected",
  error: "failed",
}

const JOB_STATUSES: Readonly<Record<string, JobStatus>> = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  retry: "queued",
  dead: "failed",
  cancelled: "cancelled",
}

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const exactKeys = (value: RecordValue, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const requiredString = (row: RecordValue, field: string) => {
  const value = row[field]
  if (typeof value !== "string") throw new Error(`invalid ${field}`)
  return value
}

const requiredUuid = (row: RecordValue, field: string) => {
  const value = requiredString(row, field)
  if (!UUID.test(value)) throw new Error(`invalid ${field}`)
  return value
}

const requiredTimestamp = (row: RecordValue, field: string) => {
  const value = requiredString(row, field)
  if (value.trim() === "" || Number.isNaN(Date.parse(value))) throw new Error(`invalid ${field}`)
  return value
}

const nullableTimestamp = (row: RecordValue, field: string) => {
  if (row[field] === null) return undefined
  return requiredTimestamp(row, field)
}

const nullableString = (row: RecordValue, field: string) => {
  if (row[field] === null) return undefined
  return requiredString(row, field)
}

const unavailable = () => new BankUnavailable()
const invalidPageToken = () => new ValidationFailed({ issues: ["pageToken is invalid"] })

const readConnection = (value: unknown, workspaceId: WorkspaceId): StoredConnection => {
  if (!isRecord(value)) throw new Error("invalid bank connection row")
  const id = requiredUuid(value, "id")
  if (requiredUuid(value, "workspace_id") !== workspaceId) throw new Error("bank connection workspace mismatch")
  if (requiredString(value, "provider") !== "enablebanking") throw new Error("invalid provider")
  const status = CONNECTION_STATUSES[requiredString(value, "status")]
  if (status === undefined) throw new Error("invalid bank connection status")
  const aspsp = {
    id: encodeAspspId({ country: requiredString(value, "aspsp_country"), name: requiredString(value, "aspsp_name") }),
    country: requiredString(value, "aspsp_country"),
    name: requiredString(value, "aspsp_name"),
  }
  const createdAt = requiredTimestamp(value, "created_at")
  const lastSyncedAt = nullableTimestamp(value, "last_synced_at")
  return {
    connection: {
      id,
      aspsp,
      status,
      ...(lastSyncedAt === undefined ? {} : { lastSyncedAt }),
    },
    cursor: { createdAt, id },
    dbStatus: requiredString(value, "status"),
  }
}

const readJob = (value: unknown, workspaceId: WorkspaceId): StoredJob => {
  if (!isRecord(value)) throw new Error("invalid job row")
  const status = JOB_STATUSES[requiredString(value, "status")]
  if (status === undefined) throw new Error("invalid job status")
  const safeErrorCode = nullableString(value, "safe_error_code")
  if (requiredUuid(value, "workspace_id") !== workspaceId) throw new Error("job workspace mismatch")
  return {
    job: {
      id: requiredUuid(value, "id"),
      workspaceId,
      status,
      createdAt: requiredTimestamp(value, "created_at"),
      updatedAt: requiredTimestamp(value, "updated_at"),
      ...(status === "failed" && safeErrorCode !== undefined ? { failureReason: safeErrorCode } : {}),
    },
    payload: isRecord(value["payload"]) ? value["payload"] : undefined,
  }
}

const matchesSyncPayload = (payload: RecordValue | undefined, connectionId: string, since: string | undefined) =>
  payload !== undefined &&
  exactKeys(payload, since === undefined ? ["connection_id"] : ["connection_id", "since"]) &&
  payload["connection_id"] === connectionId &&
  (since === undefined || payload["since"] === since)

const encodePageToken = (payload: RecordValue, key: string) => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", key).update(encoded).digest("base64url")
  return `${encoded}.${signature}`
}

const decodeConnectionCursor = (
  token: string | undefined,
  workspaceId: WorkspaceId,
  key: string,
): Effect.Effect<ConnectionCursor | undefined, ValidationFailed> => {
  if (token === undefined) return Effect.succeed(undefined)
  return Effect.try({
    try: () => {
      const [encoded, signature, ...rest] = token.split(".")
      if (
        rest.length !== 0 ||
        encoded === undefined ||
        signature === undefined ||
        !BASE64URL.test(encoded) ||
        !BASE64URL.test(signature)
      ) {
        throw new Error("invalid page token")
      }
      const expected = createHmac("sha256", key).update(encoded).digest("base64url")
      const actualBytes = Buffer.from(signature, "utf8")
      const expectedBytes = Buffer.from(expected, "utf8")
      if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
        throw new Error("invalid page token signature")
      }
      const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
      if (!isRecord(payload)) throw new Error("invalid page token payload")
      const order = payload["o"]
      if (
        !exactKeys(payload, ["v", "r", "w", "o"]) ||
        payload["v"] !== 1 ||
        payload["r"] !== "connections" ||
        payload["w"] !== workspaceId ||
        !isRecord(order) ||
        !exactKeys(order, ["createdAt", "id"]) ||
        typeof order["createdAt"] !== "string" ||
        order["createdAt"].trim() === "" ||
        Number.isNaN(Date.parse(order["createdAt"])) ||
        typeof order["id"] !== "string" ||
        !UUID.test(order["id"])
      ) {
        throw new Error("invalid page token payload")
      }
      return { createdAt: order["createdAt"], id: order["id"] }
    },
    catch: invalidPageToken,
  })
}

const isSafeReturnPath = (value: string) => {
  if (
    value === "" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false
  }
  try {
    return new URL(value, "https://finch.invalid").origin === "https://finch.invalid"
  } catch {
    return false
  }
}

const validateCallbackUrl = (value: string) => {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("unsafe callback URL")
  } catch {
    throw new Error("callbackUrl must be an HTTPS URL without credentials")
  }
}

const preserveListFailure = (cause: unknown): ValidationFailed | BankUnavailable =>
  cause instanceof ValidationFailed ? cause : unavailable()

const preserveReadFailure = (cause: unknown): BankNotFound | BankUnavailable =>
  cause instanceof BankNotFound || cause instanceof BankUnavailable ? cause : unavailable()

const preserveStartFailure = (cause: unknown): BankConflict | BankUnavailable =>
  cause instanceof BankConflict || cause instanceof BankUnavailable ? cause : unavailable()

const preservePortFailure = (cause: unknown): BankNotFound | BankConflict | BankUnavailable =>
  cause instanceof BankNotFound || cause instanceof BankConflict || cause instanceof BankUnavailable
    ? cause
    : unavailable()

export const makeSupabaseBankLayer = (
  config: SupabaseBankConfig,
): Layer.Layer<BankPort, never, BankAuthorizationGateway> => {
  if (config.pageTokenHmacKey.trim() === "") throw new Error("pageTokenHmacKey must not be blank")
  validateCallbackUrl(config.callbackUrl)

  const client = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  })

  const resolveActorId = async (principal: { readonly issuer: string; readonly subjectId: string }) => {
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
    connectionId: string,
    action: string,
    outcome: "success" | "failed",
    actorId?: string,
    safeErrorCode?: string,
  ) => {
    const { error } = await client.from("audit_events").insert({
      workspace_id: workspaceId,
      actor_id: actorId ?? null,
      action,
      resource_type: "bank_connection",
      resource_id: connectionId,
      outcome,
      ...(safeErrorCode === undefined ? {} : { safe_error_code: safeErrorCode }),
    })
    if (error !== null) throw unavailable()
  }

  const findConnection = async (workspaceId: WorkspaceId, connectionId: string) => {
    const { data, error } = await client
      .from("bank_connections")
      .select(CONNECTION_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("id", connectionId)
      .maybeSingle()
    if (error !== null) throw unavailable()
    if (data === null) throw new BankNotFound({ resource: "connection", id: connectionId })
    return readConnection(data, workspaceId)
  }

  return Layer.effect(
    BankPort,
    Effect.gen(function* () {
      const gateway = yield* BankAuthorizationGateway

      const bank: BankPortService = {
        listConnections: (input) =>
          Effect.gen(function* () {
            const cursor = yield* decodeConnectionCursor(input.page.pageToken, input.workspaceId, config.pageTokenHmacKey)
            const base = client
              .from("bank_connections")
              .select(CONNECTION_COLUMNS)
              .eq("workspace_id", input.workspaceId)
              .order("created_at", { ascending: false })
              .order("id", { ascending: false })
            const { data, error } = cursor === undefined
              ? yield* Effect.tryPromise({ try: () => base.limit(input.page.pageSize + 1), catch: unavailable })
              : yield* Effect.tryPromise({
                try: () => base
                  .or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)
                  .limit(input.page.pageSize + 1),
                catch: unavailable,
              })
            if (error !== null || !Array.isArray(data)) return yield* Effect.fail(unavailable())
            const rows = yield* Effect.try({
              try: () => data.map((row) => readConnection(row, input.workspaceId)),
              catch: unavailable,
            })
            const page = rows.slice(0, input.page.pageSize)
            const last = page.at(-1)
            return {
              connections: page.map((row) => row.connection),
              ...(rows.length > input.page.pageSize && last !== undefined
                ? { nextPageToken: encodePageToken({ v: 1, r: "connections", w: input.workspaceId, o: last.cursor }, config.pageTokenHmacKey) }
                : {}),
            }
          }).pipe(Effect.catchAll((cause) => Effect.fail(preserveListFailure(cause)))),

        getConnectionStatus: (input) =>
          Effect.tryPromise({
            try: async () => (await findConnection(input.workspaceId, input.connectionId)).connection,
            catch: preserveReadFailure,
          }),

        startAuthorization: (input) =>
          Effect.tryPromise({
            try: async () => {
              if (!isSafeReturnPath(input.returnPath)) throw new BankConflict({ reason: "invalid return path" })
              const actorId = await resolveActorId(input.principal)
              const { data, error } = await client
                .from("bank_connections")
                .insert({
                  workspace_id: input.workspaceId,
                  provider: "enablebanking",
                  aspsp_name: input.aspsp.name,
                  aspsp_country: input.aspsp.country,
                  status: "authorization_pending",
                  created_by: actorId,
                })
                .select(CONNECTION_COLUMNS)
                .single()
              if (error !== null || data === null) throw unavailable()
              const stored = readConnection(data, input.workspaceId)
              const state = randomBytes(32).toString("base64url")
              const { error: authorizationError } = await client.from("bank_authorizations").insert({
                workspace_id: input.workspaceId,
                connection_id: stored.connection.id,
                user_id: actorId,
                state_hash: `\\x${createHash("sha256").update(state).digest("hex")}`,
                return_path: input.returnPath,
                expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              })
              if (authorizationError !== null) {
                const { error: updateError } = await client
                  .from("bank_connections")
                  .update({ status: "error" })
                  .eq("workspace_id", input.workspaceId)
                  .eq("id", stored.connection.id)
                if (updateError !== null) throw unavailable()
                await audit(input.workspaceId, stored.connection.id, "bank.authorization.failed", "failed", actorId, "bank_authorization_failed")
                throw unavailable()
              }

              let authorizationUrl: string
              try {
                const authorization = await Effect.runPromise(gateway.startAuthorization({
                  aspsp: input.aspsp,
                  state,
                  redirectUrl: config.callbackUrl,
                }))
                if (typeof authorization.url !== "string" || authorization.url.trim() === "") throw new Error("invalid authorization URL")
                authorizationUrl = authorization.url
              } catch {
                const { error: updateError } = await client
                  .from("bank_connections")
                  .update({ status: "error" })
                  .eq("workspace_id", input.workspaceId)
                  .eq("id", stored.connection.id)
                if (updateError !== null) throw unavailable()
                await audit(input.workspaceId, stored.connection.id, "bank.authorization.failed", "failed", actorId, "bank_authorization_failed")
                throw unavailable()
              }

              await audit(input.workspaceId, stored.connection.id, "bank.authorization.started", "success", actorId)
              return { authorizationUrl, connection: stored.connection }
            },
            catch: preserveStartFailure,
          }),

        queueSync: (input) =>
          Effect.tryPromise({
            try: async () => {
              const { data: connection, error: connectionError } = await client
                .from("bank_connections")
                .select(CONNECTION_COLUMNS)
                .eq("workspace_id", input.workspaceId)
                .eq("id", input.connectionId)
                .eq("status", "active")
                .maybeSingle()
              if (connectionError !== null) throw unavailable()
              if (connection === null || readConnection(connection, input.workspaceId).connection.status !== "active") {
                throw new BankConflict({ reason: "connection is not active" })
              }
              const since = input.since?.toISOString().slice(0, 10)
              const { data: jobId, error: enqueueError } = await client.rpc("enqueue_finch_job", {
                p_workspace_id: input.workspaceId,
                p_kind: "bank.sync",
                p_payload: {
                  connection_id: input.connectionId,
                  ...(since === undefined ? {} : { since }),
                },
                p_idempotency_key: createHash("sha256").update(input.idempotencyKey).digest("hex"),
              })
              if (enqueueError !== null || typeof jobId !== "string" || !UUID.test(jobId)) throw unavailable()
              const { data: job, error: jobError } = await client
                .from("job_requests")
                .select(JOB_COLUMNS)
                .eq("workspace_id", input.workspaceId)
                .eq("id", jobId)
                .maybeSingle()
              if (jobError !== null || job === null) throw unavailable()
              const storedJob = readJob(job, input.workspaceId)
              if (!matchesSyncPayload(storedJob.payload, input.connectionId, since)) {
                throw new BankConflict({ reason: "idempotency key is already used for another sync" })
              }
              return storedJob.job
            },
            catch: preservePortFailure,
          }),

        disconnect: (input) =>
          Effect.tryPromise({
            try: async () => {
              const stored = await findConnection(input.workspaceId, input.connectionId)
              if (stored.dbStatus === "revoked") {
                return { disconnected: true, status: "disconnected" }
              }
              const actorId = await resolveActorId(input.principal)
              if (
                stored.dbStatus !== "active" &&
                stored.dbStatus !== "expired" &&
                stored.dbStatus !== "error" &&
                stored.dbStatus !== "revocation_pending"
              ) {
                throw new BankConflict({ reason: "connection is not revocable" })
              }

              if (stored.dbStatus !== "revocation_pending") {
                const { error: invalidationError } = await client
                  .from("bank_authorizations")
                  .update({ used_at: new Date().toISOString() })
                  .eq("workspace_id", input.workspaceId)
                  .eq("connection_id", input.connectionId)
                  .is("used_at", null)
                if (invalidationError !== null) throw unavailable()

                const { data: transitioned, error: transitionError } = await client
                  .from("bank_connections")
                  .update({ status: "revocation_pending" })
                  .eq("workspace_id", input.workspaceId)
                  .eq("id", input.connectionId)
                  .eq("status", stored.dbStatus)
                  .select(CONNECTION_COLUMNS)
                  .maybeSingle()
                if (transitionError !== null) throw unavailable()
                if (transitioned === null || readConnection(transitioned, input.workspaceId).dbStatus !== "revocation_pending") {
                  throw new BankConflict({ reason: "connection is not revocable" })
                }
              }

              const { data: secretRow, error: secretRowError } = await client
                .from("bank_connections")
                .select("vault_secret_id")
                .eq("workspace_id", input.workspaceId)
                .eq("id", input.connectionId)
                .eq("status", "revocation_pending")
                .maybeSingle()
              if (secretRowError !== null || !isRecord(secretRow)) throw unavailable()
              if (secretRow["vault_secret_id"] !== null) {
                const { data: session, error: sessionError } = await client.rpc("read_bank_connection_secret", {
                  p_connection_id: input.connectionId,
                })
                if (sessionError !== null || typeof session !== "string" || session.trim() === "") throw unavailable()
                const deleteExit = await Effect.runPromiseExit(gateway.deleteSession(session))
                if (deleteExit._tag === "Failure") {
                  await audit(input.workspaceId, input.connectionId, "bank.connection.disconnected", "failed", actorId, "bank_revocation_pending")
                  return { disconnected: false, status: "pending" }
                }
              }

              const { data: completed, error: completionError } = await client.rpc("complete_bank_disconnect", {
                p_workspace_id: input.workspaceId,
                p_connection_id: input.connectionId,
                p_actor_id: actorId,
              })
              if (completionError !== null || completed !== true) throw unavailable()
              return { disconnected: true, status: "disconnected" }
            },
            catch: preservePortFailure,
          }),
      }

      return bank
    }),
  )
}
