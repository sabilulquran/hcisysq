# Attendance & ADMS Admin Experience

**Status:** IMPLEMENTED — DEPLOYED TO PRODUCTION 2026-09-21  
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
- keterkaitan yang jelas ke Waktu & Kehadiran.

## Operasional Kehadiran

Sejak ATT-011-1 (2026-10-23), workspace Human Capital adalah menu **Waktu & Kehadiran** (`attendance-operational-simplification-spec.md` §3):

| Menu | Route | Permission data |
|---|---|---|
| Ringkasan | `/admin/attendance` | salah satu permission kehadiran; tiap kartu hanya tampil bila datanya bisa dimuat |
| Shift | `/admin/attendance/shifts` | `attendance.schedule.manage` |
| Jadwal → Pola jadwal | `/admin/attendance/schedules` | `attendance.schedule.manage` |
| Jadwal → Jadwal per tanggal | `/admin/attendance/schedules/dates` | `attendance.schedule.manage` |
| Jadwal → Tukar shift | `/admin/attendance/schedules/swaps` | `attendance.shift_swap.manage` |
| Kehadiran → Pantauan Hari Ini | `/admin/attendance/daily` | `attendance.reports.read` |
| Kehadiran → Kalkulasi (ATT-014-2) | `/admin/attendance/calculation` | `attendance.reports.read`; tombol Kalkulasi butuh `attendance.calculation.run` |
| Kehadiran → Klarifikasi | `/admin/attendance/clarifications` | `attendance.clarification.manage` |
| Kehadiran → Bukti HP | `/admin/attendance/mobile-evidence` | `attendance.clarification.manage` |
| Kehadiran → Koreksi HC | `/admin/attendance/corrections` | `attendance.records.manage` |
| Kehadiran → Laporan | `/admin/attendance/reports` | `attendance.reports.read` |
| Lembur | `/admin/attendance/overtime` | `attendance.overtime.manage` |
| Mesin Fingerprint | `/admin/attendance/adms` | `attendance.devices.read` |
| Pengaturan → Lokasi kerja | `/admin/attendance/settings/locations` | `attendance.schedule.manage` |

Menu sidebar membuka tab pertama yang dapat dimuat akun tersebut; menu tanpa tab yang dapat dimuat tidak tampil (K-8). Route lama `/admin/attendance/workforce/*` dialihkan ke route baru (`legacyAttendanceRedirects` di `apps/web/src/lib/attendanceNavigation.ts`) selama minimal satu rilis; `/admin/attendance/settings/recalculate` (Finalisasi ulang) dialihkan ke Kalkulasi sejak ATT-014-2. `/admin/attendance` sebelumnya halaman koreksi manual; koreksi kini ada di Kehadiran → Koreksi HC.

**Koreksi HC — tanggal kerja (perbaikan 2026-10-26).** Form memakai satu **Tanggal kerja** dan jam saja (`type="time"`), sehingga tanggal tidak bisa berbeda antar-field. Jam pulang lewat tengah malam ditandai eksplisit "Pulang keesokan hari (+1 hari)". API `POST /admin/attendance/manual-corrections` menolak dengan `422` sebelum menulis apa pun bila jam masuk tidak jatuh pada tanggal kerja (WIB), jam pulang tidak pada tanggal kerja atau keesokan harinya, atau jam pulang tidak setelah jam masuk / lebih dari 24 jam sesudahnya. Sebelumnya field jam memakai `datetime-local` dengan tanggal terpisah (default hari ini), sehingga koreksi untuk 20 Oktober bisa tersimpan dengan stempel 26 Oktober dan ikut dihitung engine.

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
