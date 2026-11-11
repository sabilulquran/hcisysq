# Pengingat Terjadwal (NOTIF-003) dan Adapter Notifikasi (NOTIF-001)

**Status:** ACCEPTED (Paket 1) — spesifikasi ini menjawab lima pertanyaan `announcements-and-reminders.md` §8 dan mengizinkan implementasi. Aturan bisnis yang belum tertulis memakai default paling masuk akal dan ditandai `DRAFT`.
**Spesifikasi:** NOTIF-003, NOTIF-001
**Tanggal:** 2026-11-11
**Terkait:** NOTIF-004, CAL-001, EMP-005, EMP-007, PERF-001, PAY-003, DOC-001, LEAVE-001, TRIP-001, LOAN-001, ATT-015, APR-001; SQ Hub KIRIM-001 (Kirim SQ)

## 1. Tujuan

Pengingat berbeda dari notifikasi transaksi: sumbernya **keadaan data** pada suatu waktu (kontrak akan berakhir, penilaian belum diisi, persetujuan menggantung), bukan peristiwa. Legacy punya `reminders:generate-*` dan `reminders:dispatch` dengan preferensi per pegawai. HCIS sudah punya satu aturan (pengingat rapat CAL-001) dengan penjalan sendiri.

Paket 1 menyediakan **satu mesin pengingat** dengan katalog aturan, idempoten, menghormati jam kirim 06.00–21.00 WIB, mengirim in-app dan WhatsApp (Kirim SQ), dengan preferensi WhatsApp per penerima per aturan.

## 2. Inventaris pengingat yang sudah dijanjikan

