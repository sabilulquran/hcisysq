> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# HUB-IMPL-003 — OIDC identity mapping operator command

**Scope:** synthetic/shared staging provisioning and rollback support  
**Production cutover:** not authorized

This command persists the accepted HCIS external identity binding. The persisted key is only the exact OIDC `issuer + sub`; email and NIP are not accepted as binding inputs.

## Safety model

- target HCIS account is supplied as exact `accounts.id` UUID;
- the command refuses to run unless `HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1` is set for that invocation;
- preview is the default and performs no write;
- `--apply` is required for a write;
- replacing a different existing mapping requires a preview followed by explicit `--replace --apply`;
- an OIDC identity already assigned to another HCIS account is rejected;
- an identical mapping is idempotent;
- clearing a mapping requires `--clear --apply`;
- write operations use one transaction, an advisory transaction lock, `FOR UPDATE`, the database unique constraint, and an HCIS auth audit event;
- if runtime `OIDC_ISSUER` is configured, the supplied issuer must match it exactly after the configured trailing slash is removed.

The command never accepts an authorization code, access token, refresh token, password, TOTP secret, or recovery code.

## Local/source checkout usage

Preview a new mapping:

```bash
HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1 \
  npm run auth:map-oidc-identity -- \
  --account-id <HCIS_ACCOUNT_UUID> \
  --issuer https://login-staging.sabilulquran.or.id/realms/sq-staff-staging \
  --subject <KEYCLOAK_SUB>
```

The expected preview status for an unmapped account is `would_map`.

After verifying the account ID, current mapping, issuer, and subject, apply it:

```bash
HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1 \
  npm run auth:map-oidc-identity -- \
  --account-id <HCIS_ACCOUNT_UUID> \
  --issuer https://login-staging.sabilulquran.or.id/realms/sq-staff-staging \
  --subject <KEYCLOAK_SUB> \
  --apply
```

If the account already has a different mapping, the preview returns `would_replace`. A write is then intentionally blocked until the operator supplies both `--replace` and `--apply`:

```bash
HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1 \
  npm run auth:map-oidc-identity -- \
  --account-id <HCIS_ACCOUNT_UUID> \
  --issuer https://login-staging.sabilulquran.or.id/realms/sq-staff-staging \
  --subject <NEW_KEYCLOAK_SUB> \
  --replace \
  --apply
```

## Shared staging container usage

The production image contains the compiled CLI under `apps/api/dist`.

Preview from the HCIS staging API container:

```bash
docker compose \
  -p hcis-staging \
  --env-file infra/.env.staging \
  -f infra/docker-compose.staging.yml \
  exec -e HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1 api \
  node apps/api/dist/modules/auth/cli/map-oidc-identity.js \
  --account-id <HCIS_ACCOUNT_UUID> \
  --issuer https://login-staging.sabilulquran.or.id/realms/sq-staff-staging \
  --subject <KEYCLOAK_SUB>
```

Add `--apply` only after verifying the preview output.

## Clear / rollback one mapping

Preview clear:

```bash
HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1 \
  npm run auth:map-oidc-identity -- \
  --account-id <HCIS_ACCOUNT_UUID> \
  --clear
```

Apply clear:

```bash
HCIS_ALLOW_OIDC_IDENTITY_MAPPING=1 \
  npm run auth:map-oidc-identity -- \
  --account-id <HCIS_ACCOUNT_UUID> \
  --clear \
  --apply
```

Clearing the mapping does not delete or disable the Keycloak identity and does not change HCIS roles, permissions, `principal_type`, employee linkage, or `accounts.id`.

## Synthetic UAT provisioning sequence

For each synthetic persona:
1. select the intended existing HCIS staging `accounts.id`;
2. provision or inspect the synthetic Keycloak identity through the controlled staging admin path;
3. obtain the exact Keycloak `sub` and canonical staging issuer;
4. run this command in preview mode;
5. verify the preview account and mapping;
6. apply the mapping;
7. create/verify the SQ Hub Application Access grant for `applicationKey=hcis`;
8. run browser SSO UAT;
9. retain the output/status as staging evidence without copying credentials or tokens.

A mapping is only one part of entry authorization. HCIS local account state and SQ Hub Application Access are still checked when a new OIDC-derived HCIS session is created.
