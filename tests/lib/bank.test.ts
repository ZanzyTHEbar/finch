import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  AspspDirectory,
  BankAssuranceRequired,
  BankPort,
  BankWriteDenied,
  WorkspaceAccess,
  WorkspaceId,
  decodeAspspId,
  encodeAspspId,
  disconnect,
  getConnectionStatus,
  listAspsps,
  listConnections,
  queueSync,
  startAuthorization,
  type BankConnection,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const connectionId = "bbbbbbbb-0000-4000-8000-000000000002"
const principal: PrincipalContext = {
  issuer: "https://id.example.test",
  subjectId: "subject-1",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}
const providerAspsp = { name: "Demo Bank", country: "PT", logoUrl: "https://banks.example.test/demo.svg" }
const connection: BankConnection = {
  id: connectionId,
  aspsp: { id: "enablebanking:v1:WyJQVCIsIkRlbW8gQmFuayJd", name: "Demo Bank", country: "PT" },
  status: "pending",
}

const unusedDirectory = (): AspspDirectory => ({
  listAspsps: () => Effect.die("not used"),
  resolveAspsp: () => Effect.die("not used"),
})

const unusedBank = (): BankPort => ({
  startAuthorization: () => Effect.die("not used"),
  listConnections: () => Effect.die("not used"),
  getConnectionStatus: () => Effect.die("not used"),
  queueSync: () => Effect.die("not used"),
  disconnect: () => Effect.die("not used"),
})

const accessFor = (role: "owner" | "admin" | "member" | "viewer"): WorkspaceAccess => ({
  authorize: (_principal, requestedWorkspace) => Effect.succeed({ workspaceId: requestedWorkspace, role }),
})

const bankLayer = (access: WorkspaceAccess, directory: AspspDirectory, bank: BankPort) =>
  Layer.mergeAll(
    Layer.succeed(WorkspaceAccess, access),
    Layer.succeed(AspspDirectory, directory),
    Layer.succeed(BankPort, bank),
  )

