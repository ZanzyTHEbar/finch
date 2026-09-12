import { describe, expect, it } from "vitest";
import * as AgentContracts from "../src/agent.ts";
import {
  CompleteBankAuthorizationRequestSchema,
  CompletePaymentAuthorizationRequestSchema,
  ProviderCallbackService,
} from "../src/gen/finch/v1/callback_pb.ts";
import * as PublicContracts from "../src/index.ts";
import type { CreateReceiptUploadIntentRequest } from "../src/index.ts";
import {
  AiService,
  BankService,
  CreatePaymentRequestSchema,
  CreateReceiptUploadIntentRequestSchema,
  CreateReceiptUploadIntentResponseSchema,
  FinanceSearchHitSchema,
  JobService,
  LedgerAccountSchema,
  LedgerService,
  LedgerTransactionSchema,
  PaymentService,
  PrivacyService,
  QueueSyncRequestSchema,
  QueueSummaryRequestSchema,
  ReceiptSchema,
  ReceiptService,
  ReconciliationService,
  RequestDataExportRequestSchema,
  RequestWorkspaceDeletionRequestSchema,
  SearchFinanceRequestSchema,
  SearchService,
  SubmitPaymentRequestSchema,
  StartAuthorizationRequestSchema,
  UploadTargetSchema,
  WorkspaceService,
} from "../src/index.ts";

const contracts = [
  [WorkspaceService, ["createWorkspace", "listWorkspaces"]],
  [LedgerService, ["getAccount", "getTransaction", "listAccounts", "listTransactions"]],
  [
    ReceiptService,
    ["createReceiptUploadIntent", "finalizeReceipt", "getReceipt", "getReceiptDownloadUrl", "listReceipts"],
  ],
  [
    BankService,
    ["disconnect", "getConnectionStatus", "listAspsps", "listConnections", "queueSync", "startAuthorization"],
  ],
  [ProviderCallbackService, ["completeBankAuthorization", "completePaymentAuthorization"]],
  [ReconciliationService, ["confirm", "listUnmatched", "match", "reject"]],
  [SearchService, ["searchFinance"]],
  [AiService, ["getAiPolicy", "queueSummary", "setAiPolicy"]],
  [PaymentService, ["createPayment", "deletePayment", "getPayment", "getPaymentStatus", "listPayments", "submitPayment"]],
  [PrivacyService, ["getDataExportDownloadUrl", "getDataPrivacyStatus", "requestDataExport", "requestWorkspaceDeletion"]],
  [JobService, ["getJobStatus"]],
] as const;

type MessageDescriptor = {
  fields: readonly { proto: { name: string; proto3Optional?: boolean } }[];
};

const fieldNames = (message: MessageDescriptor) => message.fields.map((field) => field.proto.name);

const field = (message: MessageDescriptor, name: string) =>
  message.fields.find((candidate) => candidate.proto.name === name);

const uint64ContentLength: CreateReceiptUploadIntentRequest["contentLength"] = 1n;

