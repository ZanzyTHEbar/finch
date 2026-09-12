import { createServer } from "node:http"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { Layer, ManagedRuntime } from "effect"
import { LedgerService, ReceiptService, SearchService } from "@finch/contracts"
import { LedgerPort, ReceiptPort, SearchPort, WorkspaceAccess } from "@finch/lib"
import { makeLedgerService } from "./ledger-service.ts"
import { makeReceiptService } from "./receipt-service.ts"
import { makeSearchService } from "./search-service.ts"
import type { ConnectPrincipalResolver } from "./principal.ts"

export interface ConnectServerDependencies<E> {
  readonly allowedOrigins: readonly string[]
  readonly principalResolver: ConnectPrincipalResolver
  readonly layer: Layer.Layer<LedgerPort | ReceiptPort | SearchPort | WorkspaceAccess, E>
}

const allowedBrowserOrigins = (origins: unknown): ReadonlySet<string> => {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new Error("allowedOrigins must be a nonempty allow-list")
  }
  return new Set(
    origins.map((origin) => {
      if (typeof origin !== "string") {
        throw new Error("allowedOrigins entries must be exact HTTP(S) origins")
      }
      let url: URL
      try {
        url = new URL(origin)
      } catch {
        throw new Error("allowedOrigins entries must be exact HTTP(S) origins")
      }
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
        throw new Error("allowedOrigins entries must be exact HTTP(S) origins")
      }
      return origin
    }),
  )
}

export const createConnectServer = <E>(dependencies: ConnectServerDependencies<E>) => {
  const origins = allowedBrowserOrigins(dependencies.allowedOrigins)
  const runtime = ManagedRuntime.make(dependencies.layer)
  const ledger = makeLedgerService(dependencies, runtime)
  const receipt = makeReceiptService(dependencies, runtime)
  const search = makeSearchService(dependencies, runtime)
  const adapter = connectNodeAdapter({
    readMaxBytes: 64 * 1024,
    routes: (router) => {
      router.service(LedgerService, ledger.impl)
      router.service(ReceiptService, receipt.impl)
      router.service(SearchService, search.impl)
    },
  })
  return {
    server: createServer((request, response) => {
      const origin = request.headers.origin
      const allowedOrigin = typeof origin === "string" && origins.has(origin) ? origin : undefined
      const requestedMethod = request.headers["access-control-request-method"]
      if (request.method === "OPTIONS" && requestedMethod !== undefined) {
        if (
          Number(request.headers["content-length"] ?? 0) > 0 ||
          request.headers["transfer-encoding"] !== undefined
        ) {
          response.setHeader("Connection", "close")
          response.writeHead(413)
          response.end(() => request.destroy())
          return
        }
        if (allowedOrigin === undefined) {
          response.writeHead(403)
          response.end()
          return
        }
        const requestedHeaders = request.headers["access-control-request-headers"]
        response.setHeader("Access-Control-Allow-Origin", allowedOrigin)
        response.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        response.setHeader("Vary", "Origin, Access-Control-Request-Headers")
        if (typeof requestedHeaders === "string") {
          response.setHeader("Access-Control-Allow-Headers", requestedHeaders)
        }
        response.writeHead(204)
        response.end()
        return
      }
      if (allowedOrigin !== undefined) {
        response.setHeader("Access-Control-Allow-Origin", allowedOrigin)
        response.setHeader("Vary", "Origin")
      }
      adapter(request, response)
    }),
    dispose: () => runtime.dispose(),
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error(
    "finch-connect: refusing to start without a production ConnectPrincipalResolver and WorkspaceAccess implementation",
  )
  process.exitCode = 1
}
