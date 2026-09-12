import { afterAll, beforeAll, describe, expect, it } from "vitest";

type CallbackHandler = (request: Request) => Promise<Response>;

const globals = globalThis as typeof globalThis & { Deno?: unknown };
const originalDeno = globals.Deno;
const originalFetch = globalThis.fetch;
let handler: CallbackHandler;
let resolvedStatus = "";

const paymentResolution = (status: string) => ({
  payment_id: "payment-1",
  workspace_id: "workspace-1",
  user_id: "user-1",
  return_path: "/payments/complete?source=provider#done",
  status,
});

beforeAll(async () => {
  globals.Deno = {
    env: {
      get: (name: string) => ({
        FINCH_PUBLIC_APP_ORIGIN: "https://app.finch.test",
        SUPABASE_URL: "https://supabase.example",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      })[name],
    },
    serve: (callback: CallbackHandler) => { handler = callback; },
  };
  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/rpc/consume_bank_authorization")) return Response.json([]);
    if (url.pathname.endsWith("/rpc/resolve_payment_callback")) return Response.json([paymentResolution(resolvedStatus)]);
    if (url.pathname.endsWith("/payment_orders")) return Response.json({ provider_payment_ref: "provider-payment-1" });
    if (url.pathname.endsWith("/rpc/get_worker_secret")) return Response.json({ message: "secret unavailable" }, { status: 500 });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  await import("../../supabase/functions/bank-callback/index.ts");
});

afterAll(() => {
  if (originalDeno === undefined) delete globals.Deno;
  else globals.Deno = originalDeno;
  globalThis.fetch = originalFetch;
});

describe("bank callback payment redirect outcomes", () => {
  it("redirects a provider-error callback as completed when resolution preserves an accepted payment", async () => {
    resolvedStatus = "accepted";

    const response = await handler(new Request("https://edge.finch.test/bank-callback?state=payment-state&error=access_denied"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://app.finch.test/payments/complete?source=provider&payment=completed#done");
  });

  it("redirects a verification-failed callback as failed when resolution preserves a rejected payment", async () => {
    resolvedStatus = "rejected";

    const response = await handler(new Request("https://edge.finch.test/bank-callback?state=payment-state"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://app.finch.test/payments/complete?source=provider&payment=failed#done");
  });
});
