> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# HUB-IMPL-003 — HCIS OIDC staging consumer

**Status:** IMPLEMENTATION  
**Scope:** staging rehearsal only  
**Authoritative cross-repo specification:** `imadjinasi/SQ-Hub/docs/specs/HUB-IMPL-003-hcis-oidc-client.md`

This document records the HCIS-local implementation and recovery procedure. It does not redefine the SQ Hub specification and does not authorize production cutover.

## Actor and preconditions

Actor: Staff member with a synthetic staging SQ Identity and an explicitly mapped HCIS account.

Preconditions for OIDC mode:
- `AUTH_MODE=oidc` is configured on the HCIS API;
- the SQ Identity client is configured for the accepted HCIS callback URI;
- the HCIS account has exactly one persisted `identity_issuer + identity_subject` mapping;
- the HCIS-local account is `active`;
- SQ Hub Application Access contains an active grant for `applicationKey=hcis`;
- required OIDC and machine-client secrets are supplied through runtime secret configuration, never the repository.

## Workflow and state transition

1. The browser requests `/api/auth/oidc/start`.
2. HCIS creates one-time server-side state containing only a SHA-256 hash of OAuth `state`, the PKCE verifier, nonce, and a 10-minute expiry.
3. The browser is redirected to SQ Identity using Authorization Code + PKCE + state + nonce.
4. Keycloak redirects to the exact public `/auth/callback` route. Nginx sends this route directly to the API; it is not handled by the SPA.
5. HCIS atomically consumes the one-time transaction and validates the callback through `openid-client`.
6. HCIS resolves the local principal only by exact OIDC `issuer + sub`. Email and NIP are not callback join keys.
7. HCIS checks local account state, then obtains a service token as `hcis-api-staging` and calls SQ Hub Application Access for `hcis`.
8. Only an allowed decision creates the existing HCIS app-scoped `hcis_session`; downstream HCIS roles/permissions continue to use the original `accounts.id`.

No OIDC access token, refresh token, ID token, code verifier, or machine token is stored in browser storage.

## Authentication modes

`AUTH_MODE=local` remains the default. Merging this implementation therefore does not change production authentication behavior.

When `AUTH_MODE=oidc`:
- the public password endpoint `/auth/login` returns `404 LOCAL_AUTH_DISABLED`;
- the login page fetches `/auth/mode` and renders only SQ Identity entry;
- failure to load the mode does not fall back to the local password form;
- existing valid HCIS sessions are checked locally through `/auth/me` and do not call SQ Hub on every request.

## Audit and failure behavior

The callback route suppresses request logging because the callback URL contains an authorization code. HCIS audit events record the outcome without persisting OIDC tokens or codes.

New session creation fails closed for invalid or expired callback state, invalid OIDC validation, missing mapping, inactive local account, denied Application Access, or unavailable Application Access verification.

AUTH-003 adds only safe browser-facing failure categories after the callback has failed:
- `HCIS_ACCESS_DENIED` -> `access_denied`;
- `APPLICATION_ACCESS_UNAVAILABLE` -> `access_unavailable`;
- `ACCOUNT_INACTIVE` -> `account_inactive`;
- all mapping/provider/callback/unexpected failures -> `oidc_failed`.

The browser category never contains the OIDC subject, authorization code, token, provider detail, or raw backend error message.

## Employee account/session UX

`AUTH-003` adds a shared account menu to the employee shell:
- the top-right avatar/profile opens the menu on desktop and mobile;
- the desktop sidebar user card opens the same menu;
- `Akun Saya` is reserved for the future SQ Account Center and remains visibly unavailable until that platform target exists;
- `Keluar` calls the existing `/auth/logout` contract and lets a single navigation decision follow either the SQ Identity end-session URL or the local HCIS entry.

HCIS does not add local password, MFA, recovery, or shared-security settings to fill the future SQ Account Center gap.

The Keycloak logout confirmation currently observed in staging remains part of the approved secure flow. This UX work does not hide or bypass that IdP confirmation.

## Database migration

`0020_hub_oidc_identity_mapping.sql` adds:
- nullable `accounts.identity_issuer`;
- nullable `accounts.identity_subject`;
- a pair-nullability check (both null or both populated);
- a partial unique index on populated `(identity_issuer, identity_subject)`;
- short-lived `auth_oidc_transactions` server-side callback state.

