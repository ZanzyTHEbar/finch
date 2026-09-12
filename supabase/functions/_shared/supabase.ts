import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.116.0";
import { HttpError } from "./http.ts";

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export interface WorkspaceContext {
  readonly admin: SupabaseClient;
  readonly client: SupabaseClient;
  readonly user: User;
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  readonly accessToken: string;
  readonly aal: string | undefined;
}

export interface UserContext {
  readonly admin: SupabaseClient;
  readonly client: SupabaseClient;
  readonly user: User;
  readonly userId: string;
  readonly accessToken: string;
  readonly aal: string | undefined;
}

const requiredEnv = (name: string): string => {
  const value = Deno.env.get(name)?.trim();
  if (value === undefined || value === "") {
    throw new Error(`missing required ${name}`);
  }
  return value;
};

export const projectUrl = (): string => requiredEnv("SUPABASE_URL");

export const adminClient = (): SupabaseClient =>
  createClient(projectUrl(), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const accessTokenFrom = (request: Request): string => {
  const value = request.headers.get("authorization");
  if (value === null || !value.startsWith("Bearer ")) {
    throw new HttpError(401, "authentication_required");
  }
  const token = value.slice("Bearer ".length).trim();
  if (token === "") {
    throw new HttpError(401, "authentication_required");
  }
  return token;
};

const jwtAal = (token: string): string | undefined => {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    return undefined;
  }
  try {
    const encoded = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(atob(encoded)) as { aal?: unknown };
    return typeof decoded.aal === "string" ? decoded.aal : undefined;
  } catch {
    return undefined;
  }
};

const workspaceIdFrom = (request: Request): string => {
  const workspaceId = request.headers.get("x-finch-workspace")?.trim();
  if (
    workspaceId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)
  ) {
    throw new HttpError(400, "invalid_workspace_context");
  }
  return workspaceId;
};

export const requireUser = async (request: Request): Promise<UserContext> => {
  const accessToken = accessTokenFrom(request);
  const client = createClient(projectUrl(), requiredEnv("SUPABASE_ANON_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  const { data: userData, error: userError } = await client.auth.getUser(accessToken);
  if (userError !== null || userData.user === null) {
    throw new HttpError(401, "authentication_required");
  }
  return {
    admin: adminClient(),
    client,
    user: userData.user,
    userId: userData.user.id,
    accessToken,
    aal: jwtAal(accessToken),
  };
};

export const requireWorkspace = async (
  request: Request,
  allowedRoles: readonly WorkspaceRole[] = ["owner", "admin", "member", "viewer"],
): Promise<WorkspaceContext> => {
  const userContext = await requireUser(request);
  const workspaceId = workspaceIdFrom(request);
  const { data: membership, error: membershipError } = await userContext.client
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userContext.userId)
    .is("revoked_at", null)
    .maybeSingle();
  if (membershipError !== null || membership === null || !allowedRoles.includes(membership.role as WorkspaceRole)) {
    // Do not reveal whether the workspace exists or who belongs to it.
    throw new HttpError(404, "workspace_not_found");
  }
  const { data: workspace, error: workspaceError } = await userContext.client
    .from("workspaces")
    .select("state")
    .eq("id", workspaceId)
    .maybeSingle();
  if (workspaceError !== null || workspace?.state !== "active") {
    throw new HttpError(404, "workspace_not_found");
  }
  return {
    ...userContext,
    workspaceId,
    role: membership.role as WorkspaceRole,
  };
};

export const requireRecentAal2 = (context: WorkspaceContext): void => {
  if (context.aal !== "aal2") {
    throw new HttpError(403, "recent_mfa_required");
  }
};

export const assertNoError = <T>(result: { data: T; error: { message: string } | null }): T => {
  if (result.error !== null) {
    console.error("supabase operation failed", result.error.message);
    throw new HttpError(500, "storage_unavailable");
  }
  return result.data;
};
