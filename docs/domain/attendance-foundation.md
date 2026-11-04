# ATT-001 — Kehadiran Harian

**Status:** VERIFIED MVP BASELINE  
**Verification:** final isolated synthetic mutation UAT passed on 2026-08-22

## Tujuan

Menyediakan fondasi kehadiran yang dapat dipakai sekarang tanpa menunggu integrasi mesin fingerprint, tetapi tetap aman untuk dikembangkan menjadi integrasi otomatis di milestone berikutnya.

Milestone ini sengaja hanya mencatat fakta kehadiran harian. Sistem belum menyimpulkan keterlambatan, pulang cepat, mangkir, lembur, kekurangan jam kerja, atau potongan payroll karena aturan jadwal kerja dan toleransinya belum ditetapkan sebagai kebijakan sistem.

## Prinsip domain

1. Rekaman kehadiran adalah fakta waktu, bukan keputusan disiplin atau payroll.
2. Satu pegawai memiliki paling banyak satu rekaman kanonik untuk satu tanggal kerja.
3. Rekaman dapat memiliki jam masuk saja, jam keluar saja, atau keduanya.
4. Jika kedua waktu tersedia, jam keluar tidak boleh lebih awal dari jam masuk.
5. `attendance_date` adalah tanggal kerja yang menjadi bucket rekaman. Timestamp dapat melewati tengah malam agar model tidak mengunci sistem pada pola kerja siang saja.
6. Semua timestamp disimpan sebagai `timestamptz`; antarmuka menampilkan dan memasukkan waktu operasional dengan zona `Asia/Jakarta`.
7. Tidak adanya rekaman tidak otomatis berarti pegawai tidak hadir. Kesimpulan absensi memerlukan jadwal kerja dan proses resolusi kehadiran.
8. Koreksi manual selalu diaudit dengan before/after snapshot. Audit tidak menyimpan kredensial atau data rahasia.
9. Catatan koreksi manual adalah catatan administrasi internal. Catatan dan `source_reference` tidak dikirim pada endpoint employee self-service.
10. Milestone ini tidak menghapus atau menggantikan `attendance_resolution_cases`. Modul resolusi tetap merupakan alur downstream untuk ketidakhadiran yang benar-benar telah ditetapkan perlu penyelesaian.
11. Provenance sumber tidak boleh hilang karena koreksi manual. Rekaman `integration` tidak dapat diubah menjadi `manual` atau dihapus melalui endpoint koreksi manual ATT-001.

## Sumber rekaman

`attendance_daily_records.source` pada milestone ini mendukung:

- `manual` — dimasukkan atau dikoreksi oleh Super Admin melalui HCIS.
- `integration` — disediakan sebagai kontrak schema untuk integrasi sumber otomatis berikutnya.

`source` wajib diisi eksplisit oleh setiap writer dan tidak memiliki default database. Endpoint tulis pada ATT-001 selalu menulis sumber `manual`. Belum ada public/service ingestion endpoint untuk `integration`.

Jika pada milestone berikutnya integrasi otomatis sudah aktif, koreksi terhadap rekaman `integration` harus mengikuti kontrak integrasi/audit tersendiri. Endpoint PUT/DELETE manual ATT-001 menolak mutation atas rekaman `integration` agar sumber asli tidak tertimpa diam-diam.

## Model data

### attendance_daily_records

Kunci primer: `(employee_id, attendance_date)`.

Field utama:

- `employee_id`
- `attendance_date`
- `check_in_at`
- `check_out_at`
- `source`
- `source_reference`
- `note`
- `created_by_account_id`
- `updated_by_account_id`
- `created_at`
- `updated_at`

Rekaman wajib memiliki minimal salah satu dari `check_in_at` atau `check_out_at`.

### attendance_daily_audit_events (DIHAPUS)

> **Dihapus 2026-11-04** oleh migration `0140_drop_attendance_daily_audit_events.sql` (legacy cleanup tahap 1). Tabel ini tidak pernah terisi di production (0 baris) dan tidak dipakai kode API; perubahan manual kini tercatat sebagai event presensi canonical dan klarifikasi. Uraian di bawah adalah catatan historis.

Riwayat immutable untuk setiap operasi manual:

- `created`
- `updated`
- `deleted`

Audit menyimpan employee id, tanggal kerja, actor account id, snapshot `before_record`, snapshot `after_record`, dan waktu kejadian.

Mutation manual untuk pasangan `(employee_id, attendance_date)` diserialisasi selama transaksi agar create/update audit tidak salah klasifikasi saat dua request datang bersamaan.

## Akses

### Employee

Employee aktif dapat membaca rekaman miliknya sendiri melalui:

- `GET /attendance/me`

Query:

- `from=YYYY-MM-DD`
- `to=YYYY-MM-DD`

Rentang maksimum 62 hari. Default adalah 30 hari terakhir sampai hari ini.

Response tidak menyertakan rekaman pegawai lain. `note` administrasi dan `source_reference` tidak menjadi field response employee, bukan sekadar dikosongkan.

### Super Admin

