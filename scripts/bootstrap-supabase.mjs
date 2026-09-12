import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const publicSchemaObjectsQuery = `
  select exists (
    select 1
    from pg_catalog.pg_class as object
    join pg_catalog.pg_namespace as namespace on namespace.oid = object.relnamespace
    where namespace.nspname = 'public'
      and object.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    union all
    select 1
    from pg_catalog.pg_proc as object
    join pg_catalog.pg_namespace as namespace on namespace.oid = object.pronamespace
    where namespace.nspname = 'public'
    union all
    select 1
    from pg_catalog.pg_type as object
    join pg_catalog.pg_namespace as namespace on namespace.oid = object.typnamespace
    where namespace.nspname = 'public'
      and object.typtype in ('b', 'c', 'd', 'e', 'r')
  ) as has_objects
`;

export const runBootstrap = async ({
  schemaMode = process.env.FINCH_SUPABASE_SCHEMA_MODE ?? "bootstrap",
  connectionString = process.env.FINCH_SUPABASE_DB_URL,
  readSchema = () => readFile(resolve("supabase/schemas/finch.sql"), "utf8"),
  Client = pg.Client,
} = {}) => {
  if (schemaMode !== "bootstrap" && schemaMode !== "existing") {
    throw new Error('FINCH_SUPABASE_SCHEMA_MODE must be either "bootstrap" or "existing"');
  }

  if (schemaMode === "existing") {
    console.log("Finch Supabase schema mode is existing; no schema mutation performed");
    return;
  }

  if (typeof connectionString !== "string" || connectionString.trim() === "") {
    throw new Error("FINCH_SUPABASE_DB_URL is required for fresh Supabase bootstrap");
  }

  const schema = await readSchema();
  const client = new Client({ connectionString });

  await client.connect();
  try {
    await client.query("begin");
    const result = await client.query(publicSchemaObjectsQuery);
    if (result.rows[0]?.has_objects === true) {
      throw new Error("refusing to bootstrap a non-empty public schema");
    }
    await client.query(schema);
    await client.query("commit");
    console.log("Finch Supabase bootstrap applied");
  } catch (cause) {
    await client.query("rollback").catch(() => undefined);
    throw cause;
  } finally {
    await client.end();
  }
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runBootstrap();
}
