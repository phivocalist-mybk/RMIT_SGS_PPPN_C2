import { withAnyRole } from "@/lib/auth/protect";
import { hasRole } from "@/lib/auth/tideJWT";
import {
  actorOf,
  orgOf,
  readJson,
  SIGNOFF_MIN_APPROVERS,
  SIGNOFF_MIN_ORGS,
  SIGNOFF_ROLES,
} from "@/lib/organtrust/access";
import { audit, updateDb, type Proposal } from "@/lib/organtrust/store";

function progressOf(proposal: Proposal) {
  const approvals = proposal.approvals ?? [];
  return {
    approvers: approvals.length,
    organizations: new Set(approvals.map((a) => a.org)).size,
    rankSignoff: approvals.some((a) => a.rankSignoff),
    needApprovers: SIGNOFF_MIN_APPROVERS,
    needOrganizations: SIGNOFF_MIN_ORGS,
  };
}

// Flow 4: independent, multi-organization sign-off. Roles and organizations come from each
// approver's verified TideCloak token (role grants need the IGA quorum). The counting rules —
// two people, two organizations, one rank_signoff holder, never the proposer — are app logic
// enforced here on the server.
export const POST = withAnyRole(SIGNOFF_ROLES, async (req, jwt) => {
  const { id, decision } = await readJson<{ id: string; decision: "approve" | "reject" }>(req);
  if (typeof id !== "string" || (decision !== "approve" && decision !== "reject")) {
    return Response.json({ error: "id and decision (approve|reject) are required" }, { status: 400 });
  }
  const org = orgOf(jwt);
  if (!org) {
    return Response.json({ error: "Forbidden: your TideCloak token has no organization claim" }, { status: 403 });
  }

  const result = updateDb((db) => {
    const proposal = db.proposals.find((p) => p.id === id);
    if (!proposal) return { error: `Unknown proposal ${id}`, status: 404 };
    if (proposal.status !== "pending") return { error: `Proposal is already ${proposal.status}`, status: 409 };
    if (proposal.proposedBy === jwt.sub) {
      audit(db, actorOf(jwt), `Blocked: tried to sign off their own proposal ${id}`);
      return { error: "You cannot sign off your own proposal", status: 403 };
    }

    const now = new Date().toISOString();
    if (decision === "reject") {
      proposal.status = "rejected";
      proposal.decidedBy = String(jwt.sub);
      proposal.decidedByName = actorOf(jwt);
      proposal.decidedAt = now;
      audit(db, actorOf(jwt), `Rejected urgency ${proposal.from} -> ${proposal.to} for ${proposal.patientId} (${org})`);
      return { proposal, progress: progressOf(proposal) };
    }

    proposal.approvals ??= [];
    if (proposal.approvals.some((a) => a.sub === jwt.sub)) {
      return { error: "You already approved this proposal", status: 409 };
    }
    proposal.approvals.push({ sub: String(jwt.sub), name: actorOf(jwt), org, rankSignoff: hasRole(jwt, "rank_signoff"), at: now });

    const progress = progressOf(proposal);
    const complete =
      progress.approvers >= SIGNOFF_MIN_APPROVERS && progress.organizations >= SIGNOFF_MIN_ORGS && progress.rankSignoff;
    if (complete) {
      proposal.status = "approved";
      proposal.decidedBy = String(jwt.sub);
      proposal.decidedByName = proposal.approvals.map((a) => `${a.name} (${a.org})`).join(", ");
      proposal.decidedAt = now;
      const patient = db.patients.find((p) => p.id === proposal.patientId);
      if (patient) patient[proposal.field] = proposal.to;
    }
    audit(
      db,
      actorOf(jwt),
      complete
        ? `Final sign-off (${progress.approvers} people, ${progress.organizations} organizations): urgency ${proposal.from} -> ${proposal.to} for ${proposal.patientId} applied`
        : `Approved urgency ${proposal.from} -> ${proposal.to} for ${proposal.patientId} as ${org} (${progress.approvers}/${SIGNOFF_MIN_APPROVERS} people, ${progress.organizations}/${SIGNOFF_MIN_ORGS} organizations${progress.rankSignoff ? "" : ", still needs rank_signoff"})`,
    );
    return { proposal, progress };
  });
  return "error" in result
    ? Response.json({ error: result.error }, { status: result.status })
    : Response.json(result);
});
