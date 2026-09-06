import { dinero, toDecimal, toSnapshot, type DineroCurrency } from "dinero.js/bigint"
import * as BigIntCurrencies from "dinero.js/bigint/currencies"
import { Schema } from "effect"
import { ValidationFailed } from "./errors.ts"

export const CurrencyCode = Schema.String.pipe(
  Schema.pattern(/^[A-Z]{3}$/),
  Schema.brand("CurrencyCode"),
)

export type CurrencyCode = Schema.Schema.Type<typeof CurrencyCode>

export const normalizeCurrency = (input: string): CurrencyCode =>
  Schema.decodeUnknownSync(CurrencyCode)(input.toUpperCase())

export const AmountMinor = Schema.BigIntFromSelf.pipe(Schema.brand("AmountMinor"))

export type AmountMinor = Schema.Schema.Type<typeof AmountMinor>

// ISO 4217 exponents top out at 4; this cap only guards the BigInt scale
// math below if the currency table ever ships something unexpected.
const MAX_FRACTION_DIGITS = 9

const currenciesByCode = BigIntCurrencies as unknown as Record<
  string,
  DineroCurrency<bigint> | undefined
>

export const resolveCurrency = (input: CurrencyCode | string): DineroCurrency<bigint> => {
  const code = normalizeCurrency(input)
  const currency = currenciesByCode[code]
  if (currency === undefined) {
    throw new ValidationFailed({ issues: [`unknown currency code: ${JSON.stringify(code)}`] })
  }
  const exponent = Number(currency.exponent)
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_FRACTION_DIGITS) {
    throw new RangeError(`unsupported exponent for currency ${code}: ${String(currency.exponent)}`)
  }
  return currency
}

const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d*))?$/

export const toMinor = (major: string, currency: CurrencyCode | string = "USD"): AmountMinor => {
  const dineroCurrency = resolveCurrency(currency)
  const exponent = Number(dineroCurrency.exponent)
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
  if (fracPart.length > exponent) {
    throw new ValidationFailed({
      issues: [
        `too many fraction digits for ${dineroCurrency.code}: got ${fracPart.length}, max ${exponent} in ${JSON.stringify(major)}`,
      ],
    })
  }
  const scale = 10n ** BigInt(exponent)
  const frac = fracPart === "" ? 0n : BigInt(fracPart.padEnd(exponent, "0"))
  const amount = sign * (BigInt(intPart) * scale + frac)
  return toSnapshot(dinero({ amount, currency: dineroCurrency })).amount as AmountMinor
}

export const toMajor = (minor: bigint, currency: CurrencyCode | string = "USD"): string =>
  toDecimal(dinero({ amount: minor, currency: resolveCurrency(currency) }))

export const isZero = (minor: bigint): boolean => minor === 0n
