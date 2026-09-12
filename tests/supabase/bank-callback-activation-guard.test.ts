import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";

type CallbackHandler = (request: Request) => Promise<Response>;

const globals = globalThis as typeof globalThis & { Deno?: unknown };
const originalDeno = globals.Deno;
const originalFetch = globalThis.fetch;
const workerSecrets = new Map<string, string>();
const providerRequests: string[] = [];
let activePatchQuery = "";
let handler: CallbackHandler;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  workerSecrets.set("enablebanking_application_id", "test-application");
  workerSecrets.set("enablebanking_private_key", await exportPKCS8(privateKey));
  workerSecrets.set("enablebanking_psu_ip", "203.0.113.10");
  workerSecrets.set("enablebanking_psu_user_agent", "finch-edge-test");
  globals.Deno = {
    env: {
      get: (name: string) => ({
        FINCH_PUBLIC_APP_ORIGIN: "https://app.finch.test",
        SUPABASE_URL: "https://supabase.example",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
        ENABLEBANKING_BASE_URL: "https://provider.example",
      })[name],
    },
    serve: (callback: CallbackHandler) => { handler = callback; },
  };
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input.toString(), init);
    const url = new URL(request.url);

    if (url.origin === "https://provider.example") {
      providerRequests.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST" && url.pathname === "/sessions") return Response.json({ session_id: "provider-session-1" });
      if (request.method === "DELETE" && url.pathname === "/sessions/provider-session-1") return new Response(null, { status: 204 });
    }

    if (url.pathname.endsWith("/rpc/consume_bank_authorization")) {
      return Response.json([{
        workspace_id: "workspace-1",
        connection_id: "connection-1",
        user_id: "user-1",
        return_path: "/bank/connections?source=callback#result",
      }]);
    }
    if (url.pathname.endsWith("/rpc/get_worker_secret")) {
      const { p_name } = await request.json() as { p_name?: string };
      return Response.json(p_name === undefined ? null : workerSecrets.get(p_name) ?? null);
    }
    if (url.pathname.endsWith("/rpc/store_pending_bank_connection_secret")) return Response.json(null);
    if (url.pathname.endsWith("/rpc/complete_bank_disconnect")) return Response.json(true);
    if (url.pathname.endsWith("/bank_connections") && request.method === "PATCH") {
      const { status } = await request.json() as { status?: string };
      if (status === "active") {
        activePatchQuery = url.search;
        return Response.json([]);
      }
      if (status === "revocation_pending") return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${request.method} ${url}`);
  }) as typeof fetch;
  await import("../../supabase/functions/bank-callback/index.ts");
});

afterAll(() => {
  if (originalDeno === undefined) delete globals.Deno;
  else globals.Deno = originalDeno;
  globalThis.fetch = originalFetch;
});

describe("bank callback activation guard", () => {
  it("fails safely when concurrent revocation prevents activation", async () => {
    activePatchQuery = "";
    providerRequests.length = 0;

    const response = await handler(new Request("https://edge.finch.test/bank-callback?state=bank-state&code=authorization-code"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://app.finch.test/bank/connections?source=callback&bank=failed#result");
    expect(new URLSearchParams(activePatchQuery).get("status")).toBe("eq.authorization_pending");
    expect(providerRequests).toEqual(["POST /sessions", "DELETE /sessions/provider-session-1"]);
  });
});
