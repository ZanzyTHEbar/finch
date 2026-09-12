import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  SearchPort,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceId,
  searchFinance,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const principal: PrincipalContext = {
  issuer: "https://id.example.test",
  subjectId: "subject-1",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

const useCase = (
  workspaceAccess: WorkspaceAccess,
  searchPort: SearchPort,
  input: Parameters<typeof searchFinance>[1],
)
: ReturnType<typeof searchFinance> =>
  searchFinance(principal, input).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(WorkspaceAccess, workspaceAccess),
        Layer.succeed(SearchPort, searchPort),
      ),
    ),
  )

const run = (...args: Parameters<typeof useCase>) => Effect.runPromise(useCase(...args))

describe("searchFinance", () => {
  it("decodes the requested workspace and authorizes it before searching", async () => {
    const calls: string[] = []
    const workspaceAccess: WorkspaceAccess = {
      authorize: (receivedPrincipal, requestedWorkspace) =>
        Effect.sync(() => {
          calls.push("authorize")
          expect(receivedPrincipal).toBe(principal)
          expect(requestedWorkspace).toBe(workspaceId)
          return { workspaceId: requestedWorkspace, role: "member" as const }
        }),
    }
    const searchPort: SearchPort = {
      search: (input) =>
        Effect.sync(() => {
          expect(calls).toEqual(["authorize"])
          calls.push("search")
          expect(input).toMatchObject({ workspaceId, query: "groceries", topK: 5 })
          return {
            hits: [],
            diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 },
          }
        }),
    }

    await expect(run(workspaceAccess, searchPort, { workspaceId, query: "groceries", topK: 5 })).resolves.toMatchObject({
      diagnostics: { fusedCandidates: 0 },
    })
    expect(calls).toEqual(["authorize", "search"])
  })

  it("uses 10/5 defaults and permits their capped product", async () => {
    const limits: Array<{ topK: number | undefined; candidateMultiplier: number | undefined }> = []
    const searchPort: SearchPort = {
      search: (input) =>
        Effect.sync(() => {
          limits.push({ topK: input.topK, candidateMultiplier: input.candidateMultiplier })
          return { hits: [], diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 } }
        }),
    }
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) => Effect.succeed({ workspaceId: requestedWorkspace, role: "member" }),
    }

    await expect(run(workspaceAccess, searchPort, { workspaceId, query: "groceries" })).resolves.toBeDefined()
    await expect(
      run(workspaceAccess, searchPort, { workspaceId, query: "groceries", topK: 100, candidateMultiplier: 10 }),
    ).resolves.toBeDefined()
    expect(limits).toEqual([
      { topK: 10, candidateMultiplier: 5 },
      { topK: 100, candidateMultiplier: 10 },
    ])
  })

  it("rejects oversized limits before authorization or the search port", async () => {
    let authorizations = 0
    let searches = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: () =>
        Effect.sync(() => {
          authorizations += 1
          return { workspaceId, role: "member" as const }
        }),
    }
    const searchPort: SearchPort = {
      search: () =>
        Effect.sync(() => {
          searches += 1
          return { hits: [], diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 } }
        }),
    }

    for (const input of [
      { workspaceId, query: "groceries", topK: 101 },
      { workspaceId, query: "groceries", candidateMultiplier: 11 },
      { workspaceId, query: "groceries", topK: Number.POSITIVE_INFINITY },
    ]) {
      const exit = await Effect.runPromiseExit(useCase(workspaceAccess, searchPort, input))
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } } })
    }
    expect(authorizations).toBe(0)
    expect(searches).toBe(0)
  })

  it("rejects an invalid workspace scope before authorization", async () => {
    let authorizations = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: () =>
        Effect.sync(() => {
          authorizations += 1
          return { workspaceId, role: "member" as const }
        }),
    }
    const searchPort: SearchPort = {
      search: () => Effect.die("search must not run"),
    }

    const exit = await Effect.runPromiseExit(
      useCase(workspaceAccess, searchPort, { workspaceId: "not-a-uuid", query: "groceries" }),
    )
    expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } } })
    expect(authorizations).toBe(0)
  })

  it("does not call the search port when workspace access is denied", async () => {
    let searches = 0
    const workspaceAccess: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) =>
        Effect.fail(new WorkspaceAccessDenied({ workspaceId: requestedWorkspace })),
    }
    const searchPort: SearchPort = {
      search: () =>
        Effect.sync(() => {
          searches += 1
          return { hits: [], diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 } }
        }),
    }

    const exit = await Effect.runPromiseExit(useCase(workspaceAccess, searchPort, { workspaceId, query: "groceries" }))
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail", error: { _tag: "WorkspaceAccessDenied", workspaceId } },
    })
    expect(searches).toBe(0)
  })
})
