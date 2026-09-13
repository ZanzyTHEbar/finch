import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import type { SupabaseClient } from "@supabase/supabase-js";

type EnableBanking = typeof import("../../supabase/functions/_shared/enable-banking.ts");

const globals = globalThis as typeof globalThis & { Deno?: unknown };
const originalDeno = globals.Deno;
const environment = new Map<string, string>([["ENABLEBANKING_BASE_URL", "https://provider.example"]]);

let banking: EnableBanking;
let privateKeyPem = "";

const admin = {
  rpc: async (name: string, parameters: { p_name?: string }) => {
    if (name !== "get_worker_secret") return { data: null, error: { message: "unexpected RPC" } };
    const secrets: Record<string, string> = {
      enablebanking_application_id: "test-application",
      enablebanking_private_key: privateKeyPem,
      enablebanking_psu_ip: "203.0.113.10",
      enablebanking_psu_user_agent: "finch-edge-test",
    };
    return { data: parameters.p_name === undefined ? null : secrets[parameters.p_name] ?? null, error: null };
  },
} as unknown as SupabaseClient;

const withProviderPayloads = async <T>(payloads: unknown[], run: () => Promise<T>): Promise<T> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const payload = payloads.shift();
    if (payload === undefined) throw new Error("unexpected provider request");
    return Response.json(payload);
  }) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const expectInvalidResponse = async (run: () => Promise<unknown>): Promise<void> => {
  await expect(run()).rejects.toMatchObject({ code: "provider_invalid_response", retryable: false });
};

const expectInvalidConfiguration = async (run: () => Promise<unknown>): Promise<void> => {
  await expect(run()).rejects.toMatchObject({ code: "provider_configuration_unavailable", retryable: false });
};

const authorizationInput = {
  aspspName: "Example Bank",
  aspspCountry: "PT",
  redirectUrl: "https://app.finch.test/bank/callback",
  state: "test-state",
};

beforeAll(async () => {
  globals.Deno = { env: { get: (name: string) => environment.get(name) } };
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  privateKeyPem = await exportPKCS8(privateKey);
  banking = await import("../../supabase/functions/_shared/enable-banking.ts");
});

afterAll(() => {
  if (originalDeno === undefined) delete globals.Deno;
  else globals.Deno = originalDeno;
});

describe("Enable Banking Edge payload validation", () => {
  it.each(["http://provider.example", "https://user:secret@provider.example"])(
    "rejects an unsafe ENABLEBANKING_BASE_URL before sending JWT or PSU headers: %s",
    async (baseUrl) => {
      const originalFetch = globalThis.fetch;
      const requests: Request[] = [];
      environment.set("ENABLEBANKING_BASE_URL", baseUrl);
      globalThis.fetch = (async (input, init) => {
        requests.push(input instanceof Request ? input : new Request(input.toString(), init));
        return Response.json({ url: "https://bank.example/authorize" });
      }) as typeof fetch;
      try {
        await expectInvalidConfiguration(() => banking.startAuthorization(admin, authorizationInput));
        expect(requests).toEqual([]);
      } finally {
        environment.set("ENABLEBANKING_BASE_URL", "https://provider.example");
        globalThis.fetch = originalFetch;
      }
    },
  );

  it("rejects unknown provider payment statuses instead of treating them as authorization pending", () => {
    expect(() => banking.paymentStatusFromProvider("UNKNOWN")).toThrow(
      expect.objectContaining({ code: "provider_invalid_response", retryable: false }),
    );
  });

  it.each([
    ["ACCC", "accepted"],
    ["ACSC", "accepted"],
    ["ACSP", "submitted"],
    ["ACPT", "submitted"],
    ["ACTC", "submitted"],
  ])("maps documented provider payment status %s to %s", (providerStatus, expectedStatus) => {
    expect(banking.paymentStatusFromProvider(providerStatus)).toBe(expectedStatus);
  });

  it.each([
    ["is missing", [{}]],
    ["is not an array", [{ accounts: "account-1" }]],
    ["contains a non-string ID", [
      { accounts: ["account-1", 42] },
      { uid: "account-1", currency: "EUR" },
    ]],
  ])("rejects a successful session response whose account list %s", async (_case, payloads) => {
    await expectInvalidResponse(() => withProviderPayloads(payloads, () => banking.listAccounts(admin, "session-1")));
  });

  it("rejects a successful account detail response that cannot form an account snapshot", async () => {
    await expectInvalidResponse(() =>
      withProviderPayloads(
        [{ accounts: ["account-1"] }, { uid: "account-1" }],
        () => banking.listAccounts(admin, "session-1"),
      ));
  });

  it.each([
    ["is missing", {}],
    ["is not an array", { transactions: { id: "transaction-1" } }],
    ["has a malformed continuation key", { transactions: [], continuation_key: 42 }],
    ["contains a malformed transaction", {
      transactions: [
        {
          transaction_id: "transaction-1",
          booking_date: "2026-09-12",
          credit_debit_indicator: "CRDT",
          status: "BOOK",
          transaction_amount: { amount: "1.00", currency: "EUR" },
        },
        { transaction_id: "malformed-transaction" },
      ],
    }],
    ["contains a transaction with an unknown status", {
      transactions: [{
        transaction_id: "transaction-1",
        booking_date: "2026-09-12",
        credit_debit_indicator: "CRDT",
        status: "UNKNOWN",
        transaction_amount: { amount: "1.00", currency: "EUR" },
      }],
    }],
  ])("rejects a successful transactions page whose collection %s", async (_case, page) => {
    await expectInvalidResponse(() =>
      withProviderPayloads(
        [{ accounts: ["account-1"] }, page],
        () => banking.listTransactions(admin, "session-1", "account-1"),
      ));
  });

  it("accepts HTTPS credential-free provider authorization URLs", async () => {
    await expect(withProviderPayloads([{ url: "https://bank.example/authorize" }], () => banking.startAuthorization(admin, authorizationInput)))
      .resolves.toBe("https://bank.example/authorize");
  });

  it.each(["http://bank.example/authorize", "https://user:secret@bank.example/authorize"])(
    "rejects an unsafe provider authorization URL: %s",
    async (url) => {
      await expectInvalidResponse(() => withProviderPayloads([{ url }], () => banking.startAuthorization(admin, authorizationInput)));
    },
  );

  it("treats a missing provider session as already deleted", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    try {
      await expect(banking.deleteSession(admin, "session-1")).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
