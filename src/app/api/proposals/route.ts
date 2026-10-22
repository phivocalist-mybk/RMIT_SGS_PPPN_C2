import { withAnyRole, withRole } from "@/lib/auth/protect";
import { actorOf, CLINICAL_ROLES, orgOf, readJson } from "@/lib/organtrust/access";
import { audit, newId, readDb, updateDb } from "@/lib/organtrust/store";

export const GET = withAnyRole(CLINICAL_ROLES, async () => {
  return Response.json({ proposals: readDb().proposals });
});

// Flow 4: a doctor proposes a rank-affecting change. Nothing changes until approvers from two
// organizations, including a rank_signoff holder, approve it (see ./decide).
export const POST = withRole("transplant_doctor", async (req, jwt) => {
  const { patientId, to, reason } = await readJson<{ patientId: string; to: number; reason: string }>(req);
  const urgency = Number(to);
  if (typeof patientId !== "string" || !Number.isInteger(urgency) || urgency < 1 || urgency > 4 || !reason?.trim()) {
    return Response.json({ error: "patientId, a new urgency from 1 to 4 and a reason are required" }, { status: 400 });
  }

  const result = updateDb((db) => {
    const patient = db.patients.find((p) => p.id === patientId);
    if (!patient) return { error: `Unknown patient ${patientId}`, status: 404 };
    if (patient.urgency === urgency) return { error: `Urgency is already ${urgency}`, status: 400 };
    const proposal = {
      id: newId("prop"),
      patientId,
      field: "urgency" as const,
      from: patient.urgency,
      to: urgency,
      reason: reason!.trim().slice(0, 300),
      proposedBy: String(jwt.sub),
      proposedByName: actorOf(jwt),
      proposedByOrg: orgOf(jwt),
      approvals: [],
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    };
    db.proposals.unshift(proposal);
    audit(db, proposal.proposedByName, `Proposed urgency ${proposal.from} -> ${urgency} for ${patientId}: ${proposal.reason}`);
    return { proposal };
  });
  return "error" in result
    ? Response.json({ error: result.error }, { status: result.status })
    : Response.json(result, { status: 201 });
});
