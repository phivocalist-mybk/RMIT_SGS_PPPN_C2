#!/bin/bash
# init-tideless.sh — FALLBACK realm for OrganTrust when Tide accounts cannot be created.
#
# Adds realm `organtrust-tideless` to the TideCloak container that init-tidecloak.sh started.
# It does not wipe or touch the Tide realm. Differences from the Tide realm:
#   - users sign in with a TideCloak password (no Tide account, no enclave)
#   - IGA runs in Tideless mode: the admin quorum is enforced by TideCloak's own server logic,
#     NOT by the Tide network. Whoever operates the server could bypass it.
#   - no E2EE: encrypting through the Tide network needs Tide accounts
#
# Usage: bash scripts/init-tideless.sh          (needs curl, jq and .env from init-tidecloak.sh)
#        FORCE_RECREATE=1 bash scripts/init-tideless.sh   (deletes and recreates this realm only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a; . "$PROJECT_DIR/.env"; set +a
fi

TIDECLOAK_URL="${TIDECLOAK_URL:-http://localhost:8080}"
REALM_NAME="${REALM_NAME:-organtrust-tideless}"
CLIENT_NAME="${CLIENT_NAME:-organtrust-client}"
CLIENT_APP_URL="${CLIENT_APP_URL:-http://localhost:3000}"
IGA_THRESHOLD="${IGA_THRESHOLD:-2}"
ADAPTER_OUTPUT="${ADAPTER_OUTPUT:-$PROJECT_DIR/data/tidecloak.tideless.json}"
ACCOUNTS_FILE="$PROJECT_DIR/data/tideless-accounts.txt"
KC_BOOTSTRAP_ADMIN_USERNAME="${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}"
: "${KC_BOOTSTRAP_ADMIN_PASSWORD:?KC_BOOTSTRAP_ADMIN_PASSWORD is not set (see .env)}"

# Same demo accounts and roles as init-tidecloak.sh.
# Format: username|firstName|lastName|realm roles|organization (fictional; goes into the token's
# `organization` claim, which the app uses for the two-organization sign-off rule)
DEMO_USERS=(
  "doctor|Dana|Doctor|transplant_doctor|Riverside General Hospital"
  "director|Harper|Director|hospital_director|Riverside General Hospital"
  "board1|Bao|Board-One|bioethics_board|Northgate Bioethics Council"
  "board2|Linh|Board-Two|bioethics_board|Riverside General Hospital"
  "immunologist|Imogen|Immunologist|immunologist rank_signoff|Independent HLA Laboratory"
  "family|Donor|Family|donor_family|"
)
# These get realm-management/realm-admin, i.e. they are the IGA approvers.
REALM_ADMINS="director board1 board2 immunologist"

get_token() {
  curl -s -X POST "$TIDECLOAK_URL/realms/master/protocol/openid-connect/token" \
    -d "client_id=admin-cli" -d "grant_type=password" \
    --data-urlencode "username=$KC_BOOTSTRAP_ADMIN_USERNAME" \
    --data-urlencode "password=$KC_BOOTSTRAP_ADMIN_PASSWORD" \
    | jq -r '.access_token'
}
API_BODY="$(mktemp)"
trap 'rm -f "$API_BODY" "$API_BODY.profile"' EXIT
api() { # api METHOD PATH [JSON] -> prints HTTP status, body to $API_BODY
  curl -s -o "$API_BODY" -w '%{http_code}' -X "$1" "$TIDECLOAK_URL/admin/realms$2" \
    -H "Authorization: Bearer $(get_token)" -H "Content-Type: application/json" ${3:+-d "$3"}
}
user_id() {
  curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users?username=$1&exact=true" \
    -H "Authorization: Bearer $(get_token)" | jq -r '.[0].id // empty'
}

curl -sf -m 5 "$TIDECLOAK_URL/realms/master" > /dev/null || { echo "ERROR: TideCloak is not running at $TIDECLOAK_URL"; exit 1; }

# --- Realm ---
if [ "$(api GET "/$REALM_NAME")" = "200" ]; then
  if [ "${FORCE_RECREATE:-0}" = "1" ]; then
    echo "==> Deleting existing realm '$REALM_NAME'..."
    api DELETE "/$REALM_NAME" > /dev/null
  else
    echo "ERROR: realm '$REALM_NAME' already exists. Re-run with FORCE_RECREATE=1 to rebuild it."
    exit 1
  fi
fi

