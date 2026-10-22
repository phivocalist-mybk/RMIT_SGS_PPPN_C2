import { withRole } from "@/lib/auth/protect";
import { actorOf, readJson } from "@/lib/organtrust/access";
import { audit, updateDb } from "@/lib/organtrust/store";

// Stores a clinical note that the doctor's browser already encrypted with TideCloak.
// The server cannot check that it is ciphertext; it only ever receives what the browser sends.
export const POST = withRole("transplant_doctor", async (req, jwt) => {
  const { patientId, ciphertext } = await readJson<{ patientId: string; ciphertext: string }>(req);
  if (typeof patientId !== "string" || typeof ciphertext !== "string" || !ciphertext || ciphertext.length > 20000) {
    return Response.json({ error: "patientId and ciphertext are required" }, { status: 400 });
  }

  const stored = updateDb((db) => {
    const patient = db.patients.find((p) => p.id === patientId);
    if (!patient) return false;
    patient.clinicalNote = ciphertext;
    audit(db, actorOf(jwt), `Stored an encrypted clinical note for ${patientId} (ciphertext only)`);
    return true;
  });
  return stored
    ? Response.json({ stored: true })
    : Response.json({ error: `Unknown patient ${patientId}` }, { status: 404 });
});
