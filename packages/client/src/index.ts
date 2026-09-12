import { createClient, type Client } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-web"
import { LedgerService, ReceiptService, SearchService } from "@finch/contracts"

export type FinchClientHeaders = ConstructorParameters<typeof Headers>[0]

export interface FinchClientOptions {
  readonly baseUrl: string
  readonly bearerToken?: string
  readonly headers?: FinchClientHeaders
}

export interface FinchClient {
  readonly ledger: Client<typeof LedgerService>
  readonly receipts: Client<typeof ReceiptService>
  readonly search: Client<typeof SearchService>
}

export const createFinchClient = (options: FinchClientOptions): FinchClient => {
  const headers = new Headers(options.headers)
  if (options.bearerToken !== undefined) {
    headers.set("Authorization", `Bearer ${options.bearerToken}`)
  }
  const transport = createConnectTransport({
    baseUrl: options.baseUrl,
    interceptors: [
      (next) => async (request) => {
        headers.forEach((value, name) => request.header.set(name, value))
        return next(request)
      },
    ],
  })
  return {
    ledger: createClient(LedgerService, transport),
    receipts: createClient(ReceiptService, transport),
    search: createClient(SearchService, transport),
  }
}
