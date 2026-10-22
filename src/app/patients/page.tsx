"use client";

import { useTideCloak } from "@tidecloak/nextjs";
import { useCallback, useEffect, useState } from "react";
import { NOTES_RECORD_ID, type NotePolicyName } from "@/lib/organtrust/access";
import { decryptForRecord, encryptForRecord } from "@/lib/organtrust/relationship";
import { isTideMode } from "@/lib/organtrust/roles";
import { errorMessage, LoginGate, useApi } from "../useApi";

type RankedPatient = {
  id: string;
  urgency: number;
  hlaScore: number;
  waitingDays: number;
  priorDonor: boolean;
  score: number;
  rank: number;
  clinicalNote: string | null;
};
type Allocation = { id: string; patientId: string; kind: "policy" | "exception"; rankAtAllocation: number; policyVersion: string; allocatedBy: string; reason?: string; at: string };
type PatientsResponse = {
  policy: { version: string; description: string };
  organ: { id: string; organ: string; bloodType: string; status: string };
  patients: RankedPatient[];
  allocations: Allocation[];
};
type Proposal = {
  id: string;
  patientId: string;
  from: number;
  to: number;
  reason: string;
  proposedBy: string;
  proposedByName: string;
  proposedByOrg?: string;
  approvals?: { sub: string; name: string; org: string; rankSignoff: boolean }[];
  status: string;
};
type Progress = { approvers: number; organizations: number; rankSignoff: boolean; needApprovers: number; needOrganizations: number };
type AuditEntry = { at: string; actor: string; action: string };

