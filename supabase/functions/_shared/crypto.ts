import { HttpError } from "./http.ts";

const toBinary = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

export const randomState = (): string =>
  btoa(toBinary(crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

export const sha256 = async (text: string | ArrayBuffer): Promise<Uint8Array> => {
  const data = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
};

export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const bytea = (bytes: Uint8Array): string => `\\x${hex(bytes)}`;

export const sha256Bytea = async (text: string | ArrayBuffer): Promise<string> => bytea(await sha256(text));

export const requireSha256Hex = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new HttpError(400, "invalid_sha256");
  }
  return value.toLowerCase();
};

export const byteaFromHex = (value: string): string => `\\x${value}`;
