"use client";

import { useEffect, useState } from "react";
import { errorMessage, LoginGate, useApi } from "../useApi";

type RawRecord = { id: string; clinicalNote: string | null; [key: string]: unknown };

// Flow 2: the stored records as they sit in the database file.
function RawContent() {
  const api = useApi();
  const [records, setRecords] = useState<RawRecord[] | null>(null);
  const [file, setFile] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ file: string; patients: RawRecord[] }>("/api/raw-db")
      .then((res) => {
        setFile(res.file);
        setRecords(res.patients);
      })
      .catch((err) => setError(errorMessage(err)));
  }, [api]);

  return (
    <main className="page">
      <header className="topbar">
        <h1>IT admin / raw database</h1>
        <a href="/">Home</a>
      </header>
      <p className="muted">
        What anyone with access to the server or the database file sees. Ranking inputs are
        pseudonymous; clinical notes were encrypted in the doctor&apos;s browser by TideCloak, so the
        server only ever stored ciphertext.
      </p>
      {error && <p className="error">{error}</p>}
      {records && (
        <section className="card">
          <h3><code>{file}</code></h3>
          {records.map((r) => (
            <div key={r.id} className="raw-record">
              <pre>{JSON.stringify({ ...r, clinicalNote: undefined }, null, 2)}</pre>
              <p className="muted">clinicalNote:</p>
              <pre className="cipher">{r.clinicalNote ?? "(no note stored yet)"}</pre>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

export default function RawPage() {
  return <LoginGate title="IT admin / raw database"><RawContent /></LoginGate>;
}
