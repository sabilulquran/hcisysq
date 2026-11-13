# Legacy Migration Strategy

**Status:** ACCEPTED as implemented 2026-11-13 (repeatable path below); phases and go/no-go remain the cutover discipline  
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

## MIG-001 — jalur migrasi yang sudah ada (implemented, 2026-11-13)

MIG-001 tidak dibangun sebagai satu alat migrasi tunggal. Jalur yang repeatable adalah kumpulan alat per domain di bawah ini. Setiap alat dimiliki domainnya sendiri, punya dry-run, idempoten atau aman diulang, mencetak laporan berupa hitungan dan kode isu (bukan data pribadi), dan sudah dipakai di production. Keputusan ini `DRAFT` (default agent): orkestrasi satu tombol tidak menambah keamanan bagi yayasan seukuran YSQ (±330 pegawai), sedangkan alat per domain dapat diuji dan di-rollback sendiri-sendiri.

| Urutan | Domain | Alat | Sifat | Bukti production |
|---|---|---|---|---|
| 1 | Pegawai (master) | EMP-004: impor XLSX di layar Admin dan CLI `employees:import` | pratinjau dulu; upsert per NIP; menyimpan snapshot klasifikasi sumber; baris di luar pengelolaan HCIS dilewati | impor master berkala sejak MVP (EMP-004 `verified`) |
| 2 | Struktur organisasi | ORG-004/ORG-008 change set di HCIS | ditulis di HCIS, bukan dimigrasikan; diterbitkan berversi | struktur terbit dipakai AUTH-015 |
| 3 | Riwayat kepegawaian | `employment:baseline` (EMP-005 §8.2) | dry-run default; `--apply`; `--cutoff`; ulang per pegawai dengan `--rerun`; koreksi kategori `--reclassify`; tidak pernah mengarang tanggal | 2026-11-03: 326 employment (96 aktif); 2026-11-04: 3 reklasifikasi |
| 4 | Data payroll awal | `payroll:initial-load` (PAY-003-MIG, `docs/domain/payroll-initial-data-load.md`) | dry-run default; `--apply` dengan `--actor-account`; menolak bila periode sudah dihitung; penanda `[PAY-003-MIG]` untuk rollback | 2026-11-03: 12 kebijakan, 96 profil |
| 5 | Slip gaji historis | PAY-001 impor batch | validasi baris, publikasi terpisah PAY-002 | jalur slip resmi sampai PAY-003 lulus uji paralel |
| 6 | Dokumen pegawai | EMP-011 unggah per pegawai | manual oleh HC; tidak ada impor massal berkas | — |

Tidak dimigrasikan (`DRAFT`, keputusan default yang dicatat):

- **Kehadiran sebelum HCIS:** tetap di sistem lama/ADMS sebagai arsip; HCIS menghitung kehadiran dari data mesin dan HP sejak dipakai.
- **Riwayat cuti lama:** tidak diimpor; saldo cuti tahunan dihitung oleh kebijakan LEAVE-001 dari TMT. Bila HC perlu memasukkan cuti yang sudah terpakai di tahun berjalan, itu dicatat sebagai keputusan owner tersendiri.
- **Pinjaman lama (kasbon legacy):** arsip saja (LOAN-001 D5). Saldo kasbon berjalan dimuat ke register PAY-003 lewat `payroll:initial-load` langkah 2 oleh akun Keuangan yang memegang `payroll.loans.manage`.

Rekonsiliasi per domain mengikuti §3 di atas dan dicatat sebagai hitungan di catatan verifikasi rilis (`docs/development/production-release-verification-*.md`), misalnya uji paralel payroll Oktober 2026 (`pay003-parallel-run-2026-10.md`). Sisa pekerjaan cutover (pegawai baru Agustus–Oktober 2026, kasbon, tanggal akhir 110 mantan pegawai) adalah kegiatan data owner, bukan pekerjaan alat.

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