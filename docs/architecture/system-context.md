> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# System Context

**Status:** PROPOSED

## Logical view

```text
Employee / Approver / HC / Finance / Yayasan
                    |
                 Web App
                    |
                 HCIS API
      +-------------+--------------+
      |             |              |
  Relational DB  Object Storage  Job Queue
      |             |              |
      +------- Worker/Scheduler ----+
                    |
       Email / WhatsApp / OAuth / External APIs
```

## Component responsibilities

### Web app

- Rendering dan interaction.
- Form state dan client-side validation untuk usability.
- API client berdasarkan contract.
- Tidak menyimpan keputusan bisnis authoritative.

### API

- Authentication/session integration.
- Authorization dan policy enforcement.
- Application use cases.
- Transaction boundary.
- API contract dan error semantics.

### Domain modules

- Entity/value object/domain service.
- Invariant dan state transition.
- Tidak bergantung pada vendor infrastructure.

### Worker/scheduler

- Notification delivery.
- PDF/Excel processing.
- Import dan long-running jobs.
- Reminder dan scheduled domain commands.
- Retry dengan idempotency.

### Infrastructure adapters

- Relational database.
- Object storage/Google Drive/S3-compatible provider.
- Queue database/Redis/managed queue.
- SMTP/email API.
- WhatsApp provider.
- OAuth/OIDC provider.

## Module boundaries awal

```text
identity
employees
organization
authorization
approvals
attendance
leave
reimbursement
payroll
loans
performance
training
documents
notifications
audit
reporting
```

Modul berkomunikasi melalui application contract/event, bukan query lintas tabel tanpa boundary.

## Deployment portability

Target portability:

- local development;
- CI test environment;
- preview/staging managed environment;
- Docker-based VPS;
- managed database/storage bila diperlukan.

Portability tidak berarti semua provider diaktifkan bersamaan. Setiap environment memilih satu adapter per capability melalui validated configuration.

## Reliability principles

- Database transaction untuk keputusan domain.
- Outbox atau pola setara untuk side effect penting.
- Idempotency untuk job, webhook, submit, dan import.
- Health/readiness endpoint.
- Structured logs tanpa data sensitif.
- Backup off-site dan restore drill.
- Resource limit untuk setiap process/container.

## Open architecture decisions

- Frontend framework/build output final.
- Backend runtime/framework final.
- Canonical relational database.
- Authentication provider strategy.
- Queue implementation pada release pertama.
- Storage provider pada release pertama.

Keputusan tersebut harus dicatat sebagai ADR sebelum implementation lock-in.