#!/bin/bash
# init-tidecloak.sh — Bootstrap TideCloak dev instance for this app
#
# Run via: npm run init
#
# What this does:
#   1. Starts TideCloak dev container (Docker required)
#   2. Creates realm and client from template
#   3. Initializes Tide licensing + IGA
#   4. Creates admin user with tide-realm-admin role
#   5. Generates invite link (you must open it in a browser)
#   6. Waits for account linking
#   7. Exports tidecloak.json to data/
#
# Prerequisites: docker, curl, jq
# Override any default via environment variable.

set -euo pipefail

# --- Derive app-relatable defaults from package.json ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Read the project name from package.json and sanitize for use as realm/client name.
# Strips @scope/, converts non-alphanumeric to hyphens, lowercases.
if [ -f "$PROJECT_DIR/package.json" ] && command -v jq &>/dev/null; then
  _PKG_NAME=$(jq -r '.name // empty' "$PROJECT_DIR/package.json" | sed 's|^@[^/]*/||' | tr -cs 'a-zA-Z0-9-' '-' | tr '[:upper:]' '[:lower:]' | sed 's/^-//;s/-$//')
fi
_APP_NAME="${_PKG_NAME:-myapp}"

# --- Configuration (override via environment) ---
TIDECLOAK_URL="${TIDECLOAK_URL:-http://localhost:8080}"
REALM_NAME="${REALM_NAME:-$_APP_NAME}"
CLIENT_NAME="${CLIENT_NAME:-${_APP_NAME}-client}"
CLIENT_APP_URL="${CLIENT_APP_URL:-http://localhost:3000}"
# No default email: the licence email is asked for below (TIDE_LICENSE_EMAIL).
ADAPTER_OUTPUT="${ADAPTER_OUTPUT:-./data/tidecloak.json}"
TIDECLOAK_IMAGE="${TIDECLOAK_IMAGE:-tideorg/tidecloak-dev:latest}"

# --- Master-admin credentials: from the environment / .env, NEVER hardcoded ---
# Load .env if present (gitignored). `set -a` exports everything it defines.
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a; . "$PROJECT_DIR/.env"; set +a
fi

KC_BOOTSTRAP_ADMIN_USERNAME="${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}"

# No default. A default password IS a hardcoded credential, just with extra steps —
# and one that silently ships to whoever runs this next (AP-41).
if [ -z "${KC_BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  cat >&2 <<'MSG'
ERROR: KC_BOOTSTRAP_ADMIN_PASSWORD is not set.

  This is the TideCloak master-admin password. It must come from the environment,
  not from this script:

    cp .env.example .env
    $EDITOR .env            # set KC_BOOTSTRAP_ADMIN_PASSWORD
    npm run init

  .env is gitignored. For anything beyond local Docker, inject the value from your
  secret manager instead of a file.
MSG
  exit 1
fi

# --- Licence email + Terms & Conditions: answered by a PERSON, before anything is created ---
# `setUpTideRealm` licenses the realm to an email address, under Tide's Terms & Conditions
# (https://tide.org/legal). Both belong to whoever owns this deployment. So there is no default
# email, and nothing in this script accepts the terms on anyone's behalf (AP-90). This runs before
# the container starts: declining must leave nothing behind.
TIDE_TERMS_URL="https://tide.org/legal"
LICENSE_EMAIL="${TIDE_LICENSE_EMAIL:-${ADMIN_EMAIL:-}}"

valid_license_email() {
  [[ "${1:-}" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || return 1
  # A placeholder is not an answer. These are the addresses agents and old docs reach for.
  case "${1##*@}" in
    example.com|example.org|example.net|yourorg.com|yourdomain.com|yourcompany.com|company.com|\
    domain.com|test.com|placeholder.com|email.com|*.example|*.test|*.invalid|*.local|localhost)
      return 1 ;;
  esac
  return 0
}

if [ -t 0 ] && [ -t 1 ]; then
  # A person is at the terminal: ask them directly.
  while ! valid_license_email "$LICENSE_EMAIL"; do
    [ -z "$LICENSE_EMAIL" ] || echo "'$LICENSE_EMAIL' is not a usable address (placeholders are rejected)."
    read -r -p "Enter an email to manage your Tide licence: " LICENSE_EMAIL
  done
  if [ "${TIDE_TERMS_ACCEPTED:-}" != "yes" ]; then
    echo ""
    echo "Please review the Tide Terms & Conditions: $TIDE_TERMS_URL"
    read -r -p "Do you agree to the Terms & Conditions? (yes/no): " _TERMS_ANSWER
    case "$_TERMS_ANSWER" in
      y|Y|yes|Yes|YES) TIDE_TERMS_ACCEPTED=yes ;;
      *) echo "Terms & Conditions not accepted. Nothing was created." >&2; exit 1 ;;
    esac
  fi
