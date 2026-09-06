import { Schema } from "effect"

export const UtcInstant = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/),
  Schema.brand("UtcInstant"),
)

export type UtcInstant = Schema.Schema.Type<typeof UtcInstant>

export const nowInstant = (): UtcInstant =>
  Schema.decodeUnknownSync(UtcInstant)(new Date().toISOString())

export const IsoDate = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.filter((s) => isValidCalendarDate(s), {
    message: () => "expected a valid calendar date (YYYY-MM-DD)",
  }),
  Schema.brand("IsoDate"),
)

export type IsoDate = Schema.Schema.Type<typeof IsoDate>

const ISO_DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/

export const isValidCalendarDate = (s: string): boolean => {
  const match = ISO_DATE_PARTS.exec(s)
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return false
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false
  }
  const dt = new Date(Date.UTC(year, month - 1, day))
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day
}

export const makeIsoDate = (s: string): IsoDate => {
  const decoded = Schema.decodeUnknownSync(IsoDate)(s)
  if (!isValidCalendarDate(decoded)) {
    throw new RangeError(`invalid calendar date: ${JSON.stringify(s)}`)
  }
  return decoded
}

export const todayIsoDate = (): IsoDate => {
  const now = new Date()
  const y = now.getUTCFullYear().toString().padStart(4, "0")
  const m = (now.getUTCMonth() + 1).toString().padStart(2, "0")
  const d = now.getUTCDate().toString().padStart(2, "0")
  return makeIsoDate(`${y}-${m}-${d}`)
}