function PatientsContent() {
  const api = useApi();
  const { hasRealmRole, getValueFromToken, getConfig } = useTideCloak();
  const tideMode = isTideMode(getConfig());
  const me = getValueFromToken("sub") as string;
  const isDoctor = hasRealmRole("transplant_doctor");
  const canSignOff = hasRealmRole("rank_signoff");
  const canApprove = canSignOff || hasRealmRole("bioethics_board");
  const myOrg = (getValueFromToken("organization") as string | undefined) ?? "";
  const notePolicyName: NotePolicyName | null = isDoctor ? "transplant_doctor" : canSignOff ? "rank_signoff" : null;

  const [data, setData] = useState<PatientsResponse | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [policies, setPolicies] = useState<Record<string, { policy: string }>>({});
  const [plain, setPlain] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [proposeFor, setProposeFor] = useState("");
  const [proposeTo, setProposeTo] = useState(4);
  const [proposeReason, setProposeReason] = useState("Rapid decline in kidney function; dialysis access failing.");
  const [exceptionFor, setExceptionFor] = useState("");
  const [exceptionReason, setExceptionReason] = useState("");
  const [noteFor, setNoteFor] = useState("");
  const [noteText, setNoteText] = useState("Synthetic note: on haemodialysis 3x/week, no recent infections, cleared by cardiology.");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, pr, au, po] = await Promise.all([
        api<PatientsResponse>("/api/patients"),
        api<{ proposals: Proposal[] }>("/api/proposals"),
        api<{ audit: AuditEntry[] }>("/api/audit"),
        api<{ policies: Record<string, { policy: string }> }>("/api/e2ee/policies"),
      ]);
      setData(p);
      setProposals(pr.proposals);
      setAuditLog(au.audit);
      setPolicies(po.policies);
      if (p.patients.length) {
        setProposeFor((v) => v || p.patients[0].id);
        setExceptionFor((v) => v || p.patients[p.patients.length - 1].id);
        setNoteFor((v) => v || p.patients[0].id);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function run(action: () => Promise<string>) {
    setMessage(null);
    setError(null);
    try {
      setMessage(await action());
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const notePolicy = notePolicyName ? policies[notePolicyName]?.policy : undefined;

  if (!data) return <main className="page">{error ? <p className="error">{error}</p> : <p>Loading the waiting list…</p>}</main>;

  return (
    <main className="page">
      <header className="topbar">
        <h1>Kidney waiting list</h1>
        <a href="/">Home</a>
      </header>
      <p className="muted">
        Ranking policy <b>{data.policy.version}</b>: {data.policy.description}. Donor organ {data.organ.id} ({data.organ.organ}, blood type {data.organ.bloodType}) is <b>{data.organ.status}</b>.
      </p>
      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2>Ranking</h2>
        <table className="table">
          <thead>
            <tr><th>#</th><th>Patient</th><th>Urgency</th><th>HLA</th><th>Waiting</th><th>Prior donor</th><th>Score</th><th>Clinical note</th></tr>
          </thead>
          <tbody>
            {data.patients.map((p) => (
              <tr key={p.id}>
                <td>{p.rank}</td>
                <td>{p.id}</td>
                <td>{p.urgency}</td>
                <td>{p.hlaScore}</td>
                <td>{p.waitingDays} d</td>
                <td>{p.priorDonor ? "yes" : "no"}</td>
                <td>{p.score}</td>
                <td>
                  {!p.clinicalNote && <span className="muted">none</span>}
                  {p.clinicalNote && plain[p.id] && <span>{plain[p.id]}</span>}
                  {p.clinicalNote && !plain[p.id] && (
                    <span className="row-actions">
                      <code>{p.clinicalNote.slice(0, 16)}…</code>
                      {notePolicy && (
                        <button
                          className="secondary"
                          onClick={() => run(async () => {
                            const text = await decryptForRecord(p.clinicalNote!, NOTES_RECORD_ID, notePolicy);
                            setPlain((prev) => ({ ...prev, [p.id]: text }));
                            return `Decrypted ${p.id}'s note in your browser via the Tide network.`;
                          })}
                        >
                          Decrypt
                        </button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!tideMode && (
          <p className="muted">Clinical-note encryption needs Tide mode (Tide accounts); it is off in this Tideless fallback.</p>
        )}
        {tideMode && notePolicyName && !notePolicy && (
          <p className="muted">Notes cannot be encrypted or decrypted until a realm admin signs the E2EE policy for {notePolicyName} (Governance page).</p>
        )}
      </section>

      {isDoctor && notePolicy && (
        <section className="card">
          <h2>Write an encrypted clinical note</h2>
          <p className="muted">Encrypted in your browser by TideCloak before it is sent; the server stores ciphertext only.</p>
          <div className="form-row">
            <label>Patient
              <select value={noteFor} onChange={(e) => setNoteFor(e.target.value)}>
                {data.patients.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              </select>
            </label>
          </div>
          <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} />
          <button
            onClick={() => run(async () => {
              const ciphertext = await encryptForRecord(noteText, NOTES_RECORD_ID, notePolicy);
              await api("/api/patients/note", { patientId: noteFor, ciphertext });
              return `Encrypted note stored for ${noteFor}.`;
            })}
          >
            Encrypt and save
          </button>
        </section>
      )}

      <section className="card">
        <h2>Rank-affecting changes</h2>
        <p className="muted">
          A doctor proposes. The ranking changes only after <b>2 different people from 2 different
          organizations</b> approve, including one rank_signoff holder; the proposer cannot approve.
          Roles and organizations come from each approver&apos;s TideCloak token; the counting rule is
          enforced by this app&apos;s server.
        </p>
        {myOrg && <p className="muted">You sign in as <b>{getValueFromToken("preferred_username")}</b> from <b>{myOrg}</b>.</p>}
        {isDoctor && (
          <div className="form-row">
            <label>Patient
              <select value={proposeFor} onChange={(e) => setProposeFor(e.target.value)}>
                {data.patients.map((p) => <option key={p.id} value={p.id}>{p.id} (urgency {p.urgency})</option>)}
              </select>
            </label>
            <label>New urgency
              <select value={proposeTo} onChange={(e) => setProposeTo(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label style={{ flex: 1 }}>Reason
              <input value={proposeReason} onChange={(e) => setProposeReason(e.target.value)} />
            </label>
            <button onClick={() => run(async () => {
              await api("/api/proposals", { patientId: proposeFor, to: proposeTo, reason: proposeReason });
              return "Proposal filed. The ranking does not change until 2 people from 2 organizations, including a rank_signoff holder, approve it.";
            })}>Propose</button>
          </div>
        )}
        {proposals.length === 0 && <p className="muted">No proposals yet.</p>}
        {proposals.length > 0 && (
          <table className="table">
            <thead><tr><th>Patient</th><th>Change</th><th>Reason</th><th>Proposed by</th><th>Approvals</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {proposals.map((pr) => {
                const approvals = pr.approvals ?? [];
                const orgCount = new Set(approvals.map((a) => a.org)).size;
                const iApproved = approvals.some((a) => a.sub === me);
                return (
                <tr key={pr.id}>
                  <td>{pr.patientId}</td>
                  <td>urgency {pr.from} → {pr.to}</td>
                  <td>{pr.reason}</td>
                  <td>{pr.proposedByName}{pr.proposedByOrg && <span className="muted"><br />{pr.proposedByOrg}</span>}</td>
                  <td>
                    <b>{approvals.length}/2 people · {orgCount}/2 organizations</b>
                    {!approvals.some((a) => a.rankSignoff) && pr.status === "pending" && <span className="muted"><br />still needs a rank_signoff holder</span>}
                    {approvals.map((a) => (
                      <span key={a.sub} className="muted"><br />✓ {a.name} ({a.org}){a.rankSignoff ? " · rank_signoff" : ""}</span>
                    ))}
                  </td>
                  <td><span className={`pill ${pr.status}`}>{pr.status}</span></td>
                  <td className="row-actions">
                    {pr.status === "pending" && canApprove && (
                      <>
                        <button
                          disabled={pr.proposedBy === me || iApproved}
                          title={pr.proposedBy === me ? "You cannot sign off your own proposal" : iApproved ? "You already approved" : undefined}
                          onClick={() => run(async () => {
                            const { proposal, progress } = await api<{ proposal: Proposal; progress: Progress }>("/api/proposals/decide", { id: pr.id, decision: "approve" });
                            return proposal.status === "approved"
                              ? `Final sign-off: ${progress.approvers} people from ${progress.organizations} organizations. The ranking was recalculated.`
                              : `Approval recorded: ${progress.approvers}/${progress.needApprovers} people, ${progress.organizations}/${progress.needOrganizations} organizations${progress.rankSignoff ? "" : ", still needs a rank_signoff holder"}. The ranking has not changed.`;
                          })}
                        >
                          Approve
                        </button>
                        <button className="secondary" onClick={() => run(async () => {
                          await api("/api/proposals/decide", { id: pr.id, decision: "reject" });
                          return "Rejected.";
                        })}>Reject</button>
                      </>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!canApprove && proposals.some((p) => p.status === "pending") && (
          <p className="muted">Your token has neither rank_signoff nor bioethics_board, so the server will refuse your approval.</p>
        )}
      </section>

      <section className="card">
        <h2>Allocate {data.organ.id}</h2>
        {data.allocations.length > 0 ? (
          <p>
            Allocated to {data.allocations[0].patientId} ({data.allocations[0].kind === "policy" ? `rank #1 under policy ${data.allocations[0].policyVersion}` : `exception, rank #${data.allocations[0].rankAtAllocation}: ${data.allocations[0].reason}`}) by {data.allocations[0].allocatedBy}.
          </p>
        ) : (
          <>
            <p className="muted">Normal allocation always goes to rank #1; you do not choose the patient.</p>
            <button onClick={() => run(async () => {
              await api("/api/allocation", {});
              return "Allocated to the patient ranked #1.";
            })}>Allocate to rank #1</button>
            <h3>Exception (needs allocation_override)</h3>
            <div className="form-row">
              <label>Patient
                <select value={exceptionFor} onChange={(e) => setExceptionFor(e.target.value)}>
                  {data.patients.map((p) => <option key={p.id} value={p.id}>#{p.rank} {p.id}</option>)}
                </select>
              </label>
              <label style={{ flex: 1 }}>Reason
                <input value={exceptionReason} onChange={(e) => setExceptionReason(e.target.value)} placeholder="Why rank #1 should not receive this organ" />
              </label>
              <button className="secondary" onClick={() => run(async () => {
                await api("/api/allocation/override", { patientId: exceptionFor, reason: exceptionReason });
                return "Exception recorded.";
              })}>Allocate as exception</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2>Audit log</h2>
        <p className="muted">App-level log stored by this server. It is not tamper-proof; TideCloak keeps its own change-request records for role grants.</p>
        <table className="table">
          <tbody>
            {auditLog.map((a, i) => (
              <tr key={i}><td className="muted">{new Date(a.at).toLocaleTimeString()}</td><td>{a.actor}</td><td>{a.action}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

export default function PatientsPage() {
  return <LoginGate title="Kidney waiting list"><PatientsContent /></LoginGate>;
}
