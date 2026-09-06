import { Schema } from "effect"

export const CurrencyCode = Schema.String.pipe(
  Schema.pattern(/^[A-Z]{3}$/),
  Schema.brand("CurrencyCode"),
)

export type CurrencyCode = Schema.Schema.Type<typeof CurrencyCode>

export const normalizeCurrency = (input: string): CurrencyCode =>
  Schema.decodeUnknownSync(CurrencyCode)(input.toUpperCase())

export const AmountMinor = Schema.BigIntFromSelf.pipe(Schema.brand("AmountMinor"))

export type AmountMinor = Schema.Schema.Type<typeof AmountMinor>

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d*))?$/

export const toMinor = (major: string, fractionDigits = 2): bigint => {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0) {
    throw new RangeError(`fractionDigits must be a non-negative integer, got ${fractionDigits}`)
  }
  const trimmed = major.trim()
  const match = DECIMAL_RE.exec(trimmed)
  if (match === null || match[2] === undefined) {
    throw new RangeError(`invalid decimal amount: ${JSON.stringify(major)}`)
  }
  const sign = match[1] === "-" ? -1n : 1n
  const intPart = match[2]
  const fracPart = match[3] ?? ""
  if (intPart.length === 0) {
    throw new RangeError(`invalid decimal amount: ${JSON.stringify(major)}`)
  }
  if (fracPart.length > fractionDigits) {
    // truncate extra digits, no rounding
    const kept = fracPart.slice(0, fractionDigits)
    const scale = 10n ** BigInt(fractionDigits)
    return sign * (BigInt(intPart) * scale + BigInt(kept.padEnd(fractionDigits, "0")))
  }
  const scale = 10n ** BigInt(fractionDigits)
  const frac = fracPart === "" ? 0n : BigInt(fracPart.padEnd(fractionDigits, "0"))
  return sign * (BigInt(intPart) * scale + frac)
}

export const toMajor = (minor: bigint, fractionDigits = 2): string => {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0) {
    throw new RangeError(`fractionDigits must be a non-negative integer, got ${fractionDigits}`)
  }
  if (fractionDigits === 0) {
    return minor.toString()
  }
  const negative = minor < 0n
  const abs = negative ? -minor : minor
  const scale = 10n ** BigInt(fractionDigits)
  const intPart = abs / scale
  const fracPart = (abs % scale).toString().padStart(fractionDigits, "0")
  return `${negative ? "-" : ""}${intPart.toString()}.${fracPart}`
}

export const isZero = (minor: bigint): boolean => minor === 0n
