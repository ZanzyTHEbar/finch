import { afterEach, describe, expect, it, vi } from "vitest"

const queryResults: unknown[] = []
const clients: FakeClient[] = []

class FakeClient {
  readonly connect = vi.fn(async () => undefined)
  readonly query = vi.fn(async () => queryResults.shift())
  readonly end = vi.fn(async () => undefined)

  constructor(readonly options: { readonly connectionString: string }) {
    clients.push(this)
  }
}

const loadRunBootstrap = async () => {
  vi.resetModules()
  vi.doMock("pg", () => ({ default: { Client: FakeClient } }))
  const script = await import(new URL("../../scripts/bootstrap-supabase.mjs", import.meta.url).href)
  return script.runBootstrap as (input: Record<string, unknown>) => Promise<void>
}

afterEach(() => {
  clients.length = 0
  queryResults.length = 0
  vi.doUnmock("pg")
  vi.restoreAllMocks()
})

describe("Supabase schema bootstrap", () => {
  it("does not connect or mutate a database in existing mode", async () => {
    const runBootstrap = await loadRunBootstrap()
    const readSchema = vi.fn(async () => "schema")
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)

    await expect(runBootstrap({ schemaMode: "existing", readSchema })).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith("Finch Supabase schema mode is existing; no schema mutation performed")
    expect(readSchema).not.toHaveBeenCalled()
    expect(clients).toEqual([])
  })

  it("rejects unsupported schema modes before connecting", async () => {
    const runBootstrap = await loadRunBootstrap()

    await expect(runBootstrap({ schemaMode: "replace" })).rejects.toThrow(
      'FINCH_SUPABASE_SCHEMA_MODE must be either "bootstrap" or "existing"',
    )
    expect(clients).toEqual([])
  })

  it("refuses to apply the fresh schema when public is non-empty", async () => {
    const runBootstrap = await loadRunBootstrap()
    queryResults.push(undefined, { rows: [{ has_objects: true }] })

    await expect(
      runBootstrap({
        connectionString: "postgresql://example.test/finch",
        schemaMode: "bootstrap",
        readSchema: async () => "fresh schema",
      }),
    ).rejects.toThrow("refusing to bootstrap a non-empty public schema")
    expect(clients[0]?.query.mock.calls.map(([statement]) => statement)).toEqual([
      "begin",
      expect.stringContaining("pg_namespace"),
      "rollback",
    ])
    expect(clients[0]?.query).not.toHaveBeenCalledWith("fresh schema")
  })

  it("applies the fresh schema only after public is confirmed empty", async () => {
    const runBootstrap = await loadRunBootstrap()
    queryResults.push(undefined, { rows: [{ has_objects: false }] })
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    await expect(
      runBootstrap({
        connectionString: "postgresql://example.test/finch",
        readSchema: async () => "fresh schema",
      }),
    ).resolves.toBeUndefined()
    expect(clients[0]?.query.mock.calls.map(([statement]) => statement)).toEqual([
      "begin",
      expect.stringContaining("pg_namespace"),
      "fresh schema",
      "commit",
    ])
  })
})
