# System Context

**Status:** PROPOSED (logical view). **Updated:** 2026-11-16 — module list, integrations, and deployment facts brought in line with the running system and with SQ-Hub ADR-0014.

> This document is a living overview, not a retired one. Only its former mention of a staging environment was retired: staging was permanently retired by owner decision of 2 October 2026 (`docs/operations/permanent-staging-retirement-2026-10-02.md`) and production runs on Mi8VPS only. Nothing here authorizes recreating staging.

## Place in SQ Suite

HCIS is the workforce application inside SQ Suite, the ecosystem of Yayasan Sabilul Qur'an applications. It runs as its own program with its own database. The list of SQ Suite applications, portals, and their status is kept only in [STRUKTUR-001](https://github.com/sabilulquran/SQ-Hub/blob/main/docs/product/struktur-sq-suite.md) in the `SQ-Hub` repository.

HCIS reaches the rest of SQ Suite only through contracts:

| Counterpart | What crosses the boundary | HCIS reference |
|---|---|---|
| Akun SQ (platform) | Sign-in through OIDC; HCIS holds no production passwords | AUTH-012, `docs/domain/access-model.md` |
| Admin SQ and SQ Hub (platform) | Application Access check, launcher list, staff activation invite, role grants through the admin channel | AUTH-013, AUTH-014 |
| Direktori Organisasi (platform) | Read-only organization snapshot pulled from HCIS | ORG-006 |
| Portal Organ | HCIS governance summary (the Laporan face), employee list for organs, organ approvals | ORG-010, ORG-013, ORG-014 |
| Kirim SQ | Outgoing WhatsApp messages | NOTIF-001, CAL-001 |
| Aset SQ | Read-only asset holdings of an employee | ASSET-001 |
| Karir SQ | Vacant-position facts out, hire into employment in | REC-001 hand-off, `docs/product/hcis-capability-map.md` §7 |

## Logical view

```text
Employee / Approver / HC / Finance            Organ yayasan
        (Portal Pegawai)                      (Portal Organ)
                    |                               |
                 Web App                  governance summary API
                    |
                 HCIS API
      +-------------+--------------+
      |             |              |
  Relational DB  Object Storage  Job Queue
      |             |              |
      +------- Worker/Scheduler ----+
                    |
   Akun SQ (OIDC) / Kirim SQ (WhatsApp) / other SQ Suite applications
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

## Module boundaries

These are modules inside HCIS. The list follows `apps/api/src/modules` as of 2026-11-16; the product view of the same modules, with specification IDs and status, is `docs/product/hcis-capability-map.md`.

```text
auth                     identity, session, authorization, role administration
employees                employee master, import, data change
employment               employment terms, placement, PK/SK register
employee-documents       employee document archive
employee-cards           employee ID card
employee-assets          read-only view of Aset SQ holdings
organization             structure, authority resolution, designer
organization-directory   read-only export to the SQ Hub platform
committees               kepanitiaan
attendance               schedules, devices (ADMS), evaluation, requests
leave                    leave, balances, approval chain
trips                    business travel
payslips                 imported payslips (PAY-001/PAY-002)
payroll                  payroll calculation (PAY-003)
reimbursements           reimbursement
loans                    employee loans
performance              performance review
training                 training records
documents                HR documents and letter numbering
meetings                 meeting invitations and personal calendar
announcements            announcements
notifications            in-app notification center and delivery
reminders                scheduled reminders
reports                  HR reports
help                     help center
board                    board view inside HCIS
governance               governance summary for Portal Organ
system                   health and runtime
```

Modul berkomunikasi melalui application contract/event, bukan query lintas tabel tanpa boundary.

## Deployment portability

Current environments:

- local development;
- CI test environment;
- production on Mi8VPS (release directories, no Docker or systemd; `docs/development/mi8vps-hcis-release.md`).

There is no staging environment (retired 2026-10-02) and the Docker-based VPS was terminated. Portability to another host or to managed database/storage remains a design goal reached through configuration and adapters.

Portability tidak berarti semua provider diaktifkan bersamaan. Setiap environment memilih satu adapter per capability melalui validated configuration.

## Reliability principles

- Database transaction untuk keputusan domain.
- Outbox atau pola setara untuk side effect penting.
- Idempotency untuk job, webhook, submit, dan import.
- Health/readiness endpoint.
- Structured logs tanpa data sensitif.
- Backup off-site dan restore drill.
- Resource limit untuk setiap process/container.

## Architecture decisions

Settled in the running system:

- Frontend: React built with Vite (`apps/web`).
- Backend: Fastify on Node.js (`apps/api`).
- Relational database: PostgreSQL.
- Authentication: Akun SQ through OIDC in production; local login only for development and tests.
- External infrastructure behind ports and adapters: ADR-0002 (ACCEPTED).

Still open:

- ADR-0001 (modular monolith) is still PROPOSED although the system is built that way.
- A separate worker process and queue: background work currently runs as in-process runners inside the API.
- Object storage: files are currently stored encrypted in the HCIS database behind a port (EMP-011 D-01).

Keputusan yang masih terbuka harus dicatat sebagai ADR sebelum implementation lock-in.