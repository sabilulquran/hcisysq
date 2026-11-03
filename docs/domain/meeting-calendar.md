# Kalender dan Undangan Rapat

**Status:** ACCEPTED (Paket 1) — pemilik produk menyetujui K-01..K-08 pada 2026-11-02, dengan K-05 dan K-06 diubah (§3). Spesifikasi ini mengizinkan implementasi Paket 1. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Implementasi:** Paket 1 terpasang 2026-11-02 (migrasi `0117_meeting_calendar.sql`, `apps/api/src/modules/meetings/`, layar `/app/calendar`, kontrak `docs/api/meeting-calendar.openapi.yaml`). Keputusan implementasi di §16. WhatsApp tetap adapter `log` (dry run) sampai prasyarat §15 terpenuhi.
**Spesifikasi:** CAL-001
**Tanggal:** 2026-11-02
**Terkait:** LEAVE-001, LEAVE-002, TRIP-001, NOTIF-001, NOTIF-003, NOTIF-004, ATT-011, AUTH-011, ENG-LIST-001, WORK-001 (removed); SQ Hub ADR-0011 dan KIRIM-001 (Kirim SQ)
**Roadmap:** `docs/product/hcis-capability-map.md` §6, `docs/product/feature-parity.yaml` (CAL-001)

## 1. Tujuan

Pegawai dapat mengundang pegawai lain ke rapat atau kegiatan berjam, dan HCIS **menolak undangan yang membuat jadwal seorang peserta bertabrakan**. Setiap pegawai melihat satu kalender berisi rapat yayasan, cutinya, perjalanan dinasnya, dan hari libur.

Paket 1 menghasilkan:

- undangan rapat dengan peserta pegawai, judul, waktu mulai dan selesai, lokasi teks bebas, dan keterangan;
- pemblokiran waktu peserta: rapat aktif lain, cuti yang disetujui, dan perjalanan dinas yang disetujui menolak undangan (§6);
- konfirmasi hadir (Hadir / Berhalangan) oleh peserta;
- ubah dan batal oleh penyelenggara;
- notifikasi in-app (NOTIF-004) dan WhatsApp lewat Kirim SQ untuk undangan, perubahan, dan pembatalan (§9);
- pengingat 30 menit sebelum rapat, in-app dan WhatsApp (§9.3);
- kalender bulanan yang menampilkan semua rapat yayasan, dengan rapat bertanda **Rahasia** hanya tampil sebagai "Sibuk" bagi bukan peserta (K-05);
- daftar rapat saya Akan Datang / Lewat.

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
| Kalender bulanan | `app/Http/Controllers/CalendarController.php` | Grid 6 minggu: agenda, cuti `approved` milik sendiri, hari libur (cuti bersama dibedakan dari nama), tanggal Hijriah dengan offset setelan. Semua agenda aktif seluruh yayasan ditampilkan ke semua pegawai, termasuk judulnya (warna ungu, tanpa tautan), tanpa cara menyembunyikan rapat yang sensitif. |
| Jadwal Saya | `app/Http/Controllers/ScheduleController.php` | Gabungan shift kerja, agenda sendiri, libur, cuti, dan jadwal menguji rekrutmen. |
| Agenda hari ini | `HomeDataAssembler::getTodayAgenda`, `YayasanDashboardController` | Panel di beranda; dihapus dari beranda pegawai 3 Juli 2026 (`ba888d7`) karena duplikat Kalender, tetap ada di dashboard yayasan. |
| Hari libur | `app/Http/Controllers/Admin/HolidayController.php`, `HolidayPolicy`, `HolidayTarget::matchesEmployee` | Dikelola Kepala HR dan super_admin. Berlaku untuk semua, atau ditargetkan per pegawai, unit, jabatan, atau role. |
| Penugasan kerja | `WorkAssignmentController`, tabel `work_assignments` (`perjalanan_dinas`, `tugas_luar`, `wfh_wfa`, `perubahan_shift`) | **Tidak** dibaca oleh cek bentrok agenda maupun kalender. |
| Kepanitiaan | `CommitteeController`, tabel `committees` | Panitia berumur tanggal dengan anggota dan persetujuan. Bukan fitur kalender dan tidak memblokir waktu; di luar CAL-001. |

Yang **tidak** ada di legacy: ruang rapat sebagai sumber daya yang dipesan, rapat berulang, integrasi Google Calendar atau berkas `.ics`, audit log agenda, dan cek bentrok terhadap cuti atau perjalanan dinas.

## 3. Keputusan

