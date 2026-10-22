import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { RankingInputs } from "./policy";

// Local JSON "database" (data/organtrust-db.json, created by `npm run seed`). Synthetic data only.
// Server-only: import it from route handlers, never from client components.

export type StoredPatient = RankingInputs & {
  // Ciphertext produced in the doctor's browser by TideCloak. The server never sees plaintext.
  clinicalNote: string | null;
};

export type Proposal = {
  id: string;
  patientId: string;
  field: "urgency";
  from: number;
  to: number;
  reason: string;
  proposedBy: string; // TideCloak sub
  proposedByName: string;
  proposedByOrg?: string;
  approvals?: SignoffApproval[];
  status: "pending" | "approved" | "rejected";
  decidedBy?: string;
  decidedByName?: string;
  createdAt: string;
  decidedAt?: string;
};

export type SignoffApproval = { sub: string; name: string; org: string; rankSignoff: boolean; at: string };

export type Allocation = {
  id: string;
  organId: string;
  patientId: string;
  kind: "policy" | "exception";
  policyVersion: string;
  rankAtAllocation: number;
  allocatedBy: string;
  reason?: string;
  // For an exception: who approved the allocation_override grant in TideCloak, read from its
  // change-request record, and how many realm admins existed then.
  roleGrantApprovers?: string[];
  realmAdminCount?: number;
  at: string;
};

export type SignedNotePolicy = { policy: string; signedBy: string; at: string };

export type AuditEntry = { at: string; actor: string; action: string };

export type Db = {
  donorOrgan: { id: string; organ: string; bloodType: string; recoveredAt: string; status: "available" | "allocated" };
  patients: StoredPatient[];
  proposals: Proposal[];
  allocations: Allocation[];
  audit: AuditEntry[];
  // Signed RelationshipAttestation:1 policies (not secret: they are useless without a matching login).
  notePolicies?: Partial<Record<string, SignedNotePolicy>>;
};

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const dbPath = () => join(process.cwd(), "data", "organtrust-db.json");

export function readDb(): Db {
  try {
    return JSON.parse(readFileSync(dbPath(), "utf-8"));
  } catch {
    throw new Error("data/organtrust-db.json is missing. Run `npm run seed` first.");
  }
}

// Read-modify-write. Fine for a single-process local demo; not safe under concurrent writers.
export function updateDb<T>(change: (db: Db) => T): T {
  const db = readDb();
  const result = change(db);
  writeFileSync(dbPath(), JSON.stringify(db, null, 2));
  return result;
}

export function audit(db: Db, actor: string, action: string) {
  db.audit.unshift({ at: new Date().toISOString(), actor, action });
}
