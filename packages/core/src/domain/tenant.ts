import { Schema } from "effect"

export const TenantId = Schema.NonEmptyString.pipe(Schema.brand("TenantId"))

export type TenantId = Schema.Schema.Type<typeof TenantId>

export const WorkspaceId = Schema.UUID.pipe(Schema.brand("WorkspaceId"))

export type WorkspaceId = Schema.Schema.Type<typeof WorkspaceId>