echo "==> Creating realm '$REALM_NAME' (password login)..."
# The Tide realm template, minus the Tide login flow: plain username/password form instead.
REALM_JSON=$(sed -e "s|REALM_NAME|$REALM_NAME|g" -e "s|CLIENT_NAME|$CLIENT_NAME|g" -e "s|CLIENT_APP_URL|$CLIENT_APP_URL|g" \
    "$SCRIPT_DIR/realm.json.template" \
  | jq 'del(.authenticationFlows, .authenticatorConfig, .browserFlow)
        | .requiredActions = [.requiredActions[] | select(.alias != "link-tide-account-action")]
        | .attributes = ((.attributes // {}) + {"iga.attestor": "simple"})')
CODE=$(api POST "" "$REALM_JSON")
[ "$CODE" = "201" ] || { echo "ERROR: realm create answered $CODE: $(head -c 300 "$API_BODY")"; exit 1; }

# Synthetic accounts have no email; drop Keycloak's default "email required".
curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users/profile" -H "Authorization: Bearer $(get_token)" \
  | jq '(.attributes[] | select(.name=="email")) |= del(.required)' > "$API_BODY.profile"
CODE=$(api PUT "/$REALM_NAME/users/profile" "$(cat "$API_BODY.profile")")
echo "    user profile: HTTP $CODE"

# --- Users, passwords and roles: all BEFORE IGA is enabled, so no quorum is needed for setup ---
echo "==> Creating demo users with generated passwords..."
mkdir -p "$(dirname "$ACCOUNTS_FILE")"
{
  echo "# OrganTrust Tideless demo accounts (local only, gitignored). Login: $CLIENT_APP_URL"
  echo "# realm $REALM_NAME on $TIDECLOAK_URL"
} > "$ACCOUNTS_FILE"
RM_UUID=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=realm-management" -H "Authorization: Bearer $(get_token)" | jq -r '.[0].id')
for entry in "${DEMO_USERS[@]}"; do
  IFS='|' read -r U FIRST LAST ROLES ORG <<< "$entry"
  # `|| true`: tr gets SIGPIPE when head stops reading, which pipefail would turn into an exit.
  PW="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c 16 || true)"
  ATTRS=$([ -n "$ORG" ] && echo "\"attributes\":{\"organization\":[\"$ORG\"]}," || true)
  CODE=$(api POST "/$REALM_NAME/users" "{\"username\":\"$U\",\"firstName\":\"$FIRST\",\"lastName\":\"$LAST\",\"enabled\":true,$ATTRS\"credentials\":[{\"type\":\"password\",\"value\":\"$PW\",\"temporary\":false}]}")
  [ "$CODE" = "201" ] || { echo "ERROR: user $U answered $CODE: $(head -c 300 "$API_BODY")"; exit 1; }
  DEMO_UID=$(user_id "$U")
  for R in $ROLES; do
    ROLE_JSON=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/roles/$R" -H "Authorization: Bearer $(get_token)")
    api POST "/$REALM_NAME/users/$DEMO_UID/role-mappings/realm" "[$ROLE_JSON]" > /dev/null
  done
  if [[ " $REALM_ADMINS " == *" $U "* ]]; then
    ADMIN_ROLE=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/clients/$RM_UUID/roles/realm-admin" -H "Authorization: Bearer $(get_token)")
    api POST "/$REALM_NAME/users/$DEMO_UID/role-mappings/clients/$RM_UUID" "[$ADMIN_ROLE]" > /dev/null
  fi
  printf '%-13s %s\n' "$U" "$PW" >> "$ACCOUNTS_FILE"
  echo "    $U: roles [$ROLES]$([[ " $REALM_ADMINS " == *" $U "* ]] && echo " + realm-admin") org [${ORG:-none}]"
done

# --- IGA, Tideless mode ---
echo "==> Enabling IGA (Tideless, threshold $IGA_THRESHOLD)..."
REALM_REP=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME" -H "Authorization: Bearer $(get_token)")
CODE=$(api PUT "/$REALM_NAME" "$(echo "$REALM_REP" | jq --arg t "$IGA_THRESHOLD" '.attributes = ((.attributes // {}) + {"iga.attestor":"simple","iga.threshold":$t})')")
echo "    realm attributes: HTTP $CODE"
IGA_OUT=$(curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/tide-admin/toggle-iga" \
  -H "Authorization: Bearer $(get_token)" -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "isIGAEnabled=true")
echo "    toggle-iga: $(echo "$IGA_OUT" | head -c 300)"

# Baseline ADOPT_* requests have threshold 1; the master admin can commit those.
for pass in 1 2 3; do
  for id in $(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests?status=PENDING" -H "Authorization: Bearer $(get_token)" \
      | jq -r 'if type=="array" then (.[] | select(.actionType | startswith("ADOPT_")) | .id) else empty end'); do
    api POST "/$REALM_NAME/iga/change-requests/$id/authorize" '{}' > /dev/null
    api POST "/$REALM_NAME/iga/change-requests/$id/commit" > /dev/null
  done
done

# --- Adapter ---
echo "==> Exporting adapter config to $ADAPTER_OUTPUT..."
CLIENT_UUID=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=$CLIENT_NAME" -H "Authorization: Bearer $(get_token)" | jq -r '.[0].id')
ADAPTER=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/clients/$CLIENT_UUID/installation/providers/keycloak-oidc-keycloak-json" -H "Authorization: Bearer $(get_token)")
# The app verifies tokens against an embedded key set, as on the Tide realm. Embed this realm's.
JWKS=$(curl -s "$TIDECLOAK_URL/realms/$REALM_NAME/protocol/openid-connect/certs")
echo "$ADAPTER" | jq --argjson jwk "$JWKS" '. + {jwk: $jwk}' > "$ADAPTER_OUTPUT"
jq -e 'has("jwk") and (.jwk.keys | length > 0)' "$ADAPTER_OUTPUT" > /dev/null \
  || { echo "ERROR: adapter has no signing keys"; exit 1; }

echo ""
echo "Done. Realm $REALM_NAME is ready."
echo "  Passwords: $ACCOUNTS_FILE"
echo "  Use it:    cp data/tidecloak.tideless.json data/tidecloak.json   (then restart npm run dev)"
echo "  Pending change requests:"
curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests?status=PENDING" -H "Authorization: Bearer $(get_token)" \
  | jq -r 'if type=="array" then (.[] | "    \(.actionType) \(.entityType) (\(.authorizationCount // 0)/\(.threshold // "?"))") else "    \(.)" end'