Pemilik produk 2026-11-02: "sepakat semua kecuali K-06: Ya; K-05 Terlihat." Untuk judul rapat K-05, pemilik produk memilih opsi B (terlihat, dengan centang Rahasia per rapat): "Ya, pilihan B".

| # | Keputusan | Status |
| --- | --- | --- |
| K-01 | **Semua pegawai aktif dengan akun** boleh membuat undangan, seperti legacy. Tidak ada permission baru untuk membuat. | ACCEPTED |
| K-02 | Bentrok dengan rapat aktif lain **ditolak** (blokir keras), seperti legacy. Tidak ada tombol "paksa". | ACCEPTED |
| K-03 | Cuti `approved` dan perjalanan dinas `APPROVED`/`ISSUED` peserta juga **menolak** undangan. Cuti `in_review` dan perjalanan `IN_REVIEW` hanya **peringatan**. | ACCEPTED |
| K-04 | Peserta dapat menjawab **Hadir** atau **Berhalangan** (alasan opsional). Peserta yang Berhalangan **tidak lagi memblokir** waktunya. | ACCEPTED |
| K-05 | Rapat **terlihat** di kalender semua pegawai aktif (pemilik produk). Bukan peserta melihat judul, jam, lokasi, dan nama penyelenggara; daftar peserta dan keterangan hanya untuk peserta. Penyelenggara dapat mencentang **Rahasia**: bagi bukan peserta rapat itu tampil sebagai "Sibuk" tanpa judul, lokasi, dan penyelenggara. Default tidak rahasia. | ACCEPTED (2026-11-02, termasuk opsi Rahasia) |
| K-06 | WhatsApp dan pengingat **masuk Paket 1** (pemilik produk). WhatsApp lewat Kirim SQ di SQ Hub (ADR-0011) dengan nomor milik HCIS; HCIS tidak memanggil JalurPesan atau Starsender langsung. | ACCEPTED |
| K-07 | **Tidak ada pemesanan ruang rapat.** Lokasi teks bebas, sejalan dengan WORK-001 yang dihapus pemilik produk 2026-11-02. | ACCEPTED |
| K-08 | Pengajuan atau persetujuan cuti dan perjalanan dinas **tidak** dicek terhadap rapat. Bila cuti/dinas disetujui setelah undangan, peserta ditandai "berhalangan (cuti/dinas)" saat dibaca dan penyelenggara melihatnya. | ACCEPTED |
| K-09 | Durasi rapat 15 menit sampai 7 hari. Mulai paling cepat sekarang (WIB). Lokasi ≤255, judul 3–200, keterangan ≤3000, peserta 1–200 selain penyelenggara. | DRAFT |
| K-10 | Rapat pada hari libur atau akhir pekan di kalender kerja (`leave_calendar_*`) hanya **peringatan**, karena kegiatan pesantren sering berjalan di hari libur. | DRAFT |
| K-11 | Ubah hanya oleh penyelenggara, hanya sebelum rapat dimulai, dan tidak untuk rapat batal (sama dengan legacy). Perubahan waktu mengembalikan jawaban semua peserta ke `PENDING` dan memberi tahu semua peserta; perubahan judul/lokasi/keterangan saja tidak mengubah jawaban. | DRAFT |
| K-12 | Batal hanya oleh penyelenggara, sebelum rapat selesai, alasan wajib 5–500 karakter. | DRAFT |
| K-13 | Pegawai tanpa akun aktif (HCIS belum live ke staf) **boleh** diundang: waktunya tetap terblokir. Ia tidak menerima notifikasi in-app, tetapi tetap menerima WhatsApp bila nomornya ada. Layar memberi tanda "belum punya akun". | DRAFT |
| K-14 | WhatsApp undangan, perubahan, dan pembatalan dikirim bila penyelenggara mencentang **"Kirim juga lewat WhatsApp"** (default tercentang). Pengingat WhatsApp selalu dikirim bila nomor ada. Tidak ada preferensi pengingat per pegawai di Paket 1. | DRAFT |
| K-15 | Pengingat satu kali, **30 menit sebelum mulai** (default legacy), untuk penyelenggara dan peserta yang tidak Berhalangan. | DRAFT |

## 4. Batas

