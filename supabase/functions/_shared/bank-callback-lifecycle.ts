export type BankAuthorizationCompletion = "connected" | "revoked" | "revocation_pending" | "compensation_failed";

export interface BankAuthorizationLifecycle {
  readonly createSession: (code: string) => Promise<string>;
  readonly storeSecret: (session: string) => Promise<void>;
  readonly activate: () => Promise<void>;
  readonly enqueue: () => Promise<void>;
  readonly auditSuccess: () => Promise<void>;
  readonly markRevocationPending: (safeErrorCode: string) => Promise<void>;
  readonly revokeRemoteSession: (session: string) => Promise<void>;
  readonly completeDisconnect: () => Promise<void>;
  readonly auditRevocationPending: (safeErrorCode: string) => Promise<void>;
}

export interface UnstoredBankSessionLifecycle {
  readonly markRevocationPending: (safeErrorCode: string) => Promise<void>;
  readonly revokeRemoteSession: (session: string) => Promise<void>;
  readonly completeDisconnect: () => Promise<void>;
  readonly markError: (safeErrorCode: string) => Promise<void>;
  readonly auditFailure: (safeErrorCode: string) => Promise<void>;
}

const activationFailure = "bank_connection_activation_failed";

const auditRevocationPending = async (lifecycle: BankAuthorizationLifecycle, safeErrorCode: string): Promise<void> => {
  try {
    await lifecycle.auditRevocationPending(safeErrorCode);
  } catch {
    // The connection remains revocation_pending even when the audit store is unavailable.
  }
};

export const completeBankAuthorization = async (
  lifecycle: BankAuthorizationLifecycle,
  code: string,
): Promise<BankAuthorizationCompletion> => {
  const session = await lifecycle.createSession(code);
  await lifecycle.storeSecret(session);
  try {
    await lifecycle.activate();
    await lifecycle.enqueue();
    await lifecycle.auditSuccess();
    return "connected";
  } catch {
    try {
      await lifecycle.markRevocationPending(activationFailure);
    } catch {
      try {
        await lifecycle.revokeRemoteSession(session);
      } catch {
        // Do not overwrite an unavailable revocation state with an error state.
        return "compensation_failed";
      }
      try {
        await lifecycle.completeDisconnect();
        return "revoked";
      } catch {
        return "compensation_failed";
      }
    }
    try {
      await lifecycle.revokeRemoteSession(session);
    } catch {
      await auditRevocationPending(lifecycle, activationFailure);
      return "revocation_pending";
    }
    try {
      await lifecycle.completeDisconnect();
      return "revoked";
    } catch {
      await auditRevocationPending(lifecycle, activationFailure);
      return "revocation_pending";
    }
  }
};

export const compensateUnstoredBankSession = async (
  lifecycle: UnstoredBankSessionLifecycle,
  session: string,
  safeErrorCode: string,
): Promise<"revoked" | "error"> => {
  try {
    await lifecycle.revokeRemoteSession(session);
    await lifecycle.markRevocationPending(safeErrorCode);
    await lifecycle.completeDisconnect();
    return "revoked";
  } catch {
    try {
      await lifecycle.markError(safeErrorCode);
    } catch {
      // A storage outage cannot be made safe by retrying in this callback.
    }
    try {
      await lifecycle.auditFailure(safeErrorCode);
    } catch {
      // Do not replace the safe redirect with an audit failure.
    }
    return "error";
  }
};
