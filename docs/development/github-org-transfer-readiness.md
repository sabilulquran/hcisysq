# GitHub Organization Transfer — Observed State and Runtime Boundary

**Status:** REPOSITORY TRANSFER OBSERVED; RUNTIME/GHCR MIGRATION NOT IMPLIED  
**Canonical repository:** `sabilulquran/hcisysq`  
**Historical repository:** `imadjinasi/hcisysq` (redirect observed through GitHub)

## Why this document changed

The earlier readiness runbook described `imadjinasi/hcisysq` as current and `sabilulquran/hcisysq` as planned. On 2026-09-15, repository inspection through GitHub showed the active repository at `sabilulquran/hcisysq`; a request for the old repository returned a permanent redirect. This is repository-level evidence that the transfer has occurred.

This documentation update records that observed transfer. It does **not** claim that organization-owned GHCR packages, Actions permissions, deployment credentials, VPS remotes, or running workloads were migrated merely because the repository moved.

## Preserved invariants

- repository name remains `hcisysq`;
- default branch remains `main`;
- no production/staging secret or runtime change is authorized by this documentation;
- existing runtime image references remain on the proven personal GHCR namespace until organization-owned publication and consumption are independently verified;
- production deployment remains a separate human-approved exact-SHA operation.

## Repository transfer and GHCR remain separate

Current deployment documentation still uses the proven runtime package namespace:

- `ghcr.io/imadjinasi/hcisysq-api`
- `ghcr.io/imadjinasi/hcisysq-web`

Do not change those runtime defaults merely because the GitHub repository owner changed. A later reviewed runtime-migration change may switch namespaces only after exact-SHA API and Web packages in the organization namespace are published and independently verified.

## Post-transfer evidence still required before runtime migration

Record evidence for:

1. repository owner/name/default branch and expected `main` SHA;
2. required branches and PR behavior;
3. GitHub App/integration access under organization policy;
4. required Actions workflows and permissions;
5. successful exact-SHA publication of both API and Web images in `ghcr.io/sabilulquran/...`;
6. OCI source metadata pointing at the organization repository;
7. an explicitly reviewed decision to change staging/production runtime image targets.

If any of 3–6 are not proven, keep runtime on the existing proven namespace. Repository transfer success is not runtime-migration approval.

## Historical checkpoint

The pre-transfer checklist and freeze logic from the earlier runbook remain historical evidence of the intended transfer procedure. They must not be read as current proof that package publishing or VPS configuration changed. The current-state correction in this file is documentation-only.
