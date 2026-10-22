import { withAnyRole } from "@/lib/auth/protect";
import { actorOf, CLINICAL_ROLES } from "@/lib/organtrust/access";
import { POLICY_VERSION, rankPatients } from "@/lib/organtrust/policy";
import { audit, newId, updateDb } from "@/lib/organtrust/store";

// Flow 5: normal allocation. The caller does not pick a patient: the server gives the organ to
// whoever is ranked #1 under the current policy.
export const POST = withAnyRole(CLINICAL_ROLES, async (_req, jwt) => {
  const result = updateDb((db) => {
    if (db.donorOrgan.status !== "available") return { error: "The donor organ is already allocated", status: 409 };
    const [top] = rankPatients(db.patients);
    const allocation = {
      id: newId("alloc"),
      organId: db.donorOrgan.id,
      patientId: top.id,
      kind: "policy" as const,
      policyVersion: POLICY_VERSION,
      rankAtAllocation: 1,
      allocatedBy: actorOf(jwt),
      at: new Date().toISOString(),
    };
    db.allocations.unshift(allocation);
    db.donorOrgan.status = "allocated";
    audit(db, actorOf(jwt), `Allocated ${db.donorOrgan.id} to ${top.id}, ranked #1 under policy ${POLICY_VERSION}`);
    return { allocation };
  });
  return "error" in result
    ? Response.json({ error: result.error }, { status: result.status })
    : Response.json(result, { status: 201 });
});
