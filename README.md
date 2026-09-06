# finch

Self-updating financial transaction search engine. TypeScript + Bun + Effect, SQLite authoritative via Drizzle, event-sourced.

## Packages

- `@finch/core` — domain, versioned events, ports (hexagon inside; no infra imports)
- `@finch/db` — Drizzle schema/migrations, event store, repositories, projections, vector + lexical indexes
- `@finch/search` — RRF fusion, hybrid search, eval metrics, Voyage embedding provider
- `@finch/enablebanking`, `@finch/reconciliation`, `@finch/mcp`, `@finch/connect`, `@finch/client` — later phases

## Commands

```bash
bun install          # install (exact pins, bun workspaces)
bun run typecheck    # tsc --noEmit (tests run via `bun run test`: bun:sqlite needs the Bun runtime)
bun run test         # 79 vitest/fast-check tests over real SQLite
bun tests/manual/rebuild-roundtrip.ts   # with DATABASE_URL=file:./data/verify.db
```

Migrations live in `packages/db/drizzle` and apply via drizzle-orm's bun-sqlite migrator (see `tests/setup.ts`).
`VOYAGE_API_KEY` gates live embedding tests; the offline suite needs no credentials.
