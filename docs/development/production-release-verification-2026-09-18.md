# Production Release Verification — 2026-09-18

**Historical checkpoint:** superseded as the latest production baseline by [`production-release-verification-2026-09-19.md`](production-release-verification-2026-09-19.md), which records deployment of `66da50cbd2a12f6099a59adbda28b657863e8e40`. This file remains the authoritative dated record for the earlier `acd22b...` release and its browser acceptance evidence.

**Status:** VERIFIED — RELEASE ACCEPTANCE CLOSED  
**Deployed application SHA:** `acd22b438a7468dc6ea53ae001980cd06f7343cd`  
**Repository state after release:** `main` later advanced to `92889f14ae5c39b817945fc71ee26f8fdbca9471`; that later commit is repository state, not evidence of the deployed runtime.

This checkpoint records the production release evidence for the HCIS deployment completed on 2026-09-18. It is an operational evidence record only. It does not authorize a new deployment, does not activate ORG-006, and does not by itself authorize the one-unit pilot gates documented in `hcis-operational-readiness.md`.

## Evidence classes

- **GitHub-observed evidence:** workflow/job state read directly from the repository after the release.
- **Operator-supplied production evidence:** runtime/VPS/browser results reported by the authorized operator after executing the repository deployment path.
- **Repository fact:** source state observed in canonical `sabilulquran/hcisysq`.

No production credential, cookie, token, employee identifier, biometric payload, database dump, or other secret is recorded here.

## Release chain

| Item | Evidence |
| --- | --- |
| Main SHA selected for publication/deployment | `acd22b438a7468dc6ea53ae001980cd06f7343cd` |
| Previous production SHA | `ca38db08e85f064ffe5513f32ae0b75c11a3cf56` |
| Publisher | [run 35371463160](https://github.com/sabilulquran/hcisysq/actions/runs/35371463160) |
| Publisher result | GitHub-observed: API publish success; Web publish success |
| Target API image | `ghcr.io/sabilulquran/hcisysq-api:sha-acd22b438a7468dc6ea53ae001980cd06f7343cd` |
| Target Web image | `ghcr.io/sabilulquran/hcisysq-web:sha-acd22b438a7468dc6ea53ae001980cd06f7343cd` |
| Production workflow | [run 35371563402](https://github.com/sabilulquran/hcisysq/actions/runs/35371563402) |
| Production workflow result | GitHub-observed: `Production preflight` success; `Deploy and verify` success |
| Final deployed repository SHA | Operator-supplied: `acd22b438a7468dc6ea53ae001980cd06f7343cd` |

## Preflight and rollback evidence

Operator-supplied evidence records:

- target exact-SHA API/Web images were available;
- rollback exact-SHA API/Web images for `ca38db08...` were available;
- production working-tree guard passed;
- biometric guard passed with biometric collection OFF;
- PostgreSQL pre-deploy custom-format backup completed successfully, approximately 12 MB;
- deployment continued through the normal repository workflow rather than an ad-hoc container cutover.

The backup size is evidence that a pre-deploy dump was created; it is not evidence of a completed restore drill. Restore readiness remains governed separately by the operational-readiness runbook.

## Runtime verification

Operator-supplied production evidence records:

- `deploy-vps`: `DEPLOY SUCCESS`;
- `verify-vps`: PASS with successful exit status;
- API runtime uses the target exact-SHA image and is healthy;
- Web runtime uses the target exact-SHA image and is healthy;
- PostgreSQL, API, and Web report healthy;
- `/`, `/api/health`, and `/api/ready` returned HTTP 200;
- API health/readiness responses reported `ok` and `ready`;
- verifier recorded device-command delta `0`;
- no active hardware/fingerprint command was run;
- biometric collection remained OFF.

## Browser acceptance

The operator first verified a fresh-browser unauthenticated boundary:

- visiting `/app` redirected to Akun SQ as expected;
- authentication surfaces were inspected at `390x844` and `1440x900`;
- no credential automation or credential exposure was used.

The operator subsequently confirmed the authenticated UI smoke as **PASS** using an authorized existing session. This closes the authenticated release-UI gap that remained immediately after automated deployment verification.

This checkpoint records the pass/fail result only. It intentionally does not store session material, credentials, cookies, screenshots containing personal data, or user identity details.

## Scope boundaries

- **ORG-006 remains `DISCOVERY`.** This release evidence does not claim a new endpoint, sync, worker, webhook, writeback, directory publication, or runtime activation.
- Production deployment success does not itself authorize ORG-004 SHADOW/STRUCTURE activation or a one-unit pilot. Those operational gates remain separate.
- No biometric collection was enabled.
- No active device command was used for release proof.
- Repository `main` advanced after the deployment. As of this checkpoint, commit `92889f14...` from PR #59 is newer than the deployed SHA. Do not infer that newer repository commits are live merely because they are on `main`.

## Follow-up, non-blocking

The release completed successfully with two maintenance warnings/follow-ups:

- GitHub Actions Node.js 20 action deprecation;
- planned Ubuntu runner migration.

These are technical-maintenance items, not blockers or failed acceptance criteria for this release. They should be handled separately from this release-evidence PR.

## Closure

For application release purposes, the 2026-09-18 production deployment of `acd22b438a7468dc6ea53ae001980cd06f7343cd` is recorded as fully verified:

```text
exact-SHA publish PASS
+ production preflight PASS
+ deploy PASS
+ verifier PASS
+ exact runtime images PASS
+ health/readiness PASS
+ unauthenticated browser boundary PASS
+ authenticated UI smoke PASS
= release acceptance closed
```

This closure is deliberately narrower than pilot authorization and future production deployment approval.
