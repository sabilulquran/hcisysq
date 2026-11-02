# Kalender dan Undangan Rapat

**Status:** PROPOSED — spesifikasi Paket 1. Implementasi menunggu persetujuan pemilik produk atas keputusan K-01..K-08 (§3). Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Spesifikasi:** CAL-001
**Tanggal:** 2026-11-02
**Terkait:** LEAVE-001, LEAVE-002, TRIP-001, NOTIF-001, NOTIF-003, NOTIF-004, ATT-011, AUTH-011, ENG-LIST-001, WORK-001 (removed)
**Roadmap:** `docs/product/hcis-capability-map.md` §5, `docs/product/feature-parity.yaml` (CAL-001)

## 1. Tujuan

Pegawai dapat mengundang pegawai lain ke rapat atau kegiatan berjam, dan HCIS **menolak undangan yang membuat jadwal seorang peserta bertabrakan**. Setiap pegawai melihat satu kalender pribadi berisi rapatnya, cutinya, perjalanan dinasnya, dan hari libur.

Paket 1 menghasilkan:

- undangan rapat dengan peserta pegawai, judul, waktu mulai dan selesai, lokasi teks bebas, dan keterangan;
- pemblokiran waktu peserta: rapat aktif lain, cuti yang disetujui, dan perjalanan dinas yang disetujui menolak undangan (§6);
- konfirmasi hadir (Hadir / Berhalangan) oleh peserta;
- ubah dan batal oleh penyelenggara;
- notifikasi in-app (NOTIF-004) untuk undangan, perubahan, dan pembatalan;
- kalender bulanan pribadi dan daftar rapat Akan Datang / Lewat.

## 2. Bukti legacy

HCIS lama adalah aplikasi Laravel di repository GitHub **`hcysq/hcis-ysq`** (akun `hcysq`, commit terakhir `30264ba312d8`, 31 Juli 2026). Versi Apps Script yang lebih tua, **`hcysq/GAS-HCIS`** (`6e6cb7e5124b`), tidak punya fitur rapat; ia hanya menyebut "Manage holidays & kalender" di `ROLE_SYSTEM.md`. Kedua repository hanya dibaca untuk kajian ini; tidak ada yang diubah. Ini juga menjawab sebagian keputusan D1 di `docs/migration/legacy-migration-and-freeze-plan.md` (lokasi kode legacy); host dan database legacy tetap belum dikaji.

