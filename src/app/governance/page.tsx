"use client";

import { useTideCloak } from "@tidecloak/nextjs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NOTE_POLICIES, NOTES_RECORD_ID, type NotePolicyName } from "@/lib/organtrust/access";
import { signRelationshipPolicy } from "@/lib/organtrust/relationship";
import { isTideMode } from "@/lib/organtrust/roles";
import {
  adminBase,
  approveChangeRequest,
  consoleUrl,
  listChangeRequests,
  listUsers,
  requestRealmRoleGrant,
  type ChangeRequest,
} from "@/lib/organtrust/tidecloakAdmin";
import { absoluteUrl, errorMessage, useApi } from "../useApi";

const GOVERNED_ROLES = ["allocation_override", "rank_signoff"] as const;

// Flow 1: a realm admin (the director) asks TideCloak to grant him allocation_override.
// TideCloak files a change request; it applies only after the admin quorum signs it.
export default function GovernancePage() {
  const { authenticated, isInitializing, login, getConfig, getValueFromToken, hasClientRole, hasRealmRole, secureFetch } =
    useTideCloak();
  const config = useMemo(() => (authenticated ? getConfig() : null), [authenticated, getConfig]);
  const base = config ? adminBase(config) : "";

  const [users, setUsers] = useState<{ id: string; username: string }[]>([]);
  const [targetUser, setTargetUser] = useState<string>("");
  const [role, setRole] = useState<(typeof GOVERNED_ROLES)[number]>("allocation_override");
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [overrideResult, setOverrideResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const api = useApi();
  const [signedPolicies, setSignedPolicies] = useState<Record<string, { signedBy: string; at: string }>>({});
  const [policyMessage, setPolicyMessage] = useState<string | null>(null);

  const isRealmAdmin =
    authenticated && (hasClientRole("tide-realm-admin", "realm-management") || hasClientRole("realm-admin", "realm-management"));
  const tideMode = isTideMode(config);
  const me = authenticated ? (getValueFromToken("sub") as string) : "";

  const refresh = useCallback(async () => {
    if (!base) return;
    setError(null);
    try {
      const [u, crs, po] = await Promise.all([
        listUsers(secureFetch, base),
        listChangeRequests(secureFetch, base),
        api<{ policies: Record<string, { signedBy: string; at: string }> }>("/api/e2ee/policies"),
      ]);
      setUsers(u);
      setRequests(crs);
      setSignedPolicies(po.policies);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [base, secureFetch, api]);

  useEffect(() => {
    if (isRealmAdmin) refresh();
  }, [isRealmAdmin, refresh]);

  useEffect(() => {
    if (me && !targetUser) setTargetUser(me);
  }, [me, targetUser]);

  if (isInitializing) return <main className="page"><p>Connecting to TideCloak…</p></main>;
  if (!authenticated) {
    return <main className="page"><h1>Governance</h1><button onClick={login}>Log in with Tide</button></main>;
  }

  const usernameOf = (id: string) => users.find((u) => u.id === id)?.username ?? id;

  async function requestGrant() {
    setMessage(null);
    setError(null);
    try {
      const { status, detail } = await requestRealmRoleGrant(secureFetch, base, targetUser, role);
      if (status !== 202 && status !== 204) {
        setMessage(`TideCloak answered HTTP ${status}. ${detail}`);
        return;
      }
      // Tide mode answers 202 and Tideless 204, so look at what TideCloak actually recorded.
      const pending = (await listChangeRequests(secureFetch, base)).find(
        (cr) => cr.actionType === "GRANT_ROLES" && cr.entityId === targetUser,
      );
      setMessage(
        pending
          ? `TideCloak did not grant ${role}. It filed a change request that stays pending until ${pending.threshold ?? "the quorum of"} admins approve it.`
          : `TideCloak applied the grant immediately (HTTP ${status}). This realm is not enforcing a quorum.`,
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Signs one RelationshipAttestation:1 policy in the Tide enclave: holders of `name` may use the
  // clinical notes record. The admin's approval in the enclave IS the grant.
  async function signNotePolicy(name: NotePolicyName) {
    setPolicyMessage(null);
    setError(null);
    try {
      const res = await secureFetch(`${base}/iga/role-policies/name/tide-realm-admin`);
      if (!res.ok) throw new Error(`Could not read the realm admin policy (${res.status})`);
      const { policy } = await res.json();
      const adminPolicy = Uint8Array.from(atob(policy), (c) => c.charCodeAt(0));
      const signed = await signRelationshipPolicy(
        {
          vendorId: String(config?.vendorId),
          subject: { type: "Role", id: name },
          recordId: NOTES_RECORD_ID,
          access: NOTE_POLICIES[name],
        },
        adminPolicy,
      );
      await api("/api/e2ee/policies", { name, policy: signed });
      setPolicyMessage(`Signed: holders of ${name} may ${NOTE_POLICIES[name]} the clinical notes.`);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function approve(cr: ChangeRequest) {
    setMessage(null);
    setError(null);
    try {
      const result = await approveChangeRequest(secureFetch, base, cr.id);
      if (result.mode === "needs-approval") {
        setMessage("This realm needs a Tide enclave signature: approve it in the TideCloak admin console.");
      } else {
        setMessage(
          result.committed
            ? "Your approval completed the quorum. TideCloak applied the change."
            : `Approval recorded (${result.authCount ?? "?"} of ${result.threshold ?? "?"}). It still needs another admin.`,
        );
      }
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function tryOverride() {
    setOverrideResult(null);
    const res = await secureFetch(absoluteUrl("/api/allocation/override"), { method: "POST" });
    const body = await res.json().catch(() => ({}));
    setOverrideResult(res.ok ? `Accepted: ${body.note}` : `Rejected with HTTP ${res.status}: ${body.error ?? res.statusText}`);
  }

  return (
    <main className="page">
      <header className="topbar">
        <h1>Governance</h1>
        <a href="/">Home</a>
      </header>
      <p className="muted">
        Signed in as <b>{getValueFromToken("preferred_username")}</b>.{" "}
        {hasRealmRole("allocation_override")
          ? "Your token carries allocation_override."
          : "Your token does not carry allocation_override."}
      </p>
      <p className={tideMode ? "muted" : "mode-warning"}>
        {tideMode
          ? "Tide mode: every approval is a signature from the admin's Tide enclave, and the quorum is enforced by the Tide network."
          : "Tideless mode (fallback): approvals are recorded and the quorum is enforced by TideCloak's own server software, not by the Tide network. Whoever operates the server could bypass it."}
      </p>

      {!isRealmAdmin && (
        <section className="card">
          <p>Only realm admins can file or see role change requests.</p>
        </section>
      )}

      {isRealmAdmin && (
        <section className="card">
          <h2>Request a governed role</h2>
          <p className="muted">
            Roles like allocation_override can only be granted through TideCloak&apos;s admin quorum.
            Asking for one files a change request; it does not grant the role.
          </p>
          <div className="form-row">
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                {GOVERNED_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label>
              Grant to
              <select value={targetUser} onChange={(e) => setTargetUser(e.target.value)}>
                {users.length === 0 && <option value={me}>me</option>}
                {users.map((u) => <option key={u.id} value={u.id}>{u.username}{u.id === me ? " (me)" : ""}</option>)}
              </select>
            </label>
            <button onClick={requestGrant} disabled={!targetUser}>Request grant</button>
          </div>
          {message && <p>{message}</p>}
        </section>
      )}

      {isRealmAdmin && (
        <section className="card">
          <div className="topbar">
            <h2>Pending change requests in TideCloak</h2>
            <button className="secondary" onClick={refresh}>Refresh</button>
          </div>
          {requests.length === 0 && <p className="muted">No pending change requests.</p>}
          {requests.length > 0 && (
            <table className="table">
              <thead>
                <tr><th>Action</th><th>Target</th><th>Requested by</th><th>Approvals</th>{!tideMode && <th></th>}</tr>
              </thead>
              <tbody>
                {requests.map((cr) => (
                  <tr key={cr.id}>
                    <td>{cr.actionType}</td>
                    <td>{cr.entityType === "USER" ? usernameOf(cr.entityId) : `${cr.entityType} ${cr.entityId}`}</td>
                    <td>{cr.requestedBy ?? "?"}</td>
                    <td>
                      {cr.authorizationCount ?? (cr.readyToCommit ? "ready" : "?")} of {cr.threshold ?? "?"}
                      {cr.authorizers && cr.authorizers.length > 0 && (
                        <span className="muted"> ({cr.authorizers.map((a) => a.username).join(", ")})</span>
                      )}
                    </td>
                    {!tideMode && (
                      <td>
                        <button
                          className="secondary"
                          disabled={cr.authorizers?.some((a) => a.username === getValueFromToken("preferred_username"))}
                          onClick={() => approve(cr)}
                        >
                          Approve
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {config && (
            <p className="muted">
              {tideMode
                ? "Admins approve these in the TideCloak console with their own Tide signature: "
                : "Each admin approves from their own login, here or in the TideCloak console. TideCloak lets the requester approve too, but one approval is never enough. "}
              <a href={consoleUrl(config)} target="_blank" rel="noreferrer">open the admin console</a> → Change Requests.
            </p>
          )}
        </section>
      )}

      {isRealmAdmin && !tideMode && (
        <section className="card">
          <h2>E2EE policies for clinical notes</h2>
          <p className="muted">Not available in Tideless mode: encryption through the Tide network needs Tide accounts.</p>
        </section>
      )}

      {isRealmAdmin && tideMode && (
        <section className="card">
          <h2>E2EE policies for clinical notes</h2>
          <p className="muted">
            Uses Tide&apos;s built-in RelationshipAttestation:1 contract. The ORK network, not this server,
            decides who can decrypt notes tagged <code>{NOTES_RECORD_ID}</code>.
          </p>
          <table className="table">
            <tbody>
              {(Object.keys(NOTE_POLICIES) as NotePolicyName[]).map((name) => (
                <tr key={name}>
                  <td>Role <b>{name}</b> may {NOTE_POLICIES[name]}</td>
                  <td>{signedPolicies[name] ? `signed by ${signedPolicies[name].signedBy}` : "not signed"}</td>
                  <td><button onClick={() => signNotePolicy(name)}>{signedPolicies[name] ? "Re-sign" : "Sign in Tide enclave"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {policyMessage && <p className="ok">{policyMessage}</p>}
        </section>
      )}

      <section className="card">
        <h2>Try to use an allocation override</h2>
        <p className="muted">The API checks the role on the server from the verified TideCloak token.</p>
        <button onClick={tryOverride}>Call /api/allocation/override</button>
        {overrideResult && <p className={overrideResult.startsWith("Accepted") ? "ok" : "error"}>{overrideResult}</p>}
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