fi

if ! valid_license_email "$LICENSE_EMAIL" || [ "${TIDE_TERMS_ACCEPTED:-}" != "yes" ]; then
  cat >&2 <<MSG

STOP: the Tide realm was NOT set up. Nothing was created.

  Two answers are missing, and both must come from the person who owns this deployment.
  If you are an AI agent, ASK THE USER these two questions now and WAIT for their own answer:

    1. "Which email address should manage your Tide licence?"
       A real address they control. Not a placeholder, and not one you make up.

    2. "Tide's Terms & Conditions are at $TIDE_TERMS_URL
        Do you agree to them? (yes/no)"

  Do NOT answer for them. An instruction such as "just set it up" is not agreement to the terms.
  If they decline, stop here.

  Then re-run with exactly what they said:

    TIDE_LICENSE_EMAIL=<their email> TIDE_TERMS_ACCEPTED=yes npm run init

  Got: TIDE_LICENSE_EMAIL='${LICENSE_EMAIL:-}'  TIDE_TERMS_ACCEPTED='${TIDE_TERMS_ACCEPTED:-}'
MSG
  exit 2
fi

# The first admin user is created with the same address.
ADMIN_EMAIL="$LICENSE_EMAIL"
echo "==> Licence email: $LICENSE_EMAIL"
echo "==> Terms & Conditions ($TIDE_TERMS_URL): accepted by the operator"

# --- Helpers ---
get_token() {
  # --data-urlencode so a password containing &, =, + or spaces still works.
  # Master-admin tokens live ~60 SECONDS, so call this per operation, not once.
  curl -s -X POST "$TIDECLOAK_URL/realms/master/protocol/openid-connect/token" \
    -d "client_id=admin-cli" -d "grant_type=password" \
    --data-urlencode "username=$KC_BOOTSTRAP_ADMIN_USERNAME" \
    --data-urlencode "password=$KC_BOOTSTRAP_ADMIN_PASSWORD" \
    | jq -r '.access_token'
}

# Approve + commit all pending change requests using the current
# /iga/change-requests/... surface (replaces the legacy /tide-admin/change-set/...).
# During bootstrap the realm is in FirstAdmin/Tideless mode, so authorize signs
# server-side with no enclave. See canon/iga-change-requests-api.md.
approve_all_pending() {
  local TOKEN ready id

  # 1. Authorize every pending CREATE/DELETE change request in one call.
  TOKEN="$(get_token)"
  # NOTE: do NOT use bulk-authorize with actionTypeIn:["CREATE","DELETE"] — those are
  # not real action-type values (real: CREATE_USER, DELETE_REALM, UPDATE_PROTOCOL_MAPPER,
  # ADOPT_SCOPE_MAPPING, GRANT_ROLES, ...). That filter matches nothing and silently
  # authorizes ZERO CRs with a 200. Omitting the filter returns 400. VERIFIED 2026-08-06.
  ids=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests?status=PENDING" \
    -H "Authorization: Bearer $TOKEN" 2>/dev/null \
    | jq -r 'if type=="array" then (.[] | select(.actionType | IN("DISABLE_IGA","DELETE_REALM","OFFBOARD_REALM") | not) | .id) else empty end' 2>/dev/null)
  for id in $ids; do
    TOKEN="$(get_token)"
    curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests/$id/authorize" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' > /dev/null 2>&1 || true
  done

  # 2. Commit everything ready; loop passes so dependent CRs become ready.
  for pass in 1 2 3 4 5; do
    TOKEN="$(get_token)"
    ready=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests?status=PENDING" \
      -H "Authorization: Bearer $TOKEN" 2>/dev/null \
      | jq -r '.[] | select(.actionType | IN("DISABLE_IGA","DELETE_REALM","OFFBOARD_REALM") | not) | select(.readyToCommit==true) | .id' 2>/dev/null)
    [ -z "$ready" ] && break
    for id in $ready; do
      TOKEN="$(get_token)"
      curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests/$id/commit" \
        -H "Authorization: Bearer $TOKEN" > /dev/null 2>&1
    done
  done
}

