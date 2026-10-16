# HCIS YSQ Engineering Rules

## Permanent production-VPS staging retirement

HCIS/SQ Hub staging on the production VPS was permanently retired by owner decision on 2 October 2026. Production-only is the intended topology. Do not recreate, deploy, enable, or infer a requirement for staging from historical files, backups, Docker resources, workflows, or documentation. Reintroduction requires a new explicit owner decision and a new deployment plan.

Operational source of truth: `docs/operations/permanent-staging-retirement-2026-10-02.md`.

Dokumen ini berlaku untuk manusia, ChatGPT, Codex, dan automation lain yang mengubah repository.

## 1. Source of truth

Urutan otoritas:

1. Keputusan produk dan domain di `docs/product/` dan `docs/domain/`.
2. Kontrak HTTP di `docs/api/openapi.yaml`.
3. ADR berstatus Accepted di `docs/architecture/adr/`.
4. Automated test.
5. Implementasi kode.
6. Legacy HCIS sebagai referensi discovery.

Bila sumber-sumber tersebut bertentangan, jangan menebak. Perbarui specification/ADR atau eskalasi keputusan produk.

## 2. Canonical repository

`sabilulquran/hcisysq` adalah repository development canonical setelah transfer GitHub. Repository lama `imadjinasi/hcisysq` mengalihkan ke repository organisasi tersebut.

- Frontend canonical: `apps/web`.
- Target API: `apps/api`.
- Domain rules: `packages/domain` ketika mulai diimplementasikan.
- Shared contracts: `packages/contracts` ketika dibutuhkan.

`imadjinasi/hcis-ysq-foundation` adalah design/reference archive. Jangan membuat fitur baru di sana dan jangan merge history repository tersebut ke canonical repo.

Production runtime: **Mi8VPS** (Android phone, Ubuntu chroot `/data/local/ubuntu26`, tanpa Docker/systemd). VPS berbayar lama (Docker Compose + GHCR) sudah dihentikan. Release HCIS adalah direktori `/srv/hcis/releases/hcis-<sha8>-<yyyymmdd>` yang dijalankan oleh `/data/local/mi8vps/sq-core-launch.sh` dan diawasi `sq-core-worker.sh`; release yang berjalan dibuktikan dari `cwd` proses `hcis`/`hcis-web`, bukan dari repository, GHCR, atau hasil workflow.

- Release flow: `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001). CI hanya membangun bundle linux/arm64 (`build-mi8-release.yml`); operator merilis dengan `scripts/mi8/release-mi8.sh` (dry-run default, `--apply` hanya dengan persetujuan owner).
- `.github/workflows/deploy-production.yml`, `scripts/deploy-vps.sh`, dan `scripts/verify-vps.sh` sudah **RETIRED** dan selalu gagal. Jangan menganggap run apa pun dari workflow tersebut sebagai deploy production, dan jangan menghidupkannya kembali.
- Setiap perubahan production di Mi8VPS (launcher, worker, release, database, env) membutuhkan persetujuan owner yang eksplisit. Inspeksi read-only via `ssh mi8vps` / `ssh mi8vps-root` diperbolehkan.
- Runbook operasional of record: Google Doc "Mi8VPS Platform Runbook".

Dokumen `docs/development/vps-deployment.md`, `github-vps-production-deployment.md`, dan `github-org-transfer-readiness.md` adalah catatan historis VPS lama (Docker/GHCR).

## 3. Documentation first

- Fitur baru harus mempunyai specification ID sebelum implementasi.
- Perubahan perilaku wajib memperbarui dokumentasi dalam perubahan yang sama.
- Workflow harus menjelaskan actor, precondition, input, state, transition, permission, audit event, dan failure behavior.
- Field dan istilah domain harus konsisten dengan `docs/domain/glossary.md`.
- Asumsi yang belum diverifikasi harus ditandai `DRAFT`, `DISCOVERY`, atau `TBD`.
- MVP mengikuti `docs/product/mvp.md`.

## 4. Architecture boundaries

- Frontend tidak boleh memuat aturan payroll, approval, authorization, saldo cuti, atau keputusan bisnis lain.
- Frontend berkomunikasi melalui kontrak API; jangan mengakses tabel production secara langsung.
- Domain logic tidak boleh bergantung langsung pada HTTP framework, database client, object storage, queue, email, atau vendor SDK.
- Integrasi eksternal berada di adapter/infrastructure layer.
- Jangan memperkenalkan microservice tanpa ADR.
- Portabilitas database dicapai melalui konfigurasi/adapter, bukan dukungan beberapa database sekaligus.

## 5. MVP boundaries

- Reimbursement berada setelah MVP.
- MVP payroll scope hanya import/validation data payslip dan employee read-only access.
- Jangan membangun payroll calculation engine untuk memenuhi layar payslip MVP.
- Approval chain mengikuti snapshot-on-submit behavior di `docs/domain/workflows/approval-engine.md`.

## 6. AI-assisted workflow

Implementation owner dapat mengerjakan kode melalui chat/GitHub-assisted editing. Codex Local diprioritaskan untuk execution loop yang membutuhkan environment nyata: install, lint, typecheck, test, migration, build, dan browser smoke test.

Baca `docs/development/ai-assisted-workflow.md` sebelum menyerahkan verification/fix loop ke agent lokal.

## 7. Quality gates

Sebelum merge:

- acceptance criteria terpenuhi;
- typecheck, lint, test, dan build lulus di environment yang benar-benar menjalankannya;
- setiap permission baru memiliki automated test;
- state transition penting menghasilkan audit event;
- migration memiliki rollback/recovery plan;
- kontrak API dan client tetap sinkron;
- error, loading, empty, forbidden, dan mobile state diperiksa;
- dokumentasi diperbarui;
- tidak ada secret atau data pribadi pada diff.

Jangan menyatakan quality gate lulus hanya berdasarkan inspeksi statis.

## 8. Security and privacy

- Jangan commit `.env`, token, credential, database dump, dokumen pegawai, foto absensi, slip gaji production, atau data payroll production.
- Jangan log password, token, nomor identitas lengkap, rekening, nominal sensitif, atau isi dokumen.
- Terapkan least privilege pada role aplikasi, database, storage, dan deployment.
- Auth, permission, audit, payslip/payroll, atau migration membutuhkan review tambahan.

## 9. Pull request discipline

- Satu pull request mempunyai tujuan dan scope yang jelas.
- Sertakan specification ID, risiko, perubahan database, bukti test, dan langkah rollback bila relevan.
- Jangan mencampur refactor besar dengan perubahan perilaku tanpa alasan kuat.
- Jangan menonaktifkan test untuk meloloskan perubahan.
- Jangan force push ke `main`.