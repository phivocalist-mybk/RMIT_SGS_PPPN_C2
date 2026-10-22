import { withAuth } from "@/lib/auth/protect";
import { appRolesOf, REALM_ADMIN_ROLES } from "@/lib/organtrust/roles";

// What the SERVER sees after verifying the token signature, issuer, azp, expiry and the
// DPoP proof (withAuth). The UI uses this to show that roles come from TideCloak, not from it.
export const GET = withAuth(async (_req, jwt) => {
  const realmRoles = (jwt.realm_access as { roles?: string[] } | undefined)?.roles ?? [];
  const realmManagement =
    (jwt.resource_access as Record<string, { roles?: string[] }> | undefined)?.["realm-management"]?.roles ?? [];

  return Response.json({
    sub: jwt.sub,
    username: jwt.preferred_username,
    roles: appRolesOf(realmRoles),
    realmAdmin: REALM_ADMIN_ROLES.some((role) => realmManagement.includes(role)),
  });
});
