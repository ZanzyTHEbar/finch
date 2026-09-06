import { Schema } from "effect"

export const NonEmptyTrimmedString = Schema.String.pipe(
  Schema.filter((s) => s.trim().length > 0, {
    message: () => "expected a non-empty trimmed string",
  }),
  Schema.brand("NonEmptyTrimmedString"),
)

export type NonEmptyTrimmedString = Schema.Schema.Type<typeof NonEmptyTrimmedString>

export const DescriptionString = Schema.String.pipe(
  Schema.maxLength(2000),
  Schema.brand("DescriptionString"),
)

export type DescriptionString = Schema.Schema.Type<typeof DescriptionString>

export const ExternalId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(500),
  Schema.brand("ExternalId"),
)

export type ExternalId = Schema.Schema.Type<typeof ExternalId>