| Janji | Sumber | Paket 1 |
| --- | --- | --- |
| Rapat mulai 30 menit lagi | CAL-001 K-15 | **Sudah berjalan** di penjalan CAL-001 (`meetings/runner.ts`); tidak dipindah (D-02). |
| Kontrak / masa percobaan / magang akan berakhir | EMP-005 D-11 (jendela 60 hari) | Aturan `employment.term_ending` |
| Sertifikat pegawai akan berakhir | EMP-007 §7.5 | Aturan `employee.certificate_expiring` |
| Persetujuan menunggu (cuti, dinas, pinjaman, tugas luar/WFH/ubah jadwal) | APR-001, NOTIF-003 legacy "leave pending" | Aturan `approval.pending_digest` |
| Validasi cuti HC menunggu | LEAVE-001 HC task | Aturan `leave.hc_queue_digest` |
| Permintaan surat keterangan menunggu | DOC-001, `announcements-and-reminders.md` §8 | Aturan `documents.request_queue_digest` |
| Penilaian diri dan penilaian atasan jatuh tempo | PERF-001 (`self_due_on`, `review_due_on`) | Aturan `performance.self_due`, `performance.review_due` |
| Tenggat input payroll dan tanggal bayar | PAY-003 (`cutoff_end`, `pay_date`) | Aturan `payroll.cutoff_due`, `payroll.pay_date_due` |
| Surat peringatan akan habis masa berlaku | `announcements-and-reminders.md` §8 | **Tidak** (D-09): berakhirnya SP tidak meminta tindakan siapa pun. |
| Pengingat absen masuk harian 06.30 | Legacy `reminders:generate-attendance` | **Tidak** (D-09): jadwal pegawai beragam; pesan harian ke semua pegawai adalah kebisingan. Perlu keputusan owner. |
| Penerbitan otomatis pengumuman terjadwal | NOTIF-002 N-07 | **Tidak**: N-07 tetap mensyaratkan tindakan operator. |
| RTL pelatihan, tenggat tugas pelatihan | TRAIN-001 D-15 | Belum ada data tenggat di Paket 1 pelatihan; aturan ditambahkan bersama fiturnya. |
| Reimbursement menunggu | Legacy | REIMB-001 belum dibangun. |
| Arsip dokumen pegawai (KTP, ijazah) kedaluwarsa | Legacy | EMP-011 belum dibangun. |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| D-01 | **Penjalan di dalam proses API**, interval 60 detik, sama dengan CAL-001 §9.3, diaktifkan oleh saklar yang sama `MEETING_RUNNER_ENABLED` (mati di kandidat rilis dan di test). Tidak ada cron/systemd di Mi8VPS. | ACCEPTED (mengikuti CAL-001) |
| D-02 | Pengingat rapat tetap di penjalan CAL-001, karena ia memeriksa ulang keadaan rapat saat menembak dan antrean WhatsApp-nya sudah berjalan. Mesin ini menangani aturan lain. | ACCEPTED |
| D-03 | **Idempotensi**: satu baris `reminder_occurrences` per `(rule_key, occurrence_key, recipient_account_id)`, unik di basis data. Notifikasi in-app memakai `event_key = reminder.<rule>.<occurrence>` sehingga keunikan NOTIF-004 menjadi penjaga kedua. Dua penjalan bersamaan atau penjalan yang diulang tidak menggandakan apa pun. | ACCEPTED |
| D-04 | **Jam kirim 06.00–21.00 WIB** untuk pembuatan pengingat dan penyerahan WhatsApp, sama dengan jam kirim `notifikasi` Kirim SQ. Di luar jam itu penjalan tidak membuat pengingat dan tidak menyerahkan pesan. | ACCEPTED (ditetapkan dalam tugas) |
| D-05 | Setiap aturan punya **jam tembak WIB** (bawaan 07.00, payroll 08.00). Aturan dijalankan sekali per hari kalender Jakarta pada atau setelah jam tembaknya, dicatat di `reminder_rule_runs`. Bila server mati pada jam tembak, aturan berjalan begitu server hidup di hari yang sama (sebelum 21.00). | DRAFT |
| D-06 | **Ambang sebagai jendela**: aturan berambang (mis. H-60/H-30/H-7) menembak ambang **terkecil** yang sudah tercapai dan belum pernah ditembakkan untuk objek itu. Hari yang terlewat karena server mati tidak menghilangkan pengingat, dan objek yang baru dicatat dengan sisa 20 hari langsung mendapat pengingat H-30. | DRAFT |
| D-07 | **Kanal**: in-app selalu (kotak masuk adalah catatan kerja); WhatsApp lewat Kirim SQ sesuai bawaan aturan dan preferensi penerima. Teks WhatsApp tidak memuat nama pegawai lain, nominal, atau isi dokumen; rinciannya hanya di in-app. | DRAFT |
| D-08 | **Preferensi**: per akun per aturan, hanya saklar WhatsApp (nyala/mati). Pengingat in-app tidak dapat dimatikan. Tanpa preferensi tersimpan, bawaan aturan berlaku. | DRAFT |
| D-09 | Pengingat SP berakhir dan absen harian tidak dibawa (lihat §2). | DRAFT |
| D-10 | **Email tidak dibangun.** HCIS tidak punya adapter SMTP; email akun dikirim Akun SQ (Keycloak). NOTIF-001 ditutup dengan dua adapter: in-app (NOTIF-004) dan WhatsApp (Kirim SQ, port `meetings/whatsapp.ts`). Email menunggu keputusan owner dan ADR adapter. | DRAFT |
| D-11 | Pembatas penerima WhatsApp CAL-001 K-17 berlaku: selama `WHATSAPP_RECIPIENT_MODE=allowlist`, WhatsApp sungguhan hanya ke NIP di `WHATSAPP_ALLOWLIST`; lainnya `SKIPPED not_allowlisted`. Adapter `log` tidak mengirim apa pun. | ACCEPTED |
| D-12 | Pesan WhatsApp pengingat kedaluwarsa pukul **21.00 WIB** hari pembuatannya; yang belum terserahkan saat itu berstatus `SKIPPED expired`. In-app tetap ada. | DRAFT |
| D-13 | Penerima pengingat HC adalah akun aktif yang memegang izin terkait pada scope organisasi (penugasan langsung atau peran yang mengikuti jabatan, AUTH-015), dihitung saat aturan berjalan. | ACCEPTED |
| D-14 | Hanya akun pegawai **aktif** yang menerima pengingat; pegawai yang belum diaktifkan tidak menerima apa pun (HCIS belum dibuka untuk staf). | ACCEPTED |

## 4. Katalog aturan (Paket 1)

