> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# Test Strategy

**Status:** DRAFT

## Test pyramid

### Domain unit tests

Menguji calculation, invariant, state transition, policy helper, dan value object tanpa database/network.

### Application/integration tests

Menguji use case, transaction, repository, outbox, idempotency, concurrency, dan adapter contract.

### API contract tests

Memastikan implementasi sesuai `docs/api/openapi.yaml`, termasuk status code dan problem response.

### End-to-end tests

Menguji flow pengguna kritis melalui browser/API pada environment terisolasi.

### Migration tests

Menguji transform dari fixture legacy sintetis, rerun, partial failure, mapping, dan reconciliation output.

## Critical suites

- Authentication dan account state.
- Permission matrix dan object-level authorization.
- Approval concurrency.
- Leave balance/calendar.
- Payroll and loan reconciliation.
- Attachment authorization.
- Audit event creation.
- Notification idempotency.
- Backup/restore smoke test pada staging.

## Test data

- Synthetic dan deterministic.
- Seeder memiliki skenario role/unit/state yang jelas.
- Financial values dibuat khusus untuk test dan tidak menyerupai data nyata.
- Fixture untuk edge case: timezone, leap day, holiday, overlap, rounding, retry, duplicate webhook.

## CI gates awal

```text
format/lint
  -> typecheck
  -> unit test
  -> integration test
  -> OpenAPI validation
  -> build
  -> dependency/security checks
```

E2E dapat berjalan pada pull request atau preview environment sesuai biaya, tetapi critical E2E wajib sebelum release.

## Flaky tests

Flaky test adalah defect. Jangan hanya retry tanpa issue/root cause. Test yang dikarantina harus memiliki owner, alasan, dan deadline.

## Coverage

Coverage percentage bukan satu-satunya target. Prioritas pada rule berisiko, negative authorization, state transition, dan reconciliation.