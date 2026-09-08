import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { exportPKCS8, generateKeyPair } from "jose"
import { ProviderUnavailable } from "../../packages/core/src/ports/bank-provider.ts"
import { makeEnableBankingService } from "../../packages/enablebanking/src/client.ts"

const headerString = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

describe("EnableBanking client", () => {
  let server: Server
  let baseUrl = ""
  let privateKeyPem = ""
  let statusOverride: number | null = null
  const captured: Array<{
    method: string
    pathname: string
    auth: string | undefined
    psuIp: string | undefined
    body: unknown
    search: string
  }> = []

  beforeAll(async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true })
    privateKeyPem = await exportPKCS8(privateKey)
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1")
        const bodyText = await readBody(req)
        const body = bodyText === "" ? undefined : (JSON.parse(bodyText) as unknown)
        captured.push({
          method: req.method ?? "",
          pathname: url.pathname,
          auth: req.headers.authorization,
          psuIp: headerString(req.headers["psu-ip-address"]),
          body,
          search: url.search,
        })
        if (statusOverride !== null) {
          res.writeHead(statusOverride, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "unauthorized" }))
          return
        }
        const method = req.method ?? ""
        const pathname = url.pathname
        let payload: unknown = { error: "not found" }
        let status = 404
        if (method === "GET" && pathname === "/aspsps") {
          status = 200
          payload = { aspsps: [{ name: "Demo Bank", country: "FI" }] }
        } else if (method === "POST" && pathname === "/auth") {
          status = 200
          payload = { url: "https://bank.example/authorize" }
        } else if (method === "POST" && pathname === "/sessions") {
          status = 200
          payload = {
            session_id: "sess-1",
            accounts: [
              {
                uid: "acc-1",
                name: "Current",
                currency: "EUR",
                cash_account_type: "CACC",
                account_id: { iban: "FI2112345600000785" },
              },
            ],
          }
        } else if (method === "GET" && pathname === "/sessions/sess-1") {
          status = 200
          payload = { accounts: ["acc-1"] }
        } else if (method === "GET" && pathname === "/accounts/acc-1/details") {
          status = 200
          payload = {
            uid: "acc-1",
            name: "Current",
            currency: "EUR",
            cash_account_type: "CACC",
            account_id: { iban: "FI2112345600000785" },
          }
        } else if (method === "GET" && pathname === "/accounts/acc-1/transactions") {
          status = 200
          if (url.searchParams.get("continuation_key") === "page-2") {
            payload = {
              transactions: [
                {
                  transaction_id: "tx-2",
                  booking_date: "2026-09-02",
                  credit_debit_indicator: "DBIT",
                  status: "BOOK",
                  transaction_amount: { amount: "4.00", currency: "EUR" },
                  remittance_information: ["Coffee"],
                },
              ],
            }
          } else {
            payload = {
              continuation_key: "page-2",
              transactions: [
                {
                  transaction_id: "tx-1",
                  booking_date: "2026-09-01",
                  credit_debit_indicator: "CRDT",
                  status: "BOOK",
                  transaction_amount: { amount: "10.00", currency: "EUR" },
                  remittance_information: ["Salary"],
                },
                {
                  transaction_id: "tx-pending",
                  booking_date: "2026-09-01",
                  credit_debit_indicator: "DBIT",
                  status: "PDNG",
                  transaction_amount: { amount: "9.00", currency: "EUR" },
                  remittance_information: ["Hold"],
                },
              ],
            }
          }
        } else if (method === "DELETE" && pathname === "/sessions/sess-1") {
          status = 204
          res.writeHead(status)
          res.end()
          return
        }
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(payload))
      })()
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()))
    })
  })

  const service = (pem = privateKeyPem, applicationId = "app-1") =>
    makeEnableBankingService({
      baseUrl,
      applicationId,
      privateKeyPem: pem,
      psuIp: "203.0.113.10",
      psuUserAgent: "finch-test",
    })

  it("calls AIS endpoints with a Bearer JWT and paginates transactions", async () => {
    captured.length = 0
    const bank = service()
    const aspsps = await Effect.runPromise(bank.listAspsps())
    expect(aspsps).toEqual([{ name: "Demo Bank", country: "FI" }])

    const auth = await Effect.runPromise(
      bank.startAuthorization({
        aspsp: { name: "Demo Bank", country: "FI" },
        redirectUrl: "https://finch.example/callback",
        state: "s-1",
      }),
    )
    expect(auth.url).toBe("https://bank.example/authorize")
    const authReq = captured.find((row) => row.pathname === "/auth")
    expect(authReq?.psuIp).toBe("203.0.113.10")
    expect(authReq?.body).toEqual(
      expect.objectContaining({
        aspsp: { name: "Demo Bank", country: "FI" },
        redirect_url: "https://finch.example/callback",
      }),
    )

    const session = await Effect.runPromise(bank.createSession("auth-code"))
    expect(session.sessionId).toBe("sess-1")
    expect(session.accounts[0]?.externalAccountId).toBe("acc-1")

    const accounts = await Effect.runPromise(bank.listAccounts("sess-1"))
    expect(accounts).toEqual([
      expect.objectContaining({
        externalAccountId: "acc-1",
        name: "Current",
        iban: "FI2112345600000785",
        currency: "EUR",
      }),
    ])

    const txs = await Effect.runPromise(bank.listTransactions("sess-1", "acc-1"))
    expect(txs).toHaveLength(2)
    expect(txs[0]?.externalTransactionId).toBe("tx-1")
    expect(txs[1]?.externalTransactionId).toBe("tx-2")
    expect(txs[1]?.amountMinor).toBe(-400n)

    const foreign = await Effect.runPromise(Effect.flip(bank.listTransactions("sess-1", "acc-other")))
    expect(foreign).toBeInstanceOf(ProviderUnavailable)
    expect(foreign.message).toBe("account is not in the Enable Banking session")

    await Effect.runPromise(bank.deleteSession("sess-1"))

    for (const row of captured) {
      const token = row.auth ?? ""
      expect(token.startsWith("Bearer ")).toBe(true)
      expect(token.slice("Bearer ".length).split(".")).toHaveLength(3)
    }
  })

  it("maps 401 to ProviderUnavailable", async () => {
    statusOverride = 401
    try {
      const failure = await Effect.runPromise(Effect.flip(service().listAspsps()))
      expect(failure._tag).toBe("ProviderUnavailable")
      expect(failure.message).toContain("401")
    } finally {
      statusOverride = null
    }
  })

  it("fails when credentials are empty", async () => {
    const bank = service("", "")
    const failure = await Effect.runPromise(Effect.flip(bank.listAspsps()))
    expect(failure).toBeInstanceOf(ProviderUnavailable)
    expect(failure.message).toBe("Enable Banking credentials missing")
  })
})
