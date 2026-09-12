import { errorResponse, HttpError, json, options, requireObject, requireString } from "../_shared/http.ts";
import { requireUser } from "../_shared/supabase.ts";

type Tool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};

const workspaceProperty = { workspaceId: { type: "string", description: "Authorized workspace context" } };

const tools: readonly Tool[] = [
  { name: "list_workspaces", description: "List workspaces available to the authenticated user.", inputSchema: { type: "object", properties: {} } },
  { name: "list_bank_connections", description: "List active and historical bank connections in a workspace.", inputSchema: { type: "object", properties: workspaceProperty, required: ["workspaceId"] } },
  { name: "start_bank_authorization", description: "Start a bank consent flow. Returns a provider redirect URL and connection ID.", inputSchema: { type: "object", properties: { ...workspaceProperty, aspspName: { type: "string" }, aspspCountry: { type: "string" }, returnPath: { type: "string" } }, required: ["workspaceId", "aspspName", "aspspCountry", "returnPath"] } },
  { name: "queue_bank_sync", description: "Queue an idempotent asynchronous bank synchronization.", inputSchema: { type: "object", properties: { ...workspaceProperty, connectionId: { type: "string" }, requestId: { type: "string" }, since: { type: "string" } }, required: ["workspaceId", "connectionId", "requestId"] } },
  { name: "list_receipts", description: "List receipt metadata. Receipt originals require a separate short-lived download URL.", inputSchema: { type: "object", properties: workspaceProperty, required: ["workspaceId"] } },
  { name: "create_receipt_upload_intent", description: "Create a private receipt upload target. Returns the receipt ID plus the exact PUT method and required headers.", inputSchema: { type: "object", properties: { ...workspaceProperty, mimeType: { type: "string" }, byteSize: { type: "integer" }, sha256: { type: "string" }, idempotencyKey: { type: "string" }, totalMinor: { type: "string" }, currency: { type: "string" }, merchant: { type: "string" }, receiptDate: { type: "string" } }, required: ["workspaceId", "mimeType", "byteSize", "sha256", "idempotencyKey"] } },
  { name: "finalize_receipt_upload", description: "Verify a receipt object's hash and make it available for search.", inputSchema: { type: "object", properties: { ...workspaceProperty, receiptId: { type: "string" } }, required: ["workspaceId", "receiptId"] } },
  { name: "get_receipt_download_url", description: "Issue a 60-second authorized receipt download URL.", inputSchema: { type: "object", properties: { ...workspaceProperty, receiptId: { type: "string" } }, required: ["workspaceId", "receiptId"] } },
  { name: "search_finances", description: "Run tenant-scoped lexical finance search. Semantic indexing is controlled by workspace AI policy.", inputSchema: { type: "object", properties: { ...workspaceProperty, query: { type: "string" }, limit: { type: "integer" } }, required: ["workspaceId", "query"] } },
  { name: "set_ai_policy", description: "Set the workspace's external AI processing policy.", inputSchema: { type: "object", properties: { ...workspaceProperty, mode: { type: "string" }, embeddingProvider: { type: "string" }, embeddingModel: { type: "string" }, assistantProvider: { type: "string" }, assistantModel: { type: "string" } }, required: ["workspaceId", "mode"] } },
  { name: "queue_ai_summary", description: "Queue an opt-in aggregate AI summary for a date range.", inputSchema: { type: "object", properties: { ...workspaceProperty, periodStart: { type: "string" }, periodEnd: { type: "string" }, requestId: { type: "string" } }, required: ["workspaceId", "periodStart", "periodEnd", "requestId"] } },
  { name: "request_data_export", description: "Request a complete asynchronous data export. Requires a recent MFA-authenticated owner session.", inputSchema: { type: "object", properties: workspaceProperty, required: ["workspaceId"] } },
  { name: "get_export_download_urls", description: "Issue 60-second signed URLs for each completed export archive part.", inputSchema: { type: "object", properties: { ...workspaceProperty, exportId: { type: "string" } }, required: ["workspaceId", "exportId"] } },
  { name: "request_workspace_deletion", description: "Request irreversible workspace deletion. Requires a recent MFA-authenticated owner session and confirmation.", inputSchema: { type: "object", properties: { ...workspaceProperty, confirm: { type: "boolean" } }, required: ["workspaceId", "confirm"] } },
  { name: "create_payment", description: "Create a SEPA payment authorization. Requires a recent MFA-authenticated owner or admin session.", inputSchema: { type: "object", properties: { ...workspaceProperty, connectionId: { type: "string" }, clientRequestId: { type: "string" }, creditorName: { type: "string" }, creditorIban: { type: "string" }, amountMinor: { type: "string" }, currency: { type: "string" }, returnPath: { type: "string" }, remittance: { type: "string" } }, required: ["workspaceId", "connectionId", "clientRequestId", "creditorName", "creditorIban", "amountMinor", "currency", "returnPath"] } },
  { name: "list_payments", description: "List payment orders in a workspace.", inputSchema: { type: "object", properties: workspaceProperty, required: ["workspaceId"] } },
];

type Route = { readonly method: "GET" | "POST"; readonly path: (args: Record<string, unknown>) => string; readonly body?: (args: Record<string, unknown>) => Record<string, unknown> };

