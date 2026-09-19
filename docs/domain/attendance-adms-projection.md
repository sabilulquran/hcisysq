# ATT-005 Historical Go 2 — ADMS Employee Mapping & Attendance Projection

**Status:** IMPLEMENTED LEGACY SUB-SCOPE OF ATT-005

> Historical note: this document originally used feature ID ATT-003. The canonical capability map now reserves ATT-003 for schedules and shifts. ADMS mapping/projection is an ATT-005 device-plane sub-scope; database filenames and historical PR references are intentionally unchanged.

## Tujuan

Menghubungkan fakta ATTLOG yang sudah durable pada ATT-002 ke employee HCIS dan memproyeksikannya menjadi `attendance_daily_records` native HCIS tanpa menjadikan adapter ADMS sebagai policy engine.

ATT-003 tidak mengubah raw request/event ATT-002. Raw evidence tetap append-only dan menjadi sumber provenance untuk projection.

## Scope Go 2

- mapping eksplisit `(device, PIN) -> employee` dengan effective window;
- projection event ADMS yang sudah mapped ke satu canonical `attendance_daily_records` per employee/business date;
- deterministic neutral-punch rule: punch paling awal menjadi `check_in_at`; bila ada minimal dua punch, punch paling akhir menjadi `check_out_at`;
- `source = 'integration'` dan `source_reference` ber-namespace `adms:`;
- serialization dengan advisory lock yang sama dengan koreksi manual ATT-001;
- append-only projection audit;
- projection failure tidak boleh membatalkan durable ACK ATT-002.

## Non-goals

Go 2 tidak:

- menebak makna field status/verify/workcode ATTLOG;
- menyimpulkan terlambat, tidak hadir, pulang cepat, jam kerja, overtime, payroll deduction, annual-leave conversion, atau attendance-resolution outcome;
- memindahkan atau mengubah raw ATTLOG;
- menyediakan Admin UI atau device-management UI;
- melakukan biometric/template sync atau remote command.

Admin API/UI untuk registry/mapping, observability, dan live cutover berada pada Go 3.

## Mapping

`attendance_adms_employee_mappings` menyimpan mapping eksplisit:

- `device_id`
- `pin` sebagai text; leading zero dipertahankan;
- `employee_id`
- `effective_from`
- `effective_to` nullable
- actor create/end bila tersedia.

Satu `(device_id, pin)` hanya boleh mempunyai satu mapping aktif pada saat yang sama.

Mapping tidak diasumsikan dari `employee_number`. HCIS tidak boleh menganggap PIN mesin identik dengan employee number tanpa mapping eksplisit.

Effective window mencegah mapping baru diam-diam mengklaim raw history sebelum mapping berlaku. Backfill historis pada Go 3 harus menjadi aksi eksplisit dengan effective time yang jelas.

## Business date

Go 2 menggunakan tanggal kalender `Asia/Jakarta` dari `occurred_at` sebagai business-date bucket karena HCIS belum memiliki schedule/shift contract yang dapat menentukan bucket lintas tengah malam.

Ini adalah projection transport yang deterministik, bukan keputusan jadwal kerja. Dukungan shift/overnight berbasis schedule memerlukan policy milestone terpisah.

## Neutral punch projection

Untuk semua raw ADMS events yang:

1. mempunyai mapping efektif ke employee yang sama; dan
2. jatuh pada business date Jakarta yang sama,

projection menghitung:

- 1 punch: `check_in_at = punch`, `check_out_at = NULL`;
- >=2 punch: `check_in_at = earliest`, `check_out_at = latest`.

Intermediate punch tetap berada pada raw `attendance_adms_events`; canonical daily record hanya menyimpan boundary earliest/latest.

Rule ini tidak membaca field status/verify/workcode karena semantics vendor tersebut belum menjadi contract HCIS.

## Conflict behavior

Projection diserialisasi menggunakan key advisory lock `attendance:<employee_id>:<attendance_date>`, sama dengan mutation manual ATT-001.

- bila belum ada daily record: buat `source='integration'`;
- bila ada ADMS integration record: recompute/update earliest/latest dan provenance;
- bila ada `source='manual'`: jangan overwrite; catat `skipped_manual_conflict`;
- bila ada `source='integration'` tetapi `source_reference` bukan namespace `adms:`: jangan overwrite; catat `skipped_foreign_integration`;
- bila hasil projection tidak berubah: tidak perlu menulis ulang daily record.

Manual ATT-001 tetap tidak dapat mengubah atau menghapus record integration.

## Provenance

`source_reference` berbentuk deterministik:

`adms:<first-event-id>:<last-event-id>`

Untuk satu punch, first dan last menggunakan event yang sama.

`attendance_adms_projection_audit_events` menyimpan before/after snapshot, mapping IDs, source event IDs, action, employee, dan attendance date. Audit bersifat append-only.

## Ingress coupling

ATT-002 commit raw request/event/cursor terlebih dahulu. Sesudah raw commit berhasil, ingress dapat memanggil ATT-003 projection.

Projection dijalankan best-effort setelah durable capture. Jika projection gagal, error dicatat pada application log tanpa mengubah success ACK menjadi failure. Ini mencegah retry storm dan duplicate transport side effect; raw event tetap tersedia untuk re-projection.

## Acceptance criteria Go 2

1. Mapping mempertahankan leading-zero PIN dan memiliki effective window.
2. Satu device+PIN tidak dapat memiliki dua mapping aktif.
3. Event tanpa effective mapping tidak menulis `attendance_daily_records`.
4. Satu mapped punch membuat check-in-only integration record.
5. Punch berikutnya pada employee/business date yang sama memperluas boundary menjadi earliest check-in/latest check-out.
6. Intermediate punch tidak hilang dari raw event table.
7. Exact replay ATTLOG tetap tidak menggandakan raw event maupun mengubah canonical result secara tidak perlu.
8. Manual record tidak pernah ditimpa projection ADMS.
9. Integration record provider lain tidak pernah ditimpa projection ADMS.
10. Projection menghasilkan `source='integration'` dan `source_reference` namespace `adms:`.
11. Projection tidak menghasilkan late/absence/overtime/payroll/resolution outcome.
12. Projection failure tidak membatalkan durable ADMS ACK.
13. Migration, typecheck, lint, test, dan build harus lulus pada environment nyata sebelum Go 2 dinyatakan verified.
