import { withRole } from "@/lib/auth/protect";
import { SIGNOFF_MIN_APPROVERS, SIGNOFF_MIN_ORGS } from "@/lib/organtrust/access";
import { POLICY_DESCRIPTION, POLICY_VERSION } from "@/lib/organtrust/policy";
import { readDb } from "@/lib/organtrust/store";

type Check = { label: string; status: "pass" | "fail" | "info"; detail: string };

// Flow 3: what a donor family may see. It never includes the recipient's id or any patient data:
// only the outcome, the policy version and a rules check computed from this server's records.
export const GET = withRole("donor_family", async () => {
  const db = readDb();
  const allocation = db.allocations.find((a) => a.organId === db.donorOrgan.id);

  let outcome = "Not allocated yet.";
  let detail: string | null = null;
  if (allocation?.kind === "policy") {
    outcome = `Allocated to the patient ranked #1 under policy ${allocation.policyVersion}.`;
  } else if (allocation?.kind === "exception") {
    const n = allocation.roleGrantApprovers?.length;
    const m = allocation.realmAdminCount;
    outcome = n && m
      ? `Exception approved by ${n} of ${m} realm admins.`
      : "Exception made under allocation_override (approval record not found).";
    detail =
      "An exception needs the allocation_override role. TideCloak only grants that role after the admin quorum signs the change request.";
  }

  // Rank-affecting changes that took effect before the allocation (or so far, if none yet).
  const cutoff = allocation?.at ?? new Date().toISOString();
  const applied = db.proposals.filter((p) => p.status === "approved" && (p.decidedAt ?? "") <= cutoff);
  const appliedAfter = allocation ? db.proposals.filter((p) => p.status === "approved" && (p.decidedAt ?? "") > cutoff).length : 0;
  const notApplied = db.proposals.filter((p) => p.status !== "approved");
  const changeChecks = applied.map((p) => {
    const approvals = p.approvals ?? [];
    const orgs = new Set(approvals.map((a) => a.org));
    const ok =
      approvals.length >= SIGNOFF_MIN_APPROVERS &&
      orgs.size >= SIGNOFF_MIN_ORGS &&
      approvals.some((a) => a.rankSignoff) &&
      approvals.every((a) => a.sub !== p.proposedBy);
    return { ok, people: approvals.length, orgs: [...orgs] };
  });

  const checks: Check[] = [
    {
      label: "A published, versioned ranking policy was used",
      status: allocation ? (allocation.policyVersion === POLICY_VERSION ? "pass" : "fail") : "info",
      detail: `Policy ${allocation?.policyVersion ?? POLICY_VERSION}: ${POLICY_DESCRIPTION}.`,
    },
    {
      label: "The organ went to the patient ranked #1",
      status: !allocation ? "info" : allocation.kind === "policy" && allocation.rankAtAllocation === 1 ? "pass" : "fail",
      detail: !allocation
        ? "Not allocated yet."
        : allocation.kind === "policy"
          ? "Normal allocation: the server picked rank #1 itself; nobody chose the patient."
          : `Exception: the patient was ranked #${allocation.rankAtAllocation}. Allowed only for a holder of allocation_override.`,
    },
    {
      label: `Every rank change was approved by ${SIGNOFF_MIN_APPROVERS}+ people from ${SIGNOFF_MIN_ORGS}+ organizations`,
      status: changeChecks.every((c) => c.ok) ? "pass" : "fail",
      detail:
        (changeChecks.length === 0
          ? `No rank-affecting changes were made${allocation ? " before the allocation" : ""}.`
          : changeChecks
              .map((c, i) => `Change ${i + 1}: ${c.people} people from ${c.orgs.length} organizations (${c.orgs.join(", ")})${c.ok ? "" : " - RULE NOT MET"}`)
              .join(". ") + ". The proposer never counted as an approver.") +
        (appliedAfter ? ` ${appliedAfter} change(s) approved after the allocation could not affect it.` : ""),
    },
    {
      label: "Changes without enough approvals did not affect the ranking",
      status: "info",
      detail:
        notApplied.length === 0
          ? "There were no unapproved or rejected proposals."
          : `${notApplied.length} proposal(s) were not applied (${notApplied.filter((p) => p.status === "pending").length} pending, ${notApplied.filter((p) => p.status === "rejected").length} rejected).`,
    },
  ];

  return Response.json({
    organ: { id: db.donorOrgan.id, organ: db.donorOrgan.organ, status: db.donorOrgan.status },
    currentPolicy: POLICY_VERSION,
    outcome,
    detail,
    allocatedAt: allocation?.at ?? null,
    checks,
  });
});
