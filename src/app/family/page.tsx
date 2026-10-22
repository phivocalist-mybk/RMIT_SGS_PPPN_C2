"use client";

import { useEffect, useState } from "react";
import { errorMessage, LoginGate, useApi } from "../useApi";

type Check = { label: string; status: "pass" | "fail" | "info"; detail: string };
type FamilyView = {
  organ: { id: string; organ: string; status: string };
  currentPolicy: string;
  outcome: string;
  detail: string | null;
  allocatedAt: string | null;
  checks: Check[];
};

const ICON: Record<Check["status"], string> = { pass: "✓", fail: "✗", info: "ℹ" };

// Flow 3: the donor family can check that the rules were followed, never who received the organ.
function FamilyContent() {
  const api = useApi();
  const [view, setView] = useState<FamilyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<FamilyView>("/api/family").then(setView).catch((err) => setError(errorMessage(err)));
  }, [api]);

  return (
    <main className="page">
      <header className="topbar">
        <h1>Donor family view</h1>
        <a href="/">Home</a>
      </header>
      {error && <p className="error">{error}</p>}
      {view && (
        <>
          <section className="card">
            <p className="muted">Donated {view.organ.organ} · {view.organ.id} · status: {view.organ.status}</p>
            <h2>{view.outcome}</h2>
            {view.detail && <p className="muted">{view.detail}</p>}
            {view.allocatedAt && <p className="muted">Recorded {new Date(view.allocatedAt).toLocaleString()}</p>}
            <p className="muted">
              Current ranking policy: {view.currentPolicy}. This page never shows who received the organ.
            </p>
          </section>

          <section className="card">
            <h2>Rules check</h2>
            <ul className="checks">
              {view.checks.map((c) => (
                <li key={c.label} className={`check ${c.status}`}>
                  <span className="check-icon">{ICON[c.status]}</span>
                  <div>
                    <strong>{c.label}</strong>
                    <p className="muted">{c.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="muted">
              Computed by the OrganTrust server from its own records, which are not tamper-proof. Who may
              approve, and which organization each approver belongs to, come from TideCloak, where
              granting a role or changing an organization needs the admin quorum.
            </p>
          </section>
        </>
      )}
    </main>
  );
}

export default function FamilyPage() {
  return <LoginGate title="Donor family view"><FamilyContent /></LoginGate>;
}
