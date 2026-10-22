// Realm roles OrganTrust cares about. Everything else in the token (Tide internals,
// default-roles, appUser) is hidden from the UI.
export const APP_ROLES = {
  transplant_doctor: "Transplant doctor",
  hospital_director: "Hospital director",
  bioethics_board: "Bioethics board member",
  immunologist: "Independent immunologist",
  donor_family: "Donor family",
  rank_signoff: "Rank sign-off (granted only by quorum)",
  allocation_override: "Allocation override (granted only by quorum)",
} as const;

export type AppRole = keyof typeof APP_ROLES;

export function appRolesOf(realmRoles: string[]): AppRole[] {
  return (Object.keys(APP_ROLES) as AppRole[]).filter((role) => realmRoles.includes(role));
}

// Realm admins (IGA approvers): tide-realm-admin on a Tide realm, realm-admin on the Tideless one.
export const REALM_ADMIN_ROLES = ["tide-realm-admin", "realm-admin"];

// Tide mode = the adapter belongs to a Tide-licensed realm (it carries the realm's vendorId).
// Tideless mode = the fallback realm from scripts/init-tideless.sh: password logins, quorum
// enforced by TideCloak's own server logic, no E2EE.
export function isTideMode(config: Record<string, unknown> | null | undefined): boolean {
  return Boolean(config?.vendorId);
}
