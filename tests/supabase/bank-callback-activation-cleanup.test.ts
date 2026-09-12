import { describe, expect, it } from "vitest";
import { compensateUnstoredBankSession, completeBankAuthorization } from "../../supabase/functions/_shared/bank-callback-lifecycle.ts";

type PostStorageFailure = "activate" | "enqueue" | "auditSuccess";
type Completion = "connected" | "revoked" | "revocation_pending" | "compensation_failed";

type CallbackLifecycle = {
  readonly createSession: (code: string) => Promise<string>;
  readonly storeSecret: (session: string) => Promise<void>;
  readonly activate: () => Promise<void>;
  readonly enqueue: () => Promise<void>;
  readonly auditSuccess: () => Promise<void>;
  readonly markRevocationPending: (safeErrorCode: string) => Promise<void>;
  readonly revokeRemoteSession: (session: string) => Promise<void>;
  /** Atomically destroys the Vault secret, marks revoked, and records success. */
  readonly completeDisconnect: () => Promise<void>;
  readonly auditRevocationPending: (safeErrorCode: string) => Promise<void>;
};

type CompleteBankAuthorization = (lifecycle: CallbackLifecycle, code: string) => Promise<Completion>;

const postStorageFailures: readonly PostStorageFailure[] = ["activate", "enqueue", "auditSuccess"];

describe("bank callback post-storage compensation", () => {
  it.each(postStorageFailures)("revokes remotely before destroying the local secret when %s fails", async (failure) => {
    const calls: string[] = [];
    const lifecycle: CallbackLifecycle = {
      createSession: async () => {
        calls.push("create");
        return "provider-session";
      },
      storeSecret: async () => { calls.push("store"); },
      activate: async () => {
        calls.push("activate");
        if (failure === "activate") throw new Error("activation unavailable");
      },
      enqueue: async () => {
        calls.push("enqueue");
        if (failure === "enqueue") throw new Error("enqueue unavailable");
      },
      auditSuccess: async () => {
        calls.push("audit-success");
        if (failure === "auditSuccess") throw new Error("audit unavailable");
      },
      markRevocationPending: async () => { calls.push("mark-revocation-pending"); },
      revokeRemoteSession: async () => { calls.push("revoke-remote"); },
      completeDisconnect: async () => { calls.push("complete-disconnect"); },
      auditRevocationPending: async () => { calls.push("audit-revocation-pending"); },
    };
    const complete: CompleteBankAuthorization = completeBankAuthorization;

    await expect(complete(lifecycle, "authorization-code")).resolves.toBe("revoked");
    expect(calls).toContain("revoke-remote");
    expect(calls.indexOf("revoke-remote")).toBeLessThan(calls.indexOf("complete-disconnect"));
  });

  it("keeps a stored secret retryable when remote revocation fails", async () => {
    const calls: string[] = [];
    const lifecycle: CallbackLifecycle = {
      createSession: async () => "provider-session",
      storeSecret: async () => { calls.push("store"); },
      activate: async () => { throw new Error("activation unavailable"); },
      enqueue: async () => { calls.push("enqueue"); },
      auditSuccess: async () => { calls.push("audit-success"); },
      markRevocationPending: async () => { calls.push("mark-revocation-pending"); },
      revokeRemoteSession: async () => {
        calls.push("revoke-remote");
        throw new Error("provider unavailable");
      },
      completeDisconnect: async () => { calls.push("complete-disconnect"); },
      auditRevocationPending: async () => { calls.push("audit-revocation-pending"); },
    };
    const complete: CompleteBankAuthorization = completeBankAuthorization;

    await expect(complete(lifecycle, "authorization-code")).resolves.toBe("revocation_pending");
    expect(calls).toEqual(["store", "mark-revocation-pending", "revoke-remote", "audit-revocation-pending"]);
  });

  it("reports a distinct safe compensation failure after storage when revocation marking fails", async () => {
    const calls: string[] = [];
    const lifecycle: CallbackLifecycle = {
      createSession: async () => "provider-session",
      storeSecret: async () => { calls.push("store"); },
      activate: async () => { throw new Error("activation unavailable"); },
      enqueue: async () => { calls.push("enqueue"); },
      auditSuccess: async () => { calls.push("audit-success"); },
      markRevocationPending: async () => {
        calls.push("mark-revocation-pending");
        throw new Error("status storage unavailable");
      },
      revokeRemoteSession: async () => { calls.push("revoke-remote"); },
      completeDisconnect: async () => { calls.push("complete-disconnect"); },
      auditRevocationPending: async () => { calls.push("audit-revocation-pending"); },
    };
    const complete: CompleteBankAuthorization = completeBankAuthorization;

    await expect(complete(lifecycle, "authorization-code")).resolves.toBe("compensation_failed");
    expect(calls).toEqual(["store", "mark-revocation-pending", "revoke-remote"]);
  });

  it("revokes an unstored session before completing the local disconnect", async () => {
    const calls: string[] = [];
    await expect(compensateUnstoredBankSession({
      markRevocationPending: async () => { calls.push("mark-revocation-pending"); },
      revokeRemoteSession: async () => { calls.push("revoke-remote"); },
      completeDisconnect: async () => { calls.push("complete-disconnect"); },
      markError: async () => { calls.push("mark-error"); },
      auditFailure: async () => { calls.push("audit-failure"); },
    }, "provider-session", "bank_connection_storage_failed")).resolves.toBe("revoked");
    expect(calls).toEqual(["revoke-remote", "mark-revocation-pending", "complete-disconnect"]);
  });

  it("keeps an unstored session as a safe error when remote revocation fails", async () => {
    const calls: string[] = [];
    await expect(compensateUnstoredBankSession({
      markRevocationPending: async () => { calls.push("mark-revocation-pending"); },
      revokeRemoteSession: async () => {
        calls.push("revoke-remote");
        throw new Error("provider unavailable");
      },
      completeDisconnect: async () => { calls.push("complete-disconnect"); },
      markError: async () => { calls.push("mark-error"); },
      auditFailure: async () => { calls.push("audit-failure"); },
    }, "provider-session", "bank_connection_storage_failed")).resolves.toBe("error");
    expect(calls).toEqual(["revoke-remote", "mark-error", "audit-failure"]);
  });
});
