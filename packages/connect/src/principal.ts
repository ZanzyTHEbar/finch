import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect"
import type { PrincipalContext } from "@finch/lib"

/** Adapter boundary for a production transport authenticator. */
export interface ConnectPrincipalResolver {
  readonly resolve: (
    context: HandlerContext,
  ) => PrincipalContext | undefined | Promise<PrincipalContext | undefined>
}

/** Signals a transient failure retrieving identity-provider verification metadata. */
export class IdentityProviderUnavailableError extends Error {
  constructor() {
    super("identity provider unavailable")
  }
}

/** Resolves a trusted principal; resolver outages are safe to retry. */
export const requireConnectPrincipal = async (
  resolver: ConnectPrincipalResolver,
  context: HandlerContext,
): Promise<PrincipalContext> => {
  let principal: PrincipalContext | undefined
  try {
    principal = await resolver.resolve(context)
  } catch (error) {
    if (error instanceof IdentityProviderUnavailableError) {
      throw new ConnectError("identity provider unavailable", Code.Unavailable)
    }
    throw error
  }
  if (principal === undefined) {
    throw new ConnectError("authentication required", Code.Unauthenticated)
  }
  return principal
}
