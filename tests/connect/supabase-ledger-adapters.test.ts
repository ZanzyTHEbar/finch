import { Schema, Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  LedgerPort,
  LedgerUnavailable,
  ValidationFailed,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceAccessUnavailable,
  WorkspaceId,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"
import { makeSupabaseLedgerLayer } from "../../packages/connect/src/index.ts"

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const otherWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("bbbbbbbb-0000-4000-8000-000000000002")
const accountId = "cccccccc-0000-4000-8000-000000000003"
const transactionId = "dddddddd-0000-4000-8000-000000000004"
const principal: PrincipalContext = {
  issuer: "https://id.example.test",
  subjectId: "subject-a",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

afterEach(() => vi.unstubAllGlobals())

const expectFailure = async (effect: Effect.Effect<unknown, { readonly _tag: string }>) => {
  const exit = await Effect.runPromiseExit(effect)
  expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail" } })
  return (exit as { readonly cause: { readonly error: { readonly _tag: string } } }).cause.error
}

const services = async () => {
  const layer = makeSupabaseLedgerLayer({
    supabaseUrl: "https://supabase.example.test",
    serviceRoleKey: "service-role-key",
    pageTokenHmacKey: "dedicated-test-hmac-key",
  })
  return Effect.runPromise(
    Effect.gen(function* () {
      return { access: yield* WorkspaceAccess, ledger: yield* LedgerPort }
    }).pipe(Effect.provide(layer)),
  )
}

describe("Supabase ledger adapters", () => {
  it("signs keyset tokens, scopes every read, and rejects tampered or cross-scope tokens", async () => {
    const requests: URL[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      requests.push(url)
      if (url.pathname.endsWith("/rpc/resolve_authentik_workspace_access")) {
        return Response.json([{ role: "member" }])
      }
      if (url.pathname.endsWith("/accounts")) {
        return Response.json([
          {
            id: accountId,
            workspace_id: workspaceId,
            name: "Daily account",
            currency: "EUR",
            account_type: "checking",
            created_at: "2026-09-10T12:00:00+00:00",
          },
          {
            id: "dddddddd-0000-4000-8000-000000000004",
            workspace_id: workspaceId,
            name: "Savings account",
            currency: "EUR",
            account_type: "savings",
            created_at: "2026-09-09T12:00:00+00:00",
          },
        ])
      }
      if (url.pathname.endsWith("/transactions")) {
        return Response.json([
          {
            id: transactionId,
            workspace_id: workspaceId,
            account_id: accountId,
            amount_minor: "90071992547409931234",
            currency: "EUR",
            booking_date: "2026-09-10",
            value_date: null,
            raw_description: "Large integer purchase",
            merchant_name: null,
            status: "booked",
          },
        ])
      }
      throw new Error(`unexpected request: ${url}`)
    }))
    const { access, ledger } = await services()

    await expect(Effect.runPromise(access.authorize(principal, workspaceId))).resolves.toEqual({
      workspaceId,
      role: "member",
    })
    const first = await Effect.runPromise(ledger.listAccounts({ workspaceId, page: { pageSize: 1 } }))
    expect(first.accounts).toEqual([
      { id: accountId, name: "Daily account", currency: "EUR", accountType: "checking" },
    ])
    expect(first.nextPageToken).toEqual(expect.any(String))
    expect(requests.at(-1)?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`)
    expect(requests.at(-1)?.searchParams.get("order")).toBe("created_at.desc,id.desc")
    expect(requests.at(-1)?.searchParams.get("limit")).toBe("2")

    const transactions = await Effect.runPromise(ledger.listTransactions({
      workspaceId,
      accountId,
      page: { pageSize: 1 },
    }))
    expect(transactions.transactions).toEqual([
      {
        id: transactionId,
        accountId,
        amount: { minorUnits: "90071992547409931234", currency: "EUR" },
        bookingDate: "2026-09-10",
        description: "Large integer purchase",
        status: "booked",
      },
    ])
    expect(requests.at(-1)?.searchParams.get("workspace_id")).toBe(`eq.${workspaceId}`)
    expect(requests.at(-1)?.searchParams.get("account_id")).toBe(`eq.${accountId}`)

    const token = first.nextPageToken as string
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const lastCharacter = token.at(-1) as string
    // A base64url HMAC's final character carries unused padding bits. Change only
    // those bits to prove we reject non-canonical aliases, not just different MACs.
    const tampered = `${token.slice(0, -1)}${alphabet[alphabet.indexOf(lastCharacter) + 1]}`
    expect((await expectFailure(ledger.listAccounts({ workspaceId, page: { pageSize: 1, pageToken: tampered } })))._tag)
      .toBe(new ValidationFailed({ issues: [] })._tag)
    expect((await expectFailure(ledger.listAccounts({ workspaceId: otherWorkspaceId, page: { pageSize: 1, pageToken: token } })))._tag)
      .toBe(new ValidationFailed({ issues: [] })._tag)
    expect((await expectFailure(ledger.listTransactions({ workspaceId, accountId, page: { pageSize: 1, pageToken: token } })))._tag)
      .toBe(new ValidationFailed({ issues: [] })._tag)
  })

  it("maps missing access to denied and malformed or failed Supabase responses to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      if (url.pathname.endsWith("/rpc/resolve_authentik_workspace_access")) {
        return Response.json([])
      }
      return Response.json({ message: "database unavailable" }, { status: 400 })
    }))
    const { access, ledger } = await services()
    expect((await expectFailure(access.authorize(principal, workspaceId)))._tag)
      .toBe(new WorkspaceAccessDenied({ workspaceId })._tag)
    expect((await expectFailure(ledger.listAccounts({ workspaceId, page: { pageSize: 1 } })))._tag)
      .toBe(new LedgerUnavailable()._tag)

    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ role: "member", profile_id: "leak" }])))
    expect((await expectFailure(access.authorize(principal, workspaceId)))._tag)
      .toBe(new WorkspaceAccessUnavailable()._tag)
  })
})