| Di luar Paket 1 | Alasan / pemilik |
| --- | --- |
| Email undangan | NOTIF-001 adapter email belum ada. |
| Preferensi pengingat per pegawai (jeda, kanal) | Legacy punya; ditunda sampai ada permintaan. |
| Ruang rapat, proyektor, kendaraan | K-07; WORK-001 removed. |
| Rapat berulang (mingguan) | Paket 2 bila diminta; legacy tidak punya. |
| Google Calendar / `.ics` | Tidak ada di legacy; butuh keputusan terpisah. |
| Undangan untuk orang luar (wali, tamu) | Peserta hanya Employee. |
| Hari libur bertarget per unit/jabatan/role | Legacy punya; HCIS baru hanya kalender kerja tingkat organisasi (`leave_calendar_exceptions`). Itu gap LEAVE-002/ATT, bukan CAL-001. |
| Cek terhadap shift/roster kerja peserta | ATT-011 punya roster, tetapi rapat di luar jam kerja sah. Tidak dicek. |
| Kehadiran rapat (absen rapat, notulen) | Bukan HR inti; tidak diminta. |
| Kepanitiaan | Fitur terpisah ORG-012 (`docs/domain/committees.md`). Kepanitiaan tidak memblokir waktu; formulir rapat hanya menawarkan "Undang seluruh panitia" yang mengisi daftar peserta dengan anggota aktif kepanitiaan si penyelenggara (ORG-012 D-16). Rapat tidak menyimpan tautan ke kepanitiaan dan semua aturan §6 tetap berlaku. |
| Register admin seluruh rapat | Paket 2 bila dibutuhkan untuk menangani penyalahgunaan; akan butuh permission `meetings.read`/`meetings.manage`. |
| Tanggal Hijriah di kalender | Legacy punya; Paket 2. |

## 5. Actor

| Actor | Boleh |
| --- | --- |
| Penyelenggara (pegawai aktif dengan akun) | Membuat, mengubah, membatalkan rapatnya; melihat jawaban peserta. |
| Peserta | Melihat detail rapat yang ia ikuti; menjawab Hadir/Berhalangan; mengubah jawabannya sampai rapat dimulai. |
| Pegawai aktif lain | Melihat rapat di kalender sesuai K-05: judul, jam, lokasi, penyelenggara untuk rapat biasa; "Sibuk" saja untuk rapat Rahasia. Tidak melihat daftar peserta, keterangan, atau jawaban. |

Akses detail adalah kepemilikan dari sesi (penyelenggara atau baris peserta), bukan permission. Akun tanpa Employee aktif mendapat 403 `EMPLOYEE_NOT_ACTIVE`. `SUPER_ADMIN` tidak memakai layar ini (sama dengan legacy).

## 6. Aturan ketersediaan (domain)

Aturan ini adalah fungsi murni di `packages/domain` (atau modul domain API) yang menerima interval dan sumber kesibukan, bukan logika frontend.

Interval rapat adalah setengah terbuka `[startAt, endAt)` dalam `timestamptz`; zona tampilan Asia/Jakarta. Dua interval bentrok bila `a.start < b.end && b.start < a.end`. Bersentuhan bukan bentrok.

Untuk setiap orang dalam `{penyelenggara} ∪ peserta`:

| Sumber | Kondisi | Hasil |
| --- | --- | --- |
| Rapat lain | status `ACTIVE`, orang itu penyelenggara atau peserta dengan jawaban `PENDING`/`ACCEPTED`, interval beririsan, bukan rapat yang sedang diubah | **BLOCK** `MEETING_OVERLAP` |
| Pelatihan (TRAIN-001) | view `training_employee_busy` (sesi `SCHEDULED` program `ACTIVE`, peserta `ENROLLED` atau narasumber internal), interval beririsan | **BLOCK** `IN_TRAINING` |
| Cuti | `leave_requests.status = 'approved'`, `[start_on, end_on]` (tanggal penuh WIB, inklusif) beririsan | **BLOCK** `ON_LEAVE` |
| Cuti | `status = 'in_review'`, beririsan | WARN `LEAVE_PENDING` |
| Perjalanan dinas | `business_trip_requests.status IN ('APPROVED','ISSUED')`, `[start_on, end_on]` beririsan | **BLOCK** `ON_TRIP` |
| Perjalanan dinas | `status = 'IN_REVIEW'`, beririsan | WARN `TRIP_PENDING` |
| Tugas luar (ATT-015 D-08) | `attendance_work_arrangement_requests.status = 'APPROVED'`, `arrangement_type = 'FIELD_ASSIGNMENT'`, beririsan | WARN `ON_FIELD_ASSIGNMENT` (rapat itu bisa jadi bagian tugasnya, jadi tidak memblokir) |
| Kalender kerja | hari mana pun dalam interval adalah libur/non-kerja menurut `leave_calendar_*` | WARN `NON_WORKING_DAY` |

Tanggal penuh dikonversi ke interval `[tanggal 00:00 WIB, tanggal+1 00:00 WIB)`.

