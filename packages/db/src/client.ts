import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { ConfigError, Context, Effect, Layer } from "effect";
import { AppConfigTag, type AppConfig } from "@finch/core";
import * as schema from "./schema/index.ts";

export type BunSQLiteDrizzle = BunSQLiteDatabase<typeof schema>;

export class Db extends Context.Tag("Db")<Db, { db: BunSQLiteDrizzle; sqlite: Database }>() {}

const parsePath = (url: string): string => {
  if (url === ":memory:") {
    return ":memory:";
  }
  if (url.startsWith("file:")) {
    return url.slice("file:".length) || ":memory:";
  }
  return url;
};

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const SqliteLive: Layer.Layer<Db, ConfigError.ConfigError, AppConfig> = Layer.effect(
  Db,
  Effect.gen(function* () {
    const { databaseUrl } = yield* AppConfigTag;
    return yield* Effect.try({
      try: () => {
        const path = parsePath(databaseUrl);
        if (path !== ":memory:") {
          const dir = dirname(path);
          if (dir !== "" && dir !== ".") {
            mkdirSync(dir, { recursive: true });
          }
        }
        const sqlite = new Database(path, { create: true });
        sqlite.exec("PRAGMA journal_mode = WAL;");
        sqlite.exec("PRAGMA foreign_keys = ON;");
        const db = drizzle(sqlite, { schema });
        return { db, sqlite };
      },
      catch: (cause) =>
        ConfigError.InvalidData(
          ["DATABASE_URL"],
          `failed to open sqlite database at ${JSON.stringify(databaseUrl)}: ${describeCause(cause)}`,
        ),
    });
  }),
);
