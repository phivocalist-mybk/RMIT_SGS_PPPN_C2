"use client";

import { useTideCloak } from "@tidecloak/nextjs";
import { useCallback } from "react";

// secureFetch builds its DPoP proof from `new URL(url)`, so it needs an absolute URL.
export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

// Calls our own API with secureFetch, which attaches the access token and a DPoP proof.
// Throws "<status>: <error>" so pages can show exactly what the server refused.
export function useApi() {
  const { secureFetch } = useTideCloak();
  return useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      const res = await secureFetch(
        absoluteUrl(path),
        body === undefined
          ? undefined
          : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status}: ${json.error ?? res.statusText}`);
      return json as T;
    },
    [secureFetch],
  );
}

// Shown by every page before the SDK is ready or while nobody is signed in.
export function LoginGate({ title, children }: { title: string; children: React.ReactNode }) {
  const { authenticated, isInitializing, login } = useTideCloak();
  if (isInitializing) return <main className="page"><p>Connecting to TideCloak…</p></main>;
  if (!authenticated) {
    return (
      <main className="page">
        <h1>{title}</h1>
        <button onClick={login}>Log in with Tide</button>
      </main>
    );
  }
  return <>{children}</>;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
