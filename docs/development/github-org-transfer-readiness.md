# GitHub Organization Transfer — Observed State and Runtime Boundary

**Status:** REPOSITORY TRANSFER OBSERVED; ORGANIZATION GHCR PRODUCTION BASELINE VERIFIED BY CODEX LOCAL  
**Canonical repository:** `sabilulquran/hcisysq`  
**Historical repository:** `imadjinasi/hcisysq` (redirect observed through GitHub)

## Why this document changed

The earlier readiness runbook described `imadjinasi/hcisysq` as current and `sabilulquran/hcisysq` as planned. On 2026-09-15, repository inspection through GitHub showed the active repository at `sabilulquran/hcisysq`; a request for the old repository returned a permanent redirect. This is repository-level evidence that the transfer has occurred.

Fresh Codex Local verification reported on 2026-09-16 adds runtime evidence that the production API and Web are currently running exact-SHA organization-owned images for application SHA `9e9098c5bd8579ae9ec36dc1f698c03a064c66ab`:

```text
ghcr.io/sabilulquran/hcisysq-api:sha-9e9098c5bd8579ae9ec36dc1f698c03a064c66ab
ghcr.io/sabilulquran/hcisysq-web:sha-9e9098c5bd8579ae9ec36dc1f698c03a064c66ab
```

This is evidence about the inspected production runtime at that SHA. It does not authorize future deployment, imply every historical image was migrated, or prove unrelated GitHub/organization settings.

## Preserved invariants

- repository name remains `hcisysq`;
- default branch remains `main`;
- no production/staging secret or runtime change is authorized by this documentation;
- production deployment remains a separate human-approved exact-SHA operation;
- repository transfer, package publication, script defaults, and an individual production cutover are distinct facts and must be evidenced separately.

## Repository transfer and GHCR state

Current production evidence is now the organization namespace, not the historical personal namespace.

The production workflow supplies:

```text
HCIS_GHCR_API_REPO=ghcr.io/sabilulquran/hcisysq-api
HCIS_GHCR_WEB_REPO=ghcr.io/sabilulquran/hcisysq-web
```

`scripts/deploy-vps.sh` still contains legacy default repository values under `ghcr.io/imadjinasi/...`. Those defaults are overridden by the production workflow, so they must **not** be used to describe the current production image source. Cleaning the defaults is a runtime/deployment-code change and is intentionally outside this documentation-only PR; if desired, make it a separate reviewed PR with deployment regression coverage.

## What remains to verify for future changes

For a future runtime/deployment change, record evidence for:

1. expected repository owner/name/default branch and exact `main` SHA;
2. required GitHub App/integration and Actions permissions;
3. successful exact-SHA publication of target API and Web images in `ghcr.io/sabilulquran/...`;
4. availability of rollback images required by the deployment guard;
5. production workflow/environment approval;
6. exact runtime image references after cutover;
7. health/readiness/migration verification after cutover.

The verified 2026-09-16 production image baseline does not remove these release-by-release gates.

## Historical checkpoint

The pre-transfer checklist, deployment freeze, and “first organization-GHCR cutover” guidance from the earlier runbook remain historical evidence of the intended transition procedure. Statements from that checkpoint that production might still use `ghcr.io/imadjinasi/...` are no longer current-state claims after the Codex Local evidence above.

Do not rewrite historical release evidence to pretend it was known earlier; distinguish the historical checkpoint from the current verified runtime state.