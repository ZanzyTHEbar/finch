import { sha256Bytea } from "../_shared/crypto.ts";
import { compensateUnstoredBankSession, completeBankAuthorization } from "../_shared/bank-callback-lifecycle.ts";
import { createSession, deleteSession, getPayment, paymentStatusFromProvider, ProviderError, type BankPayment } from "../_shared/enable-banking.ts";
import { errorResponse, HttpError, options } from "../_shared/http.ts";
import { requireReturnPath } from "../_shared/return-path.ts";
import { adminClient } from "../_shared/supabase.ts";

const publicAppOrigin = (): string => {
  const value = Deno.env.get("FINCH_PUBLIC_APP_ORIGIN")?.trim();
  if (value === undefined || value === "") throw new Error("missing required FINCH_PUBLIC_APP_ORIGIN");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("FINCH_PUBLIC_APP_ORIGIN must be an https origin");
  }
  return url.origin;
};

const redirect = (returnPath: string, flow: "bank" | "payment", outcome: "connected" | "completed" | "failed" | "pending" | "unknown"): Response => {
  const target = new URL(requireReturnPath(returnPath), publicAppOrigin());
  target.searchParams.append(flow, outcome);
  return Response.redirect(target.toString(), 303);
};

type PaymentCallback = {
  readonly provider_payment_ref: string | null;
};

type PaymentCallbackResolution = {
  readonly payment_id: string;
  readonly workspace_id: string;
  readonly user_id: string;
  readonly return_path: string;
  readonly status: string;
};

const paymentCallback = async (admin: ReturnType<typeof adminClient>, stateHash: string): Promise<PaymentCallback> => {
  const { data, error } = await admin
    .from("payment_orders")
    .select("provider_payment_ref")
    .eq("state_hash", stateHash)
    .is("state_used_at", null)
    .gt("state_expires_at", new Date().toISOString())
    .maybeSingle();
  if (error !== null) throw new HttpError(500, "storage_unavailable");
  if (data === null) throw new HttpError(400, "invalid_bank_callback");
  return data as PaymentCallback;
};

const resolvePaymentCallback = async (
  admin: ReturnType<typeof adminClient>,
  stateHash: string,
  resolution: "provider_error" | "verification_failed" | "verified",
  providerPayment?: BankPayment,
): Promise<PaymentCallbackResolution> => {
  const { data, error } = await admin.rpc("resolve_payment_callback", {
    p_state_hash: stateHash,
    p_resolution: resolution,
    p_provider_payment_ref: providerPayment?.providerPaymentRef ?? null,
    p_provider_status: providerPayment?.status ?? null,
    p_resolved_status: providerPayment === undefined ? null : paymentStatusFromProvider(providerPayment.status),
  });
  if (error !== null || !Array.isArray(data)) throw new HttpError(500, "storage_unavailable");
  if (data.length !== 1) throw new HttpError(400, "invalid_bank_callback");
  return data[0] as PaymentCallbackResolution;
};

const paymentOutcome = (status: string): "completed" | "failed" | "pending" | "unknown" =>
  status === "accepted" ? "completed" : status === "rejected" ? "failed" : status === "submission_unknown" ? "unknown" : "pending";

