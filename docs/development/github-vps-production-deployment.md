# GitHub to HCIS Production VPS Deployment

**Status:** ACTIVE MANUAL PRODUCTION WORKFLOW — ORGANIZATION GHCR RUNTIME OBSERVED; EACH DEPLOY STILL REQUIRES APPROVAL

## Goal

Production delivery is initiated from GitHub Actions while the VPS remains the runtime host. The workflow deploys only the exact current `main` SHA and delegates the actual cutover, migration, health checks, rollback guard, and verification to the repository scripts already used on the VPS.

```text
PR -> CI green -> merge main -> exact-SHA GHCR publish -> manual GitHub production approval -> SSH -> deploy-vps.sh -> verify-vps.sh
```

The workflow is intentionally **not** triggered automatically by a merge or image publication.

Fresh Codex Local verification reported on 2026-09-16 records production API/Web running SHA `9e9098c5bd8579ae9ec36dc1f698c03a064c66ab` from the organization GHCR repositories:

```text
ghcr.io/sabilulquran/hcisysq-api:sha-9e9098c5bd8579ae9ec36dc1f698c03a064c66ab
ghcr.io/sabilulquran/hcisysq-web:sha-9e9098c5bd8579ae9ec36dc1f698c03a064c66ab
```

This current-state evidence replaces the older assumption that production might still be on the personal `imadjinasi` image namespace. It does not authorize another deployment.

## Required GitHub environment

The production path uses a GitHub Environment named `production` with the required reviewer/deployment protection configured by repository owners.

The workflow expects these Environment secrets:

- `HCIS_PROD_HOST` — production VPS hostname or IP.
- `HCIS_PROD_USER` — dedicated SSH operator account that can run Docker without an interactive sudo prompt.
- `HCIS_PROD_REPO_PATH` — absolute path to the HCIS production working tree.
- `HCIS_PROD_SSH_PRIVATE_KEY` — private SSH key dedicated to GitHub Actions deployment.
- `HCIS_PROD_SSH_KNOWN_HOSTS` — pinned `known_hosts` entry for the production VPS. Do not replace this with an unauthenticated runtime `ssh-keyscan` step.

Do not store the production application `.env`, database password, auth encryption key, biometric keyring, or other application secrets in GitHub. Those remain VPS-local.

The job's ephemeral `GITHUB_TOKEN` is granted only `contents: read` and `packages: read`. It is piped through SSH to `docker login ghcr.io --password-stdin`, used for the deployment window, and removed from the VPS with `docker logout ghcr.io` in an `always()` cleanup step.

## Manual gate

Run **Deploy HCIS Production** manually and provide:

- `target_sha`: the full 40-character SHA to deploy;
- `confirmation`: exactly `DEPLOY_PRODUCTION`.

The workflow refuses to deploy if `target_sha` is not the current `origin/main` SHA.

Use the GitHub `production` Environment approval as the human authorization boundary. Starting the workflow is not a substitute for an approved production deployment.

## Preflight safety

Before `deploy-vps.sh` can run, the workflow verifies remotely that:

1. the production working tree is clean;
2. the production Git remote points to `sabilulquran/hcisysq`;
3. `origin/main` still equals the requested exact SHA;
4. `BIOMETRIC_COLLECTION_ENABLED=0` remains true;
5. the target API and Web exact-SHA images can be pulled from organization GHCR;
6. the **currently deployed SHA** API and Web images can also be pulled from organization GHCR.

The last condition is required because `deploy-vps.sh` automatically attempts application rollback to the previous SHA if the new application fails health checks. The GitHub workflow must not start a cutover unless that rollback image is available.

## Organization-GHCR cutover — historical checkpoint

Before organization GHCR was proven in production, the runbook treated the first organization-owned cutover as a pending migration and allowed for a production SHA that might exist only in `ghcr.io/imadjinasi/...`.

That was a valid transition checkpoint, but it is no longer the current production state. Codex Local evidence on 2026-09-16 shows the inspected production SHA already uses `ghcr.io/sabilulquran/...` exact-SHA API and Web images.

The historical recovery logic remains useful if a required rollback SHA is missing from organization GHCR: do not bypass the check or disable automatic rollback. Publish/backfill the required reviewed historical exact-SHA image through the approved publisher, then rerun preflight.

## Runtime image namespace

The GitHub production workflow explicitly exports:

```text
HCIS_GHCR_API_REPO=ghcr.io/sabilulquran/hcisysq-api
HCIS_GHCR_WEB_REPO=ghcr.io/sabilulquran/hcisysq-web
```

`scripts/deploy-vps.sh` still contains legacy personal-namespace defaults. The production workflow overrides them, which is why current production can and does run organization-owned images without changing those defaults.

Do not interpret the legacy defaults as evidence of the current production image source. Retiring them is a deployment-code cleanup and is intentionally kept out of this documentation-only PR; perform that cleanup, if desired, in a separate reviewed PR with deployment-script tests and rollback review.

## What the GitHub workflow does not do

It does not:

- auto-deploy on merge;
- change production application secrets;
- enable biometric collection;
- run arbitrary device commands;
- bypass the repository deployment or verification scripts;
- disable rollback checks;
- delete personal GHCR packages;
- change database rollback policy.

Database rollback remains manual and release-specific, exactly as documented in `vps-deployment.md`.

## Per-deployment checklist

Before every GitHub-triggered production cutover:

- [ ] `production` Environment reviewer protection is active.
- [ ] required SSH/VPS Environment secrets remain configured and valid.
- [ ] the SSH account remains least-privilege and can run required Docker/Git operations non-interactively.
- [ ] the pinned host key is still the expected production host key.
- [ ] current production SHA is recorded read-only.
- [ ] organization GHCR contains exact-SHA API/Web images for both current production and target `main`.
- [ ] target PR/CI is green and target SHA is current `main`.
- [ ] production deployment is explicitly approved.
- [ ] no concurrent HCIS production deployment is running.

The workflow uses a non-cancelling `hcis-production` concurrency group so two GitHub-triggered production deployments cannot run simultaneously.