| Fitur legacy | Bukti (`hcysq/hcis-ysq`) | Perilaku persis |
| --- | --- | --- |
| Undangan agenda | `app/Http/Controllers/AgendaController.php` (`store`, `update`), tabel `agendas` + `agenda_participants` (migrasi `2026_04_19_090000/090001`) | Semua pegawai yang login boleh membuat (route hanya memblokir role `super_admin`). Minimal satu peserta selain penyelenggara; semua peserta harus pegawai aktif. Mulai tidak boleh di masa lalu; selesai harus sesudah mulai. Judul ≤255, lokasi teks ≤255, deskripsi ≤3000. Penyelenggara otomatis peserta `organizer`/`accepted`; peserta lain `attendee`/`pending`. |
| Pemblokiran waktu | `app/Services/Agenda/AgendaConflictService.php::findConflicts` | Bentrok bila ada agenda **tidak dibatalkan** dengan `start_at < akhirBaru` dan `end_at > mulaiBaru` yang diikuti salah satu peserta **atau penyelenggara**. Batas bersentuhan (09:00–10:00 lalu 10:00–11:00) boleh. Saat ubah, agenda itu sendiri dikecualikan. Bentrok = **ditolak**, tidak ada opsi paksa. Baris pegawai dikunci `lockForUpdate` urut id di dalam transaksi supaya dua undangan bersamaan tidak lolos. |
| Pesan bentrok | `AgendaController::formatConflictMessages` | `"<Nama> bentrok dengan "<judul agenda lain>" (HH:MM-HH:MM)."` — judul rapat lain terlihat oleh pembuat undangan walau ia bukan peserta rapat itu. |
| Ubah | `AgendaController::update`, `ensureEditableBy` | Hanya penyelenggara; tidak boleh bila dibatalkan atau sudah dimulai. Peserta baru menerima undangan; peserta lama tidak diberi tahu perubahan waktu. Semua respons di-reset ke `pending`. |
| Batal | `AgendaController::cancel` | Hanya penyelenggara, alasan opsional ≤2000. Semua peserta lain mendapat notifikasi. Agenda batal tidak lagi memblokir waktu. |
| Konfirmasi hadir | kolom `agenda_participants.response` (`pending/accepted/declined`) | Kolom ada, **tetapi tidak ada route atau tombol untuk menjawab**. Peserta yang (secara data) menolak tetap memblokir waktunya. |
| Notifikasi | `app/Notifications/AgendaInvitationNotification.php`, `AgendaCancelledNotification.php` | In-app (kanal `database`). WhatsApp lewat Starsender bila penyelenggara mencentang `notify_whatsapp`, dikirim langsung di request. |
| Pengingat | `app/Services/ReminderService.php::scheduleForAgenda`, `DispatchReminders` | Default 30 menit sebelum mulai, in-app, bisa diatur per pegawai (`reminder_preferences`). **Cacat:** pengingat tidak dihapus saat agenda dibatalkan atau peserta dikeluarkan, sehingga tetap terkirim. |
| Kalender bulanan | `app/Http/Controllers/CalendarController.php` | Grid 6 minggu: agenda, cuti `approved` milik sendiri, hari libur (cuti bersama dibedakan dari nama), tanggal Hijriah dengan offset setelan. **Semua agenda aktif seluruh yayasan ditampilkan ke semua pegawai**, termasuk judulnya (warna ungu, tanpa tautan) — kebocoran informasi. |
| Jadwal Saya | `app/Http/Controllers/ScheduleController.php` | Gabungan shift kerja, agenda sendiri, libur, cuti, dan jadwal menguji rekrutmen. |
| Agenda hari ini | `HomeDataAssembler::getTodayAgenda`, `YayasanDashboardController` | Panel di beranda; dihapus dari beranda pegawai 3 Juli 2026 (`ba888d7`) karena duplikat Kalender, tetap ada di dashboard yayasan. |
| Hari libur | `app/Http/Controllers/Admin/HolidayController.php`, `HolidayPolicy`, `HolidayTarget::matchesEmployee` | Dikelola Kepala HR dan super_admin. Berlaku untuk semua, atau ditargetkan per pegawai, unit, jabatan, atau role. |
| Penugasan kerja | `WorkAssignmentController`, tabel `work_assignments` (`perjalanan_dinas`, `tugas_luar`, `wfh_wfa`, `perubahan_shift`) | **Tidak** dibaca oleh cek bentrok agenda maupun kalender. |
| Kepanitiaan | `CommitteeController`, tabel `committees` | Panitia berumur tanggal dengan anggota dan persetujuan. Bukan fitur kalender dan tidak memblokir waktu; di luar CAL-001. |

Yang **tidak** ada di legacy: ruang rapat sebagai sumber daya yang dipesan, rapat berulang, integrasi Google Calendar atau berkas `.ics`, audit log agenda, dan cek bentrok terhadap cuti atau perjalanan dinas.

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| K-01 | **Semua pegawai aktif dengan akun** boleh membuat undangan, seperti legacy. Tidak ada permission baru untuk membuat. | DRAFT |
| K-02 | Bentrok dengan rapat aktif lain **ditolak** (blokir keras), seperti legacy. Tidak ada tombol "paksa". | DRAFT |
| K-03 | Cuti `approved` dan perjalanan dinas `APPROVED`/`ISSUED` peserta juga **menolak** undangan. Cuti `in_review` dan perjalanan `IN_REVIEW` hanya **peringatan**. Baru, tidak ada di legacy. | DRAFT |
| K-04 | Peserta dapat menjawab **Hadir** atau **Berhalangan** (alasan opsional). Peserta yang Berhalangan **tidak lagi memblokir** waktunya. Baru; legacy hanya punya kolomnya. | DRAFT |
| K-05 | Kalender hanya menampilkan rapat yang pegawai itu ikuti. Rapat orang lain **tidak** ditampilkan, judulnya pun tidak. Pesan bentrok hanya menyebut nama peserta dan jam sibuk, bukan judul rapat lain, kecuali pembuat undangan juga peserta rapat itu. Memperbaiki kebocoran legacy. | DRAFT |
| K-06 | Paket 1 hanya notifikasi **in-app**. WhatsApp menunggu adapter NOTIF-001; pengingat 30 menit sebelum rapat menunggu penjalan NOTIF-003 (Paket 2). | DRAFT |
| K-07 | **Tidak ada pemesanan ruang rapat.** Lokasi teks bebas. Pemesanan sumber daya ikut keputusan WORK-001 yang dihapus pemilik produk 2026-11-02. | DRAFT |
| K-08 | Pengajuan atau persetujuan cuti dan perjalanan dinas **tidak** dicek terhadap rapat. Hak cuti dan tugas dinas lebih kuat dari undangan; bila cuti/dinas disetujui setelah undangan, peserta ditandai "berhalangan (cuti/dinas)" saat dibaca dan penyelenggara melihatnya. | DRAFT |
| K-09 | Durasi rapat 15 menit sampai 7 hari. Mulai paling cepat sekarang (WIB). Lokasi ≤255, judul 3–200, keterangan ≤3000, peserta 1–200 selain penyelenggara. | DRAFT |
| K-10 | Rapat pada hari libur atau akhir pekan di kalender kerja (`leave_calendar_*`) hanya **peringatan**, karena kegiatan pesantren sering berjalan di hari libur. | DRAFT |
| K-11 | Ubah hanya oleh penyelenggara, hanya sebelum rapat dimulai, dan tidak untuk rapat batal (sama dengan legacy). Perubahan waktu mengembalikan jawaban semua peserta ke `PENDING` dan memberi tahu semua peserta; perubahan judul/lokasi/keterangan saja tidak mengubah jawaban. | DRAFT |
| K-12 | Batal hanya oleh penyelenggara, sebelum rapat selesai, alasan wajib 5–500 karakter. | DRAFT |
| K-13 | Pegawai tanpa akun aktif (HCIS belum live ke staf) **boleh** diundang: waktunya tetap terblokir, tetapi ia tidak menerima notifikasi. Layar memberi tanda "belum punya akun". | DRAFT |

