// Seeds OrganTrust's local JSON database with synthetic data only.
// Demo accounts and roles are created by scripts/init-tidecloak.sh, not here.
//
//   node scripts/seed.mjs            # writes data/organtrust-db.json (overwrites it)
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = join(root, "data", "organtrust-db.json");

// Ranking inputs are pseudonymous and stay in plaintext so the server can apply the policy.
// Clinical notes are added later, encrypted in the doctor's browser with TideCloak.
const patients = [
  { id: "KID-1042", urgency: 3, hlaScore: 72, waitingDays: 410, priorDonor: false },
  { id: "KID-2178", urgency: 2, hlaScore: 88, waitingDays: 260, priorDonor: false },
  { id: "KID-3305", urgency: 4, hlaScore: 55, waitingDays: 120, priorDonor: false },
  { id: "KID-4417", urgency: 1, hlaScore: 91, waitingDays: 900, priorDonor: true },
  { id: "KID-5523", urgency: 3, hlaScore: 64, waitingDays: 530, priorDonor: false },
  { id: "KID-6690", urgency: 2, hlaScore: 47, waitingDays: 700, priorDonor: true },
].map((p) => ({ ...p, clinicalNote: null }));

const db = {
  donorOrgan: { id: "ORGAN-K-0001", organ: "kidney", bloodType: "O", recoveredAt: "2026-10-22T06:00:00Z", status: "available" },
  patients,
  proposals: [],
  allocations: [],
  audit: [{ at: new Date().toISOString(), actor: "seed", action: "Database seeded with 6 synthetic patients and 1 donor kidney" }],
};

mkdirSync(dirname(dbPath), { recursive: true });
writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log(`Seeded ${patients.length} synthetic patients into ${dbPath}`);
