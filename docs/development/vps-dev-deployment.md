# VPS Development Deployment

> **HISTORICAL (2026-11-04).** `scripts/deploy-vps.sh`, `scripts/verify-vps.sh` and the Docker VPS files mentioned below were removed from the repository. Production runs on Mi8VPS; see `mi8vps-hcis-release.md`.

**Status:** SUPERSEDED DEPLOYMENT BOOTSTRAP  
**Replacement:** [`vps-deployment.md`](vps-deployment.md)

This document previously described the early HCIS bootstrap flow that cloned a feature branch and built API/Web containers directly on the shared VPS. That is no longer the active deployment model.

## Current rule

Current HCIS releases use reviewed `main` SHAs and the exact-SHA GHCR deployment workflow documented in [`vps-deployment.md`](vps-deployment.md):

```text
PR/MERGE -> CI GREEN -> PUBLISH EXACT-SHA IMAGE -> DEPLOY SCRIPT -> VERIFY SCRIPT
```

For normal releases:

- do not deploy an arbitrary feature branch to the production VPS;
- do not build API/Web release images on the VPS;
- do not use the old sequential `docker compose build` bootstrap as a release procedure;
- use `./scripts/deploy-vps.sh <EXPECTED_MAIN_SHA>` from the currently deployed baseline;
- use `./scripts/verify-vps.sh <EXPECTED_MAIN_SHA>` after a successful cutover;
- keep production secrets in the server environment and out of the repository;
- keep `BIOMETRIC_COLLECTION_ENABLED=0` until the separate biometric gate is explicitly approved.

The environment strategy remains: CI builds immutable artifacts/images; the VPS pulls the reviewed release image.

## Repository URL during organization transfer

The planned canonical repository is `sabilulquran/hcisysq`, but the transfer is a separate manual administration step.

Do not recreate a working production checkout merely for transfer readiness. After the transfer is confirmed, fresh clones should use:

```bash
git clone https://github.com/sabilulquran/hcisysq.git
```

Existing checkouts should update `origin` only after `https://github.com/sabilulquran/hcisysq` is verified as the canonical PUBLIC repository.

See [`github-org-transfer-readiness.md`](github-org-transfer-readiness.md) for the complete transfer and deployment-freeze checklist.

## Historical topology notes

The early bootstrap established these deployment characteristics, which remain useful architectural context even though the old deployment commands are retired:

- shared Caddy is the public ingress;
- only the HCIS web container joins the shared edge network;
- API and PostgreSQL remain private to the HCIS backend network;
- the web container can expose a host-local smoke-test port without publishing API/PostgreSQL publicly;
- PostgreSQL data must never be destroyed with routine `docker compose down -v` operations.

For current operational commands, health checks, rollback behavior, image provenance, and evidence handling, use the active VPS runbook rather than this historical bootstrap document.