const audit = async (
  admin: ReturnType<typeof adminClient>,
  workspaceId: string,
  userId: string,
  resourceType: "bank_connection" | "payment_order",
  resourceId: string,
  action: string,
  outcome: "success" | "failed",
  safeErrorCode?: string,
): Promise<void> => {
  const { error } = await admin.from("audit_events").insert({
    workspace_id: workspaceId,
    actor_id: userId,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    outcome,
    safe_error_code: safeErrorCode,
  });
  if (error !== null) throw new HttpError(500, "storage_unavailable");
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return options();
  try {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (state === null || state.length > 1024 || (code !== null && code.length > 4096)) {
      throw new HttpError(400, "invalid_bank_callback");
    }
    const admin = adminClient();
    const stateHash = await sha256Bytea(state);
    const { data: bankStates, error: bankStateError } = await admin.rpc("consume_bank_authorization", { p_state_hash: stateHash });
    if (bankStateError !== null || !Array.isArray(bankStates)) throw new HttpError(500, "storage_unavailable");
    if (bankStates.length === 1) {
      const authorization = bankStates[0] as {
        workspace_id: string;
        connection_id: string;
        user_id: string;
        return_path: string;
      };
      if (url.searchParams.has("error") || code === null || code === "") {
        const { data, error } = await admin
          .from("bank_connections")
          .update({ status: "error", safe_error_code: "bank_authorization_failed" })
          .eq("id", authorization.connection_id)
          .eq("workspace_id", authorization.workspace_id)
          .eq("status", "authorization_pending")
          .select("id")
          .maybeSingle();
        if (error !== null || data === null) throw new HttpError(500, "storage_unavailable");
        await audit(admin, authorization.workspace_id, authorization.user_id, "bank_connection", authorization.connection_id, "bank.authorization.failed", "failed", "bank_authorization_failed");
        return redirect(authorization.return_path, "bank", "failed");
      }
      let session: string | undefined;
      let secretStored = false;
      let revocationPending = false;
      const markRevocationPending = async (safeErrorCode: string): Promise<void> => {
        const { error } = await admin
          .from("bank_connections")
          .update({ status: "revocation_pending", safe_error_code: safeErrorCode })
          .eq("id", authorization.connection_id)
          .eq("workspace_id", authorization.workspace_id);
        if (error !== null) throw new HttpError(500, "storage_unavailable");
        revocationPending = true;
      };
      const completeDisconnect = async (): Promise<void> => {
        const { data, error } = await admin.rpc("complete_bank_disconnect", {
          p_workspace_id: authorization.workspace_id,
          p_connection_id: authorization.connection_id,
          p_actor_id: authorization.user_id,
        });
        if (error !== null || data !== true) throw new HttpError(500, "storage_unavailable");
        revocationPending = false;
      };
      const markError = async (safeErrorCode: string): Promise<void> => {
        const { error } = await admin
          .from("bank_connections")
          .update({ status: "error", safe_error_code: safeErrorCode })
          .eq("id", authorization.connection_id)
          .eq("workspace_id", authorization.workspace_id);
        if (error !== null) throw new HttpError(500, "storage_unavailable");
        revocationPending = false;
      };
      try {
        const completion = await completeBankAuthorization({
          createSession: async (callbackCode) => {
            session = await createSession(admin, callbackCode);
            return session;
          },
          storeSecret: async (sessionSecret) => {
            const { error } = await admin.rpc("store_pending_bank_connection_secret", {
              p_connection_id: authorization.connection_id,
              p_session_secret: sessionSecret,
            });
            if (error !== null) throw new HttpError(500, "storage_unavailable");
            secretStored = true;
          },
          activate: async () => {
            const { data, error } = await admin
              .from("bank_connections")
              .update({
                status: "active",
                consent_expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
                safe_error_code: null,
              })
              .eq("id", authorization.connection_id)
              .eq("workspace_id", authorization.workspace_id)
              .eq("status", "authorization_pending")
              .select("id")
              .maybeSingle();
            if (error !== null || data === null) throw new HttpError(500, "storage_unavailable");
          },
          enqueue: async () => {
            const { error } = await admin.rpc("enqueue_finch_job", {
              p_workspace_id: authorization.workspace_id,
              p_kind: "bank.sync",
              p_payload: { connection_id: authorization.connection_id },
              p_idempotency_key: `initial:${authorization.connection_id}`,
            });
            if (error !== null) throw new HttpError(500, "job_enqueue_failed");
          },
          auditSuccess: async () =>
            await audit(admin, authorization.workspace_id, authorization.user_id, "bank_connection", authorization.connection_id, "bank.authorization.completed", "success"),
          markRevocationPending,
          revokeRemoteSession: async (sessionSecret) => await deleteSession(admin, sessionSecret),
          completeDisconnect,
          auditRevocationPending: async (safeErrorCode) =>
            await audit(admin, authorization.workspace_id, authorization.user_id, "bank_connection", authorization.connection_id, "bank.authorization.revocation_pending", "failed", safeErrorCode),
        }, code);
        return redirect(authorization.return_path, "bank", completion === "connected" ? "connected" : "failed");
      } catch (cause) {
        if (session !== undefined && !secretStored) {
          await compensateUnstoredBankSession({
            markRevocationPending,
            revokeRemoteSession: async (sessionSecret) => await deleteSession(admin, sessionSecret),
            completeDisconnect,
            markError,
            auditFailure: async (safeErrorCode) =>
              await audit(admin, authorization.workspace_id, authorization.user_id, "bank_connection", authorization.connection_id, "bank.authorization.failed", "failed", safeErrorCode),
          }, session, "bank_connection_storage_failed");
          return redirect(authorization.return_path, "bank", "failed");
        }
        if (revocationPending) return redirect(authorization.return_path, "bank", "failed");
        const safeErrorCode = cause instanceof ProviderError ? cause.code : "bank_connection_activation_failed";
        await markError(safeErrorCode);
        await audit(admin, authorization.workspace_id, authorization.user_id, "bank_connection", authorization.connection_id, "bank.authorization.failed", "failed", safeErrorCode);
        return redirect(authorization.return_path, "bank", "failed");
      }
    }
    if (bankStates.length !== 0) throw new HttpError(500, "storage_unavailable");

    if (url.searchParams.has("error")) {
      const payment = await resolvePaymentCallback(admin, stateHash, "provider_error");
      return redirect(payment.return_path, "payment", paymentOutcome(payment.status));
    }

    const pendingPayment = await paymentCallback(admin, stateHash);
    let providerPayment: BankPayment;
    try {
      if (pendingPayment.provider_payment_ref === null || pendingPayment.provider_payment_ref === "") {
        throw new ProviderError("payment_provider_verification_failed", false);
      }
      providerPayment = await getPayment(admin, pendingPayment.provider_payment_ref);
      if (providerPayment.providerPaymentRef !== pendingPayment.provider_payment_ref) {
        throw new ProviderError("payment_provider_verification_failed", false);
      }
    } catch {
      const payment = await resolvePaymentCallback(admin, stateHash, "verification_failed");
      return redirect(payment.return_path, "payment", paymentOutcome(payment.status));
    }
    const payment = await resolvePaymentCallback(admin, stateHash, "verified", providerPayment);
    return redirect(payment.return_path, "payment", paymentOutcome(payment.status));
  } catch (cause) {
    return errorResponse(cause);
  }
});