# Back-compat wrapper: the legacy call sites pass a type arg (clients/users/roles)
# which the new list-all surface ignores. Each call sweeps all pending CRs.
approve_and_commit() { approve_all_pending; }

# --- Step 0: Check prerequisites ---
for cmd in docker curl jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd is required but not found."
    exit 1
  fi
done

# RESUME_AT_USERS=1 skips Steps 1-6 and continues on a realm that is already created, licensed and
# IGA-enabled. Tide's licensing call can fail transiently, and a licensed realm is worth keeping.
if [ "${RESUME_AT_USERS:-0}" != "1" ]; then

# --- Step 1: Clean previous state ---
# OrganTrust runs on Windows (Git Bash + Docker Desktop): no sudo/lsof, and the H2 database
# lives in a named Docker volume instead of a bind-mounted ./data folder.
H2_VOLUME="${H2_VOLUME:-organtrust-tidecloak-h2}"
echo "==> Cleaning previous state..."
docker stop tidecloak 2>/dev/null || true
docker rm tidecloak 2>/dev/null || true
docker volume rm "$H2_VOLUME" 2>/dev/null || true
mkdir -p "$PROJECT_DIR/data"

if curl -s -m 3 -o /dev/null "$TIDECLOAK_URL"; then
  echo "ERROR: Port 8080 is already in use."
  exit 1
fi

# --- Step 2: Start container ---
echo "==> Starting TideCloak ($TIDECLOAK_IMAGE)..."

# tideorg/tidecloak-dev is a development build of the server wired to the PRODUCTION Tide
# network (ork1, 14-of-20). It ships
# working ORK/threshold/payer defaults — do NOT pass SYSTEM_HOME_ORK, USER_HOME_ORK,
# THRESHOLD_T/N or PAYER_PUBLIC by hand. The -stg image is an internal pre-release
# build and is not supported by this pack.
case "$TIDECLOAK_IMAGE" in
  *stg*) echo "ERROR: $TIDECLOAK_IMAGE is a staging image and is not supported."
         echo "       Use tideorg/tidecloak-dev:latest (the only image this pack supports)."
         exit 1 ;;
esac

# Mount the volume on /opt/keycloak/data (it exists in the image), so Docker seeds the new volume
# with the image's ownership; a volume on data/h2 would be root-owned and H2 could not write.
MSYS_NO_PATHCONV=1 docker run -d --name tidecloak \
  -v "$H2_VOLUME:/opt/keycloak/data" \
  -p 8080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME="$KC_BOOTSTRAP_ADMIN_USERNAME" \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD="$KC_BOOTSTRAP_ADMIN_PASSWORD" \
  "$TIDECLOAK_IMAGE"

# --- Step 3: Wait for readiness ---
echo "==> Waiting for TideCloak to start..."
for i in {1..24}; do
  curl -sf "$TIDECLOAK_URL" > /dev/null 2>&1 && break
  echo "  Attempt $i/24..."
  sleep 5
done

if ! curl -sf "$TIDECLOAK_URL" > /dev/null 2>&1; then
  echo "ERROR: TideCloak did not start within 120 seconds. Run: docker logs tidecloak"
  exit 1
fi
echo "  TideCloak is ready."

# --- Step 4: Create realm from template ---
echo "==> Creating realm '$REALM_NAME'..."

# Use bundled realm template if available, fall back to shared
REALM_TEMPLATE=""
if [ -f "$SCRIPT_DIR/realm.json.template" ]; then
  REALM_TEMPLATE="$SCRIPT_DIR/realm.json.template"
elif [ -f "$SCRIPT_DIR/../realm.json.template" ]; then
  REALM_TEMPLATE="$SCRIPT_DIR/../realm.json.template"
else
  echo "ERROR: realm.json.template not found."
  exit 1
fi

