import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import { StorageUnavailable } from "@finch/core";
import { getLoadablePath } from "sqlite-vec";

// sqlite-vec loading is explicit and opt-in: this module is NOT imported by
// client.ts, so plain reads/writes never depend on the extension. Dev and
// migration tooling call loadVecExtension before creating vec0 tables.
export const loadVecExtension = (sqlite: Database): Effect.Effect<string, StorageUnavailable> =>
  Effect.gen(function* () {
    const override = (process.env["SQLITE_VEC_PATH"] ?? "").trim();
    const extPath =
      override.length > 0
        ? override
        : yield* Effect.try({
            try: () => getLoadablePath(),
            catch: (cause) => new StorageUnavailable({ cause }),
          });
    if (typeof sqlite.loadExtension !== "function") {
      return yield* Effect.fail(
        new StorageUnavailable({ cause: "bun:sqlite Database.loadExtension is unavailable" }),
      );
    }
    return yield* Effect.try({
      try: () => {
        sqlite.loadExtension(extPath);
        return extPath;
      },
      catch: (cause) => new StorageUnavailable({ cause }),
    });
  });
