# Legacy Migration Strategy

**Status:** DRAFT  
**Specification:** MIG-001

## Objective

Memindahkan data dan operasi dari legacy HCIS ke HCIS YSQ secara repeatable, dapat direkonsiliasi, dan dapat dipulihkan tanpa kehilangan auditability.

## Phases

### 1. Discovery

- Inventaris schema, file, integration, scheduler, role, workflow, dan edge case.
- Bekukan glossary dan mapping awal.
- Tentukan data owner untuk setiap domain.

### 2. Extract and transform rehearsal

- Gunakan snapshot tersanitasi atau environment aman.
- Jalankan migration tool dengan `run_id` unik.
- Simpan error report dan unmapped values.
- Ulangi sampai hasil deterministik.

### 3. Domain reconciliation

Tidak cukup membandingkan row count. Wajib memeriksa:

- employee/status/unit;
- hierarchy dan approver;
- leave balance dan active requests;
- attendance periods;
- payroll totals dan payslip access;
- loan outstanding dan installment;
- file count/checksum;
- role/permission assignment.

### 4. Pilot

- Pilih user dan unit terbatas.
- Hindari data finansial production pada pilot awal kecuali kontrol siap.
- Catat mismatch dan behavioral gap.

### 5. Cutover rehearsal

Latih urutan final lengkap beserta durasi, command, owner, validation, dan rollback.

### 6. Production cutover

```text
announce freeze
  -> stop legacy writes
  -> final backup
  -> final extract
  -> migrate
  -> reconcile critical domains
  -> switch routing/access
  -> smoke test
  -> monitor
```

### 7. Legacy read-only

Legacy dipertahankan read-only selama periode verifikasi yang disetujui. Akses dibatasi dan semua perubahan tetap dilakukan di sistem baru.

## Tool requirements

Migration tool harus:

- idempotent;
- resumable atau aman diulang;
- versioned;
- menghasilkan structured report;
- memisahkan warning dan fatal error;
- menyimpan mapping source-target;
- mendukung dry-run;
- tidak log secret/data sensitif penuh;
- memiliki test fixture sintetis.

## Schema migration source of truth

Database schema migration identity is the full SQL filename recorded in `schema_migrations.name`, not the numeric prefix alone.

Production-history recovery rules are defined in `docs/development/migration-source-of-truth-recovery.md`. In particular:

- never rename or renumber a migration already recorded by production;
- never silently edit a deployed migration;
- historical duplicate numeric prefixes are retained when full filenames differ and the collision is explicitly allowlisted;
- canonical source must contain every production-critical historical migration;
- clean install and disposable restore must converge on the same final schema as the accepted migration history;
- missing history is recovered from verified Git blobs, not reconstructed from production data.

The CI migration-history manifest/checksum guard is part of the recovery control and contains no production credentials or data.

## Rollback

Rollback tidak selalu berarti menghapus data target. Sebelum cutover tetapkan:

- kapan routing dikembalikan;
- apakah legacy write dibuka kembali;
- bagaimana data baru selama window diperlakukan;
- siapa decision maker;
- backup yang digunakan;
- komunikasi kepada pengguna.

Setelah transaksi baru terjadi di HCIS YSQ, rollback menjadi rekonsiliasi dua arah yang kompleks. Karena itu go/no-go harus dilakukan sebelum membuka write.

## Go/no-go criteria

- Backup dan restore diuji.
- Seluruh critical reconciliation lulus.
- Tidak ada unmapped critical enum/role.
- Permission smoke test lulus.
- Observability dan on-call owner siap.
- Rollback threshold disepakati.
- Legacy freeze berhasil.