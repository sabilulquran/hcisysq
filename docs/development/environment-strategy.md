> **RETIRED / ARCHIVED — DO NOT DEPLOY — DO NOT RECREATE.** Staging references and staging commands in this document are historical evidence. The production VPS is production-only by owner decision of 2 October 2026. See the permanent-retirement runbook; historical staging instructions do not authorize deployment.

# Environment Strategy

**Status:** PROPOSED

## Objective

Satu codebase dapat berjalan pada local, CI, preview, staging, managed production, atau Docker VPS melalui konfigurasi dan adapter tanpa mengubah domain behavior.

## Environments

| Environment | Data | Purpose |
|---|---|---|
| local | synthetic | development cepat |
| CI | ephemeral synthetic | automated verification |
| preview | synthetic | review UI/PR |
| staging | synthetic atau sanitized dengan kontrol | integration, migration rehearsal, load test |
| production | real restricted data | operasi resmi |

## Configuration principles

- Config divalidasi saat startup dan gagal cepat bila wajib tidak tersedia.
- Secret tidak memiliki default yang aman-palsu.
- Environment tidak boleh mengubah aturan domain diam-diam.
- Feature flag memiliki owner, expiry/review date, dan audit bila memengaruhi akses.

## Capability configuration

Contoh konseptual:

```text
DATABASE_URL
IDENTITY_DRIVER
OBJECT_STORAGE_DRIVER
QUEUE_DRIVER
MAIL_DRIVER
WHATSAPP_DRIVER
PDF_RENDERER_DRIVER
PUBLIC_APP_URL
TRUSTED_PROXY_RANGES
```

Nama final mengikuti stack yang dipilih.

## Deployment profiles

### Lightweight managed

- Static web hosting.
- Managed API/container.
- Managed relational database.
- Managed object storage.
- On-demand worker bila workload rendah.

### Docker VPS

- Existing reverse proxy dapat dipakai.
- API/web dan worker memiliki resource limit.
- Database dapat shared instance dengan database/user terpisah untuk tahap awal, lalu dipisahkan saat risiko/beban meningkat.
- Build dilakukan di CI; VPS hanya menarik immutable artifact/image.
- Scheduler tunggal dan idempotent.

### Resource-constrained VPS

VPS kecil bukan target ideal untuk workload payroll/PDF/Excel. Bila digunakan sementara:

- jangan build frontend/dependency di server;
- batasi process/container memory dan CPU;
- gunakan worker on-demand bila aman;
- hindari menambah database/Redis baru tanpa capacity review;
- monitor swap, OOM, queue lag, disk, dan latency;
- siapkan exit plan ke environment lebih besar.

## Portability tests

- Config schema test.
- Adapter contract test.
- Container starts with minimal required config.
- Health/readiness checks.
- Migration against clean database.
- Backup and restore rehearsal.
- No production provider required for domain unit tests.