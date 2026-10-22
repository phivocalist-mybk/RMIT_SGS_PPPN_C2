import { readFileSync } from "fs";
import { join } from "path";
import { withAnyRole } from "@/lib/auth/protect";
import { CLINICAL_ROLES } from "@/lib/organtrust/access";

// Flow 2: the stored patient records exactly as they sit on disk, i.e. what an IT admin or
// anyone with database access would see. Clinical notes are TideCloak ciphertext.
export const GET = withAnyRole(CLINICAL_ROLES, async () => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "data", "organtrust-db.json"), "utf-8"));
  return Response.json({ file: "data/organtrust-db.json", patients: raw.patients });
});
