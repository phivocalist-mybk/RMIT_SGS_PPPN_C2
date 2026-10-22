import { withAnyRole } from "@/lib/auth/protect";
import { CLINICAL_ROLES } from "@/lib/organtrust/access";
import { POLICY_DESCRIPTION, POLICY_VERSION, rankPatients } from "@/lib/organtrust/policy";
import { readDb } from "@/lib/organtrust/store";

// The ranked waiting list. The server applies the policy to pseudonymous ranking inputs;
// clinical notes come back as the ciphertext it stores.
export const GET = withAnyRole(CLINICAL_ROLES, async () => {
  const db = readDb();
  return Response.json({
    policy: { version: POLICY_VERSION, description: POLICY_DESCRIPTION },
    organ: db.donorOrgan,
    patients: rankPatients(db.patients),
    allocations: db.allocations,
  });
});
