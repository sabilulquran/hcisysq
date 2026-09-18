# HCIS VPS Deployment Workflow

**Status:** ACTIVE RUNBOOK  
**Production path:** human-approved exact-SHA VPS cutover only

## Standard release flow

Normal HCIS production delivery follows one repeatable cycle:

```text
CODE -> PR/MERGE -> CI GREEN -> PUBLISH EXACT-SHA IMAGE -> 1x DEPLOY VPS -> 1x VERIFY -> UAT if required -> DONE
```

Do not turn ordinary releases into a sequence of ad-hoc container commands. The repository scripts are the default operational path.

## Preconditions

Before production cutover:

- the target commit is merged to `origin/main`;
- required GitHub Actions validation is green for that exact PR head;
- the exact-SHA API and Web images required by the runtime have been published successfully;
- the operator has explicitly approved the production deployment;
- the VPS working tree is clean and still points at the currently deployed application SHA;
- production environment secrets remain only on the VPS;
- `BIOMETRIC_COLLECTION_ENABLED=0` remains required until the separate biometric production gate is explicitly approved;
- migration recovery notes for the release have been reviewed.

Never use `docker compose down -v`.

Do not pull the target commit manually before running the deploy script. The script intentionally captures the current local HEAD as the application rollback baseline before it fast-forwards to the target SHA.

## Image source and repository-transfer boundary

The normal deploy mode is `HCIS_DEPLOY_IMAGE_MODE=ghcr`. In this mode the VPS **does not build release images**. It pulls immutable exact-SHA API and Web images before cutover.

The latest recorded verified production release is the 2026-09-18 deployment of application SHA `acd22b438a7468dc6ea53ae001980cd06f7343cd` using:

```text
ghcr.io/sabilulquran/hcisysq-api:sha-acd22b438a7468dc6ea53ae001980cd06f7343cd
ghcr.io/sabilulquran/hcisysq-web:sha-acd22b438a7468dc6ea53ae001980cd06f7343cd
```

See [`production-release-verification-2026-09-18.md`](production-release-verification-2026-09-18.md) for the dated publisher, deployment, verifier, health, and browser-acceptance evidence. Repository `main` later advanced beyond this deployed SHA; a newer repository commit is not automatically a newer production runtime.

The repository script `scripts/deploy-vps.sh` still contains legacy fallback/default package values under:

```text
ghcr.io/imadjinasi/hcisysq-api:sha-<SHA>
ghcr.io/imadjinasi/hcisysq-web:sha-<SHA>
```

Those defaults do **not** describe the current production runtime. The GitHub production workflow explicitly supplies `HCIS_GHCR_API_REPO=ghcr.io/sabilulquran/hcisysq-api` and `HCIS_GHCR_WEB_REPO=ghcr.io/sabilulquran/hcisysq-web`, overriding the script defaults for the production path.

This documentation-only reconciliation deliberately does not change the script defaults. Retiring the legacy defaults changes deployment code and should be handled in a separate reviewed PR with the normal deployment regression gates.

See [`github-org-transfer-readiness.md`](github-org-transfer-readiness.md) for the observed transfer/runtime evidence and [`github-vps-production-deployment.md`](github-vps-production-deployment.md) for the workflow override boundary.

`HCIS_DEPLOY_IMAGE_MODE=local` remains an explicit fallback supported by the script, but it is not the normal release path and must not be used merely to bypass a missing/failed GHCR publication.

## Deploy

From the production repository working tree:

```bash
./scripts/deploy-vps.sh <EXPECTED_MAIN_SHA>
```

The script refuses to run if local HEAD already equals the target SHA, because that would lose the previous application baseline needed for a meaningful rollback guard. If source was manually moved to the target before the runtime was cut over, restore the repository to the actual deployed SHA and follow the runbook rather than bypassing this guard.

In the normal GHCR path the deploy script:

1. verifies a clean working tree and preserves its current HEAD as the application rollback baseline;
2. refuses to continue if biometric collection is not OFF;
3. verifies the exact `origin/main` target SHA;
4. creates a timestamped PostgreSQL custom-format backup before application migration/cutover;
5. records backup checksum and deployment metadata under ignored `backups/deploy/`;
6. fast-forwards local `main` only;
7. resolves API and Web to exact `sha-<SHA>` GHCR tags and pulls both images from the repositories supplied by the invoking environment/workflow;
8. recreates API and lets the API-start migration runner apply additive migrations;
9. waits for API health/readiness;
10. recreates Web and waits for Web health;
11. runs local proxy health smoke checks;
12. records the migration and Compose snapshots;
13. re-checks the retired USERINFO safety trigger and biometric gate.

PostgreSQL is not intentionally restarted by the normal application cutover.

## Failure and rollback guard

The script differentiates application rollback from database rollback.

If target application health fails after target preparation, the default guard attempts to restore API and Web to the previous application SHA. In normal GHCR mode it resolves and pulls the previous exact-SHA images from the configured repository values for that deployment invocation.

The database is **never automatically rolled back**. Migrations may have committed before application health failed. A release that contains a non-backward-compatible or destructive schema migration requires its own reviewed recovery procedure and must not rely on generic application rollback.

Set `AUTO_ROLLBACK_APP=0` only when a release-specific recovery procedure explicitly requires manual application rollback.

## Verification

After a successful deploy, run exactly once:

```bash
./scripts/verify-vps.sh <EXPECTED_MAIN_SHA>
```

The verification script checks, among other release-specific guards:

- deployed repository SHA;
- runtime API/Web image tags match the exact expected SHA in the normal GHCR path;
- PostgreSQL/API/Web container health;
- `/healthz`, `/api/health`, and `/api/ready`;
- latest repository migration equals latest applied migration;
- retired USERINFO database trigger exists exactly once;
- retired USERINFO controls are absent from the built Web bundle;
- app-shell no-store and hashed-asset immutable cache policy;
- passive ADMS/device SQL smoke checks;
- biometric collection environment gate remains OFF.

The verification script requests **zero device commands** and fails if its verification window changes the command count.

Do not set `HCIS_VERIFY_ALLOW_LOCAL_IMAGES=1` for a normal GHCR production verification.

## UAT policy

Run UAT only when it adds evidence that deployment/health checks cannot provide. Examples:

- changed business workflow;
- changed authorization/permission behavior;
- primary Admin UI workflow;
- external WhatsApp/email integration;
- sensitive migration/cutover;
- explicitly approved hardware/device command canary.

Do not run a physical fingerprint command merely to prove that a CSS change, read-only Admin summary, deployment script, or database safety trigger deployed successfully.

For browser verification after Web releases, use a fresh browser session when stale SPA state could hide the deployed asset. `index.html` is no-store while content-hashed assets remain immutable.

## Evidence handling

Deployment evidence may record:

- target/previous commit SHA;
- exact runtime image references;
- timestamps;
- container health;
- migration names/timestamps;
- safe trigger/configuration checks;
- backup path and checksum;
- redacted smoke/UAT screenshots.

Do not store production employee identifiers, device credential payloads, biometric bodies, passwords, keys, cookies, or access tokens in repository deployment records.