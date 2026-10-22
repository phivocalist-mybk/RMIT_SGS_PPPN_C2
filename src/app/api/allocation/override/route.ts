import { withRole } from "@/lib/auth/protect";
import { actorOf, readJson } from "@/lib/organtrust/access";
import { POLICY_VERSION, rankPatients } from "@/lib/organtrust/policy";
import { audit, newId, updateDb } from "@/lib/organtrust/store";
import { roleGrantApproval, type RoleGrantApproval } from "@/lib/organtrust/tidecloakServer";

// Flow 5: an allocation exception. withRole verifies the token signature, the DPoP proof and that
// the TideCloak token carries allocation_override; any other token gets 401/403 before this runs.
// Granting allocation_override itself is a TideCloak IGA change request that needs an admin quorum.
export const POST = withRole("allocation_override", async (req, jwt) => {
  const { patientId, reason } = await readJson<{ patientId: string; reason: string }>(req);
  if (typeof patientId !== "string" || !reason?.trim()) {
    return Response.json({ error: "patientId and a reason are required" }, { status: 400 });
  }

  let approval: RoleGrantApproval | null = null;
  try {
    approval = await roleGrantApproval(String(jwt.sub), "allocation_override");
  } catch {
    // Shown as "approval record not found"; the role check above already passed.
  }

  const result = updateDb((db) => {
    if (db.donorOrgan.status !== "available") return { error: "The donor organ is already allocated", status: 409 };
    const target = rankPatients(db.patients).find((p) => p.id === patientId);
    if (!target) return { error: `Unknown patient ${patientId}`, status: 404 };
    const allocation = {
      id: newId("alloc"),
      organId: db.donorOrgan.id,
      patientId,
      kind: "exception" as const,
      policyVersion: POLICY_VERSION,
      rankAtAllocation: target.rank,
      allocatedBy: actorOf(jwt),
      reason: reason!.trim().slice(0, 300),
      roleGrantApprovers: approval?.approvers,
      realmAdminCount: approval?.realmAdminCount,
      at: new Date().toISOString(),
    };
    db.allocations.unshift(allocation);
    db.donorOrgan.status = "allocated";
    audit(db, actorOf(jwt), `Exception: allocated ${db.donorOrgan.id} to ${patientId} (rank #${target.rank}) using allocation_override: ${allocation.reason}`);
    return { allocation };
  });
  return "error" in result
    ? Response.json({ error: result.error }, { status: result.status })
    : Response.json(result, { status: 201 });
});