| `rule_key` | Penerima | Kapan (WIB) | Kunci kejadian | WA bawaan | Tautan |
| --- | --- | --- | --- | --- | --- |
| `approval.pending_digest` | Approver dengan langkah `pending` di cuti, dinas, pinjaman, atau tugas luar/WFH/ubah jadwal | Senin–Sabtu 07.00, bila ada | tanggal | Nyala | `/app/approvals` |
| `leave.hc_queue_digest` | Pemegang `leave.validate` | Senin–Sabtu 07.00, bila ada tugas HC cuti `pending` | tanggal | Nyala | `/app/hc/leave` |
| `documents.request_queue_digest` | Pemegang `documents.manage` | Senin–Sabtu 07.00, bila ada permintaan `SUBMITTED` ≥ 2 hari | tanggal | Nyala | `/admin/documents` |
| `employment.term_ending` | Pemegang `employment.manage` | Harian 07.00; ambang H-60, H-30, H-7 dari akhir masa kontrak/percobaan/magang/lepas yang sedang berjalan | term + ambang | Mati | `/admin/employees/<id>` |
| `employee.certificate_expiring` | Pegawai pemilik sertifikat | Harian 07.00; ambang H-30, H-7 | sertifikat + tanggal berakhir + ambang | Nyala | `/app/my-data` |
| `performance.self_due` | Pegawai yang penilaian dirinya belum dikirim di siklus `OPEN` | Harian 07.00; ambang H-3, H-0 dari `self_due_on` | review + ambang | Nyala | `/app/performance` |
| `performance.review_due` | Penilai (atasan) dengan penilaian `MANAGER_REVIEW` | Harian 07.00; ambang H-3, H-0 dari `review_due_on` | siklus + penilai + ambang | Nyala | `/app/performance` |
| `payroll.cutoff_due` | Pemegang `payroll.inputs.manage` | Harian 08.00; ambang H-3, H-0 dari `cutoff_end` selama periode `DRAFT`/`COLLECTING` | periode + ambang | Nyala | `/admin/payroll/<id>` |
| `payroll.pay_date_due` | Pemegang `payroll.submit` dan `payroll.approve` | Harian 08.00; ambang H-3, H-1 dari `pay_date` selama periode belum `APPROVED` | periode + ambang | Nyala | `/admin/payroll/<id>` |

Ambang dan jam di atas adalah `DRAFT`. Aturan yang lewat jatuh tempo (sisa hari negatif) tidak menembak lagi; worklist HC (mis. "Sertifikat akan berakhir") tetap menampilkan yang terlambat. Ringkasan (`*_digest`) dihitung saat berjalan dan memuat jumlah, bukan daftar nama.

## 5. Alur penjalan

1. Setiap 60 detik, bila jam Jakarta di dalam 06.00–21.00 (D-04): untuk setiap aturan yang jam tembaknya sudah lewat hari ini, sisipkan `reminder_rule_runs (rule_key, run_date)`; bila baris sudah ada, aturan dilewati (sudah berjalan atau sedang dijalankan penjalan lain).
2. Aturan menghasilkan kandidat `(occurrence_key, penerima, judul, isi, tautan, teks WA)`. Untuk tiap kandidat, sisipkan `reminder_occurrences` dengan `ON CONFLICT DO NOTHING`; hanya baris yang benar-benar baru yang menulis notifikasi in-app dan, bila WhatsApp aktif bagi penerima itu (D-08) dan ia pegawai, satu `reminder_deliveries` berstatus `QUEUED`. Semuanya dalam satu transaksi per aturan.
3. Hasil aturan (`generated`, `finished_at`, atau `error_code` tanpa isi pesan) dicatat di `reminder_rule_runs`. Aturan yang gagal tidak menghentikan aturan lain dan **tidak diulang** di hari yang sama (D-05); kegagalan tampil di log dan baris run.
4. Penyerahan WhatsApp: baris `QUEUED` yang jatuh tempo diklaim dengan `FOR UPDATE SKIP LOCKED` dan lease 5 menit, diserahkan ke Kirim SQ di luar transaksi dengan `idempotency-key` tetap, lalu dicatat `HANDED_OVER`/`DRY_RUN`/`SKIPPED`/`FAILED`. Gagal sementara diulang dengan jeda CAL-001 (`retryDelayMs`). Nomor diambil dari `employees.phone` saat penyerahan; tanpa nomor `SKIPPED no_phone`.

## 6. Preferensi

| Unsur | Isi |
| --- | --- |
| Aktor | Pegawai aktif dengan akun aktif, untuk dirinya sendiri. |
| Layar | **Notifikasi → Pengaturan pengingat** (`/app/notifications`): daftar aturan dengan saklar "Kirim juga lewat WhatsApp". |
| API | `GET /me/reminders/preferences` (katalog aturan + nilai efektif), `PUT /me/reminders/preferences/:ruleKey` `{ whatsapp: boolean }`. |
| Izin | Kepemilikan; tanpa permission. Aturan yang tidak relevan bagi akun tetap tampil (tidak membocorkan peran). |
| Audit | `reminder.preference.changed` (akun, aturan, nilai lama/baru) di `reminder_audit_events`. |
| Gagal | Aturan tidak dikenal → `404 REMINDER_RULE_NOT_FOUND`; badan tidak valid → `400 INVALID_REMINDER_PREFERENCE`; akun bukan pegawai aktif → `403 EMPLOYEE_LINK_REQUIRED`. |

