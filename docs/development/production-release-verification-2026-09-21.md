# Production Release Verification — 2026-09-21

**Status:** VERIFIED — DEPLOYMENT/RUNTIME ACCEPTANCE CLOSED  
**Deployed application SHA:** `6f41ad64ed486404e03dea3f58513472d134736e`  
**Previous production SHA:** `ab8494056943a668501d795640f5acb937f6fec7`  
**Local date:** 2026-09-21 Asia/Jakarta

This checkpoint records the GitHub-observed production deployment of the attendance convergence and operations line through PR #65, PR #66, and PR #67. It records deployment/runtime evidence only. It does not claim a fresh authenticated browser UAT, physical-device canary, payroll behavior, ORG-004 rollout activation, or biometric face-recognition validation.

## Release chain

| Item | Evidence |
| --- | --- |
| Target application SHA | `6f41ad64ed486404e03dea3f58513472d134736e` |
| Previous production SHA | `ab8494056943a668501d795640f5acb937f6fec7` |
| Publisher | [run 35563521663](https://github.com/sabilulquran/hcisysq/actions/runs/35563521663) |
| Publisher result | GitHub-observed: API publish success; Web publish success |
| API image | `ghcr.io/sabilulquran/hcisysq-api:sha-6f41ad64ed486404e03dea3f58513472d134736e` |
| Web image | `ghcr.io/sabilulquran/hcisysq-web:sha-6f41ad64ed486404e03dea3f58513472d134736e` |
| Production workflow | [run 35568995536](https://github.com/sabilulquran/hcisysq/actions/runs/35568995536) |
| Production result | GitHub-observed: Validate requested SHA, Production preflight, Deploy and verify, and GHCR logout all success |
| Mobile attendance activation | [run 35425239637](https://github.com/sabilulquran/hcisysq/actions/runs/35425239637) completed success on the earlier attendance GUI baseline; the setting is carried forward by later exact-SHA deployments |

## Preflight

GitHub Actions logs record:

- requested target SHA exactly matched current `origin/main`;
- previous production SHA was `ab8494056943a668501d795640f5acb937f6fec7`;
- target exact-SHA API/Web images were pullable;
- rollback exact-SHA API/Web images for the previous production SHA were pullable;
- production biometric collection safety guard remained required;
- `PRECHECK_STATUS=OK`.

## Backup and cutover

The repository deployment path created a PostgreSQL pre-migration backup before cutover:

```text
backups/deploy/20260921T063456Z-6f41ad64ed48/postgres-before.dump
```

GitHub Actions logs report the dump at approximately 14 MB. This proves deployment backup creation, not restore-drill success.

The production working tree advanced from `ab849405...` to `6f41ad64...`.

## Runtime evidence

GitHub Actions logs record:

- API exact image `sha-6f41ad64...` pulled and running;
- Web exact image `sha-6f41ad64...` pulled and running;
- PostgreSQL container healthy;
- API container healthy;
- Web container healthy;
- API direct health succeeded;
- API readiness returned `{"status":"ready"}`;
- post-cutover readiness succeeded;
- deployment ended with `DEPLOY SUCCESS`.

## Attendance scope carried by this production baseline

This production SHA includes the repository implementation merged through:

- PR #65 — complete ADMS and attendance admin GUI;
- PR #66 — canonical attendance convergence;
- PR #67 — attendance reporting and operations polish.

Repository implementation included in this production baseline covers:

- canonical attendance events/result versions;
- manual correction convergence;
- schedule versions and published roster semantics;
- leave/attendance-resolution interaction;
- independent lateness / early-leave justification state;
- explicit overtime request/decision;
- version-owned work sessions;
- daily operational attendance read model;
- employee canonical attendance self-service;
- attendance report families and operational filters;
- ADMS global transactions;
- mobile GPS/photo attendance UI and evidence handling;
- Back Office ADMS and Human Capital attendance workspaces.

This checkpoint does not claim that every production user/path above has been manually exercised after the 2026-09-21 deployment.

## Mobile attendance

The mobile-attendance production activation workflow previously completed successfully on the attendance GUI baseline. The normal production deployment preserves the production environment configuration rather than resetting it.

The repository safety boundary remains:

- `MOBILE_ATTENDANCE_ENABLED` must be explicitly enabled in production configuration;
- `BIOMETRIC_COLLECTION_ENABLED=0` remains a separate biometric-collection guard;
- GPS/photo evidence does not imply face recognition;
- photo retention/purge policy remains a separate operational policy decision unless documented elsewhere.

## Scope boundaries

This deployment does **not** by itself:

- authorize ORG-004 SHADOW or STRUCTURE rollout;
- perform a fresh authenticated browser UAT;
- perform active physical fingerprint commands;
- prove a restore drill;
- enable face recognition;
- calculate payroll deductions from attendance;
- implement shift exchange / shift swap.

Shift exchange remains the separate product capability **ATT-008**.

## Specification ID reconciliation

The accepted product/capability source already reserves **ATT-008** for Shift Exchange Workflow.

The earlier canonical-convergence implementation document temporarily reused ATT-008. That implementation package is now labeled **ATT-010 — Canonical Attendance Convergence** so ATT-008 remains unique and available for the shift-exchange work.

ATT-009 remains Attendance Operations & Reporting Polish.

## Closure

For deployment/runtime purposes:

```text
exact-SHA API publish PASS
+ exact-SHA Web publish PASS
+ production preflight PASS
+ rollback-image availability PASS
+ pre-migration backup created
+ API/Web exact target images deployed
+ PostgreSQL/API/Web healthy
+ API health/readiness PASS
+ deploy/verify PASS
= 2026-09-21 deployment/runtime acceptance closed
```

A later repository commit must not be assumed live until it passes its own exact-SHA production deployment path.