TMP_REALM="$(mktemp)"
cp "$REALM_TEMPLATE" "$TMP_REALM"
sed -i "s|REALM_NAME|$REALM_NAME|g" "$TMP_REALM"
sed -i "s|CLIENT_NAME|$CLIENT_NAME|g" "$TMP_REALM"
sed -i "s|CLIENT_APP_URL|$CLIENT_APP_URL|g" "$TMP_REALM"

TOKEN="$(get_token)"
REALM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$TIDECLOAK_URL/admin/realms" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @"$TMP_REALM")
rm -f "$TMP_REALM"

if [[ ! "$REALM_STATUS" =~ ^2 ]]; then
  echo "ERROR: Realm import failed (HTTP $REALM_STATUS). Cannot continue."
  echo "If the realm already exists, delete it first or wipe the DB: sudo rm -f ./data/keycloakdb*"
  exit 1
fi
echo "    Realm created."

# --- Step 4b: Never show Keycloak's "Update Account Information" page --------------------------
# Tide asserts ONLY a username (the vuid). Keycloak's first-broker-login flow starts with
# `idp-review-profile`, whose default mode `missing` validates that identity against the User
# Profile and renders an UNSTYLED form showing a 64-hex username to every new user.
#
# Off by default here, so it is not a fix someone has to remember. Collect the details in the APP
# instead: templates/onboarding-modal/ProfileOnboarding.tsx writes them through the Account API.
#
# ORDER MATTERS: before toggle-iga. Once IGA is on this becomes a governed admin write and would
# return 202 as a pending change request instead of applying.
echo "==> Disabling the first-broker-login profile page..."
TOKEN="$(get_token)"
RP_EXEC="$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/authentication/flows/first%20broker%20login/executions" \
  -H "Authorization: Bearer $TOKEN")"
RP_CFG="$(printf '%s' "$RP_EXEC" | jq -r '.[]? | select(.providerId=="idp-review-profile") | .authenticationConfig // empty' | head -1)"
RP_ID="$(printf '%s' "$RP_EXEC" | jq -r '.[]? | select(.providerId=="idp-review-profile") | .id' | head -1)"
RP_BODY='{"alias":"review profile config","config":{"update.profile.on.first.login":"off"}}'
if [ -n "$RP_CFG" ]; then
  # A stock realm ALREADY has this config object, so the normal path is an update. POST would fail.
  curl -s -o /dev/null -X PUT "$TIDECLOAK_URL/admin/realms/$REALM_NAME/authentication/config/$RP_CFG" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$RP_BODY"
elif [ -n "$RP_ID" ]; then
  curl -s -o /dev/null -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/authentication/executions/$RP_ID/config" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$RP_BODY"
fi
TOKEN="$(get_token)"
RP_NOW="$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/authentication/flows/first%20broker%20login/executions" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[]? | select(.providerId=="idp-review-profile") | .authenticationConfig // empty' | head -1)"
RP_VAL=""
[ -n "$RP_NOW" ] && RP_VAL="$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/authentication/config/$RP_NOW" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.config["update.profile.on.first.login"] // empty')"
if [ "$RP_VAL" != "off" ]; then
  echo "ERROR: could not disable the first-broker-login profile page (read back '${RP_VAL:-<unset>}')." >&2
  echo "       Every new user would be stopped by Keycloak's Update Account Information form." >&2
  exit 1
fi
echo "    New users go straight into the app."

# --- Step 5: Initialize Tide + enable IGA ---
echo "==> Initializing Tide realm (license + VRK)..."
TOKEN="$(get_token)"
# Do NOT discard this response. A 200 is not proof of a licence: on current TideCloak source the
# body is the text `CREATED` (licensed), `NEED_PAYMENT` (HTTP 200, NOT licensed) or a 303 carrying
# a Stripe checkout URL. Older builds answer 200 with an activation package instead. Either way,
# NEED_PAYMENT and any non-2xx mean the realm has no licence, and everything after this would run
# against an unlicensed realm and fail somewhere less obvious.
SETUP_BODY="$(mktemp)"
SETUP_CODE="$(curl -s -o "$SETUP_BODY" -w '%{http_code}' -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/vendorResources/setUpTideRealm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "email=$ADMIN_EMAIL" \
  --data-urlencode "isRagnarokEnabled=true")" || SETUP_CODE="000"
