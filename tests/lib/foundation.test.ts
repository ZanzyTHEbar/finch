import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceId,
  type PrincipalContext,
  type RequestContext,
} from "../../packages/lib/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const context: RequestContext = {
  principal: {
    issuer: "https://id.example.test",
    subjectId: "subject-1",
    assurance: "aal2",
    authenticatedAt: new Date("2026-09-10T00:00:00Z"),
  },
  requestId: "request-1",
}

describe("lib foundation", () => {
  it("brands UUID workspace ids without changing tenant ids", () => {
    expect(workspaceId).toBe("aaaaaaaa-0000-4000-8000-000000000001")
    expect(() => Schema.decodeUnknownSync(WorkspaceId)("")).toThrow()
    expect(() => Schema.decodeUnknownSync(WorkspaceId)("workspace-1")).toThrow()
  })

  it("keeps the trusted principal separate from the requested workspace", async () => {
    let received: readonly [PrincipalContext, WorkspaceId] | undefined
    const authorize: WorkspaceAccess["authorize"] = (principal, requestedWorkspace) =>
      Effect.sync(() => {
        received = [principal, requestedWorkspace]
        return { workspaceId: requestedWorkspace, role: "owner" as const }
      })

    await expect(Effect.runPromise(authorize(context.principal, workspaceId))).resolves.toEqual({
      workspaceId,
      role: "owner",
    })
    expect(received).toEqual([context.principal, workspaceId])
    expect(WorkspaceAccess.key).toBe("WorkspaceAccess")
  })

  it("uses a safe typed error for denied workspace access", () => {
    const error = new WorkspaceAccessDenied({ workspaceId })
    expect(error).toMatchObject({ _tag: "WorkspaceAccessDenied", workspaceId })
  })
})
