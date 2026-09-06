import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ValidationFailed } from "../../packages/core/src/domain/errors.ts";
import {
  CurrencyCode,
  normalizeCurrency,
  toMajor,
  toMinor,
} from "../../packages/core/src/domain/money.ts";

describe("money", () => {
  it("converts major units to minor units (default USD, exponent 2)", () => {
    expect(toMinor("12.34")).toBe(1234n);
    expect(toMinor("0.01")).toBe(1n);
    expect(toMinor("-3.50")).toBe(-350n);
    expect(toMajor(1234n)).toBe("12.34");
  });

  it("round-trips minor -> major -> minor per currency exponent", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -99999999999n, max: 99999999999n }),
        fc.constantFrom("USD", "JPY", "BHD"),
        (minor, currency) => {
          expect(toMinor(toMajor(minor, currency), currency)).toBe(minor);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects fraction digits beyond the currency exponent with ValidationFailed", () => {
    expect(() => toMinor("1.239", "USD")).toThrowError(ValidationFailed);
    expect(() => toMinor("1.999", "USD")).toThrowError(ValidationFailed);
    expect(() => toMinor("1.5", "JPY")).toThrowError(ValidationFailed);
    expect(() => toMinor("1.2345", "BHD")).toThrowError(ValidationFailed);
    try {
      toMinor("1.239", "USD");
      expect.unreachable("excess scale must throw");
    } catch (error) {
      expect((error as ValidationFailed)._tag).toBe("ValidationFailed");
    }
  });

  it("supports zero-exponent currencies (JPY)", () => {
    expect(toMinor("500", "JPY")).toBe(500n);
    expect(toMinor("-500", "JPY")).toBe(-500n);
    expect(toMajor(500n, "JPY")).toBe("500");
    expect(toMajor(-500n, "JPY")).toBe("-500");
  });

  it("supports three-decimal currencies (BHD)", () => {
    expect(toMinor("1.234", "BHD")).toBe(1234n);
    expect(toMinor("0.001", "BHD")).toBe(1n);
    expect(toMajor(1234n, "BHD")).toBe("1.234");
  });

  it("handles negative amounts", () => {
    expect(toMinor("-3.50", "USD")).toBe(-350n);
    expect(toMajor(-350n, "USD")).toBe("-3.50");
    expect(toMinor(toMajor(-1234n, "BHD"), "BHD")).toBe(-1234n);
    expect(toMinor(toMajor(-500n, "JPY"), "JPY")).toBe(-500n);
  });

  it("rejects invalid decimal amounts with RangeError", () => {
    for (const bad of ["abc", "1.2.3", ""]) {
      expect(() => toMinor(bad)).toThrowError(RangeError);
    }
  });

  it("rejects unknown currency codes with ValidationFailed", () => {
    expect(() => toMinor("1.00", "ZZZ")).toThrowError(ValidationFailed);
    expect(() => toMajor(100n, "ZZZ")).toThrowError(ValidationFailed);
  });

  it("normalizes currency codes to uppercase", () => {
    expect(normalizeCurrency("usd")).toBe("USD");
    expect(normalizeCurrency("EUR")).toBe("EUR");
  });

  it("rejects invalid currency codes on Schema decode", () => {
    for (const bad of ["US", "usd1", "EURO"]) {
      expect(() => Schema.decodeUnknownSync(CurrencyCode)(bad)).toThrowError();
    }
  });
});
