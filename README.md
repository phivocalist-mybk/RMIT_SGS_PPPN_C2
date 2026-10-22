[![Built with TideCloak](https://tide.org/badges/built-with-tidecloak.svg)](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked)

## Project overview

_OrganTrust is a kidney waiting-list coordinator where no doctor, director, IT admin or coordinator can change a patient's ranking or grant an exception alone, and donor families can verify the rules were followed without learning who received the organ._

Built with [TideCloak](https://tide.org/tidecloak?utm_source=github&utm_medium=readme&utm_campaign=unlocked).

### 1. Vision & originality

Allocation follows a published, versioned scoring policy, and every power that could bend it (role grants, rank changes, exceptions) is split across people and organizations. Donor families get a privacy-preserving rules check instead of a promise.

### 2. Trust constraint insight

Today a hospital's admins hold the keys: one person can quietly move a patient up or grant themselves an override. Everyone else can only trust them. Removing that single point of authority makes the list credible to patients, clinicians and families.

### 3. Value & impact

Nobody can jump the queue with a favour: a rank change needs two people from two organizations, such as the hospital and an independent HLA lab. A donor family can see their gift went to rank #1 under policy v1.

### 4. Why TideCloak matters

- TideCloak IGA turns role grants (`allocation_override`, `rank_signoff`) and organization changes into change requests needing 2 of 4 admins, so the director cannot empower himself.
- Every API verifies the TideCloak token, DPoP proof and roles on the server.
- In Tide mode approvals are Tide enclave signatures and clinical notes are end-to-end encrypted, so not even the server operator can override or read them. On submission day Tide's network could not create accounts, so the demo runs TideCloak's Tideless mode, where TideCloak's server enforces the quorum.

### 5. Prototype & storytelling

Watch the director's self-grant stay pending while the override API returns 403, a rank change wait for two organizations before KID-1042 moves to #1, and the donor family's rules check.

**Demo video:** [RMIT_SGS_PPPN_C2.mp4](RMIT_SGS_PPPN_C2.mp4)

## Setup

Synthetic data only. Run every command from the repository root. Tested on Windows 11 with Git Bash and Docker Desktop.

Needs: Docker Desktop, Node.js 18+, bash, curl and jq.

1. Install and seed:
   ```bash
   npm install
   npm run seed          # 6 synthetic patients + 1 donor kidney -> data/organtrust-db.json
   ```
2. Create `.env` from `.env.example` and fill in:
   - `KC_BOOTSTRAP_ADMIN_PASSWORD`: a strong local TideCloak master-admin password.
   - `TIDE_LICENSE_EMAIL`: the email that manages the Tide licence.
   - `TIDE_TERMS_ACCEPTED=yes`: only after you read and agree to https://tide.org/legal.
3. Bootstrap TideCloak:
   ```bash
   npm run init
   ```
   This starts `tideorg/tidecloak-dev:latest` on port 8080 and creates:
   - realm `organtrust`, public client `organtrust-client` (DPoP-bound tokens, redirect `http://localhost:3000/*`)
   - Tide licence and IGA (quorum-governed admin changes)
   - realm roles `transplant_doctor`, `hospital_director`, `bioethics_board`, `immunologist`, `donor_family`, `rank_signoff`, `allocation_override`, `_tide_encryptor`, `_tide_decryptor`
   - 6 demo accounts (table below), then prints one invite link per account (also saved to `data/invite-links.txt`)

   Open each invite link in its own private browser window and create a Tide account.
   All 6 must be linked before the script continues. It then grants `tide-realm-admin` to
   director, board1, board2 and immunologist. That switches the realm to multi-admin: from now on
   every role grant is a change request that needs `max(1, floor(0.7 x 4)) = 2` admin signatures
   in the Tide enclave. Finally it exports `data/tidecloak.json`.

   If Tide's licensing call fails, run `npm run init` again (it starts a fresh realm). If the realm
   is already licensed and only a later step failed, continue with `RESUME_AT_USERS=1 npm run init`.
4. Run the app:
   ```bash
   npm run dev           # http://localhost:3000
   ```
5. Log in as a realm admin, open Governance and sign both E2EE note policies in the Tide enclave.
   Until then clinical notes cannot be encrypted or decrypted.

Demo accounts (roles assigned by `scripts/init-tidecloak.sh` before the multi-admin switch):

| Account | Realm roles | Realm admin | Organization (fictional, `organization` claim) |
|---|---|---|---|
| doctor | transplant_doctor, _tide_encryptor, _tide_decryptor | no | Riverside General Hospital |
| director | hospital_director | yes | Riverside General Hospital |
| board1 | bioethics_board | yes | Northgate Bioethics Council |
| board2 | bioethics_board | yes | Riverside General Hospital |
| immunologist | immunologist, rank_signoff, _tide_decryptor | yes | Independent HLA Laboratory |
| family | donor_family | no | none |

A rank-affecting change needs 2 different people from 2 different organizations, at least one
holding `rank_signoff`, and never the proposer. Changing someone's organization is itself a
TideCloak change request (`SET_USER_ATTRIBUTE`) that needs the admin quorum.

Nobody holds `allocation_override`. Granting it, or anything else, after setup needs 2 of 4 admins
to approve the change request in the TideCloak admin console
(`http://localhost:8080/admin/organtrust/console/` -> Change Requests).

What is enforced where:
- TideCloak: role grants need the admin quorum; tokens are signed by the Tide network; clinical
  notes are encrypted and decrypted through the Tide network (RelationshipAttestation:1), so the
  server and database only hold ciphertext.
- App server: every API route verifies the token signature, the DPoP proof and the role. The
  sign-off counting rule (2 people, 2 organizations, no self-approval) is app logic on the server,
  using the roles and `organization` claim from each approver's verified token.
- The audit log is an app-level JSON log and is not tamper-proof.

### Fallback: Tideless mode

On 22 Oct 2026 Tide's network failed to create new Tide accounts for us
(`TIDE-ORK-INTERNAL-UNEXPECTED`, HTTP 500 at `/Authentication/Create/Commit`, trace id
`a84c189e018e2909687d2b9005c24661`), so the demo can also run on a second realm:

```bash
bash scripts/init-tideless.sh                        # adds realm organtrust-tideless; passwords -> data/tideless-accounts.txt
cp data/tidecloak.tideless.json data/tidecloak.json  # point the app at it, then restart npm run dev
```

Same roles and accounts, password logins, and TideCloak IGA in Tideless mode with threshold 2:
granting `allocation_override` still creates a change request that needs 2 of the 4 realm admins
(director, board1, board2, immunologist). Limits, stated plainly:
- the quorum is enforced by TideCloak's server software, not by the Tide network; whoever runs the
  server (including the TideCloak master admin, which also counts as an approver) could bypass it
- tokens are signed by the TideCloak server key, not by the Tide network
- clinical-note encryption is off (it needs Tide accounts)

To go back to the Tide realm: `cp data/tidecloak.tide.json data/tidecloak.json` and restart.

---

`archive/fairenrol/` holds an earlier prototype by the team (FairEnrol). It is not part of this submission.
