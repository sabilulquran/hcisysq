# ATT-008 — Canonical Attendance Convergence

**Status:** IMPLEMENTATION  
**Decision date:** 2026-09-19  
**Related:** ATT-001, ATT-002, ATT-003, ATT-005, ATT-006, ATT-007, LEAVE-007

## Tujuan

Menutup gap antara fondasi kehadiran lama ATT-001 dan attendance engine ATT-007 sehingga HCIS mempunyai satu sumber kebenaran presensi untuk manual, ADMS/fingerprint, mobile GPS+foto, cuti/resolution, lembur, dashboard, laporan, dan self-service.

Arsitektur kanonik:

```text
ADMS / mobile / audited manual correction
                ↓
       attendance_events (immutable)
                ↓
schedule version + published roster version
                +
leave / validated leave day / attendance resolution
                +
approved clarification / approved overtime
                ↓
         attendance engine
                ↓
attendance_result_versions (immutable)
                ↓
attendance_result_sessions (version-owned)
                ↓
employee / HC dashboard / reports / compatibility reads
```

`attendance_daily_records` tetap dipertahankan selama cutover hanya sebagai compatibility storage historis. Writer baru tidak menjadikannya sumber policy/result.

## 1. Canonical manual attendance

Koreksi manual admin bukan edit raw evidence.

Admin memasukkan:
- employee;
- work date;
- proposed check-in/check-out;
- reason.

HCIS menyimpan approved correction dengan actor/audit append-only lalu recompute result version. Legacy ATT-001 mutation surface tidak boleh membuat fakta berbeda dari engine canonical.

Employee attendance read dan halaman admin attendance membaca result canonical. Legacy rows yang belum pernah masuk engine boleh ditampilkan sebagai compatibility fallback dengan label jelas sampai migrasi/backfill selesai.

## 2. Schedule versioning

Schedule template adalah identity yang dapat berubah untuk masa depan. Setiap perubahan semantic membuat immutable `attendance_schedule_versions`.

Versi menyimpan:
- schedule template id;
- version;
- name;
- start/end time;
- explicit `end_day_offset` (0 atau 1);
- grace;
- early-leave tolerance;
- work location;
- effective-from/to;
- actor dan timestamp.

Default assignment memilih versi schedule yang efektif pada work date.

Saat roster dipublish, setiap override schedule dipin ke satu concrete `schedule_version_id`. Mengubah template di kemudian hari tidak boleh mengubah arti roster/result historis.

## 3. Leave dan Attendance Resolution

Attendance engine harus membedakan:
- approved planned/annual leave date;
- special leave validated date;
- unresolved special-leave date;
- resolved `dispensation`;
- resolved `annual_conversion`;
- resolved `unpaid_absence`.

Rules:
- validated leave, dispensation, atau annual conversion mencegah false absence;
- unresolved date tidak otomatis dianggap leave;
- unpaid absence menghasilkan attendance status absent dengan provenance resolution;
- raw attendance evidence tetap dipertahankan bila ada.

## 4. Clarification semantics

Justification tidak lagi satu boolean global.

Result menyimpan minimal:
- `late_justified`;
- `early_leave_justified`;
- `outside_geofence_justified`.

Approval justification hanya memengaruhi kategori yang diminta. Justifikasi keterlambatan tidak membenarkan pulang cepat.

## 5. Overtime

Lembur adalah explicit request/decision, bukan inference dari checkout terlambat.

Lifecycle:

```text
submitted -> approved | rejected | cancelled
```

Employee dapat mengajukan tanggal + requested minutes + note. Human Capital berizin dapat approve/reject dan dapat menetapkan approved minutes tidak lebih besar dari requested minutes.

Attendance result menyimpan `overtime_minutes` hanya dari approved overtime. Tidak ada payroll calculation pada ATT-008.

## 6. Version-owned sessions

Setiap result version mempunyai derived session rows:

