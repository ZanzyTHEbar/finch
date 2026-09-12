import { Context, Data, type Effect } from "effect"
import type { WorkspaceId } from "@finch/core/domain"

export interface PrincipalContext {
  readonly issuer: string
  readonly subjectId: string
  readonly assurance: "aal1" | "aal2"
  readonly authenticatedAt: Date
}

export interface RequestContext {
  readonly principal: PrincipalContext
  readonly requestId: string
}

export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  readonly message: string
}> {}

export class WorkspaceAccessDenied extends Data.TaggedError("WorkspaceAccessDenied")<{
  readonly workspaceId: WorkspaceId
}> {}

export class WorkspaceAccessUnavailable extends Data.TaggedError("WorkspaceAccessUnavailable")<Record<never, never>> {}

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer"

export interface AuthorizedWorkspace {
  readonly workspaceId: WorkspaceId
  readonly role: WorkspaceRole
}

export class WorkspaceAccess extends Context.Tag("WorkspaceAccess")<
  WorkspaceAccess,
  {
    readonly authorize: (
      principal: PrincipalContext,
      requestedWorkspace: WorkspaceId,
    ) => Effect.Effect<AuthorizedWorkspace, WorkspaceAccessDenied | WorkspaceAccessUnavailable>
  }
>() {}
