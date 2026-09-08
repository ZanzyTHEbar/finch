import { createServer } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { Layer } from "effect"
import { AppConfigLive } from "@finch/core"
import { VoyageEmbeddingProviderLive } from "@finch/search/voyage"
import { SearchService } from "./gen/finch/search/v1/search_pb.ts"
import { EmbedWorkerLayerLive, makeSearchService, SearchLayerLive } from "./search-service.ts"

// Production composition: file-backed sqlite from DATABASE_URL, migrations
// applied inside SearchLayerLive, Voyage embeddings from AppConfig/keyring.
// Run from the repo root so the drizzle folder resolves.
const embeddings = Layer.provide(VoyageEmbeddingProviderLive, AppConfigLive)
const { impl, dispose, drainEmbeds } = makeSearchService(
  Layer.mergeAll(SearchLayerLive(embeddings), EmbedWorkerLayerLive(embeddings)),
)

const rawPort = process.env["PORT"] ?? "8080"
const port = Number(rawPort)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`finch-connect: invalid PORT ${JSON.stringify(rawPort)}`)
  process.exit(1)
}
const server = createServer(
  connectNodeAdapter({
    routes: (router) => router.service(SearchService, impl),
  }),
)

server.on("error", (cause) => {
  console.error(`finch-connect: ${cause.message}`)
  process.exit(1)
})

void drainEmbeds()
  .then(() => {
    server.listen(port, "127.0.0.1", () => {
      console.error(`finch-connect listening on 127.0.0.1:${port}`)
    })
  })
  .catch((cause) => {
    console.error(`finch-connect: embed drain failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exit(1)
  })

const shutdown = async () => {
  server.close()
  await dispose()
}
process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0))
})
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0))
})