- sequence;
- check-in;
- check-out;
- worked minutes;
- complete/incomplete;
- source summary.

Multi-punch:
```text
08:00 IN
12:00 OUT
13:00 IN
17:00 OUT
=> 2 sessions, worked 480, break 60
```

Session lama tidak diubah ketika result version baru dibuat.

## 7. Daily operational read model

HC daily dashboard harus memasukkan semua employee aktif pada tanggal yang dipilih, termasuk yang belum punya result materialized.

Tanpa result:
- sebelum jadwal mulai => scheduled;
- selama work window => pending / belum check-in;
- setelah work window => absent;
- off/calendar holiday => off;
- ambiguous/no valid configuration => configuration_error.

Read-only dashboard tidak membuat raw evidence.

## 8. Reports

HCIS menyediakan families:

- Detail Harian;
- Rekap Periode;
- Per Unit;
- Sesi Kerja;
- Data Scan;
- Jadwal Harian;
- Lembur.

Filter yang relevan:
- tanggal/rentang;
- employee;
- unit;
- status;
- schedule;
- location;
- source;
- ADMS device.

Report membaca latest result version dan historical/effective schedule context, bukan template terkini secara membabi buta.

## 9. Employee self-service

Employee mempunyai satu attendance truth:
- hari ini;
- jadwal efektif;
- hasil canonical;
- worked/break/late/early/overtime;
- riwayat periode;
- sessions bila diperlukan;
- clarification history;
- overtime request history;
- mobile clock action.

ATT-001 compatibility copy tidak boleh memberi nilai berbeda dari canonical engine.

## 10. ADMS global transactions

Back Office ADMS menyediakan feed transaksi lintas mesin untuk operasional:
- filter device;
- PIN;
- employee mapping;
- date/range;
- occurred/received time;
- source request;
- mapping state.

Per-device transaction page tetap tersedia untuk drill-down. Ini bukan vendor/tenant provisioning.

## Permissions

Tambahan:
- `attendance.overtime.manage` — keputusan lembur.
- Existing `attendance.records.manage` digunakan untuk audited manual correction.
- Existing schedule/clarification/report permissions tetap dipakai.

Role `human_capital_admin` mendapat overtime manage. Role `human_capital` juga boleh memproses lembur organisasi bila mempunyai capability HC aktif; backend tetap authoritative.

## Migration / compatibility

1. Tidak menghapus tabel ATT-001.
2. Seed satu schedule version dari setiap template yang sudah ada.
3. Existing roster schedule override mendapat pinned schedule version sebelum dipakai.
4. Existing result rows tetap valid; kolom baru memakai default aman.
5. Existing employee attendance legacy rows tetap bisa dibaca sebagai fallback sampai result canonical tersedia.
6. Tidak mengubah evidence ADMS/mobile.
7. Rollback aplikasi dapat mengabaikan tabel/kolom baru; migration tidak menghapus data lama.

## Acceptance criteria

- ATT-008-A: manual admin correction menghasilkan canonical result baru tanpa mutasi raw ADMS/mobile evidence.
- ATT-008-B: perubahan schedule template tidak mengubah historical published roster/result.
- ATT-008-C: validated/partially validated leave dan Attendance Resolution menghasilkan classification yang tepat per date.
- ATT-008-D: late dan early-leave justification independen.
- ATT-008-E: approved overtime minutes masuk result/report; checkout terlambat tanpa approval tidak menjadi overtime.
- ATT-008-F: session rows tersimpan per result version.
- ATT-008-G: daily HC dashboard menampilkan employee aktif walau belum ada result version.
- ATT-008-H: period/unit/session/scan/schedule/overtime report tersedia.
- ATT-008-I: employee attendance utama membaca canonical result.
- ATT-008-J: Back Office ADMS mempunyai transaksi lintas mesin.
- ATT-008-K: typecheck, lint, tests, build, clean migration, and staging compose PASS before merge.