## 4. Batas

| Di luar Paket 1 | Alasan / pemilik |
| --- | --- |
| WhatsApp dan email undangan | NOTIF-001 (adapter eksternal belum ada). |
| Pengingat sebelum rapat | NOTIF-003 (penjalan terjadwal belum diputuskan). Paket 2 CAL-001 menambah aturan `meeting.upcoming` dan wajib menghapus pengingat untuk rapat batal dan peserta yang dikeluarkan. |
| Ruang rapat, proyektor, kendaraan | K-07; WORK-001 removed. |
| Rapat berulang (mingguan) | Paket 2 bila diminta; legacy tidak punya. |
| Google Calendar / `.ics` | Tidak ada di legacy; butuh keputusan terpisah. |
| Undangan untuk orang luar (wali, tamu) | Peserta hanya Employee. |
| Hari libur bertarget per unit/jabatan/role | Legacy punya; HCIS baru hanya kalender kerja tingkat organisasi (`leave_calendar_exceptions`). Itu gap LEAVE-002/ATT, bukan CAL-001. |
| Cek terhadap shift/roster kerja peserta | ATT-011 punya roster, tetapi rapat di luar jam kerja sah. Tidak dicek. |
| Kehadiran rapat (absen rapat, notulen) | Bukan HR inti; tidak diminta. |
| Kepanitiaan | Fitur legacy terpisah; perlu ID sendiri bila dibawa. |
| Register admin seluruh rapat | Paket 2 bila dibutuhkan untuk menangani penyalahgunaan; akan butuh permission `meetings.read`/`meetings.manage`. |

## 5. Actor

| Actor | Boleh |
| --- | --- |
| Penyelenggara (pegawai aktif dengan akun) | Membuat, mengubah, membatalkan rapatnya; melihat jawaban peserta. |
| Peserta | Melihat rapat yang ia ikuti; menjawab Hadir/Berhalangan; mengubah jawabannya sampai rapat dimulai. |
| Pegawai lain | Tidak melihat apa pun tentang rapat yang tidak ia ikuti, selain "sibuk HH:MM–HH:MM" pada pesan bentrok (K-05). |

Akses adalah kepemilikan dari sesi (penyelenggara atau baris peserta), bukan permission. Akun tanpa Employee aktif mendapat 403 `EMPLOYEE_NOT_ACTIVE`. `SUPER_ADMIN` tidak memakai layar ini (sama dengan legacy).

## 6. Aturan ketersediaan (domain)

Aturan ini adalah fungsi murni di `packages/domain` (atau modul domain API) yang menerima interval dan sumber kesibukan, bukan logika frontend.

Interval rapat adalah setengah terbuka `[startAt, endAt)` dalam `timestamptz`; zona tampilan Asia/Jakarta. Dua interval bentrok bila `a.start < b.end && b.start < a.end`. Bersentuhan bukan bentrok.

