import { HttpError } from "./http.ts";

const invalid = (): never => {
  throw new HttpError(400, "invalid_return_path");
};

const unsafe = (value: string): boolean => /[\\\u0000-\u001F\u007F-\u009F]/.test(value) || !/^\/(?!\/)/.test(value);

export const requireReturnPath = (value: unknown): string => {
  if (typeof value !== "string") return invalid();
  const returnPath = value;
  if (returnPath.length === 0 || returnPath.length > 2000 || unsafe(returnPath)) invalid();
  try {
    if (unsafe(decodeURIComponent(returnPath))) invalid();
  } catch {
    invalid();
  }
  return returnPath;
};
