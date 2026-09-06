// Canonical vector/lexical document id: "<sourceType>:<sourceId>".
// Both index channels key rows by this string while search_documents stores
// the parts in separate columns; parse/format is the single translation.
export interface ParsedDocumentId {
  readonly sourceType: string;
  readonly sourceId: string;
}

export const formatDocumentId = (sourceType: string, sourceId: string): string =>
  `${sourceType}:${sourceId}`;

export const parseDocumentId = (id: string): ParsedDocumentId | null => {
  const sep = id.indexOf(":");
  if (sep <= 0 || sep >= id.length - 1) {
    return null;
  }
  return { sourceType: id.slice(0, sep), sourceId: id.slice(sep + 1) };
};