Untuk setiap orang dalam `{penyelenggara} ∪ peserta`:

| Sumber | Kondisi | Hasil |
| --- | --- | --- |
| Rapat lain | status `ACTIVE`, orang itu penyelenggara atau peserta dengan jawaban `PENDING`/`ACCEPTED`, interval beririsan, bukan rapat yang sedang diubah | **BLOCK** `MEETING_OVERLAP` |
| Cuti | `leave_requests.status = 'approved'`, `[start_on, end_on]` (tanggal penuh WIB, inklusif) beririsan | **BLOCK** `ON_LEAVE` |
| Cuti | `status = 'in_review'`, beririsan | WARN `LEAVE_PENDING` |
| Perjalanan dinas | `business_trip_requests.status IN ('APPROVED','ISSUED')`, `[start_on, end_on]` beririsan | **BLOCK** `ON_TRIP` |
| Perjalanan dinas | `status = 'IN_REVIEW'`, beririsan | WARN `TRIP_PENDING` |
| Kalender kerja | hari mana pun dalam interval adalah libur/non-kerja menurut `leave_calendar_*` | WARN `NON_WORKING_DAY` |

Tanggal penuh dikonversi ke interval `[tanggal 00:00 WIB, tanggal+1 00:00 WIB)`.

Rincian yang dikembalikan ke pembuat undangan hanya: id dan nama pegawai, kode alasan, dan jam/tanggal sibuk. **Tidak** ada judul rapat lain (kecuali pembuat juga peserta rapat itu), jenis cuti, alasan cuti, atau tujuan dinas.

Kontrak baca TRIP-001 dan LEAVE dikoordinasikan dengan sesi TRIP-001 pada 2026-11-02: CAL-001 hanya membaca `employee_id`, `start_on`, `end_on`, `status`; tidak ada hook dan tidak ada penulisan ke tabel cuti atau perjalanan.

### 6.1 Konkurensi

Pembuatan dan perubahan yang memengaruhi waktu atau peserta berjalan dalam satu transaksi:

1. kunci baris `employees` semua orang yang terlibat dengan `FOR UPDATE`, urut `id` naik (mencegah deadlock);
2. hitung ketersediaan (§6);
3. tulis rapat dan peserta.

Sebagai jaring pengaman, `meeting_participants` menyimpan salinan `busy tstzrange` dan memakai `EXCLUDE USING gist (employee_id WITH =, busy WITH &&) WHERE (blocks_time)`, dengan `btree_gist` yang sudah dipakai migrasi `0021` dan `0110`. Pelanggaran constraint (`23P01`) dipetakan ke 409 `MEETING_CONFLICT`. Cuti dan perjalanan tidak dijaga constraint ini (beda tabel); keduanya dijaga oleh langkah 1–2.

## 7. Alur dan state

### 7.1 Membuat

Input: `title`, `description?`, `location?`, `startAt`, `endAt`, `participantEmployeeIds[]`, header `Idempotency-Key`.

Validasi: K-09; peserta unik, bukan penyelenggara, semua Employee aktif; ketersediaan §6 tanpa BLOCK. Hasil: rapat `ACTIVE`, penyelenggara `ORGANIZER`/`ACCEPTED`, peserta `ATTENDEE`/`PENDING`. Notifikasi undangan ke peserta yang punya akun.

Layar memanggil cek ketersediaan (§11) saat waktu atau peserta berubah, supaya bentrok terlihat sebelum Kirim. Hasil cek itu hanya pratinjau; pemeriksaan yang mengikat dijalankan lagi saat simpan.

### 7.2 State rapat

```text
ACTIVE -> CANCELLED   (penyelenggara, alasan, sebelum endAt)
ACTIVE                (setelah endAt tampil di tab "Lewat"; tidak ada state SELESAI tersimpan)
CANCELLED -> terminal
```

### 7.3 Jawaban peserta

```text
PENDING  -> ACCEPTED | DECLINED   (peserta, sebelum startAt)
ACCEPTED <-> DECLINED             (peserta, sebelum startAt)
* -> PENDING                      (penyelenggara mengubah waktu, K-11)
```

`DECLINED` membebaskan waktu peserta (`blocks_time = false`). Kembali ke `ACCEPTED` menjalankan ulang cek §6 untuk orang itu; bila waktunya sudah dipakai rapat lain, jawaban ditolak 409 `MEETING_CONFLICT`.

### 7.4 Mengubah

