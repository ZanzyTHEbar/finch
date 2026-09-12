import { createClient } from "@supabase/supabase-js"
import { Effect, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  LedgerPort,
  ValidationFailed,
  WorkspaceAccess,
  WorkspaceAccessDenied,
  WorkspaceId,
  listAccounts,
  listTransactions,
  type PrincipalContext,
} from "../../packages/lib/src/index.ts"
import { makeSupabaseLedgerLayer } from "../../packages/connect/src/index.ts"

const url = process.env.FINCH_TEST_SUPABASE_URL
const serviceKey = process.env.FINCH_TEST_SUPABASE_SERVICE_ROLE_KEY

if (url === undefined || serviceKey === undefined) {
  throw new Error("cloud tests require scripts/run-cloud-tests.mjs")
}

const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("aaaaaaaa-0000-4000-8000-000000000001")
const otherWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("bbbbbbbb-0000-4000-8000-000000000002")
const userId = "cccccccc-0000-4000-8000-000000000003"
const connectionId = "dddddddd-0000-4000-8000-000000000004"
const accountId = "eeeeeeee-0000-4000-8000-000000000005"
const secondAccountId = "ffffffff-0000-4000-8000-000000000006"
const transactionId = "11111111-0000-4000-8000-000000000007"
const secondTransactionId = "22222222-0000-4000-8000-000000000008"
const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const principal: PrincipalContext = {
  issuer: "https://id.example.test/application/o/finch/",
  subjectId: "authentik-subject-a",
  assurance: "aal2",
  authenticatedAt: new Date("2026-09-10T00:00:00Z"),
}

const expectFailure = async (effect: Effect.Effect<unknown, { readonly _tag: string }>) => {
  const exit = await Effect.runPromiseExit(effect)
  expect(exit).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail" } })
  return (exit as { readonly cause: { readonly error: { readonly _tag: string } } }).cause.error
}

beforeAll(async () => {
  const { error: userError } = await admin.auth.admin.createUser({
    id: userId,
    email: "connect-ledger-adapter@example.test",
    password: "A-strong-password-for-finch-tests!",
    email_confirm: true,
  })
  expect(userError).toBeNull()
  const { error: workspaceError } = await admin.from("workspaces").insert([
    { id: workspaceId, name: "Connect ledger workspace" },
    { id: otherWorkspaceId, name: "Other Connect ledger workspace" },
  ])
  expect(workspaceError).toBeNull()
  const { error: membershipError } = await admin.from("workspace_members").insert([
    { workspace_id: workspaceId, user_id: userId, role: "member" },
    { workspace_id: otherWorkspaceId, user_id: userId, role: "viewer" },
  ])
  expect(membershipError).toBeNull()
  const { error: linkError } = await admin.rpc("link_authentik_subject_profile", {
    p_issuer: principal.issuer,
    p_subject: principal.subjectId,
    p_profile_id: userId,
  })
  expect(linkError).toBeNull()
  const { error: connectionError } = await admin.from("bank_connections").insert({
    id: connectionId,
    workspace_id: workspaceId,
      provider: "enablebanking",
      aspsp_name: "Example Bank",
      aspsp_country: "PT",
      status: "active",
      created_by: userId,
  })
  expect(connectionError).toBeNull()
  const { error: accountError } = await admin.from("accounts").insert([
    {
      id: accountId,
      workspace_id: workspaceId,
      bank_connection_id: connectionId,
      external_ref: "ledger-a",
      name: "Daily account",
      account_type: "checking",
      currency: "EUR",
      status: "active",
      created_at: "2026-09-10T12:00:00Z",
    },
    {
      id: secondAccountId,
      workspace_id: workspaceId,
      bank_connection_id: connectionId,
      external_ref: "ledger-b",
      name: "Savings account",
      account_type: "savings",
      currency: "EUR",
      status: "active",
      created_at: "2026-09-09T12:00:00Z",
    },
  ])
  expect(accountError).toBeNull()
  const { error: transactionError } = await admin.from("transactions").insert([
    {
      id: transactionId,
      workspace_id: workspaceId,
      bank_connection_id: connectionId,
      account_id: accountId,
      source_fingerprint: "ledger-transaction-a",
      amount_minor: "90071992547409931234",
      currency: "EUR",
      booking_date: "2026-09-10",
      raw_description: "Large integer purchase",
      merchant_name: null,
      status: "booked",
    },
    {
      id: secondTransactionId,
      workspace_id: workspaceId,
      bank_connection_id: connectionId,
      account_id: accountId,
      source_fingerprint: "ledger-transaction-b",
      amount_minor: "-266",
      currency: "EUR",
      booking_date: "2026-09-09",
      raw_description: "Groceries",
      merchant_name: "Continente",
      status: "booked",
    },
  ])
  expect(transactionError).toBeNull()
})