SETUP_OUT="$(head -c 600 "$SETUP_BODY" 2>/dev/null || true)"
rm -f "$SETUP_BODY"
case "$SETUP_CODE" in
  2??) : ;;
  303) echo "ERROR: setUpTideRealm answered 303 (paid checkout), so no free-tier licence was issued. Response: $SETUP_OUT" >&2; exit 1 ;;
  *)   echo "ERROR: setUpTideRealm failed (HTTP $SETUP_CODE). Response: $SETUP_OUT" >&2
       echo "       The real cause is in the TideCloak container log (look for '[Midgard]')." >&2; exit 1 ;;
esac
case "$SETUP_OUT" in
  *NEED_PAYMENT*) echo "ERROR: setUpTideRealm answered NEED_PAYMENT: the realm is NOT licensed. Check the licence email ($ADMIN_EMAIL)." >&2; exit 1 ;;
esac

# Stamp iga.attestor=tide on the realm BEFORE enabling IGA. Required so IGA
# comes up in Tide (cryptographic) governance mode rather than Tideless.
echo "==> Stamping iga.attestor=tide..."
TOKEN="$(get_token)"
REALM_REP=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME" -H "Authorization: Bearer $TOKEN")
UPDATED_REALM=$(echo "$REALM_REP" | jq '.attributes = ((.attributes // {}) + {"iga.attestor":"tide"})')
curl -s -X PUT "$TIDECLOAK_URL/admin/realms/$REALM_NAME" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "$UPDATED_REALM" > /dev/null

echo "==> Enabling IGA..."
TOKEN="$(get_token)"
# toggle-iga must be called AT MOST ONCE, and only when IGA is off. On current source it is a FLIP:
# `isIGAEnabled` is ignored and each call inverts the state, so a call on a realm that already has
# IGA on files a DISABLE_IGA change request (202) -- which a drain loop would then approve. Older
# builds were measured to read the parameter (and to fail open to true on a JSON body). Reading the
# state first and asserting the response is correct on both.
IGA_NOW="$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.attributes.isIGAEnabled // "false"' 2>/dev/null | tr '[:upper:]' '[:lower:]')"
if [ "$IGA_NOW" = "true" ]; then
  echo "    IGA is already enabled on this realm; not calling toggle-iga again."
else
  IGA_OUT="$(curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/tide-admin/toggle-iga" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "isIGAEnabled=true")"
  case "$IGA_OUT" in
    *'"enabled":true'*) : ;;
    *) echo "ERROR: toggle-iga did not report enabled=true. Response: $IGA_OUT" >&2; exit 1 ;;
  esac
  # A 200 with enabled=true can still carry warnings: a failed signing sweep leaves the baseline
  # change requests PENDING and logins fail closed until they are approved.
  case "$IGA_OUT" in
    *'"warnings"'*|*commitFailures*) echo "WARNING: toggle-iga reported warnings. Read them before continuing: $IGA_OUT" >&2 ;;
  esac
fi

# --- Step 6: Approve client change requests ---
echo "==> Approving client change requests..."
sleep 2
approve_and_commit clients

fi # RESUME_AT_USERS

# --- Step 6b: Email optional ---
# Demo accounts are synthetic and get no email (Tide does not need one). Keycloak's default user
# profile requires email, so drop that requirement instead of inventing addresses (AP-85).
echo "==> Making email optional in the user profile..."
curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users/profile" -H "Authorization: Bearer $(get_token)" \
  | jq '(.attributes[] | select(.name=="email")) |= del(.required)' \
  | curl -s -o /dev/null -X PUT "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users/profile" \
      -H "Authorization: Bearer $(get_token)" -H "Content-Type: application/json" --data-binary @-
sleep 2
approve_and_commit realm
EMAIL_REQUIRED=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users/profile" -H "Authorization: Bearer $(get_token)" \
  | jq -r '.attributes[] | select(.name=="email") | .required // empty')
if [ -n "$EMAIL_REQUIRED" ]; then
  echo "ERROR: email is still required by the user profile: $EMAIL_REQUIRED" >&2
  exit 1
fi