describe("bank use cases", () => {
  it("creates canonical synthetic ASPSP IDs and rejects malformed or forged IDs", async () => {
    let listed = 0
    const directory: AspspDirectory = {
      ...unusedDirectory(),
      listAspsps: () =>
        Effect.sync(() => {
          listed += 1
          return { aspsps: [{ ...providerAspsp, name: " Demo Bank ", country: "pt" }] }
        }),
    }

    const result = await Effect.runPromise(listAspsps(principal, {}).pipe(Effect.provide(Layer.succeed(AspspDirectory, directory))))
    expect(result.aspsps).toEqual([{ ...connection.aspsp, logoUrl: providerAspsp.logoUrl }])
    expect(listed).toBe(1)

    await expect(Effect.runPromise(decodeAspspId(connection.aspsp.id))).resolves.toEqual({ country: "PT", name: "Demo Bank" })
    for (const id of [
      "enablebanking:v1:WyJwdCIsIkRlbW8gQmFuayJd",
      "enablebanking:v1:WyJQVCIsIkRlbW8gQmFuayJd=",
      "enablebanking:v1:WyJQVCIsIkRlbW8gQmFuayJd!",
      "enablebanking:v1:bm90LWpzb24",
      "enablebanking:v1:WyJQVCIsIkEiXR",
      "enablebanking:v2:WyJQVCIsIkRlbW8gQmFuayJd",
    ]) {
      const exit = await Effect.runPromiseExit(decodeAspspId(id))
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } } })
    }
  })

  it("fails closed when encoding noncanonical ASPSP identities", () => {
    expect(encodeAspspId({ country: "PT", name: "Demo Bank" })).toBe(connection.aspsp.id)
    for (const identity of [
      { country: "pt", name: "Demo Bank" },
      { country: "PT", name: " Demo Bank " },
      { country: "PT", name: "Demo\u0000Bank" },
      { country: "PRT", name: "Demo Bank" },
      null,
    ]) {
      expect(() => encodeAspspId(identity)).toThrow("invalid ASPSP ID identity")
    }
  })

  it("fails safely for malformed directory and resolution ASPSPs", async () => {
    const malformedDirectory: AspspDirectory = {
      ...unusedDirectory(),
      listAspsps: () => Effect.succeed({ aspsps: [{ name: undefined, country: "PT" }] as never }),
    }

    const listExit = await Effect.runPromiseExit(
      listAspsps(principal, {}).pipe(Effect.provide(Layer.succeed(AspspDirectory, malformedDirectory))),
    )
    expect(listExit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "BankUnavailable" } } })

    let startCalls = 0
    const resolutionDirectory: AspspDirectory = {
      ...unusedDirectory(),
      resolveAspsp: () => Effect.succeed({ ...providerAspsp, logoUrl: 1 } as never),
    }
    const bank: BankPort = {
      ...unusedBank(),
      startAuthorization: () =>
        Effect.sync(() => {
          startCalls += 1
          return { authorizationUrl: "unused", connection }
        }),
    }

    const startExit = await Effect.runPromiseExit(
      startAuthorization(principal, {
        workspaceId,
        aspspId: connection.aspsp.id,
        returnPath: "/bank/complete",
      }).pipe(Effect.provide(bankLayer(accessFor("owner"), resolutionDirectory, bank))),
    )
    expect(startExit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "BankUnavailable" } } })
    expect(startCalls).toBe(0)
  })

  it("does not expose insecure or credentialed provider logo URLs", async () => {
    for (const logoUrl of ["http://banks.example.test/demo.svg", "https://client:secret@banks.example.test/demo.svg"]) {
      const directory: AspspDirectory = {
        ...unusedDirectory(),
        listAspsps: () => Effect.succeed({ aspsps: [{ ...providerAspsp, logoUrl }] }),
      }
      const exit = await Effect.runPromiseExit(
        listAspsps(principal, {}).pipe(Effect.provide(Layer.succeed(AspspDirectory, directory))),
      )
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "BankUnavailable" } } })
    }
  })

  it("uses only the directory for normalized ASPSP lists", async () => {
    const received: unknown[] = []
    const directory: AspspDirectory = {
      ...unusedDirectory(),
      listAspsps: (input) =>
        Effect.sync(() => {
          received.push(input)
          return { aspsps: [], nextPageToken: "next" }
        }),
    }

    await expect(
      Effect.runPromise(
        listAspsps(principal, { country: "pt", page: { pageSize: 0, pageToken: "" } }).pipe(
          Effect.provide(Layer.succeed(AspspDirectory, directory)),
        ),
      ),
    ).resolves.toEqual({ aspsps: [], nextPageToken: "next" })
    const exit = await Effect.runPromiseExit(
      listAspsps(principal, { country: "pt", page: { pageSize: 101, pageToken: "cursor" } }).pipe(
        Effect.provide(Layer.succeed(AspspDirectory, directory)),
      ),
    )
    expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } } })
    expect(received).toEqual([{ country: "PT", page: { pageSize: 50 } }])
  })

  it("rejects invalid list filters and pages before calling the directory", async () => {
    let calls = 0
    const directory: AspspDirectory = {
      ...unusedDirectory(),
      listAspsps: () =>
        Effect.sync(() => {
          calls += 1
          return { aspsps: [] }
        }),
    }

    for (const input of [
      { country: "PRT" },
      { country: "P1" },
      { page: { pageSize: -1 } },
      { page: { pageSize: 101 } },
      { page: { pageToken: 1 } },
    ]) {
      const exit = await Effect.runPromiseExit(
        listAspsps(principal, input).pipe(Effect.provide(Layer.succeed(AspspDirectory, directory))),
      )
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } } })
    }
    expect(calls).toBe(0)
  })

  it("rejects non-object use-case envelopes before dependencies", async () => {
    let directoryCalls = 0
    let accessCalls = 0
    let bankCalls = 0
    const directory: AspspDirectory = {
      listAspsps: () =>
        Effect.sync(() => {
          directoryCalls += 1
          return { aspsps: [] }
        }),
      resolveAspsp: () =>
        Effect.sync(() => {
          directoryCalls += 1
          return null
        }),
    }
    const access: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) =>
        Effect.sync(() => {
          accessCalls += 1
          return { workspaceId: requestedWorkspace, role: "owner" as const }
        }),
    }
    const bank: BankPort = {
      startAuthorization: () =>
        Effect.sync(() => {
          bankCalls += 1
          return { authorizationUrl: "unused", connection }
        }),
      listConnections: () =>
        Effect.sync(() => {
          bankCalls += 1
          return { connections: [] }
        }),
      getConnectionStatus: () =>
        Effect.sync(() => {
          bankCalls += 1
          return connection
        }),
      queueSync: () =>
        Effect.sync(() => {
          bankCalls += 1
          return { id: "job-1", workspaceId, status: "queued" as const, createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z" }
        }),
      disconnect: () =>
        Effect.sync(() => {
          bankCalls += 1
          return { disconnected: true, status: "pending" as const }
        }),
    }
    const layer = bankLayer(access, directory, bank)

    for (const input of [undefined, null, [], 1, "input", true, new Date(), new Map()]) {
      for (const program of [
        listAspsps(principal, input),
        startAuthorization(principal, input),
        listConnections(principal, input),
        getConnectionStatus(principal, input),
        queueSync(principal, input),
        disconnect(principal, input),
      ]) {
        const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)))
        expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } } })
      }
    }
    expect(directoryCalls).toBe(0)
    expect(accessCalls).toBe(0)
    expect(bankCalls).toBe(0)
  })

  it("authorizes an owner, resolves the exact current ASPSP, and starts authorization", async () => {
    const calls: string[] = []
    const directory: AspspDirectory = {
      ...unusedDirectory(),
      resolveAspsp: (identity) =>
        Effect.sync(() => {
          calls.push("resolve")
          expect(identity).toEqual({ country: "PT", name: "Demo Bank" })
          return { ...providerAspsp, name: " Demo Bank ", country: "pt" }
        }),
    }
    const bank: BankPort = {
      ...unusedBank(),
      startAuthorization: (input) =>
        Effect.sync(() => {
          calls.push("start")
          expect(input).toEqual({
            workspaceId,
            principal,
            aspsp: providerAspsp,
            returnPath: "/bank/complete?source=enablebanking",
          })
          return { authorizationUrl: "https://provider.example.test/authorize", connection }
        }),
    }

    await expect(
      Effect.runPromise(
        startAuthorization(principal, {
          workspaceId,
          aspspId: connection.aspsp.id,
          returnPath: "/bank/complete?source=enablebanking",
        }).pipe(Effect.provide(bankLayer(accessFor("owner"), directory, bank))),
      ),
    ).resolves.toEqual({ authorizationUrl: "https://provider.example.test/authorize", connection })
    expect(calls).toEqual(["resolve", "start"])
  })

  it("rejects unsafe authorization return paths before directory or bank work", async () => {
    let directoryCalls = 0
    let bankCalls = 0
    const directory: AspspDirectory = {
      ...unusedDirectory(),
      resolveAspsp: () =>
        Effect.sync(() => {
          directoryCalls += 1
          return providerAspsp
        }),
    }
    const bank: BankPort = {
      ...unusedBank(),
      startAuthorization: () =>
        Effect.sync(() => {
          bankCalls += 1
          return { authorizationUrl: "unused", connection }
        }),
    }

    for (const returnPath of ["", "bank/complete", "https://attacker.example.test", "//attacker.example.test", "/\\attacker.example.test", "/bank\u0000complete"]) {
      const exit = await Effect.runPromiseExit(
        startAuthorization(principal, { workspaceId, aspspId: connection.aspsp.id, returnPath }).pipe(
          Effect.provide(bankLayer(accessFor("owner"), directory, bank)),
        ),
      )
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } } })
    }
    expect(directoryCalls).toBe(0)
    expect(bankCalls).toBe(0)
  })

  it("allows every authorized role to read connections", async () => {
    const bank: BankPort = {
      ...unusedBank(),
      listConnections: (input) =>
        Effect.sync(() => {
          expect(input).toEqual({ workspaceId, page: { pageSize: 100, pageToken: "cursor" } })
          return { connections: [connection] }
        }),
      getConnectionStatus: (input) =>
        Effect.sync(() => {
          expect(input).toEqual({ workspaceId, connectionId })
          return connection
        }),
    }

    for (const role of ["owner", "admin", "member", "viewer"] as const) {
      await expect(
        Effect.runPromise(
          listConnections(principal, { workspaceId, page: { pageSize: 100, pageToken: "cursor" } }).pipe(
            Effect.provide(bankLayer(accessFor(role), unusedDirectory(), bank)),
          ),
        ),
      ).resolves.toEqual({ connections: [connection] })
      await expect(
        Effect.runPromise(
          getConnectionStatus(principal, { workspaceId, connectionId }).pipe(
            Effect.provide(bankLayer(accessFor(role), unusedDirectory(), bank)),
          ),
        ),
      ).resolves.toEqual(connection)
    }
  })

  it("allows only owners and admins to queue sync", async () => {
    for (const role of ["owner", "admin", "member", "viewer"] as const) {
      let calls = 0
      const bank: BankPort = {
        ...unusedBank(),
        queueSync: () =>
          Effect.sync(() => {
            calls += 1
            return { id: "job-1", workspaceId, status: "queued", createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z" }
          }),
      }
      const exit = await Effect.runPromiseExit(
        queueSync(principal, { workspaceId, connectionId, idempotencyKey: "k" }).pipe(
          Effect.provide(bankLayer(accessFor(role), unusedDirectory(), bank)),
        ),
      )

      if (role === "owner" || role === "admin") {
        expect(exit).toMatchObject({ _tag: "Success" })
        expect(calls).toBe(1)
      } else {
        expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "BankWriteDenied" } } })
        expect(calls).toBe(0)
      }
    }
  })

  it("normalizes valid sync timestamps and rejects invalid queue input before access or bank work", async () => {
    let authorizations = 0
    let calls = 0
    const access: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) =>
        Effect.sync(() => {
          authorizations += 1
          return { workspaceId: requestedWorkspace, role: "owner" as const }
        }),
    }
    const bank: BankPort = {
      ...unusedBank(),
      queueSync: (input) =>
        Effect.sync(() => {
          calls += 1
          expect(input.since?.toISOString()).toBe("2026-09-10T11:34:56.000Z")
          expect(input.idempotencyKey).toHaveLength(200)
          return { id: "job-1", workspaceId, status: "queued", createdAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z" }
        }),
    }
    const layer = bankLayer(access, unusedDirectory(), bank)

    await expect(
      Effect.runPromise(
        queueSync(principal, {
          workspaceId,
          connectionId,
          since: "2026-09-10T12:34:56+01:00",
          idempotencyKey: "k".repeat(200),
        }).pipe(Effect.provide(layer)),
      ),
    ).resolves.toMatchObject({ status: "queued" })

    for (const input of [
      { workspaceId: "not-a-uuid", connectionId, idempotencyKey: "k" },
      { workspaceId, connectionId: "not-a-uuid", idempotencyKey: "k" },
      { workspaceId, connectionId, since: "2026-02-29T00:00:00Z", idempotencyKey: "k" },
      { workspaceId, connectionId, since: "2026-09-10", idempotencyKey: "k" },
      { workspaceId, connectionId, idempotencyKey: "" },
      { workspaceId, connectionId, idempotencyKey: "   " },
      { workspaceId, connectionId, idempotencyKey: "k".repeat(201) },
    ]) {
      const exit = await Effect.runPromiseExit(queueSync(principal, input).pipe(Effect.provide(layer)))
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } } })
    }
    expect(authorizations).toBe(1)
    expect(calls).toBe(1)
  })

  it("requires AAL2 and an owner or admin before disconnecting", async () => {
    let calls = 0
    const bank: BankPort = {
      ...unusedBank(),
      disconnect: () =>
        Effect.sync(() => {
          calls += 1
          return { disconnected: true, status: "pending" }
        }),
    }
    const aal1 = { ...principal, assurance: "aal1" as const }
    const layer = bankLayer(accessFor("owner"), unusedDirectory(), bank)

    const assuranceExit = await Effect.runPromiseExit(
      disconnect(aal1, { workspaceId, connectionId }).pipe(Effect.provide(layer)),
    )
    expect(assuranceExit).toMatchObject({
      _tag: "Failure",
      cause: { _tag: "Fail", error: { _tag: "BankAssuranceRequired", required: "aal2", actual: "aal1" } },
    })
    expect(new BankAssuranceRequired({ required: "aal2", actual: "aal1" })).toMatchObject({ _tag: "BankAssuranceRequired" })

    const deniedExit = await Effect.runPromiseExit(
      disconnect(principal, { workspaceId, connectionId }).pipe(
        Effect.provide(bankLayer(accessFor("member"), unusedDirectory(), bank)),
      ),
    )
    expect(deniedExit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "BankWriteDenied" } } })
    expect(new BankWriteDenied({ workspaceId })).toMatchObject({ _tag: "BankWriteDenied" })
    expect(calls).toBe(0)

    await expect(
      Effect.runPromise(disconnect(principal, { workspaceId, connectionId }).pipe(Effect.provide(layer))),
    ).resolves.toEqual({ disconnected: true, status: "pending" })
    expect(calls).toBe(1)
  })
})
