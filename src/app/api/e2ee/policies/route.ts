import { withAuth, withRole } from "@/lib/auth/protect";
import { actorOf, NOTE_POLICIES, readJson } from "@/lib/organtrust/access";
import { audit, readDb, updateDb } from "@/lib/organtrust/store";

// Signed RelationshipAttestation:1 policies for the clinical notes. A realm admin signs them in the
// Tide enclave (browser); the server only stores the signed bytes. They are not secret: the ORK
// network still checks the caller's own credential on every encrypt/decrypt.
export const GET = withAuth(async () => {
  return Response.json({ policies: readDb().notePolicies ?? {} });
});

export const POST = withRole("tide-realm-admin", async (req, jwt) => {
  const { name, policy } = await readJson<{ name: string; policy: string }>(req);
  if (typeof name !== "string" || !(name in NOTE_POLICIES) || typeof policy !== "string" || !policy) {
    return Response.json({ error: `name (${Object.keys(NOTE_POLICIES).join(" | ")}) and policy are required` }, { status: 400 });
  }
  updateDb((db) => {
    db.notePolicies = { ...db.notePolicies, [name]: { policy, signedBy: actorOf(jwt), at: new Date().toISOString() } };
    audit(db, actorOf(jwt), `Signed the E2EE note policy for role ${name}`);
  });
  return Response.json({ stored: name });
});