Hanya penyelenggara, rapat `ACTIVE`, sekarang < `startAt`, dengan `expectedVersion` (optimistic concurrency, 409 `MEETING_VERSION_CONFLICT`). Peserta yang ditambahkan mendapat undangan; peserta yang dikeluarkan mendapat pemberitahuan "dikeluarkan"; bila waktu berubah, semua peserta tersisa diberi tahu dan jawabannya kembali `PENDING`.

### 7.5 Berhalangan karena cuti/dinas belakangan (K-08)

Saat dibaca, peserta yang punya cuti `approved` atau perjalanan `APPROVED`/`ISSUED` yang beririsan ditandai `unavailableReason = LEAVE | TRIP`. Tidak ada penulisan otomatis ke jawaban dan tidak ada notifikasi di Paket 1.

### 7.6 Kegagalan

400 `INVALID_MEETING`; 403 `EMPLOYEE_NOT_ACTIVE`, `MEETING_NOT_ORGANIZER`; 404 `MEETING_NOT_FOUND` (juga untuk rapat yang tidak boleh dilihat, supaya keberadaannya tidak bocor); 409 `MEETING_CONFLICT` (dengan daftar §6), `MEETING_START_IN_PAST`, `MEETING_ALREADY_STARTED`, `MEETING_CANCELLED`, `MEETING_VERSION_CONFLICT`, `PARTICIPANT_NOT_ACTIVE`.

## 8. Audit dan riwayat

Tabel `meeting_events` adalah riwayat per rapat sekaligus audit event:

`meeting.created`, `meeting.updated` (metadata: field yang berubah, waktu lama/baru), `meeting.participant.added`, `meeting.participant.removed`, `meeting.participant.responded`, `meeting.cancelled`.

Setiap event memuat aktor, waktu, dan metadata aman. Isi keterangan rapat tidak disalin ke metadata event. Legacy tidak punya audit agenda.

## 9. Notifikasi (NOTIF-004, kategori `system`)

- undangan baru / ditambahkan → peserta itu;
- waktu berubah → semua peserta tersisa;
- dikeluarkan → peserta itu;
- dibatalkan → semua peserta selain penyelenggara;
- peserta menjawab Berhalangan → penyelenggara.

Ditulis dalam transaksi yang sama dengan perubahannya, idempoten per `eventKey`. Peserta tanpa akun dilewati (K-13).

## 10. Penyimpanan

```text
meetings              id, organizer_employee_id, title, description, location,
                      start_at, end_at, status, cancel_reason, cancelled_at,
                      version, idempotency_key, created_by_account_id, timestamps
meeting_participants  meeting_id, employee_id, role, response, response_note,
                      responded_at, busy tstzrange, blocks_time boolean
meeting_events        riwayat dan audit
```

Aturan:

- `CHECK (end_at > start_at)`, `CHECK (end_at - start_at <= interval '7 days')`;
- `meetings` unik pada `(organizer_employee_id, idempotency_key)`;
- `meeting_participants` unik pada `(meeting_id, employee_id)`; tepat satu `ORGANIZER` per rapat (indeks unik parsial);
- `blocks_time = (meeting ACTIVE AND response <> 'DECLINED')`, dipelihara oleh kode dalam transaksi yang sama; `busy = tstzrange(start_at, end_at, '[)')`;
- exclusion constraint §6.1;
- indeks `(employee_id, busy)` untuk kalender pribadi;
- tidak ada endpoint hapus.

Rollback migrasi ditulis sebagai komentar `-- Down:` (drop tiga tabel; tidak ada data lain yang tersentuh). Migrasi tidak menambah permission ke role yang sudah ada, jadi tidak memaksa rilis berdiri sendiri.

## 11. API (kontrak ringkas; OpenAPI ditulis bersama implementasi)

