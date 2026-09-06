import { Effect } from "effect"
import { UnknownEventVersion } from "../errors.ts"
import { EventCatalogV1 } from "./v1.ts"

export type Upcaster = (payload: unknown) => unknown

// Additive-only evolution policy: v1 introduces the versioning scheme and no
// breaking changes exist yet, so the registry is empty. Entries keyed
// `${eventType}@${eventVersion}` get added when a v2 payload ships.
export const upcasterRegistry: ReadonlyMap<string, Upcaster> = new Map<string, Upcaster>()

export const upcastPayload = (
  eventType: string,
  eventVersion: number,
  payload: unknown,
): Effect.Effect<unknown, UnknownEventVersion> => {
  const upcaster = upcasterRegistry.get(`${eventType}@${eventVersion}`)
  if (upcaster !== undefined) {
    return Effect.succeed(upcaster(payload))
  }
  if (eventVersion === 1 && Object.hasOwn(EventCatalogV1, eventType)) {
    return Effect.succeed(payload)
  }
  return Effect.fail(new UnknownEventVersion({ eventType, eventVersion }))
}
