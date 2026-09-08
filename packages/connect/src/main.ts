import { createServer } from "node:http"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { Layer } from "effect"
import { AppConfigLive } from "@finch/core"
import { VoyageEmbeddingProviderLive } from "@finch/search/voyage"
import { SearchService } from "./gen/finch/search/v1/search_pb.ts"
import { makeSearchService, SearchLayerLive } from "./search-service.ts"

// Production composition: file-backed sqlite from DATABASE_URL, migrations
// applied inside SearchLayerLive, Voyage embeddings from AppConfig/keyring.
// Run from the repo root so the drizzle folder resolves.
const embeddings = Layer.provide(VoyageEmbeddingProviderLive, AppConfigLive)
const { impl, dispose } = makeSearchService(SearchLayerLive(embeddings))

const port = Number(process.env["PORT"] ?? "8080")
const server = createServer(
  connectNodeAdapter({
    routes: (router) => router.service(SearchService, impl),
  }),
)

server.on("error", (cause) => {
  console.error(`finch-connect: ${cause.message}`)
  process.exit(1)
})

server.listen(port, "127.0.0.1", () => {
  console.error(`finch-connect listening on 127.0.0.1:${port}`)
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
