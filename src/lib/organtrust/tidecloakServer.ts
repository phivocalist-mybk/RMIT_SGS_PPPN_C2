import { loadTideConfig } from "@/lib/auth/tidecloakConfig";

// Server-side, READ-ONLY lookups in TideCloak's own change-request records, using the local
// master-admin credentials from .env. Used to show who approved a role grant; it never approves
// or changes anything (approvals must come from each admin's own browser).

async function masterToken(base: string): Promise<string> {
  const res = await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "admin-cli",
      grant_type: "password",
      username: process.env.KC_BOOTSTRAP_ADMIN_USERNAME ?? "admin",
      password: process.env.KC_BOOTSTRAP_ADMIN_PASSWORD ?? "",
    }),
  });
  if (!res.ok) throw new Error(`Could not get a TideCloak admin token (${res.status})`);
  return (await res.json()).access_token;
}

export type RoleGrantApproval = { approvers: string[]; realmAdminCount: number };

// The committed GRANT_ROLES change request that gave `userId` the realm role `roleName`.
export async function roleGrantApproval(userId: string, roleName: string): Promise<RoleGrantApproval | null> {
  const config = loadTideConfig();
  const base = config["auth-server-url"].replace(/\/+$/, "");
  const admin = `${base}/admin/realms/${config.realm}`;
  const headers = { Authorization: `Bearer ${await masterToken(base)}` };
  const get = async (path: string) => {
    const res = await fetch(`${admin}${path}`, { headers });
    if (!res.ok) throw new Error(`TideCloak ${path} answered ${res.status}`);
    return res.json();
  };

  const role = await get(`/roles/${encodeURIComponent(roleName)}`);
  const approved: any[] = await get("/iga/change-requests?status=APPROVED");
  const grant = approved
    .filter((cr) => cr.actionType === "GRANT_ROLES" && cr.entityId === userId && JSON.stringify(cr.rows ?? "").includes(role.id))
    .pop();
  if (!grant) return null;

  // Tide realm: tide-realm-admin holders. Tideless fallback realm: realm-admin holders.
  const [realmManagement] = await get("/clients?clientId=realm-management");
  let admins: unknown[] = await get(`/clients/${realmManagement.id}/roles/tide-realm-admin/users`).catch(() => []);
  if (admins.length === 0) admins = await get(`/clients/${realmManagement.id}/roles/realm-admin/users`);
  return {
    approvers: (grant.authorizers ?? []).map((a: { username: string }) => a.username),
    realmAdminCount: admins.length,
  };
}