Rincian yang dikembalikan ke pembuat undangan: id dan nama pegawai, kode alasan, jam/tanggal sibuk, dan judul rapat yang bentrok **hanya bila rapat itu tidak Rahasia atau pembuat juga pesertanya** (konsisten dengan K-05). Tidak pernah: jenis cuti, alasan cuti, atau tujuan dinas.

Pelatihan memakai kontrak baca TRAIN-001 §7.3 (`docs/domain/training.md`): CAL-001 hanya membaca view `training_employee_busy`; judul pelatihan boleh tampil karena pelatihan tidak rahasia. Sebaliknya TRAIN-001 membaca `meeting_participants` dengan aturan yang sama saat menjadwalkan sesi. Keduanya mengunci baris `employees` urut `id` sebelum memeriksa, sehingga rapat dan sesi pelatihan untuk orang yang sama tidak dapat lolos bersamaan; exclusion constraint §6.1 hanya menjaga rapat vs rapat.

Kontrak baca TRIP-001 dan LEAVE dikoordinasikan dengan sesi TRIP-001 pada 2026-11-02: CAL-001 hanya membaca `employee_id`, `start_on`, `end_on`, `status`; tidak ada hook dan tidak ada penulisan ke tabel cuti atau perjalanan.

### 6.1 Konkurensi

Pembuatan dan perubahan yang memengaruhi waktu atau peserta berjalan dalam satu transaksi:

1. kunci baris `employees` semua orang yang terlibat dengan `FOR UPDATE`, urut `id` naik (mencegah deadlock);
2. hitung ketersediaan (§6);
3. tulis rapat dan peserta.

Sebagai jaring pengaman, `meeting_participants` menyimpan salinan `busy tstzrange` dan memakai `EXCLUDE USING gist (employee_id WITH =, busy WITH &&) WHERE (blocks_time)`, dengan `btree_gist` yang sudah dipakai migrasi `0021` dan `0110`. Pelanggaran constraint (`23P01`) dipetakan ke 409 `MEETING_CONFLICT`. Cuti dan perjalanan tidak dijaga constraint ini (beda tabel); keduanya dijaga oleh langkah 1–2.

## 7. Alur dan state

### 7.1 Membuat

Input: `title`, `description?`, `location?`, `startAt`, `endAt`, `participantEmployeeIds[]`, `confidential` (default `false`), `notifyWhatsApp` (default `true`), header `Idempotency-Key`.

Validasi: K-09; peserta unik, bukan penyelenggara, semua Employee aktif; ketersediaan §6 tanpa BLOCK. Hasil: rapat `ACTIVE`, penyelenggara `ORGANIZER`/`ACCEPTED`, peserta `ATTENDEE`/`PENDING`. Notifikasi undangan (§9) dan pengingat dijadwalkan (§9.3).

Layar memanggil cek ketersediaan (§11) saat waktu atau peserta berubah, supaya bentrok terlihat sebelum Kirim. Hasil cek itu hanya pratinjau; pemeriksaan yang mengikat dijalankan lagi saat simpan.

### 7.2 State rapat

```text
ACTIVE -> CANCELLED   (penyelenggara, alasan, sebelum endAt)
ACTIVE                (setelah endAt tampil di tab "Lewat"; tidak ada state SELESAI tersimpan)
CANCELLED -> terminal
```

Rapat batal hilang dari kalender bukan peserta; bagi peserta tetap tampil dicoret dengan label "Dibatalkan".

### 7.3 Jawaban peserta

```text
PENDING  -> ACCEPTED | DECLINED   (peserta, sebelum startAt)
ACCEPTED <-> DECLINED             (peserta, sebelum startAt)
* -> PENDING                      (penyelenggara mengubah waktu, K-11)
```

`DECLINED` membebaskan waktu peserta (`blocks_time = false`) dan membatalkan pengingatnya. Kembali ke `ACCEPTED` menjalankan ulang cek §6 untuk orang itu; bila waktunya sudah dipakai rapat lain, jawaban ditolak 409 `MEETING_CONFLICT`.

### 7.4 Mengubah

Hanya penyelenggara, rapat `ACTIVE`, sekarang < `startAt`, dengan `expectedVersion` (optimistic concurrency, 409 `MEETING_VERSION_CONFLICT`). Peserta yang ditambahkan mendapat undangan; peserta yang dikeluarkan mendapat pemberitahuan "dikeluarkan" dan pengingatnya dibatalkan; bila waktu berubah, semua peserta tersisa diberi tahu, jawabannya kembali `PENDING`, dan waktu pengingat dihitung ulang. `confidential` boleh diubah.

