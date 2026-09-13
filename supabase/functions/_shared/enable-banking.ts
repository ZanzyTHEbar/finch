import { importPKCS8, SignJWT } from "npm:jose@6.2.12";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

export interface BankAccountSnapshot {
  readonly externalRef: string;
  readonly name: string;
  readonly accountType: "checking" | "savings" | "cash" | "credit" | "other";
  readonly currency: string;
  readonly status: "active" | "closed";
}

export interface BankTransactionSnapshot {
  /** Provider transaction_id, or entry_reference when transaction_id is absent. */
  readonly externalRef: string;
  readonly bookingDate: string;
  readonly valueDate: string | undefined;
  readonly amountMinor: string;
  readonly currency: string;
  readonly rawDescription: string;
  readonly merchantName: string | undefined;
  readonly counterpartyName: string | undefined;
  readonly status: "booked" | "pending" | "reversed";
}

export interface BankPayment {
  readonly providerPaymentRef: string;
  readonly status: string;
  readonly authorizationUrl: string | undefined;
}

export type PaymentStatus = "authorization_pending" | "submitted" | "accepted" | "rejected";

export const paymentStatusFromProvider = (providerStatus: string): PaymentStatus => {
  const status = providerStatus.toUpperCase();
  if (["ACCC", "ACSC", "ACCEPTED", "COMPLETED"].includes(status)) return "accepted";
  if (["RJCT", "REJECTED", "CANCELLED", "FAILED"].includes(status)) return "rejected";
  if (["SUBMITTED", "ACTC", "ACPT", "ACSP"].includes(status)) return "submitted";
  if (["PDNG", "PENDING", "AUTHORIZATION_PENDING"].includes(status)) return "authorization_pending";
  throw new ProviderError("provider_invalid_response", false);
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const isoDate = (value: unknown): string | undefined => {
  const date = text(value);
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date ? date : undefined;
};

const providerUrl = (value: unknown): string | undefined => {
  const raw = text(value);
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const requiredEnv = (name: string): string => {
  const value = Deno.env.get(name)?.trim();
  if (value === undefined || value === "") {
    throw new Error(`missing required ${name}`);
  }
  return value;
};

const providerBaseUrl = (): string => {
  try {
    const url = new URL(requiredEnv("ENABLEBANKING_BASE_URL"));
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      throw new Error("unsafe provider base URL");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new ProviderError("provider_configuration_unavailable", false);
  }
};

const vaultSecret = async (admin: SupabaseClient, name: string): Promise<string> => {
  const { data, error } = await admin.rpc("get_worker_secret", { p_name: name });
  if (error !== null || typeof data !== "string" || data.trim() === "") {
    throw new ProviderError("provider_configuration_unavailable", false);
  }
  return data;
};

const signedToken = async (admin: SupabaseClient): Promise<string> => {
  const [applicationId, privateKey] = await Promise.all([
    vaultSecret(admin, "enablebanking_application_id"),
    vaultSecret(admin, "enablebanking_private_key"),
  ]);
  try {
    const key = await importPKCS8(privateKey, "RS256");
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({})
      .setProtectedHeader({ typ: "JWT", alg: "RS256", kid: applicationId })
      .setIssuer("enablebanking.com")
      .setAudience("api.enablebanking.com")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
  } catch {
    throw new ProviderError("provider_configuration_unavailable", false);
  }
};

const readBody = async (response: Response): Promise<string> => {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new ProviderError("provider_response_too_large", false);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
};

const readJson = async (response: Response, expectJson: boolean): Promise<unknown> => {
  const body = await readBody(response);
  if (body.length > 65536) {
    throw new ProviderError("provider_response_too_large", false);
  }
  if (!response.ok) {
    throw new ProviderError(`provider_http_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
  }
  if (!expectJson) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ProviderError("provider_invalid_response", false);
  }
};

const request = async (
  admin: SupabaseClient,
  method: string,
  path: string,
  body?: unknown,
  expectJson = true,
): Promise<unknown> => {
  const baseUrl = providerBaseUrl();
  const [jwt, psuIp, psuAgent] = await Promise.all([
    signedToken(admin),
    vaultSecret(admin, "enablebanking_psu_ip"),
    vaultSecret(admin, "enablebanking_psu_user_agent"),
  ]);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "psu-ip-address": psuIp,
        "psu-user-agent": psuAgent,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return await readJson(response, expectJson);
  } catch (cause) {
    if (cause instanceof ProviderError) {
      throw cause;
    }
    throw new ProviderError("provider_network_failure", true);
  }
};

const zeroDecimalCurrencies = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const threeDecimalCurrencies = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

const currencyDecimals = (currency: string): number =>
  zeroDecimalCurrencies.has(currency) ? 0 : threeDecimalCurrencies.has(currency) ? 3 : currency === "CLF" ? 4 : 2;

const amountMinor = (value: string, currency: string, indicator: string): string | undefined => {
  if (!/^-?\d+(\.\d+)?$/.test(value) || !/^[A-Z]{3}$/.test(currency) || (indicator !== "CRDT" && indicator !== "DBIT")) {
    return undefined;
  }
  const negative = value.startsWith("-");
  const [wholeRaw, fractionRaw = ""] = (negative ? value.slice(1) : value).split(".");
  const decimals = currencyDecimals(currency);
  if (wholeRaw === undefined || fractionRaw.length > decimals) {
    return undefined;
  }
  const raw = BigInt(wholeRaw) * BigInt(10 ** decimals) + BigInt((fractionRaw + "0".repeat(decimals)).slice(0, decimals) || "0");
  const signed = indicator === "DBIT" ? -raw : raw;
  return (negative ? -signed : signed).toString();
};

const mapAccount = (value: unknown, fallback?: string): BankAccountSnapshot | undefined => {
  const raw = record(value);
  const accountId = record(raw?.account_id);
  const externalRef = text(raw?.uid) ?? text(accountId?.iban) ?? fallback;
  const currency = text(raw?.currency);
  if (externalRef === undefined || currency === undefined || !/^[A-Z]{3}$/.test(currency)) {
    return undefined;
  }
  const kind = text(raw?.cash_account_type)?.toLowerCase();
  const accountType = kind?.includes("saving") ? "savings" : kind?.includes("credit") ? "credit" : kind?.includes("cash") ? "cash" : kind?.includes("current") ? "checking" : "other";
  return {
    externalRef,
    name: text(raw?.name) ?? text(raw?.product) ?? externalRef,
    accountType,
    currency,
    status: "active",
  };
};

const mapTransaction = (value: unknown): BankTransactionSnapshot | undefined => {
  const raw = record(value);
  const bookingDate = isoDate(raw?.booking_date);
  const indicator = text(raw?.credit_debit_indicator);
  const amount = record(raw?.transaction_amount);
  const currency = text(amount?.currency);
  const minor = currency === undefined ? undefined : amountMinor(text(amount?.amount) ?? "", currency, indicator ?? "");
  const providerStatus = text(raw?.status)?.toUpperCase();
  const status = providerStatus === "BOOK" ? "booked" : providerStatus === "PDNG" ? "pending" : providerStatus === "RVSL" ? "reversed" : undefined;
  const valueDate = raw?.value_date === undefined ? undefined : isoDate(raw.value_date);
  if (bookingDate === undefined || currency === undefined || minor === undefined || status === undefined || (raw?.value_date !== undefined && valueDate === undefined)) {
    return undefined;
  }
  const creditor = text(record(raw?.creditor)?.name);
  const debtor = text(record(raw?.debtor)?.name);
  const remittance = raw?.remittance_information;
  const remittanceText = typeof remittance === "string" ? remittance : text(record(remittance)?.unstructured) ?? "";
  const transactionId = text(raw?.transaction_id);
  const entryReference = text(raw?.entry_reference);
  const externalRef = transactionId === undefined
    ? entryReference === undefined ? undefined : `entry:${entryReference}`
    : `transaction:${transactionId}`;
  if (externalRef === undefined) {
    // Without a provider identifier there is no safe dedupe key. Dropping the
    // row is safer than merging two same-day, same-amount transactions.
    return undefined;
  }
  return {
    externalRef,
    bookingDate,
    valueDate,
    amountMinor: minor,
    currency,
    rawDescription: remittanceText || creditor || debtor || "",
    merchantName: text(record(raw?.merchant)?.name),
    counterpartyName: indicator === "DBIT" ? creditor : debtor,
    status,
  };
};

export const startAuthorization = async (
  admin: SupabaseClient,
  input: { aspspName: string; aspspCountry: string; redirectUrl: string; state: string },
): Promise<string> => {
  const body = await request(admin, "POST", "/auth", {
    access: { valid_until: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() },
    aspsp: { name: input.aspspName, country: input.aspspCountry },
    state: input.state,
    redirect_url: input.redirectUrl,
    psu_type: "personal",
  });
  const url = providerUrl(record(body)?.url);
  if (url === undefined) {
    throw new ProviderError("provider_invalid_response", false);
  }
  return url;
};

export const createSession = async (admin: SupabaseClient, code: string): Promise<string> => {
  const body = await request(admin, "POST", "/sessions", { code });
  const sessionId = text(record(body)?.session_id);
  if (sessionId === undefined) {
    throw new ProviderError("provider_invalid_response", false);
  }
  return sessionId;
};

const sessionAccountIds = async (admin: SupabaseClient, sessionId: string): Promise<readonly string[]> => {
  const body = await request(admin, "GET", `/sessions/${encodeURIComponent(sessionId)}`);
  const accounts = record(body)?.accounts;
  if (!Array.isArray(accounts)) throw new ProviderError("provider_invalid_response", false);
  const ids: string[] = [];
  for (const account of accounts) {
    const id = text(account);
    if (id === undefined) throw new ProviderError("provider_invalid_response", false);
    ids.push(id);
  }
  return ids;
};

export const listAccounts = async (admin: SupabaseClient, sessionId: string): Promise<readonly BankAccountSnapshot[]> => {
  const ids = await sessionAccountIds(admin, sessionId);
  return await Promise.all(ids.map(async (id) => {
    const account = mapAccount(await request(admin, "GET", `/accounts/${encodeURIComponent(id)}/details`), id);
    if (account === undefined) throw new ProviderError("provider_invalid_response", false);
    return account;
  }));
};

export const listTransactions = async (
  admin: SupabaseClient,
  sessionId: string,
  accountRef: string,
  since?: string,
): Promise<readonly BankTransactionSnapshot[]> => {
  const knownAccounts = await sessionAccountIds(admin, sessionId);
  if (!knownAccounts.includes(accountRef)) {
    throw new ProviderError("provider_account_not_authorized", false);
  }
  const output: BankTransactionSnapshot[] = [];
  let continuation: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ transaction_status: "BOOK" });
    if (since !== undefined) query.set("date_from", since);
    if (continuation !== undefined) query.set("continuation_key", continuation);
    const body = await request(admin, "GET", `/accounts/${encodeURIComponent(accountRef)}/transactions?${query}`);
    const raw = record(body);
    const rows = raw?.transactions;
    if (!Array.isArray(rows) || (raw?.continuation_key !== undefined && typeof raw.continuation_key !== "string")) {
      throw new ProviderError("provider_invalid_response", false);
    }
    for (const row of rows) {
      const mapped = mapTransaction(row);
      if (mapped === undefined) throw new ProviderError("provider_invalid_response", false);
      if (mapped.status === "booked" && mapped.amountMinor !== "0") output.push(mapped);
    }
    const next = text(raw?.continuation_key);
    if (next === undefined || next === continuation) return output;
    continuation = next;
  }
  throw new ProviderError("provider_pagination_limit", false);
};

export const deleteSession = async (admin: SupabaseClient, sessionId: string): Promise<void> => {
  try {
    await request(admin, "DELETE", `/sessions/${encodeURIComponent(sessionId)}`, undefined, false);
  } catch (cause) {
    if (cause instanceof ProviderError && cause.code === "provider_http_404") return;
    throw cause;
  }
};

const paymentFrom = (body: unknown): BankPayment => {
  const raw = record(body);
  const providerPaymentRef = text(raw?.payment_id);
  const status = text(raw?.status);
  if (providerPaymentRef === undefined || status === undefined) throw new ProviderError("provider_invalid_response", false);
  if (raw?.url === undefined) return { providerPaymentRef, status, authorizationUrl: undefined };
  const authorizationUrl = providerUrl(raw.url);
  if (authorizationUrl === undefined) throw new ProviderError("provider_invalid_response", false);
  return { providerPaymentRef, status, authorizationUrl };
};

export const getPayment = async (admin: SupabaseClient, providerPaymentRef: string): Promise<BankPayment> =>
  paymentFrom(await request(admin, "GET", `/payments/${encodeURIComponent(providerPaymentRef)}`));
