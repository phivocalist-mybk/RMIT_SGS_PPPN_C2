import type { JWTPayload } from "jose";

// Staff who may see the (pseudonymous) waiting list. Donor families are deliberately not here.
export const CLINICAL_ROLES = ["transplant_doctor", "immunologist", "bioethics_board", "hospital_director"];

// The one tag every encrypted clinical note carries. RelationshipAttestation:1 allows exactly one
// tag per item, and it must equal the policy's assignmentId.
export const NOTES_RECORD_ID = "organtrust-kidney-waitlist";

// Which signed E2EE policy each role uses for NOTES_RECORD_ID.
export const NOTE_POLICIES = {
  transplant_doctor: "read-write",
  rank_signoff: "read",
} as const;
export type NotePolicyName = keyof typeof NOTE_POLICIES;

// Rank-affecting changes need SIGNOFF_MIN_APPROVERS different people from SIGNOFF_MIN_ORGS
// different organizations, at least one holding rank_signoff, and never the proposer.
// App rule, enforced by this server from claims in each approver's verified TideCloak token.
export const SIGNOFF_ROLES = ["rank_signoff", "bioethics_board"];
export const SIGNOFF_MIN_APPROVERS = 2;
export const SIGNOFF_MIN_ORGS = 2;

export function actorOf(jwt: JWTPayload): string {
  return String(jwt.preferred_username ?? jwt.sub ?? "unknown");
}

// From the `organization` user attribute in TideCloak, mapped into the token. Never from the request.
export function orgOf(jwt: JWTPayload): string {
  return typeof jwt.organization === "string" ? jwt.organization.trim() : "";
}

export async function readJson<T>(req: Request): Promise<Partial<T>> {
  try {
    return (await req.json()) as Partial<T>;
  } catch {
    return {};
  }
}
