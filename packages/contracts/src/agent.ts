import { AiService } from "./gen/finch/v1/ai_pb.ts";
import { BankService } from "./gen/finch/v1/bank_pb.ts";
import { JobService } from "./gen/finch/v1/job_pb.ts";
import { LedgerService } from "./gen/finch/v1/ledger_pb.ts";
import { PaymentService } from "./gen/finch/v1/payment_pb.ts";
import { PrivacyService } from "./gen/finch/v1/privacy_pb.ts";
import { ReconciliationService } from "./gen/finch/v1/reconciliation_pb.ts";
import { ReceiptService } from "./gen/finch/v1/receipt_pb.ts";
import { SearchService } from "./gen/finch/v1/search_pb.ts";
import { WorkspaceService } from "./gen/finch/v1/workspace_pb.ts";

// Preloaded MCP exec surface. Keep this explicit: the isolate has no dynamic
// imports and provider callbacks are available only to HTTPS adapters.
export const AgentServices = {
  ai: AiService,
  bank: BankService,
  job: JobService,
  ledger: LedgerService,
  payment: PaymentService,
  privacy: PrivacyService,
  reconciliation: ReconciliationService,
  receipt: ReceiptService,
  search: SearchService,
  workspace: WorkspaceService,
} as const;

export {
  AiService,
  BankService,
  JobService,
  LedgerService,
  PaymentService,
  PrivacyService,
  ReconciliationService,
  ReceiptService,
  SearchService,
  WorkspaceService,
};