Super Admin dapat:

- membaca rekaman per pegawai;
- membuat atau mengoreksi satu rekaman manual tanggal kerja;
- menghapus rekaman manual jika memang salah input.

Endpoint:

- `GET /admin/attendance/employees/:employeeId`
- `PUT /admin/attendance/employees/:employeeId/:attendanceDate`
- `DELETE /admin/attendance/employees/:employeeId/:attendanceDate`

Penghapusan hanya menghapus rekaman manual kanonik. Audit historis tetap dipertahankan. Rekaman `integration` bersifat read-only pada surface admin ATT-001.

## Validasi tulis

Body PUT:

```json
{
  "checkInAt": "2026-08-21T07:02:00+07:00",
  "checkOutAt": "2026-08-21T16:11:00+07:00",
  "note": "Koreksi berdasarkan catatan operasional"
}
```

Ketentuan:

- timestamp harus ISO-8601 dengan offset/zona yang dapat diparse;
- input waktu pada UI Super Admin selalu ditafsirkan sebagai `Asia/Jakarta`, bukan zona lokal perangkat Admin;
- salah satu timestamp wajib ada;
- jika dua timestamp ada, `checkOutAt >= checkInAt`;
- catatan maksimum 1000 karakter dan diperlakukan sebagai catatan internal;
- employee harus ditemukan;
- perubahan manual tidak pernah mengubah status employee, leave request, atau payroll;
- mutation manual terhadap rekaman `integration` ditolak.

## UX Employee

Menu **Kehadiran** membuka `/app/attendance`.

Halaman menampilkan:

- rekaman hari ini bila ada;
- jam masuk dan jam keluar dalam waktu Jakarta;
- riwayat rekaman terbaru;
- pesan eksplisit bila belum ada rekaman;
- penjelasan bahwa belum ada kesimpulan telat/absen karena jadwal kerja belum dihubungkan.

Tidak ada tombol check-in mandiri pada milestone ini. Catatan internal Admin tidak ditampilkan.

## UX Super Admin

Menu **Kehadiran** membuka `/admin/attendance`.

Super Admin dapat:

1. memilih pegawai aktif;
2. memilih tanggal kerja;
3. mengisi jam masuk/jam keluar;
4. menambahkan catatan internal opsional;
5. menyimpan koreksi manual;
6. melihat rekaman terbaru pegawai tersebut;
7. menghapus rekaman manual yang salah dengan konfirmasi browser.

Input waktu menggunakan label waktu Jakarta dan dikonversi secara eksplisit sebagai `+07:00` sebelum dikirim ke backend, sehingga tidak bergantung pada timezone browser Admin.

Saat pegawai pilihan berubah, form tidak boleh mempertahankan jam/catatan dari pegawai sebelumnya. Response request lama juga tidak boleh menimpa state pegawai yang baru dipilih. Rekaman integrasi ditampilkan read-only tanpa aksi koreksi/hapus manual.

## Verification

Final isolated synthetic browser UAT verified the full manual mutation lifecycle:

1. employee attendance starts empty;
2. Super Admin creates one manual record;
3. employee self-view shows factual check-in/check-out without internal note/source reference;
4. Super Admin updates the record;
5. employee sees the updated factual record;
6. Super Admin deletes the manual record;
7. employee returns to an honest empty state;
8. audit events and Asia/Jakarta handling remain intact.

The test environment used synthetic employees/accounts only and did not touch VPS employee data.

## Batas eksplisit ATT-001

Belum termasuk:

- sinkronisasi mesin fingerprint;
- integrasi RuangHadir atau provider lain;
- shift/jadwal kerja;
- toleransi keterlambatan;
- status telat/pulang cepat/absen;
- perhitungan jam kerja atau lembur;
- auto-create attendance resolution dari missing punch;
- pengaruh ke payroll;
- employee self check-in berbasis GPS/foto.

Semua hal di atas membutuhkan policy/kontrak tersendiri agar HCIS tidak membuat keputusan HR dari asumsi teknis.

## Acceptance criteria

1. Migration dapat dijalankan ulang tanpa merusak schema yang sudah ada.
2. Employee hanya dapat membaca kehadirannya sendiri dan response tidak memiliki field catatan internal Admin/source reference.
3. Super Admin dapat create/update/delete rekaman manual harian dan setiap perubahan mempunyai audit immutable.
4. Invalid date range, invalid timestamp, atau checkout sebelum check-in ditolak backend.
5. Employee page tidak menyimpulkan telat/absen dari tidak adanya data.
6. UI tetap jujur saat data kosong.
7. Input waktu manual konsisten sebagai Asia/Jakarta walau browser Admin berada di timezone lain.
8. Tidak ada data sintetis yang otomatis ditulis saat deploy.
9. Tidak ada perubahan pada data employee/leave existing saat migration.
10. `source` selalu eksplisit; mutation manual tidak dapat menimpa atau menghapus provenance rekaman integrasi.
11. Pergantian pegawai pada UI admin tidak dapat membawa state atau response kehadiran pegawai sebelumnya ke target baru.
