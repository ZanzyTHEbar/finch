import { createHash, randomBytes } from "node:crypto"
import { Schema } from "effect"
import { TenantId } from "../tenant.ts"
import { UtcInstant } from "../time.ts"
import { encodeJson } from "./codec.ts"

export const AggregateType = Schema.Literal(
  "account",
  "transaction",
  "receipt",
  "reconciliation",
  "summary",
)

export type AggregateType = Schema.Schema.Type<typeof AggregateType>

export const EventMetadata = Schema.Struct({
  actor: Schema.String,
  causationId: Schema.optional(Schema.String),
  correlationId: Schema.optional(Schema.String),
  occurredAt: UtcInstant,
  recordedAt: UtcInstant,
})

export type EventMetadata = Schema.Schema.Type<typeof EventMetadata>

export const EventEnvelope = Schema.Struct({
  id: Schema.String,
  tenantId: TenantId,
  aggregateType: AggregateType,
  aggregateId: Schema.String,
  sequence: Schema.Number,
  eventType: Schema.String,
  eventVersion: Schema.Number,
  payload: Schema.Unknown,
  metadata: EventMetadata,
  idempotencyKey: Schema.String,
})

export type EventEnvelope = Schema.Schema.Type<typeof EventEnvelope>

// UUIDv7 per RFC 9562: 48-bit unix-ms timestamp (big-endian) + rand_a with
// version nibble 7 + rand_b with variant bits 10.
export const uuidv7 = (): string => {
  const bytes = new Uint8Array(16)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const now = Date.now()
  view.setUint16(0, Math.floor(now / 2 ** 32))
  view.setUint32(2, now >>> 0)
  bytes.set(randomBytes(10), 6)
  view.setUint16(6, (view.getUint16(6) & 0x0fff) | 0x7000)
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80)
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface MakeEnvelopeInput {
  readonly tenantId: Schema.Schema.Type<typeof TenantId>
  readonly aggregateType: Schema.Schema.Type<typeof AggregateType>
  readonly aggregateId: string
  readonly sequence: number
  readonly eventType: string
  readonly eventVersion: number
  readonly payload: unknown
  readonly metadata: Schema.Schema.Type<typeof EventMetadata>
  readonly id?: string
  readonly idempotencyKey?: string
}

export interface DefaultIdempotencyKeyInput {
  readonly tenantId: string
  readonly aggregateType: string
  readonly aggregateId: string
  readonly eventType: string
  readonly eventVersion: number
  readonly payload: unknown
}

// ponytail: key covers the canonical append identity only (no sequence,
// timestamps, or actor) so a retry computing a new sequence still hashes
// identically and hits the idempotency unique constraint.
export const defaultIdempotencyKey = (input: DefaultIdempotencyKeyInput): string =>
  createHash("sha256")
    .update(
      encodeJson({
        tenantId: input.tenantId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        eventVersion: input.eventVersion,
        payload: input.payload,
      }),
    )
    .digest("hex")

export const makeEnvelope = (input: MakeEnvelopeInput): EventEnvelope =>
  Schema.decodeUnknownSync(EventEnvelope)({
    id: input.id ?? uuidv7(),
    tenantId: input.tenantId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: input.sequence,
    eventType: input.eventType,
    eventVersion: input.eventVersion,
    payload: input.payload,
    metadata: input.metadata,
    idempotencyKey:
      input.idempotencyKey ??
      defaultIdempotencyKey({
        tenantId: input.tenantId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        eventVersion: input.eventVersion,
        payload: input.payload,
      }),
  })
