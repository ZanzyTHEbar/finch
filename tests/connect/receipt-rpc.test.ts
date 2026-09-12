import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Code, ConnectError, createClient } from "@connectrpc/connect"
import { connectNodeAdapter, createConnectTransport } from "@connectrpc/connect-node"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ReceiptService, ReceiptStatus, UploadHttpMethod } from "../../packages/contracts/src/index.ts"
import {
  ReceiptConflict,
  ReceiptHashMismatch,
  ReceiptMetadataMismatch,
  ReceiptNotFound,
  ReceiptPort,
  ReceiptUnavailable,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceId,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"
import { makeReceiptService, toReceiptConnectError, type ConnectPrincipalResolver } from "../../packages/connect/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const receiptId = "bbbbbbbb-0000-4000-8000-000000000002"
const principal: PrincipalContext = {
  issuer: "https://id.example.test",
  subjectId: "subject-1",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

const trustedResolver: ConnectPrincipalResolver = { resolve: () => principal }

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )

const receipt = {
  id: receiptId,
  status: "pending" as const,
  contentType: "application/pdf",
  createdAt: "2026-09-10T12:00:00.000Z",
}

const deterministicReceiptPort = (overrides: Partial<ReceiptPort>): ReceiptPort => ({
  listReceipts: () => Effect.die("not used"),
  getReceipt: () => Effect.die("not used"),
  createReceiptUploadIntent: () => Effect.die("not used"),
  finalizeReceipt: () => Effect.die("not used"),
  getReceiptDownloadUrl: () => Effect.die("not used"),
  ...overrides,
})

const serve = async (
  principalResolver: ConnectPrincipalResolver,
  workspaceAccess: WorkspaceAccess,
  receiptPort: ReceiptPort,
) => {
  const handle = makeReceiptService({
    principalResolver,
    layer: Layer.mergeAll(
      Layer.succeed(WorkspaceAccess, workspaceAccess),
      Layer.succeed(ReceiptPort, receiptPort),
    ),
  })
  const server = createServer(
    connectNodeAdapter({ routes: (router) => router.service(ReceiptService, handle.impl) }),
  )
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  return {
    client: createClient(
      ReceiptService,
      createConnectTransport({ baseUrl: `http://127.0.0.1:${address.port}`, httpVersion: "1.1" }),
    ),
    close: async () => {
      await closeServer(server)
      await handle.dispose()
    },
  }
}

describe("canonical ReceiptService RPC", () => {
  it("maps protobuf presence, upload instructions, and receipt states without exposing storage internals", async () => {
    let createInput: unknown
    const access: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) => Effect.succeed({ workspaceId: requestedWorkspace, role: "member" }),
    }
    const port = deterministicReceiptPort({
      listReceipts: () => Effect.succeed({ receipts: [receipt] }),
      getReceipt: () => Effect.succeed(receipt),
      createReceiptUploadIntent: (input) =>
        Effect.sync(() => {
          createInput = input
          return {
            receipt: {
              ...receipt,
              fileName: "receipt.pdf",
              merchant: "Finch Store",
              total: { minorUnits: "90071992547409931234", currency: "EUR" },
              receiptDate: "2026-09-10",
            },
            upload: {
              url: "https://storage.example.test/upload",
              requiredHeaders: [{ name: "content-type", value: "application/pdf" }],
            },
          }
        }),
      finalizeReceipt: () => Effect.succeed({ ...receipt, status: "ready" }),
      getReceiptDownloadUrl: () => Effect.succeed({ url: "https://storage.example.test/download", expiresAt: "2026-09-10T12:01:00.000Z" }),
    })
    const { client, close } = await serve(trustedResolver, access, port)
    try {
      const listed = await client.listReceipts({ workspaceId })
      expect(listed.receipts[0]).toMatchObject({ id: receiptId, status: ReceiptStatus.UPLOAD_PENDING })
      expect(listed.receipts[0]?.fileName).toBeUndefined()
      expect(listed.receipts[0]?.merchant).toBeUndefined()
      expect(listed.receipts[0]?.total).toBeUndefined()
      expect(listed.receipts[0]?.receiptDate).toBeUndefined()

      const created = await client.createReceiptUploadIntent({
        workspaceId,
        fileName: "receipt.pdf",
        contentType: "application/pdf",
        contentLength: 2n,
        sha256: "a".repeat(64),
        idempotencyKey: "receipt-create-1",
        merchant: "Finch Store",
        total: { minorUnits: "90071992547409931234", currency: "EUR" },
        receiptDate: "2026-09-10",
      })
      expect(createInput).toMatchObject({
        merchant: "Finch Store",
        total: { minorUnits: "90071992547409931234", currency: "EUR" },
        receiptDate: "2026-09-10",
      })
      expect(created.receipt).toMatchObject({
        fileName: "receipt.pdf",
        merchant: "Finch Store",
        total: { minorUnits: "90071992547409931234", currency: "EUR" },
        receiptDate: "2026-09-10",
      })
      expect(created.upload).toMatchObject({
        method: UploadHttpMethod.PUT,
        requiredHeaders: [{ name: "content-type", value: "application/pdf" }],
      })
      expect(created.upload).not.toHaveProperty("expiresAt")

      const finalized = await client.finalizeReceipt({ workspaceId, receiptId })
      expect(finalized.receipt?.status).toBe(ReceiptStatus.READY)
      const download = await client.getReceiptDownloadUrl({ workspaceId, receiptId })
      expect(download.download).toMatchObject({ url: "https://storage.example.test/download", expiresAt: "2026-09-10T12:01:00.000Z" })
    } finally {
      await close()
    }
  })

  it("maps missing principals and denied write roles before receipt port work", async () => {
    let authorizations = 0
    let portCalls = 0
    const access: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) =>
        Effect.sync(() => {
          authorizations += 1
          return { workspaceId: requestedWorkspace, role: "viewer" as const }
        }),
    }
    const port = deterministicReceiptPort({
      createReceiptUploadIntent: () =>
        Effect.sync(() => {
          portCalls += 1
          throw new Error("receipt port must not be called")
        }),
    })
    const unauthenticated = await serve({ resolve: () => undefined }, access, port)
    try {
      const failure = await unauthenticated.client.listReceipts({ workspaceId }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(ConnectError)
      expect((failure as ConnectError).code).toBe(Code.Unauthenticated)
      expect(authorizations).toBe(0)
      expect(portCalls).toBe(0)
    } finally {
      await unauthenticated.close()
    }

    const denied = await serve(trustedResolver, access, port)
    try {
      const failure = await denied.client.createReceiptUploadIntent({
        workspaceId,
        fileName: "receipt.pdf",
        contentType: "application/pdf",
        contentLength: 1n,
        sha256: "a".repeat(64),
        idempotencyKey: "viewer-create",
      }).then(
        () => null,
        (cause: unknown) => cause,
      )
      expect(failure).toBeInstanceOf(ConnectError)
      expect((failure as ConnectError).code).toBe(Code.PermissionDenied)
      expect(authorizations).toBe(1)
      expect(portCalls).toBe(0)
    } finally {
      await denied.close()
    }
  })

  it("maps validation and receipt failures to canonical Connect statuses", async () => {
    const access: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) => Effect.succeed({ workspaceId: requestedWorkspace, role: "member" }),
    }
    const port = deterministicReceiptPort({
      getReceipt: () => Effect.fail(new ReceiptNotFound({ receiptId })),
      finalizeReceipt: () => Effect.fail(new ReceiptHashMismatch()),
      getReceiptDownloadUrl: () => Effect.fail(new ReceiptUnavailable()),
      createReceiptUploadIntent: () => Effect.fail(new ReceiptConflict({ reason: "duplicate" })),
    })
    const { client, close } = await serve(trustedResolver, access, port)
    try {
      const invalid = await client.listReceipts({ workspaceId: "invalid" }).then(() => null, (cause: unknown) => cause)
      expect((invalid as ConnectError).code).toBe(Code.InvalidArgument)
      const missing = await client.getReceipt({ workspaceId, receiptId }).then(() => null, (cause: unknown) => cause)
      expect((missing as ConnectError).code).toBe(Code.NotFound)
      const mismatch = await client.finalizeReceipt({ workspaceId, receiptId }).then(() => null, (cause: unknown) => cause)
      expect((mismatch as ConnectError).code).toBe(Code.FailedPrecondition)
      const metadataMismatch = toReceiptConnectError(new ReceiptMetadataMismatch())
      expect(metadataMismatch.code).toBe(Code.FailedPrecondition)
      const unavailable = await client.getReceiptDownloadUrl({ workspaceId, receiptId }).then(() => null, (cause: unknown) => cause)
      expect((unavailable as ConnectError).code).toBe(Code.Unavailable)
      const conflict = await client.createReceiptUploadIntent({
        workspaceId,
        fileName: "receipt.pdf",
        contentType: "application/pdf",
        contentLength: 1n,
        sha256: "a".repeat(64),
        idempotencyKey: "conflict",
      }).then(() => null, (cause: unknown) => cause)
      expect((conflict as ConnectError).code).toBe(Code.Aborted)
    } finally {
      await close()
    }
  })

  it("maps a denied workspace access without receipt port work", async () => {
    let portCalls = 0
    const access: WorkspaceAccess = {
      authorize: (_principal, requestedWorkspace) => Effect.fail(new WorkspaceAccessDenied({ workspaceId: requestedWorkspace })),
    }
    const port = deterministicReceiptPort({
      listReceipts: () =>
        Effect.sync(() => {
          portCalls += 1
          return { receipts: [] }
        }),
    })
    const { client, close } = await serve(trustedResolver, access, port)
    try {
      const failure = await client.listReceipts({ workspaceId }).then(() => null, (cause: unknown) => cause)
      expect((failure as ConnectError).code).toBe(Code.PermissionDenied)
      expect(portCalls).toBe(0)
    } finally {
      await close()
    }
  })
})
