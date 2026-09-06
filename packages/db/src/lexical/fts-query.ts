export interface FtsQueryOptions {
  readonly prefixLast?: boolean;
}

// ponytail: FTS5 has no parameter language for queries, so every user term is
// quoted into a phrase — operators, quotes and wildcards stay literal. The
// only generated syntax is the opt-in trailing * for as-you-type search.
export const buildFtsMatchQuery = (query: string, options?: FtsQueryOptions): string | null => {
  const terms = query.split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) {
    return null;
  }
  const last = terms.length - 1;
  return terms
    .map(
      (term, i) =>
        `"${term.replaceAll('"', '""')}"${options?.prefixLast === true && i === last ? "*" : ""}`,
    )
    .join(" ");
};
