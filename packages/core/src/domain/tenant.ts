import { Schema } from "effect"

export const TenantId = Schema.NonEmptyString.pipe(Schema.brand("TenantId"))

export type TenantId = Schema.Schema.Type<typeof TenantId>
