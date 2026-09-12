import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ReceiptPort,
  ReceiptWriteDenied,
  ValidationFailed,
  WorkspaceAccess,
  WorkspaceId,
  createReceiptUploadIntent,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const authorizedWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("bbbbbbbb-0000-4000-8000-000000000002")
const receiptId = "cccccccc-0000-4000-8000-000000000003"
const principal: PrincipalContext = {
  issuer: "https://id.example.test",
  subjectId: "subject-1",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

const unusedPort = (): ReceiptPort => ({
  listReceipts: () => Effect.die("not used"),
  getReceipt: () => Effect.die("not used"),
  createReceiptUploadIntent: () => Effect.die("not used"),
  finalizeReceipt: () => Effect.die("not used"),
  getReceiptDownloadUrl: () => Effect.die("not used"),
})

const validInput = {
  workspaceId,
  fileName: "receipt.pdf",
  contentType: "application/pdf",
  contentLength: 2n,
  sha256: "a".repeat(64),
  idempotencyKey: "receipt-upload-1",
  merchant: "Finch Store",
  total: { minorUnits: "90071992547409931234", currency: "EUR" },
  receiptDate: "2026-09-10",
}

describe("receipt use cases", () => {
  it("authorizes before sending validated creates to the receipt port", async () => {
    const calls: string[] = []
    const access: WorkspaceAccess = {
      authorize: (receivedPrincipal, requestedWorkspace) =>
        Effect.sync(() => {
          calls.push("authorize")
          expect(receivedPrincipal).toBe(principal)
          expect(requestedWorkspace).toBe(workspaceId)
          return { workspaceId: authorizedWorkspaceId, role: "member" as const }
        }),
    }
    const port: ReceiptPort = {
      ...unusedPort(),
      createReceiptUploadIntent: (input) =>
        Effect.sync(() => {
          calls.push("create")
          expect(input).toMatchObject({
            workspaceId: authorizedWorkspaceId,
            fileName: "receipt.pdf",
            contentType: "application/pdf",
            contentLength: 2,
            sha256: "a".repeat(64),
            idempotencyKey: "receipt-upload-1",
            merchant: "Finch Store",
            total: { minorUnits: "90071992547409931234", currency: "EUR" },
            receiptDate: "2026-09-10",
            principal,
          })
          return {
            receipt: {
              id: receiptId,
              status: "pending" as const,
              fileName: "receipt.pdf",
              contentType: "application/pdf",
              createdAt: "2026-09-10T12:00:00.000Z",
            },
            upload: { url: "https://storage.example.test/upload", requiredHeaders: [{ name: "content-type", value: "application/pdf" }] },
          }
        }),
    }

    const result = await Effect.runPromise(
      createReceiptUploadIntent(principal, validInput).pipe(
        Effect.provide(Layer.mergeAll(Layer.succeed(WorkspaceAccess, access), Layer.succeed(ReceiptPort, port))),
      ),
    )

    expect(result.receipt.id).toBe(receiptId)
    expect(calls).toEqual(["authorize", "create"])
  })

  it("rejects invalid create fields before authorization or port work", async () => {
    let authorizations = 0
    let portCalls = 0
    const access: WorkspaceAccess = {
      authorize: () =>
        Effect.sync(() => {
          authorizations += 1
          return { workspaceId, role: "member" as const }
        }),
    }
    const port: ReceiptPort = {
      ...unusedPort(),
      createReceiptUploadIntent: () =>
        Effect.sync(() => {
          portCalls += 1
          throw new Error("receipt port must not be called")
        }),
    }
    const layer = Layer.mergeAll(Layer.succeed(WorkspaceAccess, access), Layer.succeed(ReceiptPort, port))

    for (const input of [
      { ...validInput, fileName: "../receipt.pdf" },
      { ...validInput, contentType: "image/gif" },
      { ...validInput, contentLength: 0n },
      { ...validInput, contentLength: 10n * 1024n * 1024n + 1n },
      { ...validInput, sha256: "A".repeat(64) },
      { ...validInput, idempotencyKey: " " },
      { ...validInput, merchant: "m".repeat(301) },
      { ...validInput, receiptDate: "2026-02-29" },
      { ...validInput, total: { minorUnits: "-1", currency: "EUR" } },
      { ...validInput, total: { minorUnits: "1", currency: "eur" } },
    ]) {
      const exit = await Effect.runPromiseExit(createReceiptUploadIntent(principal, input).pipe(Effect.provide(layer)))
      expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ValidationFailed" } } })
    }

    expect(authorizations).toBe(0)
    expect(portCalls).toBe(0)
  })

  it("rejects viewers before invoking a receipt write port", async () => {
    let portCalls = 0
    const access: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) => Effect.succeed({ workspaceId: requestedWorkspace, role: "viewer" }),
    }
    const port: ReceiptPort = {
      ...unusedPort(),
      createReceiptUploadIntent: () =>
        Effect.sync(() => {
          portCalls += 1
          throw new Error("receipt port must not be called")
        }),
    }

    const exit = await Effect.runPromiseExit(
      createReceiptUploadIntent(principal, validInput).pipe(
        Effect.provide(Layer.mergeAll(Layer.succeed(WorkspaceAccess, access), Layer.succeed(ReceiptPort, port))),
      ),
    )
    expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "ReceiptWriteDenied" } } })
    expect(new ReceiptWriteDenied({ workspaceId })).toMatchObject({ _tag: "ReceiptWriteDenied" })
    expect(portCalls).toBe(0)
  })
})
