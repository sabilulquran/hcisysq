# AI-Assisted Development Workflow

**Status:** ACCEPTED

## Goal

Gunakan satu repository canonical (`sabilulquran/hcisysq`) dengan pembagian kerja yang jelas antara implementation owner dan agent lokal yang dapat menjalankan environment/test secara langsung.

Repository tersebut adalah hasil transfer repository yang sudah teramati. Perubahan nama canonical di dokumentasi tidak memindahkan GHCR package, runtime, secret, atau deployment target; batas itu tetap diatur oleh `github-org-transfer-readiness.md` dan runbook deployment.

## Current workflow

```text
Product/domain documentation
       -> implementation in canonical repo
       -> local Codex verification/fix loop
       -> human review
       -> pull request quality gates
       -> merge
```

The earlier Lovable repository may remain as visual reference/archive, but is no longer an implementation source of truth.

## Implementation owner

Coding may be performed through ChatGPT/GitHub-assisted work or a human engineer, but every change must follow repository documentation and branch discipline.

Environment-dependent claims such as “build passes” or “migration works” must not be asserted until executed in a real local/CI environment.

## Codex Local verification phase

Codex Local is the preferred execution agent for work that needs repeated local feedback, including dependency install, typecheck, lint, unit/integration tests, migration up/down, local PostgreSQL fixtures, build, and browser/E2E smoke tests.

Before working, the agent must read:

1. `AGENTS.md`;
2. `docs/product/mvp.md` when the task is MVP-related;
3. specification/feature parity item;
4. workflow and ADR related to the task;
5. OpenAPI and security baseline where relevant.

## Suggested local-agent effort

Use the best coding-capable model available in the installed Codex environment. As a working default:

- routine lint/typecheck/build/test: medium reasoning effort;
- integration failures, migration issues, or non-trivial debugging: high;
- auth, authorization, approval, concurrency, or security review: high or xhigh;
- reserve maximum effort for rare blockers where lower settings failed to provide reliable progress.

Do not spend maximum reasoning effort on routine green-path verification.

## Prompt contract for Codex Local

```text
Repository: sabilulquran/hcisysq
Branch: <branch>
Specification ID: <ID>
Outcome: <expected result>
Non-goals: <explicit exclusions>
Relevant docs: <paths>

Run:
- install if needed
- typecheck
- lint
- unit/integration tests
- build
- E2E/smoke tests if present

Rules:
- do not redesign requirements
- do not move business rules into the frontend
- do not weaken authorization/tests to make them pass
- use synthetic data only
- do not commit secrets

Report:
- commands run
- pass/fail
- files changed
- why each fix was needed
- remaining risks
```

## Review checklist khusus AI

- Apakah AI mengarang requirement?
- Apakah business rule bocor ke UI?
- Apakah authorization hanya di client?
- Apakah query membuka cross-unit data?
- Apakah approval chain di-resolve ulang setelah submission tanpa alasan yang sah?
- Apakah migration destructive?
- Apakah retry membuat duplicate side effect?
- Apakah log/error membocorkan data?
- Apakah dependency baru benar-benar perlu?
- Apakah generated code lebih rumit daripada kebutuhan?

## Data policy

Hanya synthetic data yang boleh masuk prompt, fixture, screenshot, dan prototype. Secret dan data production dilarang.

## Human approval required

- Product scope changes.
- Role/permission changes.
- Payroll/payslip visibility rules.
- Data retention.
- Migration/cutover.
- Security exceptions.
- Production deployment.