## 7. Penyimpanan

```text
reminder_rule_runs       (rule_key, run_date) PK, started_at, finished_at, generated, error_code
reminder_occurrences     id, rule_key, occurrence_key, recipient_account_id, recipient_employee_id, title, href,
                         created_at; UNIQUE (rule_key, occurrence_key, recipient_account_id)
reminder_deliveries      id, occurrence_id UNIQUE, employee_id, message_text, status, attempts, next_attempt_at,
                         expires_at, idempotency_key UNIQUE, kirim_message_id, error_code
reminder_preferences     (account_id, rule_key) PK, whatsapp_enabled, updated_at
reminder_audit_events    id, event_type, account_id, rule_key, metadata, occurred_at
```

Isi in-app ada di `in_app_notifications` (NOTIF-004). Migrasi 0142 melonggarkan `href` notifikasi agar boleh juga menunjuk `/admin/...` (pengingat HC membuka worklist admin); halaman tujuan tetap memeriksa izinnya sendiri. `message_text` WhatsApp mengikuti D-07. Rollback migrasi: `-- Down:` di berkas migrasi; menghapus tabel tidak menyentuh notifikasi in-app yang sudah terkirim.

## 8. NOTIF-001 — adapter notifikasi (penutupan)

| Kanal | Adapter | Status |
| --- | --- | --- |
| In-app | `notifications/service.ts` (`notifyAccount`, `notifyEmployee`), NOTIF-004 | Berjalan di production |
| WhatsApp | `meetings/whatsapp.ts`: port `WhatsAppSender`, adapter `log` (bawaan, tidak mengirim) dan `kirim` (Kirim SQ di SQ Hub, ADR-0011, token mesin SQ Hub), pembatas penerima K-17 | Dipakai CAL-001 dan NOTIF-003 |
| Email | Tidak ada | Tidak dibangun (D-10) |

Notifikasi transaksi lain (cuti diputuskan, slip terbit, dll.) tetap in-app saja; menambahkan WhatsApp ke peristiwa tertentu adalah keputusan per fitur, bukan bagian adapter.

## 9. Acceptance criteria

- NOTIF-003-A: menjalankan penjalan dua kali (berurutan maupun bersamaan) pada hari yang sama tidak menggandakan pengingat, notifikasi, maupun pesan WhatsApp.
- NOTIF-003-B: di luar 06.00–21.00 WIB penjalan tidak membuat pengingat dan tidak menyerahkan pesan; pesan yang lewat 21.00 menjadi `SKIPPED expired`.
- NOTIF-003-C: ambang memakai jendela (D-06): kontrak dengan sisa 20 hari mendapat pengingat H-30 sekali; besoknya tidak ada pengingat lagi sampai H-7.
- NOTIF-003-D: ringkasan persetujuan memuat jumlah langkah `pending` milik approver itu saja dan tidak terkirim bila nol.
- NOTIF-003-E: penerima pengingat HC adalah pemegang izin terkait; akun tanpa izin tidak menerimanya.
- NOTIF-003-F: preferensi WhatsApp mati mencegah antrean WhatsApp untuk aturan itu, tetapi in-app tetap dibuat; perubahan preferensi diaudit dan hanya untuk akun sendiri.
- NOTIF-003-G: dengan `WHATSAPP_RECIPIENT_MODE=allowlist` dan adapter `kirim`, pegawai di luar allowlist mendapat `SKIPPED not_allowlisted`; adapter `log` menandai `DRY_RUN`.
- NOTIF-003-H: pegawai atau akun nonaktif tidak menerima pengingat.
- NOTIF-003-I: teks WhatsApp ringkasan dan pengingat HC tidak memuat nama pegawai lain.
- NOTIF-001-A: katalog layanan tidak lagi mengiklankan email; WhatsApp dan in-app dinyatakan tersedia.

## 10. Pertanyaan untuk owner (sudah dijawab dengan DRAFT)

1. Ambang dan jam tiap aturan (§4), dan apakah ringkasan juga dikirim hari Minggu.
2. Apakah pengingat absen masuk harian legacy perlu dibawa (D-09).
3. Apakah email diperlukan sama sekali (D-10).
4. Apakah pegawai boleh mematikan pengingat in-app (D-08).
