# Attendance & ADMS Admin Experience

**Status:** IMPLEMENTATION  
**Related specifications:** ATT-002, ATT-003, ATT-005, ATT-006, ATT-007  
**Decision date:** 2026-09-19

## Tujuan

Menyediakan GUI operasional yang setara dengan kemampuan backend attendance dan ADMS HCIS tanpa menyalin model multi-tenant RuangHadir.

HCIS adalah sistem internal Yayasan Sabilul Qur'an. Karena itu tidak ada tenant switcher atau provisioning tenant pada UI. Pemisahan yang dipakai adalah:

1. **Back Office ADMS** — control plane perangkat/fingerprint lintas mesin.
2. **Operasional Kehadiran** — policy dan operasi Human Capital untuk YSQ.

## Informasi arsitektur

Back Office ADMS tidak menggantikan halaman detail mesin. Halaman detail tetap menjadi drill-down untuk:

- pengguna/mapping PIN;
- biometrik;
- transaksi;
- command;
- operasi;
- settings;
- diagnostics.

Landing Back Office ADMS harus memperlihatkan fleet secara keseluruhan:

- total mesin;
- online/offline/unknown;
- mapping yang perlu ditinjau;
- PIN belum terhubung;
- mesin terdeteksi tetapi belum di-claim;
- shortcut ke device detail;
- keterkaitan yang jelas ke Operasional Kehadiran.

## Operasional Kehadiran

Workspace Human Capital dipecah menjadi tab/route:

- Ringkasan;
- Lokasi;
- Jadwal;
- Assignment;
- Roster mingguan;
- Klarifikasi;
- Evidence mobile;
- Laporan.

Route utama:

```text
/admin/attendance/workforce
/admin/attendance/workforce/locations
/admin/attendance/workforce/schedules
/admin/attendance/workforce/assignments
/admin/attendance/workforce/roster
/admin/attendance/workforce/clarifications
/admin/attendance/workforce/mobile
/admin/attendance/workforce/reports
```

Back Office ADMS:

```text
/admin/attendance/adms
/admin/attendance/devices
/admin/attendance/devices/:deviceId/...
```

## GUI behavior

### Ringkasan

Menampilkan:

- pegawai aktif;
- schedule template aktif;
- work location aktif;
- klarifikasi submitted;
- mobile evidence needs review hari ini;
- distribusi result presensi hari ini;
- CTA ke roster, klarifikasi, mobile evidence, laporan;
- CTA ke ADMS Back Office.

### Lokasi kerja

GUI wajib:

- menampilkan seluruh work location;
- membuat lokasi;
- mengubah nama, koordinat, radius, dan active state;
- tidak menghapus lokasi yang sudah direferensikan schedule; gunakan active=false.

### Jadwal

GUI wajib:

- menampilkan template schedule;
- membuat template;
- mengubah waktu, grace, early-leave tolerance, lokasi, active state;
- menandai shift overnight secara eksplisit bila end <= start.

### Assignment

GUI wajib:

- menampilkan assignment efektif per pegawai;
- weekday harus dapat dipilih Senin-Minggu, tidak hard-coded Senin-Jumat;
- dapat mengakhiri assignment dengan effective_to;
- overlapping assignment tetap diperlakukan sebagai configuration error oleh engine.

### Roster mingguan

GUI mengikuti pola spreadsheet:

- baris = pegawai;
- kolom = Senin-Minggu;
- pilihan per cell = ikut default, off, atau schedule;
- status draft/published terlihat;
- draft baru dapat dibuat untuk minggu tersebut;
- latest published roster menjadi authoritative;
- publish adalah aksi eksplisit;
- tidak mengubah raw attendance evidence.

### Klarifikasi

GUI menampilkan filter status submitted/approved/rejected/cancelled/all, employee, date, kind, mode, proposed time, reason, decision note. Decision hanya tersedia untuk submitted.

### Evidence mobile

GUI untuk Human Capital menampilkan:

- employee;
- clock action;
- timestamp;
- GPS accuracy;
- assigned work location;
- distance;
- geofence status;
- review state;
- tombol lihat foto terenkripsi melalui endpoint authenticated/no-store.

Foto hanya ditampilkan on-demand. Tidak ada bulk image gallery preload.

### Laporan

GUI menampilkan:

- date;
- filter status;
- cards summary;
- tabel employee/unit/status/check-in/check-out/worked/late/early-leave/justified;
- tombol finalisasi hari tersebut;
- finalization bukan payroll deduction.

## API pendukung GUI

Endpoint read/manage berikut diperlukan:

- `PATCH /admin/attendance/work-locations/:id`
- `PATCH /admin/attendance/schedules/:id`
- `GET /admin/attendance/schedule-assignments`
- `PATCH /admin/attendance/schedule-assignments/:id`
- `GET /admin/attendance/rosters?weekStart=...`
- `GET /admin/attendance/mobile-evidence`
- `GET /admin/attendance/mobile-evidence/:evidenceId/photo`
- clarification list menerima status filter.

Semua endpoint admin harus memakai permission backend. UI hiding tidak dianggap authorization.

## Relation to RuangHadir

RuangHadir memiliki dua persona terpisah karena produknya multi-tenant:

- platform/vendor owner;
- tenant operator.

HCIS tidak menyalin tenant provisioning karena hanya digunakan oleh YSQ. Padanan fungsionalnya:

- RuangHadir vendor/device-cloud -> HCIS Back Office ADMS;
- RuangHadir tenant attendance workspace -> HCIS Operasional Kehadiran.

Tujuannya menyerap pola operasional yang terbukti berguna tanpa membawa kompleksitas SaaS yang tidak dibutuhkan YSQ.

## Verification

Minimum CI:

- route authorization untuk seluruh child route;
- API validation untuk patch/list endpoints;
- roster read returns latest draft + published history safely;
- mobile evidence admin photo access requires reports/clarification permission boundary chosen by implementation;
- frontend typecheck/lint/test/build;
- no secret/photo plaintext exposure in JSON;
- mobile photo endpoint uses `Cache-Control: no-store`.
