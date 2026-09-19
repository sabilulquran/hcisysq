# HCIS Attendance Engine, Scheduling, Clarification, and Mobile Evidence

**Status:** IMPLEMENTATION  
**Specifications:** ATT-002, ATT-003, ATT-006, ATT-007  
**Related:** ATT-001, ATT-005, LEAVE-001, LEAVE-002, APR-001  
**Decision date:** 2026-09-19

## Tujuan

Membuat satu domain kehadiran HCIS yang menerima evidence dari fingerprint/ADMS, presensi mobile GPS + foto, dan koreksi administratif tanpa menjadikan adapter perangkat sebagai policy engine.

Alur kanonik:

```text
ADMS/fingerprint ─┐
Mobile GPS+foto ──┼─> normalized attendance events
Koreksi approved ─┘
                         ↓
             schedule / shift / calendar
                         +
                 approved leave/permission
                         ↓
                  attendance engine
                         ↓
              versioned attendance result
                         ↓
        employee / Human Capital / report
```

Raw evidence tidak boleh ditulis ulang agar suatu hasil terlihat "benar". Koreksi dan justifikasi menghasilkan evidence/keputusan baru dan hasil evaluasi versi baru.

## Source-of-truth dan kompatibilitas

- ATT-001 `attendance_daily_records` tetap menjadi factual compatibility read model untuk jam masuk/jam keluar yang sudah ada.
- ATT-005 memiliki ADMS raw ingress, PIN mapping, device management, dan physical operations. ATT-005 bukan policy engine.
- ADMS raw event diproyeksikan idempotently ke normalized attendance event; raw `attendance_adms_events` tetap immutable.
- Mobile ATT-006 menulis normalized event langsung setelah employee/session, GPS, geofence, dan foto berhasil dipersist.
- ATT-007 membaca normalized events, published/default schedule, kalender kerja, approved leave/permission, dan approved ATT-002 clarification.
- Tidak ada perubahan pada algoritma biometric matching; foto ATT-006 adalah evidence visual, bukan face recognition.

Dokumen lama `attendance-adms-ingress.md` dan `attendance-adms-projection.md` adalah implementasi historis ADMS yang sekarang berada di bawah ATT-005. Nomor ATT-002/ATT-003 pada judul lama tidak lagi menjadi feature ID kanonik.

## ATT-003 — Jadwal dan shift

### Schedule template

Human Capital dapat membuat template jadwal dengan:

- nama;
- jam mulai dan selesai;
- grace keterlambatan;
- toleransi pulang cepat;
- lokasi kerja opsional untuk geofence;
- status aktif/nonaktif.

`end_time <= start_time` berarti shift melewati tengah malam. Work date tetap tanggal mulai shift.

### Default assignment

Pegawai dapat memiliki assignment efektif bertanggal ke satu schedule template dan daftar ISO weekday 1–7. Assignment default dipakai bila tidak ada published roster override pada work date tersebut.

Overlapping assignment yang membuat resolver ambigu harus gagal tertutup dan ditampilkan sebagai configuration error; engine tidak memilih jadwal secara diam-diam.

### Weekly roster

Roster memiliki:

```text
DRAFT -> PUBLISHED
```

- satu minggu dimulai hari Senin;
- draft dapat dibuat dari default assignment atau menyalin published roster minggu sebelumnya;
- entry menentukan employee + work date + schedule template, atau `OFF`;
- hanya published roster yang memengaruhi attendance engine;
- publish tidak mengubah raw attendance evidence;
- perubahan setelah publish memakai versi roster baru, bukan edit diam-diam terhadap snapshot published.

Employee dapat membaca jadwalnya sendiri. Human Capital dapat membaca dan mengelola jadwal sesuai permission.

## Normalized attendance event

Normalized event minimal menyimpan:

- employee;
- source: `adms | mobile | manual`;
- event kind: `punch | check_in | check_out | correction`;
- `occurred_at`;
- `received_at`;
- stable `source_reference`;
- safe metadata;
- created timestamp.

Event bersifat append-only. Exact `source_reference` unik agar replay idempotent.

### ADMS

Mapped ATTLOG menghasilkan `source=adms`, `event_kind=punch`, `occurred_at` dari device evidence, dan `received_at` dari ingress evidence. Mapping efektif ATT-005 tetap authoritative.

### Mobile

Mobile clock-in/out menghasilkan `source=mobile` dan event kind eksplisit `check_in` atau `check_out`. Waktu kehadiran authoritative adalah timestamp server saat evidence diterima. Timestamp perangkat tidak menjadi sumber payroll/disiplin.