`accounts.id` and all existing foreign keys remain unchanged.

## Shared staging deployment

The production VPS compose remains unchanged. OIDC rehearsal uses the dedicated `infra/docker-compose.staging.yml`, `infra/staging.env.example`, and `infra/caddy/hcis-staging.sabilulquran.or.id.caddy` files.

The staging topology deliberately separates networks:
- HCIS PostgreSQL and internal API/web traffic use the project-local `backend` network, which remains `internal: true`;
- the public HCIS web container joins the existing external `edge_proxy` network as `hcis-staging-web`;
- the HCIS API joins the external `sq_platform_staging` network so it can reach the private SQ Hub API service and obtain outbound access to the canonical public Keycloak issuer.

SQ Hub Application Access is not required to be public. The staging template targets the private service name `sq-hub-api-staging:3100` on `sq_platform_staging`.

Prepare the VPS-only environment file:

```bash
cp infra/staging.env.example infra/.env.staging
chmod 600 infra/.env.staging
```

Replace all placeholder database, encryption, OIDC client, and machine-client secrets. Never commit `infra/.env.staging`.

Create the shared network once if it does not already exist:

```bash
docker network inspect sq_platform_staging >/dev/null 2>&1 \
  || docker network create sq_platform_staging
```

The existing Caddy network must also exist before deployment:

```bash
docker network inspect edge_proxy >/dev/null 2>&1
```

Validate Compose interpolation without starting services:

```bash
docker compose \
  --env-file infra/.env.staging \
  -f infra/docker-compose.staging.yml \
  config -q
```

Start HCIS staging using a distinct Compose project name so its database volume and service namespace cannot collide with production:

```bash
docker compose \
  -p hcis-staging \
  --env-file infra/.env.staging \
  -f infra/docker-compose.staging.yml \
  up -d --build
```

Before browser UAT, verify from the VPS/container path that:
- `https://login.sabilulquran.or.id/realms/sq-staff-staging/.well-known/openid-configuration` is reachable;
- `sq-hub-api-staging:3100` resolves from the HCIS API container over `sq_platform_staging`;
- the HCIS API `/health` endpoint is healthy;
- `https://hcis-staging.sabilulquran.or.id` terminates TLS and reaches `hcis-staging-web`.

## Recovery / rollback rehearsal

Application rollback is configuration-first:
1. stop the OIDC staging stack;
2. change the staging environment to local mode only in a deliberate rollback rehearsal, or redeploy the existing production/local-auth compose for the isolated test target;
3. restart/redeploy the isolated HCIS target;
4. verify local login and existing authorization behavior;
5. keep identity mapping columns in place during the rehearsal so rollback does not require destructive data changes.

Do not point `hcis.sabilulquran.or.id` at the staging stack during this rehearsal.

If schema removal is explicitly required later, first verify no environment is in OIDC mode and no OIDC transaction is active. Then drop `auth_oidc_transactions`, the partial identity index, the pair-nullability constraint, and the two identity columns. Do not modify `accounts.id` or role-assignment foreign keys.

## Staging configuration names

Required only for `AUTH_MODE=oidc`:
- `OIDC_ISSUER`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `OIDC_REDIRECT_URI`
- `OIDC_POST_LOGOUT_REDIRECT_URI`
- `SQ_HUB_APPLICATION_ACCESS_URL`
- `SQ_HUB_MACHINE_CLIENT_ID`
- `SQ_HUB_MACHINE_CLIENT_SECRET`

HCIS session TTL in OIDC mode is configuration-validated to a maximum of 12 hours.

## Verification commands

The PR quality gate must actually run:

```bash
npm ci
npm run migrate:api
npm run typecheck
npm run lint
npm run test
npm run build
docker compose --env-file infra/staging.env.example -f infra/docker-compose.staging.yml config -q
```

Browser UAT on the real staging stack remains required for Keycloak redirect and TLS, synthetic login, privileged TOTP and recovery behavior, logout semantics, token-storage inspection, Application Access denial, outage behavior, and rollback rehearsal.
