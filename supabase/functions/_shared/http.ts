export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const headers = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-finch-workspace, x-worker-token",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers });

export const noContent = (): Response => new Response(null, { status: 204, headers });

export const options = (): Response => new Response(null, { status: 204, headers });

export const errorResponse = (cause: unknown): Response => {
  if (cause instanceof HttpError) {
    return json({ error: cause.code }, cause.status);
  }
  console.error("finch edge function failed", cause instanceof Error ? cause.message : String(cause));
  return json({ error: "internal_error" }, 500);
};

export const requireObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_json");
  }
  return value as Record<string, unknown>;
};

export const requireString = (value: unknown, field: string, maxLength = 500): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new HttpError(400, `invalid_${field}`);
  }
  return value.trim();
};

export const requireUuid = (value: unknown, field: string): string => {
  const text = requireString(value, field, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new HttpError(400, `invalid_${field}`);
  }
  return text;
};

export const parseJson = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    return requireObject(await request.json());
  } catch (cause) {
    if (cause instanceof HttpError) {
      throw cause;
    }
    throw new HttpError(400, "invalid_json");
  }
};