## ATT-006 — GPS + foto

### Capture contract

Shipped web client:

1. meminta lokasi browser;
2. membuka kamera depan melalui `getUserMedia`;
3. menangkap frame kamera menjadi JPEG; tidak menyediakan file/gallery picker;
4. mengirim latitude, longitude, accuracy dan JPEG pada satu mutation;
5. server mengautentikasi employee aktif;
6. server menentukan schedule/work location yang berlaku;
7. server menghitung jarak geofence;
8. server mengenkripsi foto sebelum persistence;
9. normalized event + evidence disimpan dalam satu transaction;
10. attendance result direcompute sesudah evidence durable.

Backend tidak mengklaim dapat membuktikan asal kamera hanya dari JPEG. "Camera-only" adalah kontrak client yang dapat diuji; anti-spoof/liveness dan face recognition berada di luar ATT-006 ini.

### GPS/geofence

Evidence menyimpan:

- latitude/longitude;
- browser-reported accuracy meter;
- assigned work location bila ada;
- server-computed distance meter;
- status `inside | outside | uncertain_accuracy | unassigned_location`;
- review state `accepted | needs_review`.

Aturan:

- inside radius dan accuracy tidak lebih buruk dari radius => `accepted`;
- outside radius => evidence tetap disimpan, `needs_review`;
- accuracy lebih besar dari radius => `uncertain_accuracy` + `needs_review`;
- schedule tanpa work location => `unassigned_location` + `needs_review`;
- GPS/foto tidak pernah diubah untuk membuat check-in tampak valid.

Outside-geofence tidak dibuang karena evidence tersebut penting untuk tugas lapangan/klarifikasi.

### Foto

- hanya JPEG;
- maksimum 5 MiB server-side;
- disimpan AES-256-GCM menggunakan restricted-media keyring yang sama dengan safety boundary foto attendance device;
- plaintext tidak disimpan;
- API/UI rutin tidak mengembalikan ciphertext/key/IV/tag/hash;
- endpoint foto hanya untuk own evidence atau Human Capital berizin dan setiap read dicatat;
- `Cache-Control: no-store`.

`BIOMETRIC_COLLECTION_ENABLED` tidak mengaktifkan atau mematikan foto ATT-006 karena foto ini bukan biometric-template collection. Restricted-media keyring tetap wajib ready.

### Activation and retention boundary

Repository implementation dapat selesai tanpa otomatis mengaktifkan production mobile capture. `MOBILE_ATTENDANCE_ENABLED=0` adalah default fail-closed. Enablement production membutuhkan keputusan operasional eksplisit termasuk retention/purge period foto. Implementasi ini **tidak mengarang angka retention** dan tidak menambahkan auto-purge sebelum kebijakan tersebut disetujui.

## ATT-007 — Attendance engine

### Work-date resolver

Engine memakai published roster override terlebih dahulu, lalu default assignment. Shift overnight tetap memiliki work date tanggal mulai.

Evidence association window diturunkan dari schedule:

- mulai: scheduled start minus 6 jam;
- selesai: scheduled end plus 6 jam.

Buffer 6 jam adalah technical association boundary agar early/late device delivery tidak terpotong; buffer bukan grace HR. Bila domain kemudian membutuhkan multi-shift per employee per hari, boundary ini harus diganti kontrak yang lebih granular sebelum aktivasi.

### Multi-punch sessions

Event diurutkan berdasarkan `occurred_at`, lalu ID.

Untuk evidence punch yang tidak memiliki semantic check-in/out:

```text
1 -> 2 = session 1
3 -> 4 = session 2
...
```

Event mobile `check_in` / `check_out` tetap mempertahankan semantic kind. Engine membentuk session secara deterministik dan menyimpan session di bawah result version.

Hasil dapat memuat:

- first check-in;
- last check-out;
- worked minutes dari complete sessions;
- break minutes antar complete sessions;
- late minutes;
- early-leave minutes;
- incomplete-session indicator.

### Status

Read model menggunakan status:

- `scheduled` — jadwal ada dan period belum mulai;
- `pending` — period berjalan tetapi belum cukup evidence;
- `present`;
- `late`;
- `incomplete`;
- `leave`;
- `absent`;
- `off`;
- `configuration_error`.

Approved leave yang mencakup work date menghasilkan `leave` untuk schedule tersebut; tidak adanya scan tidak diubah menjadi absent.