const routes: Readonly<Record<string, Route>> = {
  list_workspaces: { method: "GET", path: () => "/api/workspaces" },
  list_bank_connections: { method: "GET", path: () => "/api/bank/connections" },
  start_bank_authorization: { method: "POST", path: () => "/api/bank/authorizations", body: (args) => ({ aspspName: args.aspspName, aspspCountry: args.aspspCountry, returnPath: args.returnPath }) },
  queue_bank_sync: { method: "POST", path: () => "/api/bank/sync", body: (args) => ({ connectionId: args.connectionId, requestId: args.requestId, ...(args.since === undefined ? {} : { since: args.since }) }) },
  list_receipts: { method: "GET", path: () => "/api/receipts" },
  create_receipt_upload_intent: { method: "POST", path: () => "/api/receipts/upload-intents", body: (args) => ({ mimeType: args.mimeType, byteSize: args.byteSize, sha256: args.sha256, idempotencyKey: args.idempotencyKey, totalMinor: args.totalMinor, currency: args.currency, merchant: args.merchant, receiptDate: args.receiptDate }) },
  finalize_receipt_upload: { method: "POST", path: (args) => `/api/receipts/${encodeURIComponent(requireString(args.receiptId, "receipt_id"))}/finalize` },
  get_receipt_download_url: { method: "POST", path: (args) => `/api/receipts/${encodeURIComponent(requireString(args.receiptId, "receipt_id"))}/download-url` },
  search_finances: { method: "GET", path: (args) => `/api/search?q=${encodeURIComponent(requireString(args.query, "query"))}${args.limit === undefined ? "" : `&limit=${encodeURIComponent(String(args.limit))}`}` },
  set_ai_policy: { method: "POST", path: () => "/api/ai-policy", body: (args) => ({ mode: args.mode, embeddingProvider: args.embeddingProvider, embeddingModel: args.embeddingModel, assistantProvider: args.assistantProvider, assistantModel: args.assistantModel }) },
  queue_ai_summary: { method: "POST", path: () => "/api/ai-summaries", body: (args) => ({ periodStart: args.periodStart, periodEnd: args.periodEnd, requestId: args.requestId }) },
  request_data_export: { method: "POST", path: () => "/api/exports" },
  get_export_download_urls: { method: "GET", path: (args) => `/api/exports/${encodeURIComponent(requireString(args.exportId, "export_id"))}/download-urls` },
  request_workspace_deletion: { method: "POST", path: () => "/api/deletion-requests", body: (args) => ({ confirm: args.confirm }) },
  create_payment: { method: "POST", path: () => "/api/payments", body: (args) => ({ connectionId: args.connectionId, clientRequestId: args.clientRequestId, creditorName: args.creditorName, creditorIban: args.creditorIban, amountMinor: args.amountMinor, currency: args.currency, returnPath: args.returnPath, remittance: args.remittance }) },
  list_payments: { method: "GET", path: () => "/api/payments" },
};

const rpc = (id: unknown, result: unknown): Response => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string): Response => json({ jsonrpc: "2.0", id, error: { code, message } });

const callTool = async (request: Request, id: unknown, params: unknown): Promise<Response> => {
  const call = requireObject(params);
  const name = requireString(call.name, "tool_name", 100);
  const route = routes[name];
  if (route === undefined) return rpcError(id, -32602, "unknown_tool");
  const args = call.arguments === undefined ? {} : requireObject(call.arguments);
  if ("tenantId" in args || "tenant_id" in args) return rpcError(id, -32602, "tenant_context_is_not_accepted");
  const workspaceId = name === "list_workspaces" ? undefined : requireString(args.workspaceId, "workspace_id", 36);
  const context = await requireUser(request);
  if (workspaceId !== undefined) {
    // The API independently performs the membership check; this only chooses its candidate scope.
    requireString(workspaceId, "workspace_id", 36);
  }
  const target = `${Deno.env.get("SUPABASE_URL")}/functions/v1${route.path(args)}`;
  const response = await fetch(target, {
    method: route.method,
    headers: {
      authorization: `Bearer ${context.accessToken}`,
      ...(workspaceId === undefined ? {} : { "x-finch-workspace": workspaceId }),
      ...(route.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: route.body === undefined ? undefined : JSON.stringify(route.body(args)),
  });
  const text = await response.text();
  if (text.length > 1_000_000) return rpcError(id, -32603, "tool_response_too_large");
  if (!response.ok) return rpc(id, { content: [{ type: "text", text }], isError: true });
  return rpc(id, { content: [{ type: "text", text: text === "" ? "{}" : text }] });
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return options();
  try {
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const message = requireObject(await request.json());
    const id = message.id ?? null;
    const method = requireString(message.method, "method", 100);
    if (method === "initialize") {
      await requireUser(request);
      return rpc(id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "finch", version: "1.0.0" } });
    }
    if (method === "tools/list") {
      await requireUser(request);
      return rpc(id, { tools });
    }
    if (method === "tools/call") return await callTool(request, id, message.params);
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    return rpcError(id, -32601, "method_not_found");
  } catch (cause) {
    if (cause instanceof HttpError) return rpcError(null, -32000, cause.code);
    return errorResponse(cause);
  }
});
