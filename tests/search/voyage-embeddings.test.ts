import { createServer, type IncomingMessage, type Server } from "node:http"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AppConfigLive, AppConfigTag } from "../../packages/core/src/config/config.ts"
import {
  makeVoyageEmbeddingService,
  VOYAGE_FINANCE_MODEL,
} from "../../packages/search/src/voyage-embeddings.ts"

interface CapturedRequest {
  readonly method: string | undefined
  readonly pathname: string
  readonly auth: string | undefined
  readonly body: Record<string, unknown>
}

const requests: CapturedRequest[] = []
let responder: (body: Record<string, unknown>) => { readonly status: number; readonly payload: unknown } =
  () => ({ status: 500, payload: { error: "responder not set" } })

const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk as Buffer))
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
      } catch (cause) {
        reject(cause)
      }
    })
    req.on("error", reject)
  })

let server: Server
let baseUrl = ""

const vector = (dims: number, fill: (i: number) => number): number[] =>
  Array.from({ length: dims }, (_, i) => fill(i))

const embeddingsPayload = (vectors: readonly number[][]): unknown => ({
  object: "list",
  model: VOYAGE_FINANCE_MODEL,
  data: vectors.map((embedding, index) => ({ object: "embedding", embedding, index })),
  usage: { total_tokens: vectors.length * 4 },
})

beforeAll(async () => {
  server = createServer((req, res) => {
    void Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Effect.promise(() => readJson(req as IncomingMessage))
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/$/, "")
        requests.push({
          method: req.method,
          pathname,
          auth: req.headers.authorization,
          body,
        })
        const { status, payload } = responder(body)
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(payload))
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("local test server did not bind a port")
  }
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
  )
})

const reset = (): void => {
  requests.length = 0
  responder = () => ({ status: 500, payload: { error: "responder not set" } })
}

describe("voyage embeddings (local HTTP, no live key)", () => {
  it("embedDocuments sends a document batch and returns Float32Arrays with metadata", async () => {
    reset()
    const texts = ["first doc", "second doc"]
    responder = (body) => ({
      status: 200,
      payload: embeddingsPayload([
        vector(1024, (i) => i / 1024),
        vector(1024, (i) => 1 - i / 1024),
      ]),
    })
    const service = makeVoyageEmbeddingService({ apiKey: "test-key", baseUrl })
    const result = await Effect.runPromise(service.embedDocuments(texts))

    expect(requests).toHaveLength(1)
    const req = requests[0]!
    expect(req.method).toBe("POST")
    expect(req.pathname).toBe("/embeddings")
    expect(req.auth).toBe("Bearer test-key")
    expect(req.body["model"]).toBe("voyage-finance-2")
    expect(req.body["input_type"]).toBe("document")
    expect(req.body["input"]).toStrictEqual(texts)

    expect(result).toHaveLength(2)
    for (const item of result) {
      expect(item.model).toBe("voyage-finance-2")
      expect(item.dims).toBe(1024)
      expect(item.vector).toBeInstanceOf(Float32Array)
      expect(item.vector).toHaveLength(1024)
    }
    expect(Array.from(result[0]!.vector.slice(0, 3))).toStrictEqual([0, 1 / 1024, 2 / 1024])
    expect(result[1]!.vector[0]).toBe(1)
  })

  it("embedQuery sends input_type query for a single text", async () => {
    reset()
    responder = () => ({
      status: 200,
      payload: embeddingsPayload([vector(1024, () => 0.5)]),
    })
    const service = makeVoyageEmbeddingService({ apiKey: "test-key", baseUrl })
    const result = await Effect.runPromise(service.embedQuery("what is my balance?"))

    expect(requests).toHaveLength(1)
    expect(requests[0]!.body["input_type"]).toBe("query")
    expect(requests[0]!.body["input"]).toStrictEqual(["what is my balance?"])
    expect(requests[0]!.body["model"]).toBe("voyage-finance-2")
    expect(result.model).toBe("voyage-finance-2")
    expect(result.dims).toBe(1024)
    expect(result.vector).toBeInstanceOf(Float32Array)
    expect(result.vector).toHaveLength(1024)
  })

  it("maps 401 to a typed EmbeddingError carrying the status", async () => {
    reset()
    responder = () => ({ status: 401, payload: { detail: "invalid api key" } })
    const service = makeVoyageEmbeddingService({ apiKey: "bad-key", baseUrl })
    const failure = await Effect.runPromise(Effect.flip(service.embedQuery("q")))
    expect(failure._tag).toBe("EmbeddingError")
    expect(failure).toMatchObject({ status: 401 })
  })

  it("maps 429 to a typed EmbeddingError carrying the status", async () => {
    reset()
    responder = () => ({ status: 429, payload: { detail: "rate limited" } })
    const service = makeVoyageEmbeddingService({ apiKey: "test-key", baseUrl })
    const failure = await Effect.runPromise(Effect.flip(service.embedDocuments(["a"])))
    expect(failure._tag).toBe("EmbeddingError")
    expect(failure).toMatchObject({ status: 429 })
  })

  it("maps 5xx to a typed EmbeddingError in a single attempt (no retries)", async () => {
    reset()
    responder = () => ({ status: 500, payload: { detail: "boom" } })
    const service = makeVoyageEmbeddingService({ apiKey: "test-key", baseUrl })
    const failure = await Effect.runPromise(Effect.flip(service.embedDocuments(["a"])))
    expect(failure._tag).toBe("EmbeddingError")
    expect(failure).toMatchObject({ status: 500 })
    expect(requests).toHaveLength(1)
  })

  it("fails loudly on dims mismatch instead of reshaping", async () => {
    reset()
    responder = () => ({ status: 200, payload: embeddingsPayload([[0.1, 0.2, 0.3]]) })
    const service = makeVoyageEmbeddingService({ apiKey: "test-key", baseUrl })
    const failure = await Effect.runPromise(Effect.flip(service.embedQuery("q")))
    expect(failure._tag).toBe("EmbeddingDimsMismatch")
    expect(failure).toMatchObject({ model: "voyage-finance-2", expectedDims: 1024, actualDims: 3 })
  })

  it("sources the auth header from VOYAGE_API_KEY via AppConfig with voyage-finance-2 default", async () => {
    reset()
    responder = () => ({
      status: 200,
      payload: embeddingsPayload([vector(1024, () => 0)]),
    })
    const prevKey = process.env["VOYAGE_API_KEY"]
    const prevModel = process.env["VOYAGE_MODEL"]
    process.env["VOYAGE_API_KEY"] = "config-sourced-key"
    delete process.env["VOYAGE_MODEL"]
    try {
      const config = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            return yield* AppConfigTag
          }),
          AppConfigLive,
        ),
      )
      expect(config.voyageModel).toBe("voyage-finance-2")
      const service = makeVoyageEmbeddingService({
        apiKey: config.voyageApiKey,
        model: config.voyageModel,
        baseUrl,
      })
      const result = await Effect.runPromise(service.embedQuery("q"))
      expect(result.model).toBe("voyage-finance-2")
      expect(requests).toHaveLength(1)
      expect(requests[0]!.auth).toBe("Bearer config-sourced-key")
    } finally {
      if (prevKey === undefined) {
        delete process.env["VOYAGE_API_KEY"]
      } else {
        process.env["VOYAGE_API_KEY"] = prevKey
      }
      if (prevModel === undefined) {
        delete process.env["VOYAGE_MODEL"]
      } else {
        process.env["VOYAGE_MODEL"] = prevModel
      }
    }
  })
})
