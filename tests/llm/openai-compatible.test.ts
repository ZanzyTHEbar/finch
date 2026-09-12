import { describe, expect, it } from "vitest"
import { chatCompletions } from "../../packages/llm/src/openai-compatible.ts"

describe("OpenAI-compatible client", () => {
  it("bounds and cancels an oversized error response body", async () => {
    const previousFetch = globalThis.fetch
    let cancelled = false
    const first = new TextEncoder().encode(`${"a".repeat(500)}b`)
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 500,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(first)
          },
          cancel() {
            cancelled = true
          },
        }),
        text: async () => {
          throw new Error("response.text() must not be used for oversized errors")
        },
      }) as unknown as Response) as unknown as typeof fetch

    try {
      let error: unknown
      try {
        await chatCompletions("https://llm.example", "test-key", "test-model", [], 16, 0)
      } catch (cause) {
        error = cause
      }

      expect(error).toBeInstanceOf(Error)
      if (error instanceof Error) {
        expect(error.message).toContain("LLM API error 500:")
        expect(error.message).not.toContain("b")
      }
      expect(cancelled).toBe(true)
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