# --- Step 7: Create the OrganTrust demo users (synthetic) ---
# Every governed write happens here, while the realm is still FirstAdmin and the server can sign.
# Once tide-realm-admin is granted (Step 11b), each role change needs an admin quorum in the enclave.
# Format: username|firstName|lastName|realm roles (space separated)|organization (fictional)
DEMO_USERS=(
  "doctor|Dana|Doctor|transplant_doctor _tide_encryptor _tide_decryptor|Riverside General Hospital"
  "director|Harper|Director|hospital_director|Riverside General Hospital"
  "board1|Bao|Board-One|bioethics_board|Northgate Bioethics Council"
  "board2|Linh|Board-Two|bioethics_board|Riverside General Hospital"
  "immunologist|Imogen|Immunologist|immunologist rank_signoff _tide_decryptor|Independent HLA Laboratory"
  "family|Donor|Family|donor_family|"
)
# These four get tide-realm-admin. With 4 admins the quorum is max(1, floor(0.7 * 4)) = 2.
REALM_ADMINS="director board1 board2 immunologist"

user_id() {
  curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users?username=$1&exact=true" \
    -H "Authorization: Bearer $(get_token)" | jq -r '.[0].id // empty'
}

echo "==> Creating demo users..."
for entry in "${DEMO_USERS[@]}"; do
  IFS='|' read -r U FIRST LAST _ ORG <<< "$entry"
  CREATE_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users" \
    -H "Authorization: Bearer $(get_token)" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$U\",\"firstName\":\"$FIRST\",\"lastName\":\"$LAST\",\"enabled\":true,\"attributes\":{\"tideInvitable\":[\"true\"]$([ -n "$ORG" ] && echo ",\"organization\":[\"$ORG\"]")}}")
  echo "    $U: HTTP $CREATE_CODE"
done

# With IGA enabled, a user is not queryable until its change request is committed.
echo "==> Approving user change requests..."
sleep 2
approve_and_commit users

echo "==> Assigning demo realm roles..."
for entry in "${DEMO_USERS[@]}"; do
  IFS='|' read -r U _ _ ROLES _ <<< "$entry"
  DEMO_UID=$(user_id "$U")
  if [ -z "$DEMO_UID" ]; then
    echo "ERROR: Could not find user '$U' after creation. Check change-request approval."
    exit 1
  fi
  # One role per request: IGA records only the first role of a multi-role POST in its change request.
  for R in $ROLES; do
    TOKEN="$(get_token)"
    ROLE_JSON=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/roles/$R" -H "Authorization: Bearer $TOKEN")
    curl -s -o /dev/null -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users/$DEMO_UID/role-mappings/realm" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "[$ROLE_JSON]"
    sleep 1
    approve_and_commit roles
  done
done
sleep 2
approve_and_commit roles

# NOTE: tide-realm-admin is granted LAST (after enrollment + signed IdP settings),
# because committing that grant flips the realm firstAdmin -> multiAdmin. No
# server-driven governed write may run after the flip. See Step 11b below.

# --- Step 8: Generate invite links ---
# Kept in a gitignored file too, so the links survive a closed terminal.
echo "==> Generating invite links..."
INVITES_FILE="$PROJECT_DIR/data/invite-links.txt"
: > "$INVITES_FILE"
echo ""
echo "============================================"
echo "Open each link in a SEPARATE private browser window and create a Tide account:"
for entry in "${DEMO_USERS[@]}"; do
  IFS='|' read -r U _ _ _ <<< "$entry"
  LINK=$(curl -s -X POST \
    "$TIDECLOAK_URL/admin/realms/$REALM_NAME/tideAdminResources/get-required-action-link?userId=$(user_id "$U")&lifespan=43200" \
    -H "Authorization: Bearer $(get_token)" \
    -H "Content-Type: application/json" \
    -d '["link-tide-account-action"]')
  echo "$U  $LINK" | tee -a "$INVITES_FILE"
done
echo "============================================"
echo ""

# --- Step 9: Wait for account linking ---
cat <<BANNER

--------------------------------------------
WHILE YOU ARE HERE — two things your users will see. Both are your call.

1) BRANDING. Right now they see TIDE's logo at sign-in, not yours.
     - generate one from the app's type   (vault identity notes chat data finance health media commerce)
     - you supply artwork                 (drop logo.png + background.jpg in ./branding/)
     - write me a prompt for an image AI  (tailored to this app)
     - leave it as Tide's