| Method | Path | Catatan |
| --- | --- | --- |
| GET | `/me/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` | Rentang maks 42 hari. Item: rapat yang diikuti, cuti sendiri (`approved`, `in_review`), perjalanan sendiri (`APPROVED`, `ISSUED`, `IN_REVIEW`), libur/non-kerja. Data dibatasi rentang tanggal, bukan daftar bertumbuh; bila lebih dari 500 item, 400 `RANGE_TOO_DENSE` — tidak dipotong diam-diam (pengecualian ENG-LIST-001 yang dicatat di sini). |
| GET | `/me/meetings?tab=upcoming\|past&page&pageSize` | ENG-LIST-001: default 25, maks 100, `total`. |
| GET | `/me/meetings/:id` | Penyelenggara dan peserta saja; lainnya 404. |
| POST | `/me/meetings/availability` | Pratinjau §6 tanpa menulis: `startAt`, `endAt`, `participantEmployeeIds`, `excludeMeetingId?`. |
| POST | `/me/meetings` | `Idempotency-Key` wajib. |
| PATCH | `/me/meetings/:id` | `expectedVersion` wajib. |
| POST | `/me/meetings/:id/cancel` | `reason`. |
| POST | `/me/meetings/:id/response` | `response: ACCEPTED \| DECLINED`, `note?` ≤500. |
| GET | `/me/meetings/participant-options?q=` | Typeahead pegawai aktif, minimal 2 huruf, maks 20 hasil, nama + unit saja (tanpa email/telepon/NIP lengkap). Memakai pencarian direktori yang sudah ada bila cocok. |

## 12. Layar

- Pegawai: menu **Kalender** — tampilan bulan (grid 6 minggu) dan daftar Akan Datang/Lewat; ketuk tanggal untuk membuat rapat dengan jam awal 08:00–09:00 (perilaku legacy).
- Form rapat: pemilih peserta typeahead; panel ketersediaan yang langsung memperlihatkan peserta yang bentrok (merah) dan peringatan (kuning) sebelum Kirim.
- Detail rapat: daftar peserta dengan jawaban dan tanda berhalangan; tombol Hadir/Berhalangan untuk peserta; Ubah/Batalkan untuk penyelenggara.
- State: loading, kosong ("Belum ada rapat"), 404/forbidden, error bentrok yang menyebut nama dan jam, dan tampilan ponsel (daftar per hari, bukan grid sempit).

## 13. Acceptance criteria

- CAL-001-A: pegawai aktif dapat membuat rapat dengan ≥1 peserta; peserta menerima notifikasi in-app.
- CAL-001-B: rapat yang beririsan dengan rapat aktif lain milik salah satu peserta **atau penyelenggara** ditolak 409 dengan nama dan jam sibuk; judul rapat lain tidak ikut kecuali pembuat juga pesertanya.
- CAL-001-C: rapat yang bersentuhan (selesai 10:00, mulai 10:00) diterima.
- CAL-001-D: rapat batal dan jawaban Berhalangan tidak memblokir waktu.
- CAL-001-E: cuti `approved` dan perjalanan `APPROVED`/`ISSUED` menolak; yang `in_review`/`IN_REVIEW` dan hari libur hanya memberi peringatan.
- CAL-001-F: dua undangan bersamaan untuk peserta yang sama pada jam yang sama: tepat satu berhasil (uji konkurensi nyata terhadap Postgres).
- CAL-001-G: hanya penyelenggara yang dapat mengubah/membatalkan; tidak bisa mengubah setelah mulai atau setelah batal.
- CAL-001-H: perubahan waktu mereset jawaban dan memberi tahu semua peserta; peserta baru diundang; peserta yang dikeluarkan diberi tahu.
- CAL-001-I: pegawai yang bukan penyelenggara/peserta mendapat 404 untuk detail rapat dan tidak melihatnya di kalender.
- CAL-001-J: setiap transisi menulis `meeting_events`.
- CAL-001-K: daftar rapat berhalaman sesuai ENG-LIST-001; kalender menolak rentang > 42 hari.

## 14. Paket berikutnya (usulan)

- **Paket 2:** pengingat sebelum rapat lewat NOTIF-003 (dengan penghapusan pengingat saat batal/dikeluarkan — cacat legacy yang tidak dibawa), WhatsApp lewat NOTIF-001, tanggal Hijriah di kalender (legacy punya offset setelan).
- **Paket 3 (bila diminta):** register admin, rapat berulang, ekspor `.ics`.

## 15. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Pertanyaan | Default |
| --- | --- | --- |
| K-01 | Siapa boleh mengundang? | Semua pegawai aktif |
| K-02 | Bentrok rapat diblokir atau hanya diperingatkan? | Diblokir |
| K-03 | Cuti/dinas ikut memblokir? | Ya bila disetujui; peringatan bila masih diajukan |
| K-04 | Ada konfirmasi hadir? | Ya; Berhalangan membebaskan waktu |
| K-05 | Rapat orang lain terlihat di kalender? | Tidak |
| K-06 | WhatsApp dan pengingat di paket pertama? | Tidak; Paket 2 |
| K-07 | Pemesanan ruang rapat? | Tidak |
| K-08 | Cuti/dinas boleh disetujui walau ada rapat? | Ya |
