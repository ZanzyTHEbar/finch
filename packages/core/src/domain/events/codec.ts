// Canonical JSON serialization for event payloads.
//
// SQLite stores payloads as TEXT, but domain payloads carry bigint money
// (minor units), which JSON.stringify rejects. This codec tags bigints as
// {"__bigint__": "<decimal>"} on encode and revives them on decode, so
// append -> persist -> read -> project round-trips losslessly. Plain JSON
// without tagged objects decodes unchanged.
const BIGINT_TAG = "__bigint__";

const isTaggedBigint = (value: unknown): value is { readonly __bigint__: string } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === BIGINT_TAG &&
    typeof (value as Record<string, unknown>)[BIGINT_TAG] === "string"
  );
};

export const encodeJson = (value: unknown): string => {
  const text = JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === "bigint" ? { [BIGINT_TAG]: nested.toString() } : (nested as unknown),
  );
  if (typeof text !== "string") {
    throw new Error("value is not JSON-serializable");
  }
  return text;
};

export const decodeJson = (text: string): unknown =>
  JSON.parse(text, (_key, nested: unknown) =>
    isTaggedBigint(nested) ? BigInt(nested.__bigint__) : (nested as unknown),
  ) as unknown;
