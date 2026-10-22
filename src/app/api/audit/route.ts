import { withAnyRole } from "@/lib/auth/protect";
import { CLINICAL_ROLES } from "@/lib/organtrust/access";
import { readDb } from "@/lib/organtrust/store";

// Flow 6: app-level audit log. It lives in the app's own JSON file, so it is NOT tamper-proof:
// whoever controls the server can edit it. TideCloak's own change-request records are separate.
export const GET = withAnyRole(CLINICAL_ROLES, async () => {
  return Response.json({ audit: readDb().audit });
});