afterAll(async () => {
  await admin.from("transactions").delete().eq("workspace_id", workspaceId)
  await admin.from("accounts").delete().eq("workspace_id", workspaceId)
  await admin.from("bank_connections").delete().eq("workspace_id", workspaceId)
  await admin.from("workspace_members").delete().in("workspace_id", [workspaceId, otherWorkspaceId])
  await admin.from("workspaces").delete().in("id", [workspaceId, otherWorkspaceId])
  await admin.auth.admin.deleteUser(userId)
})

describe("Supabase ledger adapter", () => {
  it("authorizes only mapped active members and preserves ledger read semantics", async () => {
    const layer = makeSupabaseLedgerLayer({
      supabaseUrl: url,
      serviceRoleKey: serviceKey,
      pageTokenHmacKey: "connect-ledger-adapter-dedicated-test-key",
    })
    const run = <A, E>(effect: Effect.Effect<A, E, WorkspaceAccess | LedgerPort>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)))

    const firstAccounts = await run(listAccounts(principal, { workspaceId, page: { pageSize: 1 } }))
    expect(firstAccounts.accounts).toEqual([
      { id: accountId, name: "Daily account", currency: "EUR", accountType: "checking" },
    ])
    expect(firstAccounts.accounts[0]).not.toHaveProperty("availableBalance")
    expect(firstAccounts.accounts[0]).not.toHaveProperty("currentBalance")
    expect(firstAccounts.accounts[0]).not.toHaveProperty("iban")
    expect(firstAccounts.nextPageToken).toEqual(expect.any(String))

    const secondAccounts = await run(listAccounts(principal, {
      workspaceId,
      page: { pageSize: 1, pageToken: firstAccounts.nextPageToken },
    }))
    expect(secondAccounts.accounts.map((account) => account.id)).toEqual([secondAccountId])

    const firstTransactions = await run(listTransactions(principal, {
      workspaceId,
      accountId,
      page: { pageSize: 1 },
    }))
    expect(firstTransactions.transactions).toEqual([
      {
        id: transactionId,
        accountId,
        amount: { minorUnits: "90071992547409931234", currency: "EUR" },
        bookingDate: "2026-09-10",
        description: "Large integer purchase",
        status: "booked",
      },
    ])
    expect(firstTransactions.transactions[0]).not.toHaveProperty("valueDate")
    expect(firstTransactions.transactions[0]).not.toHaveProperty("merchant")
    expect(firstTransactions.nextPageToken).toEqual(expect.any(String))

    const secondTransactions = await run(listTransactions(principal, {
      workspaceId,
      accountId,
      page: { pageSize: 1, pageToken: firstTransactions.nextPageToken },
    }))
    expect(secondTransactions.transactions).toMatchObject([{ id: secondTransactionId, merchant: "Continente" }])

    const accountToken = firstAccounts.nextPageToken as string
    expect((await expectFailure(
      listAccounts(principal, { workspaceId, page: { pageSize: 1, pageToken: `${accountToken}x` } }).pipe(Effect.provide(layer)),
    ))._tag).toBe(new ValidationFailed({ issues: [] })._tag)
    expect((await expectFailure(
      listAccounts(principal, { workspaceId: otherWorkspaceId, page: { pageSize: 1, pageToken: accountToken } }).pipe(Effect.provide(layer)),
    ))._tag).toBe(new ValidationFailed({ issues: [] })._tag)
    expect((await expectFailure(
      listTransactions(principal, {
        workspaceId,
        accountId: secondAccountId,
        page: { pageSize: 1, pageToken: firstTransactions.nextPageToken },
      }).pipe(Effect.provide(layer)),
    ))._tag).toBe(new ValidationFailed({ issues: [] })._tag)
    expect((await expectFailure(
      listAccounts({ ...principal, subjectId: "unmapped-subject" }, { workspaceId }).pipe(Effect.provide(layer)),
    ))._tag).toBe(new WorkspaceAccessDenied({ workspaceId })._tag)

    const { error: revocationError } = await admin
      .from("workspace_members")
      .update({ revoked_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
    expect(revocationError).toBeNull()
    expect((await expectFailure(listAccounts(principal, { workspaceId }).pipe(Effect.provide(layer))))._tag)
      .toBe(new WorkspaceAccessDenied({ workspaceId })._tag)
  })
})