### 7.5 Berhalangan karena cuti/dinas belakangan (K-08)

Saat dibaca, peserta yang punya cuti `approved` atau perjalanan `APPROVED`/`ISSUED` yang beririsan ditandai `unavailableReason = LEAVE | TRIP`. Tidak ada penulisan otomatis ke jawaban dan tidak ada notifikasi di Paket 1. Pengingat tetap dikirim kecuali peserta menjawab Berhalangan.

### 7.6 Kegagalan

400 `INVALID_MEETING`; 403 `EMPLOYEE_NOT_ACTIVE`, `MEETING_NOT_ORGANIZER`; 404 `MEETING_NOT_FOUND` (juga untuk detail rapat yang tidak boleh dilihat); 409 `MEETING_CONFLICT` (dengan daftar §6), `MEETING_START_IN_PAST`, `MEETING_ALREADY_STARTED`, `MEETING_CANCELLED`, `MEETING_VERSION_CONFLICT`, `PARTICIPANT_NOT_ACTIVE`.

## 8. Audit dan riwayat

Tabel `meeting_events` adalah riwayat per rapat sekaligus audit event:

`meeting.created`, `meeting.updated` (metadata: field yang berubah, waktu lama/baru, perubahan `confidential`), `meeting.participant.added`, `meeting.participant.removed`, `meeting.participant.responded`, `meeting.cancelled`.

Setiap event memuat aktor, waktu, dan metadata aman. Isi keterangan rapat tidak disalin ke metadata event. Status pengiriman WhatsApp disimpan di `meeting_notification_deliveries` (§10), bukan sebagai audit event. Legacy tidak punya audit agenda.

## 9. Notifikasi

### 9.1 In-app (NOTIF-004, kategori `system`)

- undangan baru / ditambahkan → peserta itu;
- waktu berubah → semua peserta tersisa;
- dikeluarkan → peserta itu;
- dibatalkan → semua peserta selain penyelenggara;
- peserta menjawab Berhalangan → penyelenggara.

Ditulis dalam transaksi yang sama dengan perubahannya, idempoten per `eventKey`. Peserta tanpa akun dilewati (K-13).

### 9.2 WhatsApp (NOTIF-001 lewat Kirim SQ)

HCIS memakai port `WhatsAppSender` dengan dua adapter, sesuai ADR-0011:

- `log` (default): tidak mengirim apa pun, mencatat `dry_run`. Dipakai sampai nomor HCIS di Kirim SQ siap dan kredensial klien HCIS terpasang;
- `kirim`: `POST /internal/kirim/messages` ke SQ Hub dengan token client credentials dan `Idempotency-Key`.

Aturan:

- Event yang dikirim ke WhatsApp: undangan, perubahan waktu, dikeluarkan, dibatalkan (bila `notifyWhatsApp`, K-14), dan pengingat (§9.3). Jawaban Berhalangan ke penyelenggara hanya in-app.
- Nomor tujuan: nomor telepon pegawai di data kontak HCIS. Tanpa nomor → dilewati, dan detail rapat menandai "tanpa nomor WA" bagi penyelenggara.
- Isi pesan: judul, hari/tanggal, jam WIB, lokasi, nama penyelenggara, dan tautan ke HCIS. Tidak ada keterangan rapat, daftar peserta, atau data pegawai lain.
- Kunci idempotensi: `cal:<meetingId>:<employeeId>:<event>:<version>`.
- Pengiriman tidak berjalan di dalam transaksi bisnis dan tidak membuat request pengguna menunggu SQ Hub: transaksi menulis baris `meeting_notification_deliveries` berstatus `QUEUED`, lalu penjalan latar (§9.3) menyerahkannya ke Kirim SQ. Bila SQ Hub tidak tersedia, baris diulang dengan kunci yang sama.
- `kedaluwarsa` pesan undangan/perubahan = `startAt`; pesan pengingat = `startAt`. Jam kirim otomatis 06.00–21.00 WIB ditegakkan Kirim SQ; pesan yang kedaluwarsa sebelum jendela kirim berikutnya tidak terkirim, dan in-app tetap jalan.
- Batal setelah undangan WA masih antre: baris undangan yang belum diserahkan ditandai `SKIPPED`.

### 9.3 Pengingat dan penjalan (NOTIF-003, aturan pertama)

CAL-001 adalah aturan pengingat pertama NOTIF-003 dan menjawab lima pertanyaan `announcements-and-reminders.md` §8 untuk rapat saja:

