import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CurrencyCode,
  normalizeCurrency,
  toMajor,
  toMinor,
} from "../../packages/core/src/domain/money.ts";

describe("money", () => {
  it("converts major units to minor units", () => {
    expect(toMinor("12.34")).toBe(1234n);
    expect(toMinor("0.01")).toBe(1n);
    expect(toMinor("-3.50")).toBe(-350n);
    expect(toMajor(1234n)).toBe("12.34");
  });

  it("round-trips minor -> major -> minor", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -99999999999n, max: 99999999999n }),
        fc.integer({ min: 0, max: 3 }),
        (minor, fractionDigits) => {
          expect(toMinor(toMajor(minor, fractionDigits), fractionDigits)).toBe(minor);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("truncates extra fraction digits without rounding", () => {
    // Documented behavior: toMinor drops digits beyond fractionDigits.
    expect(toMinor("1.239")).toBe(123n);
    expect(toMinor("1.999")).toBe(199n);
  });

  it("rejects invalid decimal amounts with RangeError", () => {
    for (const bad of ["abc", "1.2.3", ""]) {
      expect(() => toMinor(bad)).toThrowError(RangeError);
    }
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
