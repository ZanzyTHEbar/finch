import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeJson, encodeJson } from "../../packages/core/src/domain/events/codec.ts";
import { uuidv7 } from "../../packages/core/src/domain/events/envelope.ts";
import { IsoDate, makeIsoDate } from "../../packages/core/src/domain/time.ts";

describe("json codec", () => {
  it("round-trips bigints in nested objects and arrays", () => {
    const value = { a: 1n, nested: { b: [2n, 3n], c: "x" }, d: null };
    expect(decodeJson(encodeJson(value))).toStrictEqual(value);
  });

  it("leaves plain JSON unchanged", () => {
    const plain = { a: 1, b: "x", c: [1, 2], d: null, e: { f: true } };
    expect(encodeJson(plain)).toBe(JSON.stringify(plain));
    expect(decodeJson(JSON.stringify(plain))).toStrictEqual(plain);
  });

  it("preserves bigints beyond float precision exactly", () => {
    const value = { v: 9007199254740993n };
    const encoded = encodeJson(value);
    expect(encoded).toContain('"9007199254740993"');
    expect(decodeJson(encoded)).toStrictEqual(value);
  });

  it("throws when decoding a malformed tagged bigint", () => {
    expect(() => decodeJson('{"__bigint__":"xyz"}')).toThrowError();
  });
});

describe("iso dates", () => {
  it("rejects impossible calendar dates", () => {
    expect(() => makeIsoDate("2024-02-30")).toThrowError();
    expect(() => makeIsoDate("2023-13-01")).toThrowError();
  });

  it("accepts leap day on a leap year", () => {
    expect(makeIsoDate("2024-02-29")).toBe("2024-02-29");
  });

  it("rejects impossible dates at the Schema filter", () => {
    expect(() => Schema.decodeUnknownSync(IsoDate)("2024-02-30")).toThrowError();
  });
});

describe("uuidv7", () => {
  it("generates unique RFC 9562 v7 ids", () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = Array.from({ length: 500 }, () => uuidv7());
    for (const id of ids) {
      expect(id).toMatch(re);
    }
    expect(new Set(ids).size).toBe(500);
  });
});