1. **Penjalan** (DRAFT): loop berinterval 60 detik di dalam proses API HCIS, mengambil baris jatuh tempo dengan `FOR UPDATE SKIP LOCKED`. Tidak ada proses atau cron baru di Mi8VPS; preseden: worker Kirim SQ berjalan di dalam proses API SQ Hub. Bila API mati, baris tetap menunggu dan dikirim saat hidup lagi selama belum lewat `startAt`.
2. **Idempotensi**: satu baris `meeting_reminders` per `(meeting_id, employee_id, rule_key)`; `fired_at` diisi dalam transaksi yang sama dengan penulisan notifikasi.
3. **Aturan**: `meeting.upcoming`, `startAt − 30 menit` (K-15). Rapat yang dibuat kurang dari 30 menit sebelum mulai tidak mendapat pengingat.
4. **Penerima**: penyelenggara dan peserta yang tidak `DECLINED`.
5. **Kanal**: in-app dan WhatsApp.

Pembatalan rapat, peserta dikeluarkan, dan jawaban Berhalangan mengisi `cancelled_at` pada pengingatnya. Saat menembak, penjalan **memeriksa ulang** bahwa rapat masih `ACTIVE`, orang itu masih peserta yang tidak Berhalangan, dan `startAt` belum lewat. Ini menutup cacat legacy (pengingat terkirim untuk agenda yang sudah batal).

## 10. Penyimpanan

```text
meetings                          id, organizer_employee_id, title, description, location,
                                  start_at, end_at, status, confidential, notify_whatsapp,
                                  cancel_reason, cancelled_at, version, idempotency_key,
                                  created_by_account_id, timestamps
meeting_participants              meeting_id, employee_id, role, response, response_note,
                                  responded_at, busy tstzrange, blocks_time boolean
meeting_events                    riwayat dan audit
meeting_reminders                 meeting_id, employee_id, rule_key, fire_at, fired_at, cancelled_at
meeting_notification_deliveries   meeting_id, employee_id, event, version, channel 'whatsapp',
                                  idempotency_key, status (QUEUED, HANDED_OVER, SENT, FAILED,
                                  SKIPPED, DRY_RUN), kirim_message_id, attempts,
                                  next_attempt_at, error_code, timestamps
```

Aturan:

- `CHECK (end_at > start_at)`, `CHECK (end_at - start_at <= interval '7 days')`;
- `meetings` unik pada `(organizer_employee_id, idempotency_key)`;
- `meeting_participants` unik pada `(meeting_id, employee_id)`; tepat satu `ORGANIZER` per rapat (indeks unik parsial);
- `blocks_time = (meeting ACTIVE AND response <> 'DECLINED')`, dipelihara oleh kode dalam transaksi yang sama; `busy = tstzrange(start_at, end_at, '[)')`;
- exclusion constraint §6.1;
- indeks `meetings (start_at, end_at) WHERE status = 'ACTIVE'` untuk kalender yayasan dan `(employee_id, busy)` untuk kesibukan pribadi;
- `meeting_reminders` unik pada `(meeting_id, employee_id, rule_key)`, indeks parsial `fire_at WHERE fired_at IS NULL AND cancelled_at IS NULL`;
- `meeting_notification_deliveries` unik pada `idempotency_key`; nomor telepon **tidak** disimpan (dibaca dari data kontak saat penyerahan);
- tidak ada endpoint hapus.

Rollback migrasi ditulis sebagai komentar `-- Down:` (drop lima tabel; tidak ada data lain yang tersentuh). Migrasi tidak menambah permission ke role yang sudah ada.

## 11. API (kontrak ringkas; OpenAPI ditulis bersama implementasi)

| Method | Path | Catatan |
| --- | --- | --- |
| GET | `/me/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` | Rentang maks 42 hari. Item: semua rapat `ACTIVE` yayasan yang beririsan (rapat Rahasia yang bukan milik saya hanya `{id: null, kind: "busy", startAt, endAt}`), rapat batal yang saya ikuti, cuti sendiri (`approved`, `in_review`), perjalanan sendiri (`APPROVED`, `ISSUED`, `IN_REVIEW`), libur/non-kerja. Setiap rapat memuat `involvesMe`. Data dibatasi rentang tanggal; bila lebih dari 500 item, 400 `RANGE_TOO_DENSE` — tidak dipotong diam-diam (pengecualian ENG-LIST-001 yang dicatat di sini). |
| GET | `/me/meetings?tab=upcoming\|past&page&pageSize` | Rapat yang saya ikuti. ENG-LIST-001: default 25, maks 100, `total`. |
| GET | `/me/meetings/:id` | Penyelenggara dan peserta saja; lainnya 404. |
| POST | `/me/meetings/availability` | Pratinjau §6 tanpa menulis: `startAt`, `endAt`, `participantEmployeeIds`, `excludeMeetingId?`. |
| POST | `/me/meetings` | `Idempotency-Key` wajib. |
| PATCH | `/me/meetings/:id` | `expectedVersion` wajib. |
| POST | `/me/meetings/:id/cancel` | `reason`. |
| POST | `/me/meetings/:id/response` | `response: ACCEPTED \| DECLINED`, `note?` ≤500. |
| GET | `/me/meetings/participant-options?q=` | Typeahead pegawai aktif, minimal 2 huruf, maks 20 hasil, nama + unit + tanda punya akun/nomor WA saja (tanpa email, telepon, atau NIP lengkap). Memakai pencarian direktori yang sudah ada bila cocok. |