2) NEW-USER DETAILS. Tide gives each new user an account with NO name or email, and the Keycloak
   signup form is already turned OFF for this realm. What should the in-app form collect?
     - a display name        - first/last name        - email (Tide does NOT need it for recovery)
     - nothing; the vuid is enough

   AGENT: ask these as QUESTIONS and wait for the answer. Do not pick for the user and report it
   afterwards -- that is the one failure this placement exists to prevent (AP-87).
--------------------------------------------

BANNER

# Every account must link BEFORE the flip: linking writes tideUserKey, which is itself a change
# request, and after the flip that would need an enclave approval per user.
echo "Waiting for all demo accounts to link a Tide account (polling every 10s)..."
while true; do
  STILL_WAITING=""
  for entry in "${DEMO_USERS[@]}"; do
    IFS='|' read -r U _ _ _ <<< "$entry"
    KEY=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users?username=$U&exact=true" \
      -H "Authorization: Bearer $(get_token)" | jq -r '.[0].attributes.tideUserKey[0] // empty')
    [ -n "$KEY" ] || STILL_WAITING="$STILL_WAITING $U"
  done
  [ -z "$STILL_WAITING" ] && echo "  All accounts linked." && break
  echo "  Still waiting for:$STILL_WAITING"
  sleep 10
done

# --- Step 10: Approve role assignment change requests ---
echo "==> Approving role change requests..."
sleep 2
approve_and_commit users
approve_and_commit roles

# --- Step 11: Point the tide IdP at this realm's console origin, then sign it ---
# CustomAdminUIDomain must be the TideCloak console origin for THIS realm, not
# the app URL. sign-idp-settings needs healthy ORKs. Both run while still
# firstAdmin (before the grant flip below).
echo "==> Configuring CustomAdminUIDomain (console origin) + signing IdP settings..."
TIDE_CONSOLE_ORIGIN="$TIDECLOAK_URL/realms/$REALM_NAME/tide-console/"
TOKEN="$(get_token)"
INST=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/identity-provider/instances/tide" \
  -H "Authorization: Bearer $TOKEN")
UPDATED=$(echo "$INST" | jq --arg d "$TIDE_CONSOLE_ORIGIN" '.config.CustomAdminUIDomain=$d')
curl -s -X PUT "$TIDECLOAK_URL/admin/realms/$REALM_NAME/identity-provider/instances/tide" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d "$UPDATED" > /dev/null

curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/vendorResources/sign-idp-settings" \
  -H "Authorization: Bearer $TOKEN" > /dev/null

# --- Step 11b: Grant tide-realm-admin LAST, then final drain (flips to multiAdmin) ---
echo "==> Granting tide-realm-admin to: $REALM_ADMINS"
TOKEN="$(get_token)"
RM_UUID=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=realm-management" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

if [ -z "$RM_UUID" ] || [ "$RM_UUID" = "null" ]; then
  echo "ERROR: realm-management client not found."
  exit 1
fi

ROLE_JSON=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/clients/$RM_UUID/roles/tide-realm-admin" \
  -H "Authorization: Bearer $TOKEN")

if echo "$ROLE_JSON" | jq -e '.error' > /dev/null 2>&1; then
  echo "ERROR: tide-realm-admin role not found: $ROLE_JSON"
  exit 1
fi

for U in $REALM_ADMINS; do
  curl -s -X POST "$TIDECLOAK_URL/admin/realms/$REALM_NAME/users/$(user_id "$U")/role-mappings/clients/$RM_UUID" \
    -H "Authorization: Bearer $(get_token)" \
    -H "Content-Type: application/json" \
    -d "[$ROLE_JSON]" > /dev/null
done

# Final drain: commits GRANT_ROLES and flips firstAdmin -> multiAdmin.
# No governed write may run after this point.
echo "==> Final drain (commit grant + firstAdmin -> multiAdmin flip)..."
sleep 2
approve_and_commit roles

