# ATT-009 — Attendance Operations & Reporting Polish

**Status:** IMPLEMENTED — DEPLOYED TO PRODUCTION 2026-09-21  
**Decision date:** 2026-09-21  
**Related:** ATT-010, ATT-007, ATT-005

## Tujuan

Menutup sisa gap operasional/UX setelah ATT-010 canonical convergence. ATT-009 tidak mengubah source of truth atau aturan engine; fokusnya membuat capability canonical yang sudah ada dapat dipakai sehari-hari oleh Human Capital dan pegawai tanpa harus mengetahui detail internal.

## Scope

### 1. Laporan operasional

Halaman laporan harus mengekspos filter yang sudah didukung backend:

- pegawai;
- unit;
- jadwal;
- lokasi;
- source (`adms`, `mobile`, `manual`);
- device;
- status untuk detail harian.

UX mengikuti kebutuhan operasional:

- periode cepat **Bulan ini**;
- periode cepat **7 hari terakhir**;
- label kolom manusiawi;
- durasi menit dirender sebagai jam/menit;
- timestamp dirender dalam Asia/Jakarta;
- filter yang tidak relevan untuk jenis laporan tertentu disembunyikan dan nilainya dibersihkan;
- hasil dapat diekspor sebagai CSV UTF-8/BOM yang ramah Excel;
- hasil dapat dicetak melalui browser untuk PDF/print.

Ekspor tidak memperkenalkan source of truth baru; ia memakai baris report yang sedang tampil.

Applicability filter:

| Family | Pegawai | Unit | Jadwal | Lokasi | Source | Device | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Detail Harian | ya | ya | ya | ya | ya | ya | ya |
| Rekap Periode | ya | ya | ya | ya | ya | ya | tidak |
| Per Unit | ya | ya | ya | ya | ya | ya | tidak |
| Sesi Kerja | ya | ya | ya | ya | ya | ya | tidak |
| Data Scan | ya | ya | tidak | tidak | ya | ya | tidak |
| Jadwal Harian | ya | ya | ya | ya | tidak | tidak | tidak |
| Lembur | ya | ya | tidak | tidak | tidak | tidak | tidak |

UI wajib menyembunyikan dan membersihkan nilai filter yang tidak berlaku ketika family report berubah.

### 2. Dashboard harian

Dashboard kehadiran hari berjalan melakukan refresh best-effort berkala selama halaman terbuka:

- primary daily read: 30 detik;
- supporting counters boleh ikut refresh bersama primary load;
- kegagalan refresh tidak boleh menghapus data terakhir yang sudah berhasil dimuat;
- tanggal historis tidak perlu polling cepat.

### 3. Employee overtime lifecycle

Pegawai dapat membatalkan pengajuan lembur miliknya selama masih `submitted`.

- cancel tidak boleh tersedia untuk request yang sudah approved/rejected/cancelled;
- backend tetap authoritative;
- UI melakukan reload canonical snapshot setelah cancel.

### 4. ADMS global transactions

Back Office ADMS global transaction view menampilkan filter:

- device;
- mapping state;
- tanggal/waktu dari;
- tanggal/waktu sampai;
- pencarian lokal PIN/pegawai/serial.

Filter waktu dikirim ke API sebagai timestamp ISO dengan offset Asia/Jakarta. Read-only.

## Non-goals

- tidak mengubah attendance engine;
- tidak mengubah payroll;
- tidak menambah vendor/tenant model;
- tidak mengubah biometric capability;
- tidak menambah automation finalization;
- tidak mengubah data retention.

## Acceptance criteria

- ATT-009-A: report GUI dapat memakai employee/unit/schedule/location/source/device filters yang sudah ada di API.
- ATT-009-B: report memiliki Bulan ini, 7 hari terakhir, CSV Excel-friendly, dan print/PDF browser action.
- ATT-009-C: report memakai label dan format durasi/timestamp manusiawi.
- ATT-009-D: dashboard hari ini refresh best-effort tiap 30 detik tanpa blanking data lama saat refresh gagal.
- ATT-009-E: employee dapat cancel overtime berstatus submitted dari GUI dan snapshot direload.
- ATT-009-F: ADMS global transactions mendukung filter from/to selain device/mapping/search.
- ATT-009-G: authorization tetap backend-authoritative dan tidak ada permission baru.
- ATT-009-H: typecheck, lint, test, build, dan staging compose PASS sebelum merge.
