import { Context, Data, Effect } from "effect"

export class LexicalIndexError extends Data.TaggedError("LexicalIndexError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class LexicalIndex extends Context.Tag("LexicalIndex")<
  LexicalIndex,
  {
    indexDocument(documentId: string, content: string): Effect.Effect<void, LexicalIndexError>
    removeDocument(documentId: string): Effect.Effect<void, LexicalIndexError>
    search(
      query: string,
      topK: number,
    ): Effect.Effect<readonly { readonly documentId: string; readonly rank: number }[], LexicalIndexError>
  }
>() {}
