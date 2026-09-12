import { Context, Data, Effect } from "effect"

export interface LlmChatMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

export class LlmError extends Data.TaggedError("LlmError")<{
  readonly message: string
  readonly status?: number
  readonly cause?: unknown
}> {}

export class LlmProvider extends Context.Tag("LlmProvider")<
  LlmProvider,
  {
    readonly chat: (
      model: string,
      messages: readonly LlmChatMessage[],
      options?: { readonly maxTokens?: number; readonly temperature?: number },
    ) => Effect.Effect<string, LlmError>
  }
>() {}
