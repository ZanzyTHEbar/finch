import type { Server } from "node:http"
import { connect, type AddressInfo } from "node:net"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { createConnectServer } from "../../packages/connect/src/main.ts"
import {
  LedgerPort,
  ReceiptPort,
  SearchPort,
  WorkspaceAccess,
  WorkspaceId,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"

const allowedOrigin = "http://127.0.0.1:5173"
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const principal: PrincipalContext = {
  issuer: "https://id.example.test",
  subjectId: "subject-1",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )

const oversizedChunkedPreflight = (port: number, path: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1")
    let response = ""
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error("rejected preflight connection did not close"))
    }, 1_000)
    socket.on("connect", () => {
      const preflightBody = "x".repeat(64 * 1024 + 1)
      const postBody = JSON.stringify({ workspaceId, query: "groceries" })
      socket.write(
        [
          `OPTIONS ${path} HTTP/1.1`,
          "Host: 127.0.0.1",
          `Origin: ${allowedOrigin}`,
          "Access-Control-Request-Method: POST",
          "Access-Control-Request-Headers: authorization, content-type, connect-protocol-version",
          "Transfer-Encoding: chunked",
          "Connection: keep-alive",
          "",
          preflightBody.length.toString(16),
          preflightBody,
          "0",
          "",
          `POST ${path} HTTP/1.1`,
          "Host: 127.0.0.1",
          "Authorization: Bearer access-token",
          "Connect-Protocol-Version: 1",
          "Content-Type: application/json",
          `Content-Length: ${postBody.length}`,
          "",
          postBody,
        ].join("\r\n"),
      )
    })
    socket.on("data", (chunk) => {
      response += chunk.toString()
    })
    socket.on("error", () => undefined)
    socket.on("close", () => {
      clearTimeout(timeout)
      resolve(response)
    })
  })

describe("createConnectServer", () => {
  it("enforces CORS request limits and disposes the shared runtime once", async () => {
    let resolverCalls = 0
    let searchCalls = 0
    let ledgerCalls = 0
    let layerDisposals = 0
    const handle = createConnectServer({
      allowedOrigins: [allowedOrigin],
      principalResolver: {
        resolve: (context) => {
          resolverCalls += 1
          expect(context.requestHeader.get("authorization")).toBe("Bearer access-token")
          return principal
        },
      },
      layer: Layer.mergeAll(
        Layer.scopedDiscard(
          Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              layerDisposals += 1
            }),
          ),
        ),
        Layer.succeed(WorkspaceAccess, {
          authorize: (_principal, requestedWorkspace) =>
            Effect.succeed({ workspaceId: requestedWorkspace, role: "member" as const }),
        }),
        Layer.succeed(SearchPort, {
          search: () =>
            Effect.sync(() => {
              searchCalls += 1
              return { hits: [], diagnostics: { denseCandidates: 0, lexicalCandidates: 0, fusedCandidates: 0 } }
            }),
        }),
        Layer.succeed(LedgerPort, {
          listAccounts: () =>
            Effect.sync(() => {
              ledgerCalls += 1
              return { accounts: [] }
            }),
          getAccount: () => Effect.die("not used"),
          listTransactions: () => Effect.die("not used"),
          getTransaction: () => Effect.die("not used"),
        }),
        Layer.succeed(ReceiptPort, {
          listReceipts: () => Effect.die("not used"),
          getReceipt: () => Effect.die("not used"),
          createReceiptUploadIntent: () => Effect.die("not used"),
          finalizeReceipt: () => Effect.die("not used"),
          getReceiptDownloadUrl: () => Effect.die("not used"),
        }),
      ),
    })
    await new Promise<void>((resolve, reject) => {
      handle.server.on("error", reject)
      handle.server.listen(0, "127.0.0.1", resolve)
    })
    const { port } = handle.server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/finch.v1.SearchService/SearchFinance`
    try {
      const preflightHeaders = "authorization, content-type, connect-protocol-version"
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          origin: allowedOrigin,
          "access-control-request-method": "POST",
          "access-control-request-headers": preflightHeaders,
        },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get("access-control-allow-origin")).toBe(allowedOrigin)
      expect(preflight.headers.get("access-control-allow-methods")).toBe("POST, GET, OPTIONS")
      expect(preflight.headers.get("access-control-allow-headers")).toBe(preflightHeaders)
      expect(preflight.headers.get("access-control-allow-credentials")).toBeNull()
      expect(resolverCalls).toBe(0)

      const rejectedPreflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          origin: "https://untrusted.example.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": preflightHeaders,
        },
      })
      expect(rejectedPreflight.status).toBe(403)
      expect(rejectedPreflight.headers.get("access-control-allow-origin")).toBeNull()
      expect(rejectedPreflight.headers.get("access-control-allow-headers")).toBeNull()
      expect(resolverCalls).toBe(0)

      const oversizedPreflightResponse = await oversizedChunkedPreflight(port, new URL(url).pathname)
      expect(oversizedPreflightResponse).toContain("HTTP/1.1 413")
      expect(resolverCalls).toBe(0)

      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer access-token",
          "connect-protocol-version": "1",
          "content-type": "application/json",
          origin: allowedOrigin,
        },
        body: JSON.stringify({ workspaceId, query: "groceries" }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin)
      expect(response.headers.get("access-control-allow-credentials")).toBeNull()
      expect(await response.json()).toMatchObject({ diagnostics: {} })
      expect(resolverCalls).toBe(1)
      expect(searchCalls).toBe(1)

      const ledgerResponse = await fetch(`http://127.0.0.1:${port}/finch.v1.LedgerService/ListAccounts`, {
        method: "POST",
        headers: {
          authorization: "Bearer access-token",
          "connect-protocol-version": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ workspaceId }),
      })
      expect(ledgerResponse.status).toBe(200)
      expect(resolverCalls).toBe(2)
      expect(ledgerCalls).toBe(1)

      const oversizedPost = await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer access-token",
          "connect-protocol-version": "1",
          "content-type": "application/json",
          origin: allowedOrigin,
        },
        body: JSON.stringify({ workspaceId, query: "x".repeat(64 * 1024) }),
      })
      expect(oversizedPost.status).toBe(429)
      await expect(oversizedPost.json()).resolves.toMatchObject({ code: "resource_exhausted" })
      expect(resolverCalls).toBe(2)
      expect(searchCalls).toBe(1)
    } finally {
      await closeServer(handle.server)
      await handle.dispose()
    }
    expect(layerDisposals).toBe(1)
  })
})
