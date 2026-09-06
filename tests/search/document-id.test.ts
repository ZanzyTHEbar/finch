import { describe, expect, it } from "vitest";
import { formatDocumentId, parseDocumentId } from "../../packages/search/src/document-id.ts";

describe("document ids", () => {
  it("round-trips sourceType and sourceId", () => {
    expect(parseDocumentId(formatDocumentId("transaction", "tx-1"))).toStrictEqual({
      sourceType: "transaction",
      sourceId: "tx-1",
    });
  });

  it("keeps extra colons inside sourceId", () => {
    expect(parseDocumentId("receipt:rc:a:b")).toStrictEqual({
      sourceType: "receipt",
      sourceId: "rc:a:b",
    });
  });

  it("rejects malformed ids with null", () => {
    for (const bad of ["", ":", "nocolon", ":noseparator", "type:"]) {
      expect(parseDocumentId(bad)).toBeNull();
    }
  });
});
