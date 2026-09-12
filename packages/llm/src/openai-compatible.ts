import { Layer, Effect } from "effect"
import { LlmError, LlmProvider, AppConfigTag, ValidationFailed, type LlmChatMessage, type AppConfig } from "@finch/core"

/**
 * OpenAI-compatible chat completions client.
 * Works with OpenAI, OpenCode Zen/Go, and any OpenAI-compatible API.
 */
interface OpenAiChatResponse {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>
}

// ponytail: fixed 30s ceiling per chat call; configurable timeout if slow providers need it.
const CHAT_TIMEOUT_MS = 30_000
const MAX_ERROR_BODY = 500

const readBoundedBody = async (response: Response, maxBytes: number): Promise<string> => {
  const reader = response.body?.getReader()
  if (reader === undefined) {
    return ""
  }
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ""
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read()
      if (done || value === undefined) {
        text += decoder.decode()
        break
      }
      const remaining = maxBytes - bytesRead
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
      text += decoder.decode(chunk, { stream: true })
      bytesRead += chunk.byteLength
      if (chunk.byteLength < value.byteLength || bytesRead === maxBytes) {
        await reader.cancel()
        text += decoder.decode()
        break
      }
    }
    return text
  } finally {
    reader.releaseLock()
  }
}

export const chatCompletions = async (
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: readonly LlmChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<string> => {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  })
  if (!response.ok) {
    const body = await readBoundedBody(response, MAX_ERROR_BODY)
    throw new Error(`LLM API error ${response.status}: ${body.slice(0, MAX_ERROR_BODY)}`)
  }
  const json: OpenAiChatResponse = await response.json() as OpenAiChatResponse
  const content = json.choices?.[0]?.message?.content
  if (typeof content !== "string" || content === "") {
    throw new Error("LLM returned empty response")
  }
  return content
}

/**
 * Build an OpenAI-compatible LlmProvider layer from explicit params.
 * No context required — fully self-contained.
 */
export const makeOpenAiLlm = (
  baseUrl: string,
  apiKey: string,
): Layer.Layer<LlmProvider> =>
  Layer.succeed(LlmProvider, {
    chat: (model, messages, options) =>
      Effect.tryPromise({
        try: () =>
          chatCompletions(
            baseUrl,
            apiKey,
            model,
            messages,
            options?.maxTokens ?? 1024,
            options?.temperature ?? 0.3,
          ),
        catch: (cause) =>
          new LlmError({
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      }),
  })

/**
 * Pre-built OpenCode adapter (reads config for baseUrl/apiKey).
 * Requires AppConfig in context — use via adapter registry or Layer.provide.
 */
export const OpenCodeLlmLive: Layer.Layer<LlmProvider, ValidationFailed, AppConfig> =
  Layer.effect(
    LlmProvider,
    Effect.gen(function* () {
      const config = yield* AppConfigTag
      if (config.openCodeApiKey.trim() === "") {
        return yield* new ValidationFailed({
          issues: [
            "OpenCode LLM apiKey is empty (config.openCodeApiKey). Set OPENCODE_API_KEY env or keyring service=finch name=OPENCODE_API_KEY.",
          ],
        })
      }
      return {
        chat: (model, messages, options) =>
          Effect.tryPromise({
            try: () =>
              chatCompletions(
                config.openCodeLlmBaseUrl,
                config.openCodeApiKey,
                model,
                messages,
                options?.maxTokens ?? 1024,
                options?.temperature ?? 0.3,
              ),
            catch: (cause) =>
              new LlmError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }),
      }
    }),
  )
