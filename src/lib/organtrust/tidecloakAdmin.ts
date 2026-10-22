// Browser-side calls to the TideCloak admin REST API, made with the signed-in admin's own
// DPoP-bound token via secureFetch. Never proxy these through the app server: IGA credits an
// approval to whoever sent the HTTP request (canon iga-change-requests-api, AP-89).

type SecureFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type ChangeRequest = {
  id: string;
  entityType: string;
  entityId: string;
  actionType: string;
  status: string;
  requestedBy?: string;
  createdAt?: number | string;
  authorizationCount?: number;
  authorizers?: { username: string; timestamp?: number | string }[];
  threshold?: number;
  readyToCommit?: boolean;
  rows?: unknown;
};

export function adminBase(config: Record<string, any>): string {
  return `${String(config["auth-server-url"]).replace(/\/+$/, "")}/admin/realms/${config.realm}`;
}

export function consoleUrl(config: Record<string, any>): string {
  return `${String(config["auth-server-url"]).replace(/\/+$/, "")}/admin/${config.realm}/console/`;
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return `${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`;
}

// Asking TideCloak to grant a realm role. On an IGA realm this does not grant anything:
// TideCloak answers 202 and files a GRANT_ROLES change request that needs an admin quorum.
export async function requestRealmRoleGrant(
  secureFetch: SecureFetch,
  base: string,
  userId: string,
  roleName: string,
): Promise<{ status: number; detail: string }> {
  const roleRes = await secureFetch(`${base}/roles/${encodeURIComponent(roleName)}`);
  if (!roleRes.ok) throw new Error(`Could not read role ${roleName} (${await errorText(roleRes)})`);
  const role = await roleRes.json();

  const res = await secureFetch(`${base}/users/${userId}/role-mappings/realm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([role]),
  });
  return { status: res.status, detail: res.ok ? "" : await errorText(res) };
}

export async function listChangeRequests(
  secureFetch: SecureFetch,
  base: string,
  status = "PENDING",
): Promise<ChangeRequest[]> {
  const res = await secureFetch(`${base}/iga/change-requests?status=${status}`);
  if (!res.ok) throw new Error(`Could not list change requests (${await errorText(res)})`);
  const body = await res.json();
  return Array.isArray(body) ? body : [];
}

// The admin console's own approval lane. In Tideless mode TideCloak records the approval and
// commits once the threshold is met. In Tide multi-admin mode it answers "needs-approval" with a
// request for the enclave, which this app does not implement: approve in the admin console instead.
export async function approveChangeRequest(
  secureFetch: SecureFetch,
  base: string,
  id: string,
): Promise<{ mode?: string; committed?: boolean; authCount?: number; threshold?: number }> {
  const res = await secureFetch(`${base}/iga/change-requests/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`Approval refused (${await errorText(res)})`);
  return res.json();
}

export async function listUsers(
  secureFetch: SecureFetch,
  base: string,
): Promise<{ id: string; username: string }[]> {
  const res = await secureFetch(`${base}/users?max=100`);
  if (!res.ok) throw new Error(`Could not list users (${await errorText(res)})`);
  return res.json();
}
