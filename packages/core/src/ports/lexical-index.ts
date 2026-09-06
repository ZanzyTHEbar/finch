import { Context, Data, Effect } from "effect"
import type { TenantId } from "../domain/tenant.ts"

export class LexicalIndexError extends Data.TaggedError("LexicalIndexError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface LexicalHit {
  readonly documentId: string
  readonly rank: number
  readonly snippet?: string
}

export class LexicalIndex extends Context.Tag("LexicalIndex")<
  LexicalIndex,
  {
    // documentId addresses a search_documents row as "sourceType:sourceId".
    indexDocument(
      tenantId: TenantId,
      documentId: string,
      content: string,
    ): Effect.Effect<void, LexicalIndexError>
    removeDocument(tenantId: TenantId, documentId: string): Effect.Effect<void, LexicalIndexError>
    search(
      tenantId: TenantId,
      query: string,
      topK: number,
      options?: { readonly prefixLast?: boolean },
    ): Effect.Effect<readonly LexicalHit[], LexicalIndexError>
  }
>() {}
