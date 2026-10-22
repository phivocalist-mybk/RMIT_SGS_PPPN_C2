"use client";

import { useTideCloak } from "@tidecloak/nextjs";
import { useState } from "react";
import { APP_ROLES, appRolesOf, isTideMode } from "@/lib/organtrust/roles";
import { absoluteUrl } from "./useApi";

type ServerView = { sub: string; username: string; roles: string[]; realmAdmin: boolean };

export default function HomePage() {
  const {
    authenticated,
    isInitializing,
    login,
    logout,
    getValueFromToken,
    hasClientRole,
    secureFetch,
    getConfig,
  } = useTideCloak();
  const [serverView, setServerView] = useState<ServerView | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  if (isInitializing) return <main className="page"><p>Connecting to TideCloak…</p></main>;

  if (!authenticated) {
    return (
      <main className="page">
        <h1>OrganTrust</h1>
        <p className="lead">
          A kidney waiting list where no doctor, director, IT admin or coordinator can change a
          ranking or grant an exception alone.
        </p>
        <p className="muted">Synthetic data only. Demo accounts are created by scripts/init-tidecloak.sh.</p>
        <button onClick={login}>Log in with Tide</button>
      </main>
    );
  }

  const tokenRoles = appRolesOf(getValueFromToken("realm_access")?.roles ?? []);
  const isRealmAdmin =
    hasClientRole("tide-realm-admin", "realm-management") || hasClientRole("realm-admin", "realm-management");
  const tideMode = isTideMode(getConfig());

  async function askServer() {
    setServerError(null);
    setServerView(null);
    // secureFetch attaches the access token AND a DPoP proof; the route re-verifies both.
    const res = await secureFetch(absoluteUrl("/api/me"));
    if (!res.ok) {
      setServerError(`${res.status}: ${(await res.json().catch(() => ({}))).error ?? res.statusText}`);
      return;
    }
    setServerView(await res.json());
  }

  return (
    <main className="page">
      <header className="topbar">
        <h1>OrganTrust</h1>
        <button className="secondary" onClick={logout}>Log out</button>
      </header>

      {!tideMode && (
        <p className="mode-warning">
          Tideless mode (fallback): password logins, and the admin quorum is enforced by TideCloak&apos;s own
          server software rather than the Tide network. Clinical-note encryption is off.
        </p>
      )}

      <section className="card">
        <h2>Signed in as {getValueFromToken("preferred_username")}</h2>
        <p className="muted">
          {getValueFromToken("name")}
          {getValueFromToken("organization") && <> · {getValueFromToken("organization")}</>}
        </p>
        <h3>Roles in your TideCloak token</h3>
        <ul className="chips">
          {tokenRoles.map((role) => <li key={role}>{APP_ROLES[role]}</li>)}
          {isRealmAdmin && <li className="admin">Realm admin ({tideMode ? "tide-realm-admin" : "realm-admin"})</li>}
          {tokenRoles.length === 0 && !isRealmAdmin && <li className="none">No OrganTrust role</li>}
        </ul>
        <p className="muted">
          The page only uses these to decide what to show. Every API route verifies the token
          signature, the DPoP proof and the role again on the server.
        </p>
        <nav className="links">
          {tokenRoles.some((r) => r !== "donor_family") && <a href="/patients">Waiting list</a>}
          {tokenRoles.some((r) => r !== "donor_family") && <a href="/raw">IT admin / raw database</a>}
          {isRealmAdmin && <a href="/governance">Governance</a>}
          {tokenRoles.includes("donor_family") && <a href="/family">Donor family view</a>}
        </nav>
      </section>

      <section className="card">
        <h3>What the server sees</h3>
        <button onClick={askServer}>Ask the server to verify my token</button>
        {serverError && <p className="error">Rejected: {serverError}</p>}
        {serverView && (
          <dl className="facts">
            <dt>Subject</dt><dd><code>{serverView.sub}</code></dd>
            <dt>Username</dt><dd>{serverView.username}</dd>
            <dt>Verified roles</dt><dd>{serverView.roles.join(", ") || "none"}</dd>
            <dt>Realm admin</dt><dd>{serverView.realmAdmin ? "yes" : "no"}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}
