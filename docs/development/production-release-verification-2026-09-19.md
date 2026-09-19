# Production Release Verification — 2026-09-19

**Status:** VERIFIED — DEPLOYMENT/RUNTIME ACCEPTANCE CLOSED  
**Deployed application SHA:** `66da50cbd2a12f6099a59adbda28b657863e8e40`  
**Previous production SHA:** `acd22b438a7468dc6ea53ae001980cd06f7343cd`  
**Local date:** 2026-09-19 Asia/Jakarta (GitHub run timestamps are 2026-09-18 UTC)

This checkpoint records the GitHub-observed production deployment of current `main` after PR #59 and PR #60 were merged. It records deployment/runtime evidence only; it does not claim additional pilot, browser UAT, organization rollout activation, biometric enablement, or device-command testing.

## Release chain

| Item | Evidence |
| --- | --- |
| Target application SHA | `66da50cbd2a12f6099a59adbda28b657863e8e40` |
| Previous production SHA | `acd22b438a7468dc6ea53ae001980cd06f7343cd` |
| Publisher | [run 35381914922](https://github.com/sabilulquran/hcisysq/actions/runs/35381914922) |
| Publisher result | GitHub-observed: API publish success; Web publish success |
| API image | `ghcr.io/sabilulquran/hcisysq-api:sha-66da50cbd2a12f6099a59adbda28b657863e8e40` |
| Web image | `ghcr.io/sabilulquran/hcisysq-web:sha-66da50cbd2a12f6099a59adbda28b657863e8e40` |
| Production workflow | [run 35382026318](https://github.com/sabilulquran/hcisysq/actions/runs/35382026318) |
| Production result | GitHub-observed: all production job steps success, including Production preflight and Deploy and verify |

## Preflight

GitHub Actions logs record:

- requested target SHA exactly matched `origin/main`;
- production previous SHA was `acd22b438a7468dc6ea53ae001980cd06f7343cd`;
- target exact-SHA API/Web images were pullable;
- rollback exact-SHA API/Web images for the previous production SHA were pullable;
- biometric safety precondition was checked by the production workflow;
- `PRECHECK_STATUS=OK`.

## Backup and cutover

The normal repository deployment path created a PostgreSQL pre-migration backup before application cutover:

```text
backups/deploy/20260918T184916Z-66da50cbd2a1/postgres-before.dump
```

The GitHub log reports the dump at approximately 12 MB. This proves backup creation for the deployment; it is not a restore-drill result.

The production working tree was then fast-forwarded from `acd22b4...` to `66da50c...`.

## Runtime evidence

GitHub Actions logs record:

- API exact image pulled for `66da50c...`;
- Web exact image pulled for `66da50c...`;
- API cutover completed;
- API direct health returned `{"status":"ok"}`;
- API readiness returned `{"status":"ready"}`;
- Web cutover completed;
- edge-local smoke returned `ok`;
- post-cutover health/readiness returned `ok` / `ready`;
- PostgreSQL, API, and Web were all reported healthy;
- runtime API image exactly matched the target SHA;
- runtime Web image exactly matched the target SHA;
- retired USERINFO safety trigger remained present;
- deployment ended with `DEPLOY SUCCESS`;
- deployed repository `HEAD=66da50cbd2a12f6099a59adbda28b657863e8e40`.

The production job's combined **Deploy and verify** step completed successfully. The workflow intentionally redacts the passive device summary from GitHub Actions output.

## ORG-004 rollout safety check

A GitHub-only audit of the exact deployed delta `acd22b... -> 66da50c...` confirms:

- recovered migrations `0020` through `0023` contain no `organization_rollout_settings` mutation;
- PR #60 did not add a migration that creates or changes an ORG-004 rollout row;
- the organization repository reads rollout mode from `organization_rollout_settings`;
- the Admin API changes rollout only through an explicit authorized `PATCH /admin/organization/rollout` path.

Therefore this deployment did **not automatically activate** `SHADOW` or `STRUCTURE`.

This GitHub-only closure does not claim a fresh direct production row-count query, because the available GitHub connector has no read-only VPS/database session. The last supplied direct production evidence reported no rollout row and therefore `LEGACY`; no rollout-mutating deployment change or later activation evidence is present in this release record.

## Scope

This deployment makes the source/schema reconciliation from PR #59/#60 part of the verified production application baseline. It does **not** by itself:

- create or change ORG-004 rollout configuration;
- activate SHADOW or STRUCTURE;
- grant account/role/capability assignments;
- enable biometric collection;
- authorize active attendance-device commands;
- complete a restore drill;
- prove any additional browser/pilot UAT beyond the deployment/runtime verification above.

No additional pilot/UAT execution is claimed by this checkpoint.

## Closure

For deployment/runtime purposes:

```text
exact-SHA API publish PASS
+ exact-SHA Web publish PASS
+ production preflight PASS
+ pre-migration backup created
+ API/Web exact target images deployed
+ PostgreSQL/API/Web healthy
+ health/readiness PASS
+ repository deploy script PASS
+ repository verify step PASS
= deployment/runtime acceptance closed
```

Later repository commits must not be assumed live until they pass their own exact-SHA production deployment path.