## 12. Layar

- Pegawai: menu **Kalender** — tampilan bulan (grid 6 minggu) dan daftar Akan Datang/Lewat; rapat saya dan rapat orang lain dibedakan warna (pola legacy: rapat saya bisa diketuk, rapat orang lain hanya ringkasan); ketuk tanggal untuk membuat rapat dengan jam awal 08:00–09:00.
- Form rapat: pemilih peserta typeahead; centang **Rahasia** dan **Kirim juga lewat WhatsApp**; panel ketersediaan yang langsung memperlihatkan peserta yang bentrok (merah) dan peringatan (kuning) sebelum Kirim.
- Detail rapat: daftar peserta dengan jawaban, tanda berhalangan, tanda "belum punya akun" dan "tanpa nomor WA" (hanya bagi penyelenggara); tombol Hadir/Berhalangan untuk peserta; Ubah/Batalkan untuk penyelenggara.
- State: loading, kosong ("Belum ada rapat"), 404/forbidden, error bentrok yang menyebut nama dan jam, dan tampilan ponsel (daftar per hari, bukan grid sempit).

## 13. Acceptance criteria

- CAL-001-A: pegawai aktif dapat membuat rapat dengan ≥1 peserta; peserta menerima notifikasi in-app.
- CAL-001-B: rapat yang beririsan dengan rapat aktif lain milik salah satu peserta **atau penyelenggara** ditolak 409 dengan nama dan jam sibuk; judul rapat Rahasia tidak ikut kecuali pembuat juga pesertanya.
- CAL-001-C: rapat yang bersentuhan (selesai 10:00, mulai 10:00) diterima.
- CAL-001-D: rapat batal dan jawaban Berhalangan tidak memblokir waktu.
- CAL-001-E: cuti `approved` dan perjalanan `APPROVED`/`ISSUED` menolak; yang `in_review`/`IN_REVIEW` dan hari libur hanya memberi peringatan.
- CAL-001-F: dua undangan bersamaan untuk peserta yang sama pada jam yang sama: tepat satu berhasil (uji konkurensi nyata terhadap Postgres).
- CAL-001-G: hanya penyelenggara yang dapat mengubah/membatalkan; tidak bisa mengubah setelah mulai atau setelah batal.
- CAL-001-H: perubahan waktu mereset jawaban dan memberi tahu semua peserta; peserta baru diundang; peserta yang dikeluarkan diberi tahu.
- CAL-001-I: bukan peserta mendapat 404 untuk detail rapat; di kalender ia melihat judul rapat biasa dan hanya "Sibuk" untuk rapat Rahasia, tanpa daftar peserta atau keterangan.
- CAL-001-J: setiap transisi menulis `meeting_events`.
- CAL-001-K: daftar rapat berhalaman sesuai ENG-LIST-001; kalender menolak rentang > 42 hari.
- CAL-001-L: dengan adapter `log`, setiap undangan WA tercatat `DRY_RUN` tanpa panggilan jaringan; dengan adapter `kirim` (uji dengan server tiruan), pengiriman ulang memakai kunci idempotensi yang sama dan request pengguna tidak menunggu SQ Hub.
- CAL-001-M: pengingat terkirim tepat sekali 30 menit sebelum mulai; tidak terkirim untuk rapat batal, peserta yang dikeluarkan, atau peserta Berhalangan; penjalan yang dijalankan dua kali bersamaan tidak menggandakan pengingat.

## 14. Paket berikutnya (usulan)

- **Paket 2:** tanggal Hijriah, preferensi pengingat per pegawai, register admin bila dibutuhkan.
- **Paket 3 (bila diminta):** rapat berulang, ekspor `.ics`, email.