# Anything the flip left PENDING must now be approved by admins in the console
# ($TIDECLOAK_URL/admin/$REALM_NAME/console/ -> Change Requests).
echo "==> Change requests still pending:"
curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/iga/change-requests?status=PENDING" \
  -H "Authorization: Bearer $(get_token)" \
  | jq -r 'if type=="array" then (.[] | "  \(.actionType) \(.entityType) \(.id) (\(.authorizationCount // 0)/\(.threshold // "?"))") else . end'

# --- Step 12: Export adapter JSON ---
# --- Default enclave branding (logo + background) -------------------------------------------
# Generated locally — no image model needed — then uploaded and SIGNED. Branding is IGA-exempt
# (IGA_VENDOR_PROVISIONING), so this works even after the firstAdmin -> multiAdmin flip and needs
# no change-request drain. Skip with BRAND_SKIP=1; override colour with BRAND_ACCENT=<hex>.
BRAND_SCRIPT=""
for cand in "$SCRIPT_DIR/../../templates/enclave-branding/brand-tidecloak.sh" \
            "$SCRIPT_DIR/../templates/enclave-branding/brand-tidecloak.sh" \
            "$SCRIPT_DIR/enclave-branding/brand-tidecloak.sh"; do
  [ -f "$cand" ] && { BRAND_SCRIPT="$cand"; break; }
done
if [ "${BRAND_SKIP:-0}" = "1" ]; then
  echo "==> Skipping enclave branding (BRAND_SKIP=1)"
elif [ -z "$BRAND_SCRIPT" ]; then
  echo "==> Skipping enclave branding (templates/enclave-branding not found next to this script)"
elif ! command -v python3 >/dev/null 2>&1; then
  echo "==> Skipping enclave branding (python3 not available)"
else
  echo "==> Branding the login enclave (default logo + background)..."
  # Non-fatal: a cosmetic step must never fail a bootstrap that otherwise succeeded.
  if TIDECLOAK_URL="$TIDECLOAK_URL" bash "$BRAND_SCRIPT" \
       --realm "$REALM_NAME" --name "$_APP_NAME" \
       --accent "${BRAND_ACCENT:-1f6feb}" --out "$PROJECT_DIR/branding" 2>&1 | sed 's/^/    /'; then
    :
  else
    echo "    (branding failed — cosmetic only, bootstrap continues. Re-run:"
    echo "     bash $BRAND_SCRIPT --realm $REALM_NAME)"
  fi
fi

echo "==> Exporting adapter config..."
TOKEN="$(get_token)"
CLIENT_UUID=$(curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=$CLIENT_NAME" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

mkdir -p "$(dirname "$ADAPTER_OUTPUT")"
curl -s "$TIDECLOAK_URL/admin/realms/$REALM_NAME/vendorResources/get-installations-provider?clientId=$CLIENT_UUID&providerId=keycloak-oidc-keycloak-json" \
  -H "Authorization: Bearer $TOKEN" > "$ADAPTER_OUTPUT"

# --- Verify ---
if jq -e 'has("jwk") and has("vendorId") and has("homeOrkUrl")' "$ADAPTER_OUTPUT" > /dev/null 2>&1; then
  echo ""
  echo "============================================"
  echo "Init complete!"
  echo ""
  echo "  Adapter config: $ADAPTER_OUTPUT"
  echo "  TideCloak:      $TIDECLOAK_URL"
  echo "  Realm:          $REALM_NAME"
  echo "  Client:         $CLIENT_NAME"
  echo ""
  echo "  Next: npm run dev"
  echo "============================================"
else
  echo ""
  echo "WARNING: Adapter config exported but may be missing Tide extensions."
  echo "Check: jq 'has(\"jwk\")' $ADAPTER_OUTPUT"
  echo "If jwk is missing, IGA may not be enabled on the realm."
fi

echo ""
echo "--------------------------------------------"
echo "TWO THINGS YOUR USERS WILL SEE. Decide them now."
echo ""
echo "1) BRANDING — right now they see TIDE's logo at sign-in, not yours."
echo "     bash templates/enclave-branding/brand-tidecloak.sh --realm $REALM_NAME \\"
echo "          --kind <vault|identity|notes|chat|data|finance|health|media|commerce|generic>"
echo "     Or drop your own artwork in ./branding/ and pass --logo/--background."
echo ""
echo "2) NEW-USER DETAILS — Tide gives each new user a unique account with NO name or email."
echo "   The Keycloak signup form is already OFF for this realm, so collect them in YOUR app:"
echo "   Tell the agent which fields you want; it calls tide_onboarding and WRITES the"
echo "   component into your app already wired up. You should not have to copy a template."
echo "   It updates the user through the Account API with the user's own token. Ask which fields"
echo "   you actually need first — and never invent a placeholder email (AP-85)."
echo "--------------------------------------------"