describe("finch.v1 contracts", () => {
  it("exposes every required service method", () => {
    for (const [service, methods] of contracts) {
      expect(service.methods.map((method) => method.localName).sort()).toEqual(methods);
    }
  });

  it("keeps payment, sync, search, and upload contracts complete", () => {
    expect(fieldNames(CreatePaymentRequestSchema)).toEqual([
      "workspace_id",
      "bank_connection_id",
      "return_path",
      "creditor_name",
      "creditor_iban",
      "amount",
      "payment_type",
      "remittance",
      "idempotency_key",
    ]);
    expect(fieldNames(StartAuthorizationRequestSchema)).toEqual([
      "workspace_id",
      "aspsp_id",
      "return_path",
    ]);
    expect(fieldNames(QueueSyncRequestSchema)).toEqual([
      "workspace_id",
      "connection_id",
      "since",
      "idempotency_key",
    ]);
    expect(field(QueueSyncRequestSchema, "since")?.proto.proto3Optional).toBe(true);
    expect(fieldNames(QueueSummaryRequestSchema)).toEqual([
      "workspace_id",
      "period_start",
      "period_end",
      "idempotency_key",
    ]);
    expect(fieldNames(RequestDataExportRequestSchema)).toEqual(["workspace_id", "idempotency_key"]);
    expect(fieldNames(RequestWorkspaceDeletionRequestSchema)).toEqual([
      "workspace_id",
      "confirmed",
      "idempotency_key",
    ]);
    expect(fieldNames(SubmitPaymentRequestSchema)).toEqual([
      "workspace_id",
      "payment_id",
      "idempotency_key",
    ]);
    expect(fieldNames(SearchFinanceRequestSchema)).toEqual([
      "workspace_id",
      "query",
      "top_k",
      "candidate_multiplier",
      "page",
    ]);
    expect(fieldNames(FinanceSearchHitSchema)).toEqual([
      "entity_id",
      "entity_type",
      "title",
      "snippet",
      "fused_score",
      "dense_rank",
      "lexical_rank",
      "dense_similarity",
      "lexical_score",
      "sources",
    ]);
    expect(field(FinanceSearchHitSchema, "dense_rank")?.proto.proto3Optional).toBe(true);
    expect(field(FinanceSearchHitSchema, "lexical_rank")?.proto.proto3Optional).toBe(true);
    expect(field(FinanceSearchHitSchema, "dense_similarity")?.proto.proto3Optional).toBe(true);
    expect(field(FinanceSearchHitSchema, "lexical_score")?.proto.proto3Optional).toBe(true);
    expect(fieldNames(CreateReceiptUploadIntentRequestSchema)).toEqual([
      "workspace_id",
      "file_name",
      "content_type",
      "content_length",
      "sha256",
      "idempotency_key",
      "merchant",
      "total",
      "receipt_date",
    ]);
    expect(field(CreateReceiptUploadIntentRequestSchema, "merchant")?.proto.proto3Optional).toBe(true);
    expect(field(CreateReceiptUploadIntentRequestSchema, "receipt_date")?.proto.proto3Optional).toBe(true);
    expect(fieldNames(CreateReceiptUploadIntentResponseSchema)).toEqual(["receipt", "upload"]);
    expect(fieldNames(UploadTargetSchema)).toEqual(["url", "method", "required_headers"]);
    expect(field(ReceiptSchema, "file_name")?.proto.proto3Optional).toBe(true);
    expect(field(ReceiptSchema, "merchant")?.proto.proto3Optional).toBe(true);
    expect(field(ReceiptSchema, "receipt_date")?.proto.proto3Optional).toBe(true);
    expect(typeof uint64ContentLength).toBe("bigint");
  });

  it("preserves provider absence for optional ledger details", () => {
    expect(field(LedgerAccountSchema, "iban")?.proto.proto3Optional).toBe(true);
    expect(field(LedgerTransactionSchema, "value_date")?.proto.proto3Optional).toBe(true);
    expect(field(LedgerTransactionSchema, "merchant")?.proto.proto3Optional).toBe(true);
    expect(field(LedgerAccountSchema, "name")?.proto.proto3Optional).not.toBe(true);
    expect(field(LedgerAccountSchema, "currency")?.proto.proto3Optional).not.toBe(true);
    expect(field(LedgerAccountSchema, "account_type")?.proto.proto3Optional).not.toBe(true);
    expect(field(LedgerTransactionSchema, "amount")?.proto.proto3Optional).not.toBe(true);
    expect(field(LedgerTransactionSchema, "booking_date")?.proto.proto3Optional).not.toBe(true);
    expect(field(LedgerTransactionSchema, "description")?.proto.proto3Optional).not.toBe(true);
    expect(field(LedgerTransactionSchema, "status")?.proto.proto3Optional).not.toBe(true);
  });

  it("keeps provider callbacks server-scoped and requests free of authority fields", () => {
    expect(fieldNames(CompleteBankAuthorizationRequestSchema)).toEqual(["state", "code"]);
    expect(fieldNames(CompletePaymentAuthorizationRequestSchema)).toEqual([
      "state",
      "outcome",
      "provider_reference",
    ]);

    const forbidden = new Set([
      "tenant",
      "tenant_id",
      "user",
      "user_id",
      "role",
      "roles",
      "bearer",
      "bearer_token",
      "auth",
      "authorization",
      "principal",
      "principal_context",
    ]);
    const requestFields = contracts.flatMap(([service]) =>
      service.methods.flatMap((method) => fieldNames(method.input)),
    );

    expect(requestFields.filter((name) => forbidden.has(name))).toEqual([]);
    expect(fieldNames(CompleteBankAuthorizationRequestSchema)).not.toContain("workspace_id");
    expect(fieldNames(CompletePaymentAuthorizationRequestSchema)).not.toContain("workspace_id");
  });

  it("exports generated finch.v1 service descriptors", () => {
    for (const [service] of contracts) {
      expect(service.typeName).toMatch(/^finch\.v1\./);
    }
  });

  it("does not expose duplicate legacy Connect service descriptors", () => {
    const publicServiceTypeNames = Object.values(PublicContracts)
      .filter((value) =>
        typeof value === "object" &&
        value !== null &&
        "typeName" in value &&
        "methods" in value &&
        Array.isArray(value.methods),
      )
      .map((service) => (service as { readonly typeName: string }).typeName);

    expect(publicServiceTypeNames).not.toContain("finch.bank.v1.BankService");
    expect(publicServiceTypeNames).not.toContain("finch.search.v1.SearchService");
  });

  it("keeps provider callbacks out of public and MCP agent SDKs", () => {
    expect(PublicContracts).not.toHaveProperty("ProviderCallbackService");
    expect(AgentContracts).not.toHaveProperty("ProviderCallbackService");
    expect(Object.keys(AgentContracts.AgentServices).sort()).toEqual([
      "ai",
      "bank",
      "job",
      "ledger",
      "payment",
      "privacy",
      "receipt",
      "reconciliation",
      "search",
      "workspace",
    ]);
    expect(Object.values(AgentContracts.AgentServices)).not.toContain(ProviderCallbackService);
  });
});