## 15. Prasyarat operasional di luar kode

- Nomor WhatsApp `hcis` sudah terhubung di Kirim SQ dan klien HCIS terdaftar di SQ Hub. Sampai itu ada, adapter tetap `log` dan fitur lain berjalan normal.
- Kredensial klien Kirim untuk HCIS dipasang operator di env Mi8VPS; agen tidak mengetik kredensial.

## 16. Catatan implementasi Paket 1 (2026-11-02)

Hal yang tidak dijawab spesifikasi di atas diputuskan saat implementasi dengan default paling masuk akal. Semuanya `DRAFT` (kecuali I-11) dan bisa diubah pemilik produk tanpa migrasi.

| # | Keputusan | Status |
| --- | --- | --- |
| I-01 | "Mulai paling cepat sekarang" (K-09) diberi kelonggaran 1 menit, supaya formulir yang dibuka sesaat lalu tidak ditolak. | DRAFT |
| I-02 | Ubah tanpa mengubah waktu hanya memeriksa **peserta baru**; ubah waktu memeriksa semua orang (jawaban mereka direset, K-11). Dengan begitu mengganti judul rapat tidak ditolak karena seorang peserta belakangan cuti (K-08). Pratinjau ketersediaan memakai aturan yang sama. | DRAFT |
| I-03 | Peringatan `NON_WORKING_DAY` muncul sekali per tanggal untuk rapat itu, bukan per peserta, karena kalender kerja berlaku untuk seluruh organisasi. | DRAFT |
| I-04 | Catatan jawaban peserta dan tanda berhalangan cuti/dinas (K-08) hanya terlihat oleh penyelenggara dan peserta itu sendiri. Tanda "belum punya akun" dan "tanpa nomor WA" hanya untuk penyelenggara (§12). | DRAFT |
| I-05 | Peserta yang dikeluarkan dihapus dari `meeting_participants`; jejaknya tetap di `meeting_events` (`meeting.participant.removed`). Setelah itu ia mendapat 404 untuk detail rapat. | DRAFT |
| I-06 | Undangan WhatsApp yang masih antre ditulis dari data rapat terbaru saat diserahkan, sehingga perubahan waktu sebelum undangan terkirim tidak menambah pesan "jadwal berubah" untuk orang yang sama. | DRAFT |
| I-07 | Status `SENT` disiapkan di tabel tetapi Paket 1 belum menerima webhook `message.status` dari Kirim SQ; status terakhir yang dicatat HCIS adalah `HANDED_OVER` (atau `DRY_RUN` dengan adapter `log`). Ulang otomatis bila SQ Hub tidak menjawab: 1, 5, lalu 30 menit, kemudian `FAILED`. Penolakan 4xx langsung `FAILED`. | DRAFT |
| I-08 | Rapat orang lain di kalender dikirim dengan `id: null`, sehingga layar tidak menawarkan tautan detail yang pasti 404. | DRAFT |
| I-09 | Kalender pribadi menampilkan tujuan perjalanan dinas **milik sendiri**; cek ketersediaan untuk orang lain tetap tidak pernah menyebut tujuan atau jenis cuti (§6). | DRAFT |
| I-10 | Pengaturan env: `WHATSAPP_ADAPTER` (`log` bawaan, `kirim`), `KIRIM_BASE_URL`, `KIRIM_TOKEN_URL`, `KIRIM_CLIENT_ID`, `KIRIM_CLIENT_SECRET`, `KIRIM_AUDIENCE` (bawaan `sq-hub-kirim`), `KIRIM_DEVICE_HCIS` (bawaan `hcis`), `MEETING_RUNNER_ENABLED` (bawaan `1`). API menolak start bila `kirim` dipilih tanpa keempat `KIRIM_*`. | DRAFT |
| I-11 | Opsi **Rahasia** (K-05 pilihan B, final dari pemilik produk 2026-11-02) dipasang sebagai kolom `meetings.confidential` (bawaan `false`) dan hanya diproyeksikan di API; layar tidak memutuskan apa pun. | ACCEPTED |
| I-12 | Bentrok dengan rapat Rahasia yang tidak diikuti pembuat undangan disebut tanpa judul **dan tanpa jam** ("sudah ada rapat lain pada waktu itu"), dan pratinjau ketersediaan hanya menerima waktu yang akan datang, supaya pratinjau tidak dipakai menelusuri siapa yang ikut rapat Rahasia atau mengintip hari lampau orang lain. Pesan WhatsApp "dikeluarkan" memakai judul, jam, dan lokasi yang dikenal penerima sebelum perubahan. | DRAFT |

