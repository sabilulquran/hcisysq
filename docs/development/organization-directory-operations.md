# ORG-006 Organization Directory producer operations

**Status:** Implementation runbook
**Contract:** ORG-006 / SQ Hub HUB-IMPL-018
**Production activation:** Separate human/operator gate

## Purpose

Operate the HCIS read-only Organization Directory producer safely without changing HCIS authoring ownership or exposing production person data in logs.

## Configuration

The endpoint is disabled unless:

```text
ORG_DIRECTORY_EXPORT_ENABLED=1
ORG_DIRECTORY_TOKEN_ISSUER=<Akun SQ / Keycloak issuer>
ORG_DIRECTORY_TOKEN_AUDIENCE=hcis-organization-directory
ORG_DIRECTORY_ALLOWED_CLIENTS=sq-hub-organization-directory
ORG_DIRECTORY_REQUIRED_SCOPE=organization-directory.read
```

Only the issuer is a URL. Allowed clients is a comma-separated allowlist when more than one environment-specific machine client is intentionally authorized.

No client secret is required by HCIS for verification. The caller obtains its own client-credentials token from Keycloak; HCIS verifies the signed JWT using public JWKS.

The production Compose file passes these variables from `infra/.env.vps` to the API container. Recreate only the API after changing them, then verify the effective container environment by key/presence without printing secrets. The public HCIS reverse proxy must route `/internal/v1/organization-directory/*` to the API unchanged; the ordinary SPA fallback returns HTML 200 and cannot serve the snapshot contract. Confirm the disabled route returns JSON 503 before enabling export, and confirm an unauthenticated request returns 401 after enabling it.

When the export gate is `0`, blank Compose values for issuer, audience, and allowed clients are treated as absent. All three remain required and validated when the gate is `1`. Operators should set the explicit production values before activation.

## Pre-activation checklist

Do not enable production export until all are true:

- ORG-006 and HUB-IMPL-018 are reviewed/merged.
- Human Capital confirms the real ORG-004 published structure is appropriate for directory use.
- Dedicated Keycloak machine client exists with the exact audience/scope.
- Caller identity is not a human/browser client.
- HCIS endpoint returns 401 without a token and 403 for wrong client/scope.
- Staging/synthetic snapshot passes schema and reference validation.
- SQ Hub projection has atomic apply, last-known-good, and staleness visibility before production consumption.
- Backup/restore readiness of the existing HCIS database remains valid; ORG-006 adds no source-data migration.

## Normal operation

SQ Hub pulls:

`GET /internal/v1/organization-directory/snapshot?asOf=YYYY-MM-DD`

Recommended cadence is 5 minutes. HCIS is stateless for publication; repeat pulls over unchanged projected content return the same version.

Expected safe log metadata:
- machine client ID;
- business date;
- source snapshot ID;
- content version;
- counts;
- result/error category.

Do not log:
- bearer token;
- full response body;
- employee names/NIP lists;
- identity subjects;
- secrets.

## Expected failures

### 400 INVALID_AS_OF

Caller sent an invalid calendar date. Correct the request. Do not retry unchanged input.

### 401 INVALID_TOKEN

Token is absent, expired, malformed, wrong issuer/audience, or cannot be verified. Check Keycloak/JWKS and token configuration. Do not weaken verification.

### 403 FORBIDDEN_CLIENT / INSUFFICIENT_SCOPE

The token is cryptographically valid but the caller is not authorized. Fix client/scope configuration. Do not add broad wildcard clients/scopes as a workaround.

### 503 ORGANIZATION_DIRECTORY_EXPORT_DISABLED

The safe default or explicit rollback state. No data is exported.

### 503 ORGANIZATION_DIRECTORY_UNAVAILABLE

No effective published ORG-004 snapshot exists for the requested business date. Do not synthesize a fallback from legacy employee unit/title text.

### 500 ORGANIZATION_DIRECTORY_CONTRACT_ERROR

Generated source data violates the accepted projection/reference contract. Keep the Hub last-known-good projection, inspect HCIS source configuration, correct it through normal HCIS authoring, publish a valid structure if required, then retry.

## Recovery

The producer does not mutate organization or employee data.

Recovery sequence:

1. Keep/return `ORG_DIRECTORY_EXPORT_ENABLED=0` if publication safety is uncertain.
2. Diagnose organization source state without printing production person payload.
3. Correct authoritative facts in HCIS through normal authoring/lifecycle.
4. Validate and publish ORG-004 structure if structure changed.
5. Re-enable export only after the source is accepted.
6. Have SQ Hub perform a full re-pull/reconciliation.
7. Confirm source snapshot ID, version, counts, and freshness metadata; do not compare or export the person list as evidence.

No direct SQL from SQ Hub is a recovery mechanism.

## Rollback

Fastest safe rollback:

`ORG_DIRECTORY_EXPORT_ENABLED=0`

Then roll back the HCIS application release if needed. Because ORG-006 is a read endpoint with no new source tables, source-data rollback is not required.

SQ Hub keeps its last-known-good projection according to HUB-IMPL-018 while the producer is unavailable.

## Security/privacy review

Before release review the diff for:
- accidental production identifiers or example data;
- secrets/tokens;
- logging of response bodies;
- widened client allowlists/scopes;
- newly projected fields outside ORG-006 minimum projection;
- direct access from Aset SQ or other domain apps to HCIS.

Examples/tests must use synthetic values only.

## Verification

Repository verification for the implementation PR must include:

```text
npm run typecheck
npm run lint
npm run test
npm run build
```

The repository CI may additionally run migration rehearsal/staging-compose validation. A green producer PR does not enable production export.