`late_minutes = max(0, first_check_in - scheduled_start - grace)`.

`early_leave_minutes = max(0, scheduled_end - last_check_out - early_leave_tolerance)`.

Attendance engine tidak menghitung payroll deduction. Overtime payment/approval tetap membutuhkan policy terpisah; worked minutes boleh dilaporkan sebagai fakta hasil session.

### Result versioning

Setiap materialization menyimpan result version append-oriented beserta input hash. Bila input hash dan outcome sama dengan versi terkini, tidak dibuat versi duplikat.

Result menyimpan source event IDs, schedule/roster identifiers, clarification IDs, leave reference yang aman, dan computed metrics. Raw evidence tidak diubah.

## ATT-002 — Klarifikasi

Employee dapat mengajukan:

- missing check-in;
- missing check-out;
- machine issue;
- lateness;
- early leave;
- outside geofence;
- other.

Dua jenis keputusan dibedakan:

### Correction

Correction menyatakan fakta waktu kurang/salah. Request dapat membawa proposed check-in/check-out. Approval tidak mengubah raw ADMS/mobile evidence; engine memasukkan approved correction sebagai derived correction event/result input.

### Justification

Justification menerima alasan administratif tanpa memalsukan fakta. Contoh:

```text
Masuk 08:20
Terlambat 10 menit
Justifikasi: approved
```

Jam 08:20 dan late minutes tetap dipertahankan.

Lifecycle:

```text
submitted -> approved | rejected | cancelled
```

Decision memerlukan Human Capital permission dan menghasilkan append-only clarification event. Approval/rejection tidak mengubah Leave approval snapshot.

## Finalization dan report

- Employee read menampilkan current computed snapshot untuk own work date/range.
- Mobile capture, approved clarification, dan explicit finalization dapat materialize result version.
- Human Capital dapat menjalankan finalization satu work date untuk pegawai yang memiliki schedule resolved.
- Report harian dapat memfilter status/unit dan menampilkan summary + rows.
- Finalization tidak menghapus atau mengubah evidence dan aman dijalankan ulang.

## Permissions

Permission baru:

- `attendance.schedule.manage`
- `attendance.policy.manage`
- `attendance.clarification.manage`
- `attendance.reports.read`

`human_capital_admin` mendapat keempatnya. Role `human_capital` hanya mendapat clarification manage + reports read. Existing `attendance.records.manage` tetap mengelola factual manual ATT-001, bukan otomatis semua policy.

Frontend hanya menyembunyikan/menampilkan UI; backend permission tetap authoritative.

## Failure behavior

- employee inactive / account inactive => 403;
- mobile disabled => 409 fail-closed;
- keyring tidak ready => mobile photo mutation gagal sebelum event dibuat;
- geolocation unavailable => client tidak dapat submit mobile mutation;
- outside/uncertain/unassigned location => evidence disimpan tetapi needs review;
- duplicate idempotency key => return existing evidence/result, bukan event kedua;
- ambiguous schedule => configuration_error; jangan memilih schedule diam-diam;
- invalid roster publish => 409, draft tetap tidak authoritative;
- photo decrypt failure => 500 + audit-safe error, tidak membocorkan cryptographic material;
- engine failure setelah ADMS raw commit tidak membatalkan ACK perangkat.

## Privacy / security

- tidak ada data produksi pada fixture/test;
- tidak ada secret/key material pada repo;
- lokasi dan foto adalah restricted attendance evidence;
- employee hanya dapat melihat evidence miliknya;
- Human Capital photo view memerlukan permission dan access audit;
- Foundation Board tidak mendapat akses individual evidence secara default;
- raw GPS/photo tidak dipakai untuk face matching;
- tidak ada background location tracking; lokasi hanya ditangkap saat explicit clock action.

## Verification minimum

CI harus membuktikan:

1. clean migration dan migration guards;
2. overnight schedule resolution;
3. published roster overrides draft/default;
4. multi-punch sessions;
5. grace/late/early-leave metrics;
6. approved leave prevents false absence;
7. correction vs justification semantics;
8. mobile geofence inside/outside/uncertain cases;
9. photo encryption envelope and own/admin authorization boundary;
10. idempotent mobile mutation;
11. no raw evidence mutation;
12. permission denial tests;
13. web typecheck/lint/test/build.

CI/synthetic tests bukan production GPS/camera/browser proof. Production activation, real photo retention, and real-device/mobile UAT remain separate operator-approved gates.
