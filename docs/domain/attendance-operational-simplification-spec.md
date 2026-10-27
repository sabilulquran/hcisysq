# ATT-011 — Penyederhanaan Operasional Kehadiran: Spesifikasi

**Status:** ACCEPTED PRODUCT DIRECTION — seluruh keputusan owner D-1..D-11 dicatat 2026-10-16 (§11). Asumsi teknis bertanda DRAFT/TBD tetap diverifikasi di masing-masing paket; setiap paket tetap membutuhkan PR, test, dan persetujuan rilis owner sendiri.  
**Specification:** ATT-011  
**Drafted:** 2026-10-16  
**Direction:** `attendance-operational-simplification.md` (PROPOSED 2026-09-22)  
**Gap analysis:** `attendance-operational-simplification-gap-analysis.md`  
**Related:** ATT-002, ATT-003, ATT-006, ATT-007, ATT-008, ATT-009, ATT-010, LEAVE-007, APR-001, PAY-003 (di luar scope)

## 1. Tujuan dan batas

ATT-011 mengubah **cara Human Capital (HC) dan pegawai bekerja** dengan kehadiran menjadi empat langkah:

```text
Shift -> Jadwal -> Kehadiran -> Lembur
```

ATT-011 **tidak** mengganti model kebenaran backend. Yang tetap:

| Invariant | Sumber | Konsekuensi untuk ATT-011 |
|---|---|---|
| I-1 Effective dating + versioning jadwal | ATT-003, ATT-010 | Setiap perubahan jadwal menghasilkan versi/record baru bertanggal; yang sudah berlaku tidak ditulis ulang diam-diam. |
| I-2 Bukti mentah immutable | ATT-007, ATT-010 | Tidak ada UI/API ATT-011 yang mengubah scan ADMS/mobile. Koreksi = event baru beralasan. |
| I-3 Missing punch tetap `incomplete` | ATT-007 | UI menampilkan "07:05 – ?" dan status **Tidak lengkap**; jam jadwal tidak pernah dipakai sebagai jam masuk/pulang. |
| I-4 Jadwal adalah ekspektasi, bukan bukti | ATT-007, roadmap | Tidak ada fitur "isi otomatis sesuai jadwal". |
| I-5 Cuti/izin memengaruhi kehadiran hanya setelah keputusan authoritative | LEAVE-007, ATT-010 | Pengajuan cuti yang belum disetujui/divalidasi tidak mengubah status. Setelah keputusan final, hasil **dihitung ulang otomatis** (baru). |
| I-6 Ambiguitas gagal tertutup | ATT-003 | Konflik jadwal ditolak saat simpan (baru), dan tetap `configuration_error` bila terjadi. |
| I-7 Lembur hanya dari keputusan eksplisit | ATT-010 | Scan di luar jadwal ditampilkan sebagai fakta, bukan lembur otomatis. |
| I-8 Tidak ada kalkulasi payroll | MVP, PAY-003 | Lembur yang diakui adalah input masa depan PAY-003. |

Non-goal: perubahan protokol/mesin ADMS (ATT-012), face recognition, retention foto, payroll, ~~multi-shift per pegawai per hari~~, approval atasan baru untuk cuti.

> **Dibatalkan 2026-10-24 (keputusan owner):** non-goal "multi-shift per pegawai per hari" tidak
> berlaku lagi. Draf SK Jadwal Kerja YSQ menyusun jadwal di atas Blok Kerja dan empat kelompok
> memakai dua Blok Kerja dalam satu hari, sehingga owner memutuskan HCIS yang menyesuaikan.
> Pekerjaannya berada di spesifikasi tersendiri **ATT-013** (`attendance-multi-block-schedule.md`,
> rancangan; implementasi tercatat di `attendance-work-blocks.md`), bukan di paket ATT-011 mana pun.
> Beberapa Blok Kerja dalam satu shift kini didukung; dua pola jadwal pada tanggal yang sama tetap
> "Jadwal bermasalah".

## 2. Actor

| Actor | Role/permission saat ini | Peran di ATT-011 |
|---|---|---|
| HC Admin | `human_capital_admin`: `attendance.schedule.manage`, `.policy.manage`, `.clarification.manage`, `.reports.read`, `.overtime.manage`, `.records.manage`, `.shift_swap.manage` | Mengelola Shift dan Jadwal, memproses Kehadiran dan Lembur. |
| HC Operator | `human_capital`: `.clarification.manage`, `.reports.read`, `.overtime.manage` (menurut ATT-010; role grant diverifikasi ulang saat implementasi — TBD) | Memproses Kehadiran; melihat Shift/Jadwal **read-only** (D-1); memantau Lembur (bukan approver, kecuali sebagai atasan di unit HC — D-5). |
| Pegawai | own data | Melihat jadwal dan kehadiran sendiri, clock-in mobile, klarifikasi, lembur, tukar shift. |
| Atasan langsung | tidak ada role permission; otoritas diturunkan dari struktur organisasi (ORG-002 `LEGACY` / ORG-004 `STRUCTURE`) seperti approval cuti APR-001 | **Lembur saja (D-5):** memerintahkan lembur untuk bawahan dan menyetujui/menolak pengajuan lembur bawahan. **Tidak** mengubah jadwal (D-1). |
| Sistem (worker hitung ulang) | internal | Menghitung ulang hasil harian setelah bukti/jadwal/cuti berubah. |
| Foundation Board | tidak ada akses individual | Tidak berubah. |

Tidak ada permission baru di paket ATT-011-1 s.d. ATT-011-5. Peran atasan pada lembur (D-5) masuk paket terpisah ATT-011-6b dengan test otorisasi lengkap (AGENTS.md §7, §8). Otoritas atasan **bukan** role permission baru, melainkan snapshot approver hasil resolver struktur (§7.3).

## 3. Navigasi target

```text
Waktu & Kehadiran
  Ringkasan        (gabungan kartu hari ini + "Perlu tindakan")
  Shift            (dulu: tab "Jadwal" / template jadwal)
  Jadwal           (dulu: "Assignment" + "Roster" + akses "Tukar Shift")
  Kehadiran        (dulu: Ringkasan tabel + Klarifikasi + Evidence Mobile + Koreksi + Laporan)
  Lembur
  Mesin Fingerprint (link ke Manajemen ADMS ATT-012, tidak diubah)
  Pengaturan       (Lokasi kerja, Finalisasi ulang, tampilan lanjutan)
```

- Menu hanya tampil bila user mempunyai permission untuk **memuat datanya** (memperbaiki K-8).
- Route lama (`/admin/attendance/workforce/*`, `/admin/attendance`) dialihkan ke route baru selama minimal satu rilis; tidak ada link mati.
- "Assignment" dan "Roster mingguan" lama tetap ada sebagai **Pengaturan → Tampilan lanjutan (read-only)** sampai UAT ATT-011-5 lulus, lalu dihapus dari navigasi (bukan dari database).

### Kamus istilah UI (wajib)

| Backend | Label operator |
|---|---|
| schedule template / version | Shift / "versi shift berlaku mulai …" |
| default assignment | Pola jadwal (tidak ditampilkan sebagai istilah terpisah) |
| roster entry / roster version | Jadwal tanggal tertentu / "perubahan jadwal" |
| publish | Terapkan |
| `scheduled` | Terjadwal |
| `pending` | Belum absen |
| `present` | Hadir |
| `late` | Terlambat |
| `incomplete` | Tidak lengkap |
| `leave` | Cuti/Izin |
| `absent` | Tidak hadir |
| `off` | Libur |
| `configuration_error` | Jadwal bermasalah |
| normalized event / evidence | Data scan / bukti |
| result version | Riwayat perhitungan (hanya di detail) |
| source `adms` / `mobile` / `manual` | Mesin / HP / Koreksi HC |
| clarification `correction` / `justification` | Perbaiki jam / Terima alasan |
| overtime `submitted/approved/rejected/cancelled` | Menunggu / Disetujui / Ditolak / Dibatalkan |

UUID, "canonical", "materialized", "append-only", "authoritative", dan enum Inggris tidak boleh tampil di layar utama. Boleh tampil di panel "Detail teknis" yang tertutup secara default.

## 4. Shift

### 4.1 Layar "Shift" (HC Admin)

**Daftar:** kartu/baris `Nama | Jam | Toleransi telat | Lokasi | Dipakai oleh N pegawai | Status`.
Contoh: `Shift Pagi | 07:00–15:00 | 5 menit | Kampus SDIT | 42 pegawai | Aktif`. Shift malam tampil `21:00–05:00 (+1 hari)`.

**Tambah shift:** Nama, Jam masuk, Jam pulang, Toleransi telat (menit), Toleransi pulang cepat (menit), Lokasi kerja (opsional; tanpa lokasi → absen HP selalu "perlu ditinjau"). Bila jam pulang ≤ jam masuk, form menampilkan "Shift ini melewati tengah malam; tanggal kerja = tanggal mulai".

**Ubah shift:** form yang sama + **Berlaku mulai** (default: besok; boleh hari ini; tanggal lampau **tidak** boleh). Sebelum simpan tampil: "Perubahan ini berlaku untuk 42 pegawai mulai 1 November. Jadwal sebelum 1 November tidak berubah."

**Nonaktifkan:** ditolak bila shift masih dipakai pada tanggal ≥ hari ini; layar menampilkan daftar pegawai/tanggal yang harus dipindah dulu, dengan tombol "Buka di Jadwal".

### 4.2 Perilaku backend

- Tetap `attendance_schedule_templates` + `attendance_schedule_versions`.
- **Baru:** versi bisa dibuat dengan `effective_from` pada tanggal kerja masa depan (sekarang: `clock_timestamp()`). Versi berjalan ditutup pada batas tanggal tersebut. Hanya satu versi masa depan yang belum berlaku per shift; mengubah lagi menggantikan versi masa depan itu (versi tersebut belum pernah dipakai oleh hasil apa pun, dicek di server).
- **Baru:** `PATCH active=false` ditolak `409 SCHEDULE_IN_USE` bila ada assignment/roster entry yang berlaku pada tanggal ≥ hari ini (Asia/Jakarta). Resolver lama yang membuat assignment shift nonaktif menjadi `off` dipertahankan untuk data historis, tetapi kondisi baru tidak bisa diciptakan lagi.
- Roster yang sudah dipublish tetap terpin ke `schedule_version_id` lamanya (I-1).

### 4.3 Kegagalan dan state

| Kondisi | Respons | Layar |
|---|---|---|
| Jam tidak valid / nama duplikat aktif | 400 | Pesan di field. |
| `effective_from` lampau | 400 `EFFECTIVE_DATE_IN_PAST` | "Perubahan jam shift tidak boleh mundur. Gunakan Koreksi pada Kehadiran untuk hari yang sudah lewat." |
| Nonaktif saat dipakai | 409 `SCHEDULE_IN_USE` | Daftar pegawai terdampak. |
| Tanpa permission | 403 | Menu tidak tampil; akses langsung → halaman "Anda tidak punya akses ke Shift". |
| Kosong | — | "Belum ada shift. Buat shift pertama, misalnya Jam Kantor 08:00–16:00." |

Audit: `attendance.schedule.created`, `attendance.schedule.updated` (metadata: versi lama/baru, `effective_from`, jumlah pegawai terdampak), `attendance.schedule.deactivated`.

## 5. Jadwal

### 5.1 Model operator

Operator hanya mengenal **Jadwal** = siapa, shift apa (atau Libur), tanggal berapa. Tiga aksi:

1. **Atur jadwal** (massal): pegawai/unit + shift/Libur + rentang tanggal + hari dalam minggu (+ opsi "ulangi tanpa tanggal akhir").
2. **Ganti jadwal** (pengecualian): satu/beberapa pegawai, satu tanggal atau rentang pendek, shift/Libur pengganti.
3. **Salin jadwal**: salin minggu A ke minggu B (atau ke N minggu berikutnya) untuk unit/pegawai terpilih.

Ketiganya menghasilkan satu **Perubahan Jadwal** (backend: *schedule change set*) yang selalu melalui **Lihat dampak → Terapkan**.

### 5.2 Layar "Jadwal" (HC Admin)

**Tampilan utama — kalender planner:**

- Filter atas: Unit (termasuk sub-unit, dapat dicentang "hanya unit ini"), cari pegawai, rentang (Minggu / 2 Minggu / Bulan).
- Baris = pegawai (paging 50), kolom = tanggal. Sel = nama pendek shift (`Pagi`, `Siang`, `Malam`), `Libur`, `Libur nasional`, atau `!` merah (Jadwal bermasalah).
- Warna per shift; legend di atas.
- Ikon kecil pada sel bila jadwal tanggal itu hasil penggantian ("diganti 3 Okt oleh Siti"), detail saat hover/tap.
- Tombol: **Atur jadwal**, **Salin jadwal**, **Riwayat perubahan**.
- Pilih beberapa sel (seret atau Shift+klik) → menu **Ganti jadwal** untuk sel terpilih.

**Wizard "Atur jadwal" (3 langkah, satu halaman):**

```text
1. Siapa?      [Unit: SDIT ▼] [✓ semua 40 pegawai]  atau pilih pegawai
2. Jadwal apa? [Shift Pagi ▼]   (atau "Libur")
               Mulai [1 Okt 2026]  Sampai [31 Des 2026]  [ ] tanpa tanggal akhir
               Hari  [✓Sen ✓Sel ✓Rab ✓Kam ✓Jum  Sab  Min]
               Hari yang tidak dicentang: (•) Libur  ( ) biarkan seperti sekarang
               Keterangan [Semester ganjil]
3. [Lihat dampak]
```

**Layar "Lihat dampak"** (wajib sebelum Terapkan):

```text
40 pegawai · 1 Okt – 31 Des · 2.600 hari kerja

✓ 31 pegawai  jadwal baru (sebelumnya kosong)
↻  9 pegawai  menggantikan jadwal lama
     Ahmad: Shift Siang (1 Sep – tanpa akhir) → diakhiri 30 Sep
     ... (lihat semua)
⚑ 3 tanggal libur nasional (17 Okt, ...) → tetap Libur  [ubah: tetap masuk pada libur]
⚠ 2 pegawai bermasalah — tidak bisa diterapkan
     Budi: tidak aktif mulai 1 Nov  → dikecualikan otomatis setelah 31 Okt
     Citra: sedang mengajukan Tukar Shift 15 Okt → selesaikan dulu / kecualikan

[Kembali]  [Terapkan]
```

- "Terapkan" nonaktif selama ada baris ⚠ yang belum dikecualikan.
- Setelah Terapkan: toast "Jadwal diterapkan untuk 40 pegawai. Hasil kehadiran yang terdampak sedang diperbarui." dan kalender memuat ulang.

**Ganti jadwal** (dari sel): panel samping: "Ahmad · Kamis 15 Okt · sekarang Shift Pagi" → pilih Shift Siang/Libur → Keterangan (wajib) → Lihat dampak (ringkas, satu baris) → Terapkan. Pesan dampak: **"Jadwal baru menggantikan Shift Pagi pada 15 Oktober."**

**Salin jadwal:** Dari minggu [..] → ke minggu [..] / ulangi N minggu; unit/pegawai; sumber = jadwal yang **berlaku** pada minggu sumber (pola + penggantian), bukan hanya roster yang dipublish (memperbaiki J-5).

**Riwayat perubahan:** daftar Perubahan Jadwal: `Waktu | Oleh | Ringkasan | Pegawai | Rentang | Keterangan`. Klik → detail item. Tidak ada "hapus"; untuk membatalkan, buat Perubahan Jadwal baru (tombol "Kembalikan seperti sebelumnya" mengisi wizard dengan nilai sebelum perubahan; tetap melalui Lihat dampak).

**Tukar shift (ATT-008):** HC melihat antrean "Menunggu keputusan HC" sebagai badge di Jadwal; keputusan tetap memakai alur ATT-008. Istilah "Requester/Counterpart" diganti "Pengaju/Rekan tukar".

### 5.3 Model backend Perubahan Jadwal

Tujuan: operasi massal yang mudah, **tanpa** mengubah urutan resolver ATT-007 (roster published > libur kalender > pola/assignment) sehingga engine dan data lama tetap valid.

**Tabel baru (DRAFT, nama final saat implementasi):**

```text
attendance_schedule_change_sets
  id, kind (pattern | replacement | copy | revert), status (applied | failed),
  requested_by_account_id, applied_at, note (wajib untuk replacement/revert),
  scope_summary jsonb (unit, jumlah pegawai, rentang), preview_fingerprint,
  base_state jsonb (versi roster terakhir per minggu + id assignment yang dibaca saat preview)

attendance_schedule_change_items           -- immutable
  change_set_id, employee_id, action
    (assignment_created | assignment_ended | roster_entry_set | roster_entry_off | roster_entry_cleared),
  work_date_from, work_date_to, weekday_mask, schedule_version_id NULL, before jsonb, after jsonb
```

Kolom tambahan nullable: `attendance_schedule_assignments.change_set_id`, `attendance_rosters.change_set_id`.

**Terjemahan aksi:**

| Aksi operator | Hasil backend |
|---|---|
| Atur jadwal **berulang** (pola hari, rentang ≥ 1 minggu penuh atau tanpa akhir) | Per pegawai: assignment lama yang tumpang tindih **diakhiri** (`effective_to = from - 1`); bila assignment lama melewati `to` baru, sisa periodenya dibuat ulang sebagai assignment baru dengan shift lama; assignment baru dibuat. Tidak ada overlap tersisa (dicek di transaksi). |
| Hari yang tidak dicentang = "Libur" | Tidak ada assignment untuk weekday tersebut (resolver → `off`). |
| Ganti jadwal tanggal/rentang pendek | Entry roster (shift/OFF) pada minggu terdampak, langsung dipublish sebagai versi roster baru per minggu (copy dari versi published terakhir + perubahan) — pola yang sama dengan ATT-008. |
| Salin jadwal | Entry roster untuk tanggal tujuan, nilai = jadwal **ter-resolve** pada tanggal sumber. |
| Libur nasional dalam rentang | **D-2 (diterima):** default Libur — assignment tidak menimpa libur (resolver sudah memprioritaskan libur di atas assignment) dan roster entry melewati tanggal libur. Bila operator mencentang **"tetap masuk pada libur"** untuk perubahan itu, sistem menulis roster entry shift pada tanggal libur dalam rentang sehingga hari itu menjadi **hari kerja normal terjadwal** (lihat §5.6). |

**Publish atomik:**

1. Hitung ulang preview di server dari input yang sama; bandingkan `preview_fingerprint` dan `base_state`. Berbeda → `409 SCHEDULE_CHANGED_SINCE_PREVIEW` ("Jadwal sudah diubah orang lain. Lihat dampak lagi.").
2. Advisory lock per pegawai dan per minggu roster terdampak (urutan stabil, sama dengan ATT-008).
3. Bila ada **DRAFT roster** manual pada minggu terdampak → `409 ROSTER_DRAFT_EXISTS` dengan nama pembuat draft. ATT-011 tidak menimpa draft diam-diam. (Setelah UI lama dipensiunkan, draft manual tidak lagi dibuat.)
4. Tulis assignment, versi roster per minggu, change set, items, dan audit dalam **satu transaksi**.
5. Antrikan hitung ulang (§6.4) untuk pasangan pegawai/tanggal terdampak yang `≤ hari ini`.

**Batas (DRAFT, dapat disesuaikan setelah uji beban di Mi8VPS):** maks 500 pegawai × 400 hari per change set; preview mengembalikan maks 200 baris detail + hitungan total.

**Tanggal lampau (D-3, diterima):** selalu ditolak `422 SCHEDULE_CHANGE_IN_PAST` untuk work date < hari ini (Asia/Jakarta). Hari ini boleh diubah hanya sebelum jam mulai shift yang berlaku; setelah itu ditolak `422 SCHEDULE_CHANGE_STARTED`. Hari yang sudah lewat diselesaikan lewat Perbaiki jam / Terima alasan di Kehadiran, bukan dengan mengubah jadwal.

### 5.4 State dan transisi

```text
(input) --Lihat dampak--> preview (tidak disimpan, tidak berlaku)
preview --Terapkan--> applied        [audit attendance.schedule_change.applied]
preview --Terapkan, base berubah--> 409, kembali ke input (tidak ada perubahan)
applied --(tidak bisa diedit/dihapus)--> dikoreksi oleh change set baru (kind=revert/replacement)
```

**D-4 (diterima):** tidak ada tahap persetujuan kedua. Perubahan langsung berlaku setelah Lihat dampak → Terapkan; pengamannya adalah preview wajib, Riwayat perubahan, audit, dan Kembalikan seperti sebelumnya.

### 5.5 Kegagalan, empty, forbidden, mobile

| Kondisi | Perilaku |
|---|---|
| Belum ada shift | Jadwal kosong: "Buat shift dulu" + tombol ke Shift. |
| Unit tanpa pegawai aktif | "Tidak ada pegawai aktif di unit ini pada rentang tersebut." |
| Pegawai belum punya jadwal | Sel abu-abu "—" dan banner "12 pegawai belum punya jadwal minggu ini" (filter cepat). |
| Overlap/ambiguitas | Tidak bisa diterapkan; preview menjelaskan per pegawai. Data lama yang sudah `configuration_error` tampil `!` + link "Perbaiki". |
| Shift nonaktif dipilih | Tidak muncul di pilihan. |
| Tukar shift aktif pada tanggal terdampak | ⚠ di preview; harus dikecualikan atau diselesaikan. |
| 403 | **D-1 (diterima):** hanya HC Admin (`attendance.schedule.manage`) yang dapat mengubah. HC Operator melihat kalender **read-only** bila punya `attendance.reports.read`; tombol ubah tidak tampil dan API mutasi mengembalikan 403. Tanpa permission: halaman forbidden. |
| Jaringan gagal saat Terapkan | Tidak ada perubahan parsial (transaksi). Pesan "Belum diterapkan. Coba lagi." Terapkan ulang memakai fingerprint yang sama (idempotent by `Idempotency-Key`). |
| Mobile < 768px | Kalender menjadi daftar per pegawai per minggu; aksi **Ganti jadwal** tersedia; **Atur/Salin jadwal massal hanya di tablet/desktop** dengan pesan "Gunakan layar lebih besar untuk perubahan massal" (D-8, diterima). Batas ini hanya UI; API tidak membedakan perangkat. |

Audit: `attendance.schedule_change.applied` (actor, kind, jumlah pegawai/tanggal, rentang, change set id), `attendance.schedule_change.reverted`. Konflik 409 tidak mengubah data dan tidak perlu audit mutasi, tetapi dicatat di log aplikasi tanpa data pribadi. Gap audit lama (J-7) tertutup karena perubahan berlaku hanya lewat change set.

### 5.6 Hari libur: tugas normal vs lembur (D-2)

Owner menetapkan dua situasi yang harus dibedakan dengan jelas:

| Situasi | Contoh | Cara di HCIS | Hasil kehadiran |
|---|---|---|---|
| **Masuk pada libur sebagai tugas normal** | Satpam, petugas asrama yang memang bergiliran pada libur | HC Admin menjadwalkan shift pada tanggal libur dengan opsi **"tetap masuk pada libur"** (Atur jadwal atau Ganti jadwal). | Hari kerja biasa: Hadir/Terlambat/Tidak lengkap/Tidak hadir dihitung dari jadwal itu. Label kecil "Libur nasional — dijadwalkan masuk". Bukan lembur. |
| **Lembur pada libur** | Guru diminta membantu acara pada hari libur | Tidak ada perubahan jadwal (hari tetap Libur). Lembur diajukan/diperintahkan lewat alur Lembur §7. | Status **Libur** + "Lembur N jam" setelah lembur disetujui. Scan pada hari itu ditampilkan sebagai fakta, tidak mengubah status menjadi Hadir. |
| Tugas normal pada libur **dan** bekerja melebihi shift | Satpam shift 8 jam lalu diminta tambah 3 jam | Jadwal libur-masuk + lembur 3 jam lewat alur §7. | Hari kerja biasa + "Lembur 3 jam". |

Aturan:

- Kedua jalur tidak saling menggantikan: jadwal tidak pernah membuat lembur, dan lembur tidak pernah membuat jadwal.
- Result version menyimpan `day_type` turunan (`working_day | rest_day | public_holiday`) dan penanda bahwa libur itu dijadwalkan masuk, agar PAY-003 kelak dapat membedakan tanpa menebak (paket ATT-011-6a).
- **Libur ditambahkan belakangan** ke kalender setelah jadwal diterapkan: pegawai berpola otomatis menjadi Libur (perilaku resolver saat ini). Jadwal menampilkan banner "Libur baru 25 Des memengaruhi N pegawai yang biasanya masuk" dengan aksi **Tetap masuk pada libur** yang membuat Perubahan Jadwal biasa (preview + audit). Tidak ada perubahan otomatis diam-diam.

## 6. Kehadiran

### 6.1 Layar "Kehadiran" (HC)

Tab dalam satu halaman:

**Hari ini / Tanggal** (default hari ini):

- Kartu: Hadir · Terlambat · Tidak lengkap · Belum absen · Tidak hadir · Cuti/Izin · Libur · Jadwal bermasalah. Klik kartu = filter.
- Tabel (desktop) / kartu (mobile): `Pegawai | Unit | Shift | Masuk | Pulang | Status | Catatan`.
  Contoh: `Ahmad | SDIT | Pagi 07:00–15:00 | 07:03 | 15:01 | Hadir | Terlambat 3 mnt (dalam toleransi)`; `Siti | SMPIT | Pagi | 07:05 | – ? | Tidak lengkap | Belum scan pulang`.
- Filter: unit (+sub-unit), shift, status, sumber (Mesin/HP/Koreksi), cari nama.
- Refresh 30 detik untuk hari ini (ATT-009 dipertahankan).
- Teks kecil "Diperbarui 08:12" per baris bila hasil sedang menunggu hitung ulang: "Sedang diperbarui…".

**Perlu tindakan** (antrean gabungan, urut tanggal):

| Jenis | Sumber | Aksi utama |
|---|---|---|
| Klarifikasi menunggu | ATT-002 | Setujui / Tolak (dengan catatan) |
| Absen HP perlu ditinjau (di luar lokasi/akurasi rendah/tanpa lokasi) | ATT-006 | Lihat foto & peta → Tandai sudah ditinjau / Buka klarifikasi |
| Tidak lengkap > 1 hari | hasil | Perbaiki jam (koreksi HC) / Minta pegawai klarifikasi (notifikasi) |
| Jadwal bermasalah | hasil | Buka di Jadwal |
| Penyelesaian cuti (LEAVE-007) | resolution | Buka penyelesaian (alur LEAVE-007 tidak berubah) |

**Laporan:** 7 jenis laporan ATT-009 tetap, CSV/print tetap. Tambahan: klik baris Detail Harian → panel detail.

### 6.2 Panel detail satu hari (drill-down)

```text
Ahmad · Kamis 15 Okt 2026 · Shift Pagi 07:00–15:00 (toleransi 5 mnt)
Status: Tidak lengkap

Data scan
  07:05  Mesin SDIT-01           (diterima 07:05)
  —      tidak ada scan pulang
Sesi kerja
  1. 07:05 – ?   belum lengkap
Cuti/izin: —
Klarifikasi: —
Lembur: —

[Perbaiki jam]  [Terima alasan]  [Minta klarifikasi pegawai]

▸ Detail teknis (tertutup): versi perhitungan v3, sumber jadwal (pola / perubahan jadwal #…), referensi bukti.
```

- **Perbaiki jam** = koreksi manual ATT-010 (`attendance.records.manage`): jam masuk/pulang usulan + alasan wajib. Panel menegaskan "Data scan asli tetap disimpan".
- **Terima alasan** = justifikasi untuk telat/pulang cepat/di luar lokasi; jam tidak berubah.
- Foto absen HP hanya dimuat saat diklik dan hanya untuk `attendance.clarification.manage`; setiap baca diaudit (`attendance.mobile.photo.read`, tetap).
- Tidak ada tombol "isi sesuai jadwal" (I-3, I-4).

### 6.3 Status dan label

Status backend ATT-007 tidak berubah. Label pengecualian (bukan status): Terlambat N mnt, Pulang cepat N mnt (D-6 diterima: hanya label, bukan status), Di luar lokasi, Belum scan pulang, Alasan diterima, Lembur N jam, Dikoreksi HC.

### 6.4 Hitung ulang otomatis (baru, backend)

> **Diganti 2026-10-24 (keputusan owner):** kehadiran tidak dihitung otomatis di latar belakang.
> HCIS memakai model **Laporan & Kalkulasi** — operator memilih unit dan rentang lalu menekan
> Kalkulasi — dan layar harian menjadi **Pantauan Hari Ini** yang hanya menampilkan fakta scan.
> Spesifikasinya **ATT-014** (`attendance-report-calculation.md`). Kontrak di bawah dipertahankan
> sebagai riwayat; bagian antrean, worker, dan pemicu otomatis tidak dikerjakan.

Masalah K-1/K-2/J-8: hasil tidak mengikuti scan mesin, publish jadwal, dan keputusan cuti.

**Kontrak:**

- Tabel antrean (DRAFT) `attendance_recompute_requests(employee_id, work_date, reason, requested_at, processed_at, attempts, last_error_code)` dengan unique `(employee_id, work_date)` untuk request yang belum diproses (dedupe).
- Pemicu (dalam transaksi yang sama dengan perubahan sumber):
  - proyeksi scan ADMS ke `attendance_events` atau ingest ATTLOG yang ter-mapping (tanpa memperlambat ACK mesin; ACK tetap tidak bergantung pada engine);
  - change set jadwal applied; perubahan versi shift yang berlaku hari ini;
  - keputusan cuti/validasi LEAVE-005/007, resolution final, pembatalan cuti approved;
  - keputusan tukar shift (sudah sinkron, tetap);
  - keputusan klarifikasi/lembur/koreksi (sudah sinkron, tetap).
- Worker: loop di proses API (tanpa microservice baru, tanpa systemd — kompatibel Mi8VPS), interval DRAFT 30 detik, batch DRAFT 200, memanggil `materializeAttendanceResult` yang sudah idempotent (input hash). Gagal → `attempts+1`, backoff; setelah 5 kali tampil di "Perlu tindakan" sebagai "Gagal dihitung — hubungi admin sistem" tanpa detail teknis.
- Tanggal masa depan tidak dihitung (status tetap Terjadwal dari read model).
- Daily read untuk pegawai tanpa result **tetap** memakai read model live, tetapi bila ada scan untuk tanggal itu dan hitung ulang belum selesai, status tampil "Sedang diperbarui" alih-alih "Tidak hadir".
- "Finalisasi tanggal" dipindah ke Pengaturan sebagai **Hitung ulang rentang** (maks 31 hari, `attendance.policy.manage`, audit `attendance.finalized` dengan rentang).

**Invariant:** hitung ulang tidak membuat/mengubah bukti (I-2), tidak mensintesis jam (I-3), dan cuti yang belum final tidak memengaruhi hasil (I-5).

## 7. Lembur

### 7.1 Keputusan owner D-5 (2026-10-16)

| Butir | Keputusan |
|---|---|
| Siapa memulai | **Atasan** (perintah lembur untuk bawahan) **atau pegawai** (pengajuan lembur). |
| Persetujuan | **D-5a (dikonfirmasi owner):** pengajuan pegawai wajib disetujui atasan; perintah atasan wajib disetujui pegawai; persetujuan digital di HCIS diperlakukan sebagai persetujuan tertulis. Rujukan owner: UU Ketenagakerjaan / PP 35/2021. HCIS tidak memberi nasihat hukum; penafsiran hukum adalah keputusan owner. |
| Peran HC | **Hanya menerima notifikasi**, bukan approver. Di unit HC sendiri, yang menyetujui adalah **atasan langsung pegawai di HC**, bukan semua staf HC (D-5c, §7.3). Notifikasi hanya ke staf HC yang terkait unit pegawai (D-11, §7.4). |
| Lebih dari satu per hari | Boleh; menit yang disetujui **dijumlahkan**. |
| Lembur pada hari libur | Boleh (lihat §5.6). |
| Batas maksimal per hari | **Tidak ada batas yang memblokir** (D-5). **D-5b (diterima):** sistem menampilkan **peringatan non-blokir** bila total lembur melewati batas PP 35/2021 (§7.7). Sistem tetap menolak total teknis tidak masuk akal (> 24 jam per pegawai per hari). |
| Batas waktu pengajuan | **D-9 (diterima):** pengajuan/perintah boleh dibuat sebelum tanggal lembur dan paling lambat **7 hari setelah** tanggal lembur. |
| Direktur | **D-10 (diubah dari usulan):** Direktur tidak menerima upah lembur; lembur **tidak berlaku** untuk jabatan Direktur. Diatur sebagai aturan yang dapat dikonfigurasi per jabatan/role, bukan per orang (§7.8). |

### 7.2 Alur dan state

**A. Pegawai mengajukan**

```text
Pegawai mengajukan (tanggal, jam mulai–selesai atau menit, alasan)
  -> menunggu_atasan        [snapshot approver = atasan langsung saat submit]
       -> disetujui          (atasan; menit disetujui <= diajukan)
       -> ditolak            (atasan; catatan wajib)
       -> dibatalkan         (pegawai, selama menunggu_atasan)
disetujui -> notifikasi ke HC
```

**B. Atasan memerintahkan**

```text
Atasan membuat perintah lembur untuk 1..N bawahan (satu record per pegawai)
  -> menunggu_pegawai       [snapshot: pemberi perintah tervalidasi sebagai atasan saat submit]
       -> disetujui          (pegawai setuju; menit = menit perintah)
       -> ditolak_pegawai    (pegawai menolak; alasan opsional)
       -> dibatalkan         (atasan, selama menunggu_pegawai)
disetujui -> notifikasi ke HC
```

Pemetaan backend: request tetap memakai status `submitted | approved | rejected | cancelled` agar laporan lama terbaca; ATT-011-6b menambah `initiated_by (employee | supervisor | hc_legacy)` dan langkah persetujuan bergaya APR-001 (pihak yang harus memutuskan disnapshot). Nama final TBD saat implementasi.

**Setelah disetujui:** tidak ada pembatalan sepihak. Koreksi oleh atasan = **pembatalan lembur** beralasan yang juga perlu persetujuan pegawai (simetris dengan perintah); salah input = **pembatalan administratif** oleh HC dengan alasan wajib dan audit. Hasil kehadiran dihitung ulang otomatis (§6.4).

**Pengajuan lama:** request `submitted` yang dibuat sebelum ATT-011-6b dirilis tidak punya snapshot atasan; tetap diputuskan HC dengan alur lama (`initiated_by = hc_legacy`). Tidak ada rewrite rantai (aturan snapshot APR-001).

**Batas waktu (D-9):** work date boleh di masa depan (rencana) atau paling lambat 7 hari ke belakang (Asia/Jakarta); di luar itu `422 OVERTIME_DATE_OUT_OF_RANGE` ("Lembur hanya dapat diajukan paling lambat 7 hari setelah tanggalnya."). Batas dicek saat submit/perintah; persetujuan atas request yang sah tidak kedaluwarsa karena batas ini.

### 7.3 Siapa "atasan" — resolver

- Memakai resolver approval yang sama dengan cuti (APR-001; implementasi saat ini di `apps/api/src/modules/leave/domain/approval-chain.ts` dan `apps/api/src/modules/leave/organization-authority.ts`) dengan satu langkah `DIRECT_MANAGER` (`STRUCTURAL_DIRECT_MANAGER` bila ORG-004 `STRUCTURE` aktif; ORG-002 bila `LEGACY`). Rollout mode ikut disnapshot.
- Approver disnapshot saat submit; perubahan struktur setelahnya tidak memindahkan approval. Approver yang tidak dapat bertindak → dialihkan oleh HC dengan `approvals.reassign` (prosedur APR-001), tercatat.
- Perintah atasan: server memverifikasi pemberi perintah adalah atasan langsung hasil resolver untuk setiap pegawai yang dipilih saat submit; bila tidak → 403. Atasan tidak bisa memerintahkan dirinya sendiri.
- Tidak ada self-approval: bila resolver menghasilkan pegawai itu sendiri, pakai fallback vacancy/acting ORG-004; tanpa fallback valid → submit gagal `422 OVERTIME_APPROVER_UNRESOLVED` ("Atasan Anda belum tercatat. Hubungi HC."). Tidak ada fallback diam-diam ke HC.
- **Unit HC (D-5c, diterima):** tidak ada aturan khusus di kode. Untuk pegawai unit HC, resolver struktur dengan sendirinya menghasilkan atasan di HC (misalnya Kepala HC); orang itu bertindak sebagai atasan, dan notifikasi HC ke orang yang sama dideduplikasi.
- **Direktur (D-10):** tidak perlu approver lembur karena lembur tidak berlaku untuk jabatan itu (§7.8). Direktur tetap dapat **menyetujui/memerintahkan** lembur bawahannya bila resolver menetapkannya sebagai atasan langsung. Pegawai lain yang tidak terkena aturan tetapi resolver-nya gagal tetap `422 OVERTIME_APPROVER_UNRESOLVED`.

### 7.4 Layar

**Lembur Tim — atasan, aplikasi pegawai (`/app/attendance/team-overtime`).** Menu muncul hanya bila server menyatakan user adalah atasan langsung minimal satu pegawai aktif.

- Tab **Perlu persetujuan**: `Pegawai | Tanggal | Jam/menit diajukan | Fakta scan di luar jadwal | Alasan` → Setujui (boleh kurangi menit) / Tolak (catatan wajib). Massal: centang → Setujui sesuai pengajuan.
- Tab **Perintah lembur**: **Perintahkan lembur** → pilih bawahan (hanya bawahan langsung yang valid), tanggal, jam mulai–selesai, keterangan → kirim. Status per pegawai: Menunggu persetujuan pegawai / Disetujui / Ditolak pegawai / Dibatalkan.
- Tab **Riwayat**.
- Mobile-first (atasan sering memakai HP): kartu, bukan tabel lebar.

**Lembur Saya — pegawai.** Ajukan; daftar dengan status; kartu **Perintah lembur dari atasan**: "Pak Budi meminta Anda lembur Sabtu 18 Okt, 08:00–12:00 (4 jam) untuk Persiapan wisuda. [Setuju] [Tolak]"; batalkan pengajuan sendiri selama menunggu.

**Lembur — HC admin (pemantauan, bukan antrean keputusan).**

- Tab: **Menunggu** (menunggu siapa, sejak kapan) · Disetujui · Ditolak/Dibatalkan.
- Baris: `Pegawai | Unit | Tanggal | Jenis hari | Dimulai oleh | Menit | Fakta scan di luar jadwal | Status | Menunggu siapa`.
- Aksi HC: **Alihkan approver** (APR-001 reassign), **Batalkan administratif** (alasan wajib), **Putuskan** hanya untuk request lama `hc_legacy`, **Ajukan atas nama pegawai** (masuk alur A dengan approver atasan; HC tidak menjadi approver karenanya).
- Notifikasi in-app ke HC saat lembur disetujui (ringkas, tanpa alasan rinci). **Penerima (D-11, diterima): hanya staf HC yang terkait unit pegawai**, yaitu akun aktif dengan `attendance.overtime.manage` yang assignment role-nya ber-scope unit pegawai atau unit induknya (model scope `roles-permissions.md`). Bila tidak ada satu pun, notifikasi jatuh ke pemegang `attendance.overtime.manage` ber-scope organisasi agar tidak hilang diam-diam (DRAFT — perlu verifikasi data scope YSQ saat implementasi). Penerima dihitung saat lembur disetujui dan disimpan pada notification intent.
- Layar HC tetap dapat melihat semua lembur sesuai permission baca; pembatasan D-11 hanya untuk notifikasi.
- Pencarian pegawai penuh (bukan 100 pertama). Mobile < 768px: kartu.

"Fakta scan di luar jadwal" = selisih scan terhadap jadwal (atau seluruh scan bila hari Libur), **hanya informasi**; tidak mengisi menit otomatis (I-7). Tanpa scan: "Tidak ada scan".

### 7.5 Engine dan hasil

- `overtime_minutes` result = **jumlah** `approved_minutes` semua request `approved` pada work date (menggantikan perilaku "terbaru saja", gap L-2).
- Lembur pada hari Libur tetap tercatat; status hari tetap Libur kecuali dijadwalkan masuk (§5.6).
- Tidak ada kalkulasi upah/pengali (PAY-003). `day_type` disimpan agar PAY-003 dapat membedakan hari kerja, hari istirahat, dan libur resmi.

### 7.6 Kegagalan, empty, forbidden

| Kondisi | Respons |
|---|---|
| Atasan tidak ter-resolve / self-approval tanpa fallback | 422 `OVERTIME_APPROVER_UNRESOLVED`; tidak ada request setengah jadi. |
| Atasan memerintahkan pegawai yang bukan bawahannya | 403; default seluruh batch ditolak dan daftar pegawai tidak valid ditampilkan (perilaku "kirim yang valid saja" TBD saat UX review). |
| Keputusan ganda / langkah sudah diputuskan | 409 `OVERTIME_STEP_ALREADY_DECIDED`. |
| Bukan pihak yang harus memutuskan (termasuk HC biasa) | 403. |
| Pegawai nonaktif | 403/422 mengikuti pola ATT-007. |
| Total menit hari itu > 24 jam | 422 `OVERTIME_DAY_TOTAL_INVALID`. |
| Di luar jendela 7 hari (D-9) | 422 `OVERTIME_DATE_OUT_OF_RANGE`. |
| Jabatan tidak berhak lembur (D-10) | 422 `OVERTIME_NOT_APPLICABLE` — pegawai: "Lembur tidak berlaku untuk jabatan Anda (Direktur)." Atasan/HC saat memerintahkan/mengajukan atas nama: pegawai tersebut tidak muncul di pilihan; bila dipaksa lewat API → 422 dengan nama aturan. |
| Melewati batas PP 35/2021 (D-5b) | **Bukan error**: request tersimpan; respons membawa `warnings[]` dan layar menampilkan peringatan. |
| Kosong | Pegawai: "Belum ada pengajuan lembur." Atasan: "Tidak ada yang perlu disetujui." |
| Mobile | Lembur Tim dan Lembur Saya berupa kartu; HC admin kartu di < 768px. |

Audit (`access_audit_events`, selain `attendance_overtime_events`): `attendance.overtime.submitted`, `attendance.overtime.ordered`, `attendance.overtime.supervisor_approved`, `attendance.overtime.supervisor_rejected`, `attendance.overtime.employee_agreed`, `attendance.overtime.employee_declined`, `attendance.overtime.cancelled`, `attendance.overtime.admin_voided`, `attendance.overtime.reassigned`, dan event rantai APR-001 (chain created, step decided).

### 7.7 Peringatan batas jam lembur (D-5b)

- Peringatan, bukan blokir. Tidak ada batas maksimal yang menolak pengajuan.
- Nilai acuan dapat dikonfigurasi HC Admin (`attendance.policy.manage`) di **Pengaturan → Aturan lembur**, effective-dated dan diaudit (`attendance.overtime_policy.updated`). Nilai awal DRAFT: **4 jam per hari dan 18 jam per minggu**, mengikuti PP 35/2021 sebagaimana dirujuk owner; angka dan cakupannya (misalnya perlakuan hari libur) dikonfirmasi owner saat UAT ATT-011-6b.
- Dihitung dari total lembur **disetujui + menunggu** pegawai itu pada tanggal/minggu ISO yang sama, termasuk request yang sedang dibuat.
- Ditampilkan kepada: pembuat request (pegawai/atasan) sebelum kirim, pihak yang menyetujui sebelum menekan Setuju, dan HC di layar pemantauan (label "Melebihi batas PP 35/2021: 5 j hari ini"). Teks netral, bukan tuduhan pelanggaran.
- Peringatan yang tampil saat persetujuan disimpan pada event persetujuan (audit) agar dapat dijelaskan kemudian.

### 7.8 Aturan "lembur tidak berlaku" per jabatan/role (D-10)

Tujuan: Direktur (dan jabatan lain yang kelak ditetapkan owner) tidak dapat diajukan, diperintahkan, maupun dilaporkan lemburnya, tanpa menulis nama orang di kode.

**Model (DRAFT, nama final saat implementasi):**

```text
attendance_overtime_eligibility_rules
  id, target_kind (position | role), target_ref (ORG-004 position id / stable business id, atau role key),
  effect = 'not_applicable', reason_label (mis. "Direktur — tidak menerima upah lembur"),
  effective_from, effective_to NULL, created_by_account_id, created_at
```

- Dikelola HC Admin (`attendance.policy.manage`) di **Pengaturan → Aturan lembur**; tambah/akhiri aturan (tidak ada delete), diaudit `attendance.overtime_rule.created` / `attendance.overtime_rule.ended`.
- **Seed awal:** satu aturan untuk jabatan Direktur. Target berupa **position** (ORG-004, stable business identifier) bila struktur YSQ sudah tersedia; bila belum, role key yang setara. Pilihan target aktual diverifikasi dengan data struktur YSQ saat implementasi (DRAFT); tidak ada person/employee id di aturan.
- Evaluasi: pada work date lembur, posisi/role efektif pegawai (termasuk acting assignment yang berlaku) dicocokkan dengan aturan yang efektif pada tanggal itu. Cocok → `422 OVERTIME_NOT_APPLICABLE`. Pelaksana tugas (acting) Direktur ikut terkena aturan selama masa acting — DRAFT, dikonfirmasi owner saat UAT.
- Dicek saat pengajuan, perintah, pengajuan atas nama oleh HC, **dan lagi saat persetujuan** (bila aturan atau jabatan berubah di antaranya, persetujuan ditolak `409 OVERTIME_NO_LONGER_APPLICABLE` dan request dibatalkan otomatis dengan alasan tercatat).
- **Laporan dan hasil:** pegawai yang terkena aturan pada tanggal tersebut **tidak tampil** di laporan Lembur dan kolom lembur ringkasan; engine tidak menambahkan `overtime_minutes` untuk tanggal itu. Lembur approved yang sudah ada **sebelum** aturan berlaku tidak dihapus (bukti historis), tetap terbaca di detail audit, dan dikecualikan dari laporan dengan catatan "dikecualikan oleh aturan jabatan" — perlakuan data historis ini DRAFT, dikonfirmasi owner bila datanya ada.
- Aturan ini **tidak** mengubah kehadiran (jadwal, Hadir/Terlambat, dsb.) Direktur.

## 8. Pengalaman pegawai

Halaman **Kehadiran Saya** (`/app/attendance`):

1. **Hari ini**: shift, status, jam masuk/pulang, tombol Absen Masuk/Pulang bila absen HP aktif.
2. **Jadwal saya**: minggu ini + minggu depan (baru); tanggal yang diganti ditandai "Jadwal diganti: Shift Siang". Aksi "Tukar shift" dari tanggal (ATT-008, aturan tetap).
3. **Riwayat**: 30 hari; baris Tidak lengkap/Terlambat/Tidak hadir punya tombol **Ajukan klarifikasi** (baru untuk tanggal lalu, maks 7 hari ke belakang — D-7 diterima).
4. **Klarifikasi saya**: status + batalkan bila masih Menunggu (baru di UI; API sudah ada). Notifikasi in-app saat diputuskan (baru, memakai NOTIF in-app yang sudah ada).
5. **Lembur saya**: ajukan (disetujui atasan, D-5), status, batalkan selama menunggu; **Perintah lembur dari atasan** dengan Setuju/Tolak (§7.4).
6. **Lembur Tim** (hanya untuk atasan): persetujuan dan perintah lembur bawahan (§7.4).

Link anchor mati (`#`) diganti tab nyata. Semua bagian dirancang mobile-first (pegawai kebanyakan memakai HP).

## 9. Ringkasan permission

| Aksi | Permission | Perubahan |
|---|---|---|
| Lihat Shift/Jadwal | `attendance.schedule.manage` **atau** `attendance.reports.read` (read-only, D-1) | Read-only untuk reports.read: baru, test wajib |
| Ubah Shift, Atur/Ganti/Salin Jadwal | `attendance.schedule.manage` | — |
| Lihat Kehadiran/detail | `attendance.reports.read` | — |
| Perbaiki jam | `attendance.records.manage` | — |
| Klarifikasi, tinjau absen HP, foto | `attendance.clarification.manage` | — |
| Ajukan/batalkan lembur sendiri; setuju/tolak perintah atasan | pegawai aktif (data sendiri) | Setuju/tolak perintah: baru |
| Setujui/tolak lembur bawahan; perintahkan lembur | **atasan hasil resolver** yang disnapshot (bukan role permission) | Baru (ATT-011-6b), test otorisasi wajib |
| Pantau lembur, batalkan administratif, putuskan request `hc_legacy` | `attendance.overtime.manage` | HC tidak lagi memutuskan request baru |
| Alihkan approver lembur | `approvals.reassign` | Baru untuk domain lembur |
| Kelola Aturan lembur (peringatan PP 35/2021, jabatan tidak berhak lembur) | `attendance.policy.manage` | Baru (ATT-011-6b), test 403 wajib |
| Tukar shift (HC) | `attendance.shift_swap.manage` | — |
| Hitung ulang rentang | `attendance.policy.manage` | — |
| Penyelesaian cuti | `attendance.resolution.manage` | — |

Backend tetap authoritative; UI menyembunyikan aksi, bukan mengamankannya.

## 10. Paket implementasi

Setiap paket = satu PR, dapat di-merge dan dirilis sendiri melalui OPS-MI8-REL-001 dengan persetujuan owner. Urutan terbaru ada di bawah tabel.

| Paket | Isi | API/kontrak | Migration + rollback | Test minimum |
|---|---|---|---|---|
| **P0** (bukan ATT-011) | Perbaiki placeholder SQL filter Evidence Mobile (K-5). | Tidak berubah. | Tidak ada. | API test filter tanggal + review state; permission 403. |
| **ATT-011-1** Bahasa & navigasi | Menu "Waktu & Kehadiran", kamus istilah §3, label status/enum Indonesia, hapus UUID dari layar, redirect route lama, gating menu berdasar permission data, pencarian pegawai lembur penuh, hapus halaman mati. | Tidak berubah. | Tidak ada. Rollback = rilis sebelumnya. | Route auth test tiap route baru/redirect; test label (tidak ada enum mentah); forbidden state; typecheck/lint/build. |
| **ATT-011-2** Hitung ulang otomatis | §6.4: antrean + worker + pemicu ADMS/jadwal/cuti; status "Sedang diperbarui"; Finalisasi → Hitung ulang rentang. | `POST /admin/attendance/recompute` (rentang) menggantikan `POST /finalize/:date` (yang lama tetap alias 1 rilis); field `recomputePending` pada daily read. OpenAPI diperbarui. | Tabel `attendance_recompute_requests` (additive). Rollback: rilis lama mengabaikan tabel; `DROP TABLE` aman karena data turunan; result versions yang sudah dibuat tetap valid. | Scan ADMS → result tanpa finalisasi; cuti approved/validated → `leave`; cuti belum final → tidak berubah; publish jadwal → hitung ulang; missing punch tetap `incomplete`; idempotent (tidak ada versi duplikat); bukti tidak berubah; ACK ADMS tidak menunggu engine; worker retry/backoff. |
| **ATT-011-3** Kehadiran workspace | §6.1-6.3: tab Hari ini/Perlu tindakan/Laporan, panel detail, aksi dari panel, kartu mobile. | `GET /admin/attendance/daily/{employeeId}/{workDate}` (detail/provenance, tanpa ciphertext); `GET /admin/attendance/action-queue`. | Tidak ada. | 403 per permission; detail tidak membocorkan foto/kunci; incomplete tampil "– ?"; antrean menggabungkan jenis yang benar; mobile layout smoke. |
| **ATT-011-4** Perubahan Jadwal (backend) | §4.2 shift berlaku mulai tanggal + tolak nonaktif dipakai; §5.3 change set preview/apply/revert; opsi "tetap masuk pada libur" dan banner libur baru (§5.6). | `POST /admin/attendance/schedule-changes/preview`, `POST /admin/attendance/schedule-changes` (Idempotency-Key, fingerprint), `GET …/schedule-changes`, `GET …/schedule-changes/{id}`, `GET /admin/attendance/schedule-calendar?unitId&from&to`. OpenAPI `attendance-workforce.openapi.yaml`. | Tabel change set + items; kolom nullable `change_set_id` di assignments/rosters; `effective_from` versi shift boleh masa depan. Rollback: rilis lama tetap membaca assignment/roster biasa (hasil change set adalah baris normal) → tetap benar; kolom/tabel baru diabaikan; tidak ada data lama dihapus. Recovery: change set dapat di-revert dengan change set baru. | Pola baru di atas pola lama → split benar, nol overlap; ganti 1 tanggal → versi roster baru, minggu lain tidak tersentuh; libur nasional default dilewati; draft roster → 409; base berubah → 409; idempotent retry; transaksi atomik (gagal di tengah = nol perubahan); tanggal lampau selalu 422 dan hari ini setelah shift mulai 422 (D-3); "tetap masuk pada libur" menulis roster entry pada tanggal libur, tanpa opsi tidak; nonaktif shift dipakai → 409; versi shift masa depan tidak mengubah hasil hari ini; permission 403; audit tercatat; resolver ATT-007 menghasilkan jadwal yang sama dengan preview (property test). |
| **ATT-011-5** Jadwal planner UI | §5.2 kalender, wizard, Lihat dampak, Ganti/Salin, Riwayat; Shift UI §4.1. Assignment/Roster lama → Tampilan lanjutan read-only. | Memakai P4. | Tidak ada. | UI test wizard + preview + 409 handling; empty/forbidden/mobile; UAT sintetis 10 skenario §12. |
| **ATT-011-6a** Lembur: aturan & layar HC | §7.5 jumlahkan menit approved; `day_type` + penanda libur-dijadwalkan pada result (§5.6); fakta scan di daftar; layar pemantauan HC §7.4 (siapa yang memutuskan belum berubah); audit `access_audit_events`. | `GET /admin/attendance/overtime` menambah `dayType`, `scanOutsideScheduleMinutes`; result read menambah `dayType`. OpenAPI diperbarui. | Kolom nullable `day_type`, `holiday_scheduled_work` pada `attendance_result_versions` (versi lama `NULL` = tidak diketahui; tidak di-backfill diam-diam; hitung ulang menghasilkan versi baru). Rollback: rilis lama mengabaikan kolom; engine lama kembali ke "terbaru saja" — dicatat di release note. | Dua lembur approved dijumlahkan; lembur pada Libur tetap Libur + menit; libur-dijadwalkan → hari kerja biasa + `public_holiday`; fakta scan tidak mengisi menit; total > 24 jam → 422; layar HC menampilkan semua lembur (D-11 hanya membatasi notifikasi); result lama tidak berubah tanpa hitung ulang. |
| **ATT-011-6b** Lembur: atasan & persetujuan dua pihak | §7.1-7.8 (tidak lagi diblokir; D-5a..D-11 dijawab). Ekstrak resolver approval cuti ke modul bersama tanpa mengubah perilaku cuti. Lembur Tim, perintah lembur, persetujuan pegawai, notifikasi HC, alihkan approver, pembatalan administratif, alur `hc_legacy`, jendela 7 hari (D-9), peringatan PP 35/2021 (D-5b), aturan jabatan tidak berhak lembur + seed Direktur (D-10), notifikasi HC per unit (D-11). | Baru: `GET /attendance/overtime/team`, `POST /attendance/overtime/orders` (batch, satu record per pegawai), `POST /attendance/overtime/{id}/supervisor-decision`, `POST /attendance/overtime/{id}/employee-decision`, `POST /admin/attendance/overtime/{id}/reassign`, `POST /admin/attendance/overtime/{id}/void`, `GET/PUT /admin/attendance/overtime-policy` (ambang peringatan), `GET/POST /admin/attendance/overtime-eligibility-rules`, `POST /admin/attendance/overtime-eligibility-rules/{id}/end`; respons create/decision menambah `warnings[]`. Berubah: `POST /attendance/overtime` membuat snapshot atasan; `POST /admin/attendance/overtime` masuk alur A; `POST /admin/attendance/overtime/{id}/decision` hanya untuk `hc_legacy` (409 untuk request baru). OpenAPI. | Kolom `initiated_by`, `ordered_by_employee_id` pada `attendance_overtime_requests`; tabel langkah persetujuan lembur (atau tabel approval step bersama bila sudah generik) dengan principal snapshot + rollout mode. Tabel `attendance_overtime_policy_versions` (ambang, effective-dated) dan `attendance_overtime_eligibility_rules` (seed Direktur). Data lama: `initiated_by = 'hc_legacy'`. Rollback: rilis lama mengabaikan kolom/tabel dan kembali ke HC memutuskan semua serta **tidak** menegakkan aturan Direktur/jendela 7 hari; request yang sedang menunggu atasan/pegawai tetap `submitted` sehingga dapat diputuskan HC — **risiko perilaku yang harus diberitahukan ke owner sebelum rollback**. | Otorisasi: atasan hanya untuk bawahan hasil resolver (403 lainnya); pegawai tidak bisa menyetujui pengajuannya sendiri; hanya pegawai tujuan yang bisa setuju/tolak perintah; HC biasa 403 untuk keputusan request baru; unit HC → atasan di HC menyetujui; snapshot tetap setelah struktur berubah; LEGACY vs STRUCTURE; vacancy/acting; resolver gagal → 422 tanpa record; double decision 409; reassign tercatat; notifikasi HC setelah commit hanya ke HC ber-scope unit pegawai (fallback organisasi); D-9 di luar 7 hari → 422; D-10 Direktur → 422 di pengajuan, perintah, atas nama HC, dan 409 saat persetujuan bila aturan baru berlaku; Direktur tidak tampil di laporan lembur; Direktur tetap bisa menyetujui bawahan; aturan berbasis position/role, tidak ada employee id; D-5b peringatan muncul tanpa memblokir dan tercatat pada audit persetujuan; 403 Aturan lembur tanpa `attendance.policy.manage`; regresi seluruh test cuti lulus. Review tambahan: auth/permission. |
| **ATT-011-7** Pegawai | §8. | Jadwal ke depan memakai `GET /attendance/me/schedule?from&to` yang sudah ada (≤ 31 hari); `POST /attendance/clarifications` mendapat batas server-side yang sekarang belum ada: tanggal depan ditolak dan tanggal lampau maks D-7 hari (`422 CLARIFICATION_DATE_OUT_OF_RANGE`). | Tidak ada. | Pegawai hanya melihat jadwal sendiri; batas tanggal klarifikasi; cancel klarifikasi; notifikasi keputusan; mobile. |
| **ATT-011-8** Pensiun UI lama | Hapus Assignment/Roster lama dari navigasi setelah UAT P5 diterima owner; endpoint lama tetap (dipakai ATT-008 dan kompatibilitas) tetapi pembuatan draft manual dinonaktifkan di UI. | Endpoint draft roster: deprecate di OpenAPI. | Tidak ada. | Route test; ATT-008 tetap lulus. |

Area dengan review tambahan (AGENTS.md §8): ATT-011-2 dan ATT-011-4 (migration + engine trigger), ATT-011-6a (perhitungan lembur), ATT-011-6b (otorisasi atasan + approval chain).

Status paket: **P0** selesai (#110). **ATT-011-1** diimplementasikan 2026-10-23 (lihat §10.1). **ATT-011-7** diimplementasikan 2026-10-27 tanpa butir lembur atasan (lihat §10.2). **ATT-011-3** (antrean dan panel detail) diimplementasikan 2026-10-27 (lihat §10.3). **ATT-011-6a** diimplementasikan 2026-10-27 (lihat §10.4); paket lain belum dimulai. **ATT-011-2** digantikan oleh ATT-014 (Laporan & Kalkulasi) atas keputusan owner 2026-10-24; tab Hari ini dan Laporan dari **ATT-011-3** juga pindah ke ATT-014, sedangkan antrean "Perlu tindakan" dan panel detail tetap di ATT-011-3.

Urutan diperbarui: P0 → ATT-011-1 → ATT-011-2 → (ATT-011-3 ∥ ATT-011-4 ∥ ATT-011-6a) → ATT-011-5 → ATT-011-7 → ATT-011-6b → ATT-011-8. ATT-011-6b tidak lagi diblokir keputusan owner, tetapi bergantung pada kelengkapan data atasan langsung dan jabatan Direktur di struktur (lihat asumsi §11).

### 10.1 Catatan implementasi ATT-011-1 (2026-10-23)

- Menu sidebar "Waktu & Kehadiran" menggantikan grup "Kehadiran" + "Perangkat ADMS". Section, tab, dan redirect didefinisikan sekali di `apps/web/src/lib/attendanceNavigation.ts`; permission per route di `apps/web/src/lib/authorization.ts` sama dengan guard API di manifest AUTH-011.
- Kamus §3 ada di `apps/web/src/lib/attendanceLabels.ts`. Nilai yang tidak dikenal tampil sebagai kata netral ("Tidak diketahui"/"Lainnya"), tidak pernah sebagai kode.
- Dihapus dari layar: versi hasil ("v3"/"live"), ID mesin, referensi sumber, ID roster hasil tukar shift, kolom "Versi jadwal", dan teks `source_summary` teknis di laporan sesi.
- Ringkasan menampilkan kartu "Hari ini" dan "Perlu tindakan" (klarifikasi, bukti HP, lembur, tukar shift), masing-masing hanya bila akun dapat memuat datanya.
- Laporan hanya memuat katalog filter (pegawai/unit, shift/lokasi, mesin) yang boleh dibaca akun; filter tanpa katalog disembunyikan (K-8).
- Finalisasi tanggal pindah dari Laporan ke Pengaturan → Finalisasi ulang (`attendance.policy.manage`), perilaku API tidak berubah, sampai ATT-011-2 menggantinya dengan hitung ulang otomatis.
- Lembur, Koreksi HC, dan filter Laporan memakai pencarian pegawai server-side (`GET /admin/employees?q=`), bukan 100 pegawai pertama (L-4). Form "Catat lembur atas nama pegawai" hanya tampil dengan `employees.manage`.
- Belum termasuk (paket berikutnya): panel detail dan kartu mobile Kehadiran (ATT-011-3), planner Jadwal (ATT-011-5); Assignment/Roster lama masih menjadi tab Pola jadwal dan Jadwal per tanggal sampai ATT-011-5 diterima.
- Tidak ada perubahan API, migration, atau permission.

### 10.2 Catatan implementasi ATT-011-7 (2026-10-27)

- **Kehadiran Saya** (`/app/attendance`) memuat: Hari ini, Ajukan lembur dan pengajuan terakhir (dengan
  Batalkan), **Jadwal saya** (minggu ini + minggu depan dari `GET /attendance/me/schedule`; tanggal dari
  roster ditandai "Jadwal diganti"), **Klarifikasi saya** (status, catatan keputusan, Batalkan selama
  Menunggu), dan **Riwayat 30 hari** dengan tombol **Ajukan klarifikasi** pada hari Terlambat, Belum
  lengkap, atau Tidak hadir, hari ini sampai 7 hari ke belakang. Riwayat tampil sebagai kartu di HP.
- Form klarifikasi menjadi satu komponen (`ClarificationForm`) yang dipakai Clock In/Out (hari ini) dan
  Riwayat (tanggal lalu).
- `POST /attendance/clarifications` menolak tanggal depan dan tanggal lebih lama dari 7 hari dengan `422
  CLARIFICATION_DATE_OUT_OF_RANGE`, sebelum query apa pun.
- Keputusan HC atas klarifikasi **pegawai** mengirim notifikasi in-app ("Klarifikasi disetujui/ditolak",
  tautan ke Klarifikasi saya) dalam transaksi keputusan. Koreksi HC tidak memberi notifikasi.
- Tautan "Klarifikasi" di navigasi pegawai menuju bagian Klarifikasi saya, bukan anchor di halaman lain.
- Lembur Tim dan perintah lembur atasan (butir 5–6 §8) menunggu ATT-011-6b.
- Tidak ada migration atau permission baru.

### 10.3 Catatan implementasi ATT-011-3 (2026-10-27)

- **Perlu Tindakan** (`/admin/attendance/action-queue`) menjadi tab kedua di **Ringkasan** (§3), bukan di
  Kehadiran, karena Kehadiran tetap tiga tab (ATT-014 §19.8). Antrean `GET /admin/attendance/action-queue`
  menggabungkan, urut tanggal terlama: klarifikasi menunggu dan absen HP perlu ditinjau
  (`attendance.clarification.manage`), hari Tidak lengkap yang sudah lewat lebih dari 1 hari
  (`attendance.records.manage` atau `attendance.reports.read`), dan Jadwal bermasalah
  (`attendance.reports.read` atau `attendance.schedule.manage`). Setiap jenis hanya tampil untuk akun yang
  bisa menindaklanjutinya. Bawaan 31 hari terakhir, berhalaman standar, jumlah per jenis.
- Aturan antrean (`DRAFT`): absen HP perlu ditinjau keluar dari antrean begitu ada klarifikasi untuk hari
  itu (yang menunggu sudah tampil sebagai klarifikasi; yang diputuskan sudah menyelesaikannya), dan
  ditanggali menurut tanggal kalender scan, sehingga scan pulang lewat tengah malam pada shift malam
  tercatat di hari berikutnya. Pemegang `attendance.reports.read` saja melihat hari Tidak lengkap dan Jadwal
  bermasalah tetapi tidak dapat memperbaikinya. Belum ada aksi "Tandai sudah ditinjau", karena status
  tinjauan belum disimpan; itu butuh migration terpisah. Hari Tidak lengkap keluar dari antrean selama klarifikasi pegawai untuk
  hari itu menunggu, dan saat versi hasil terbaru tidak lagi Tidak lengkap.
- **Panel detail satu hari** (`GET /admin/attendance/daily/{employeeId}/{workDate}`, termasuk scan hari
  berikutnya sampai 6 jam setelah shift yang melewati tengah malam berakhir) dibuka dari baris
  antrean dan dari baris tab Harian di Laporan: jadwal (nama shift, jam, toleransi), status, scan per
  sumber (GPS dan foto hanya untuk `attendance.clarification.manage`, foto tetap lewat endpoint bukti yang
  diaudit), sesi (jam hilang tampil "?", tidak pernah diisi dari jadwal), cuti, lembur, klarifikasi, dan
  detail teknis yang terlipat. Aksi: **Setujui/Tolak** klarifikasi, **Perbaiki jam** (koreksi HC),
  **Minta klarifikasi pegawai**, dan **Buka di Jadwal** untuk jadwal bermasalah.
- **Minta klarifikasi pegawai** (`POST …/request-clarification`): notifikasi in-app satu kali per pegawai
  dan tanggal, audit `attendance.clarification.requested`, hanya untuk tanggal yang masih bisa
  diklarifikasi pegawai (D-7).
- `TBD`: penyelesaian cuti (LEAVE-007) tetap di halaman HC-nya sendiri; izinnya bukan izin admin sehingga
  belum masuk antrean.
- Manifest AUTH-011 +3 route. Tidak ada migration atau permission baru.

### 10.4 Catatan implementasi ATT-011-6a (2026-10-27)

- **Engine (§7.5):** `overtime_minutes` = jumlah `approved_minutes` semua lembur disetujui pada tanggal itu,
  bukan lagi yang terbaru saja. Jenis hari ikut menjadi input hasil; karena versi hasil tidak boleh diubah,
  setiap hari yang dihitung sebelum rilis ini mendapat **satu** versi baru berisi `day_type` pada Kalkulasi
  berikutnya, lalu stabil lagi.
- **Idempoten terhadap versi terakhir saja:** bila input kembali ke keadaan lama (libur ditambah lalu
  dihapus), engine menulis versi baru sebagai versi terakhir, bukan diam-diam mempertahankan versi yang lebih
  baru. Sebelumnya hasil bisa tertahan pada keadaan libur.
- **Jenis hari (§5.6):** migration `0071` menambah kolom nullable `day_type` (`working_day | rest_day |
  public_holiday`) dan `holiday_scheduled_work` pada `attendance_result_versions`. Libur kalender tetap
  `public_holiday` walaupun dijadwalkan masuk lewat jadwal per tanggal (`holiday_scheduled_work = true`).
  Versi lama tetap `NULL` dan tidak di-backfill; versi berikutnya terisi saat inputnya berubah.
- **Batas teknis 24 jam (§7.6):** total lembur menunggu + disetujui satu pegawai pada satu tanggal tidak
  boleh lebih dari 24 jam, dicek saat pegawai mengajukan, HC mencatat atas nama pegawai, dan saat
  persetujuan (`422 OVERTIME_DAY_TOTAL_INVALID`), di bawah kunci per pegawai-tanggal.
- **Audit:** `attendance.overtime.submitted` (pegawai/HC), `attendance.overtime.approved`,
  `attendance.overtime.rejected`, `attendance.overtime.cancelled` di `access_audit_events`.
- **Layar HC (§7.4):** tab Menunggu · Disetujui · Ditolak/Dibatalkan, kolom Jenis hari, Dimulai oleh, Fakta
  scan (selisih scan terhadap jadwal, atau seluruh scan pada hari tanpa jadwal; hanya informasi), kartu di
  HP, dan halaman standar (halaman dipilih dulu, fakta scan hanya dihitung untuk baris halaman itu) (`GET /admin/attendance/overtime` keluar dari daftar utang PAG-5). Siapa yang
  memutuskan belum berubah (HC); persetujuan atasan, perintah lembur, peringatan PP 35/2021, jendela D-9,
  dan aturan Direktur adalah ATT-011-6b.

### 10.5 Catatan implementasi ATT-011-4a (2026-10-27)

- **Ubah shift berlaku mulai tanggal (§4.2):** `PATCH /admin/attendance/schedules/{id}` menerima
  `effectiveFrom`. Tanggal depan membuat versi baru yang berlaku sejak tanggal itu 00.00 WIB; hari ini atau
  kosong berarti sejak disimpan. Tanggal lampau ditolak `400 EFFECTIVE_DATE_IN_PAST`. Nilai shift yang tampil
  sekarang tidak berubah sampai tanggal itu.
- **Satu versi masa depan:** mengubah lagi dengan tanggal depan menggantikan versi masa depan yang belum dipakai
  jadwal per tanggal atau hasil kehadiran (bila sudah dipakai, `409 SCHEDULE_FUTURE_VERSION_IN_USE`) dan
  meneruskan nilainya untuk field yang tidak diubah. Perubahan yang berlaku sekarang selagi ada perubahan
  terjadwal ditolak `409 SCHEDULE_CHANGE_PENDING` agar perubahan terjadwal tidak hilang diam-diam.
- **Versi yang berlaku:** perubahan tanpa tanggal, daftar Shift, grid jadwal per tanggal, daftar pola jadwal
  dan Hari Ini membaca versi yang berlaku (bukan kolom template). Publikasi jadwal per tanggal mengunci versi
  yang berlaku pada tanggal masing-masing entri.
- **Nonaktifkan:** ditolak `409 SCHEDULE_IN_USE` bila pola jadwal atau jadwal per tanggal yang dipublikasikan
  masih memakai shift itu hari ini atau sesudahnya (pegawai aktif, hari kerja); respons memuat jumlah dan sampai 20 pegawai beserta tanggal
  mulainya. Audit `attendance.schedule.deactivated`.
- **Daftar Shift:** jam sesuai versi yang berlaku sekarang, catatan "Mulai 1 Nov: 07:30–15:30" untuk perubahan
  yang terjadwal, dan "Dipakai N pegawai". Form ubah memakai **Berlaku mulai** (bawaan besok, atau tanggal
  perubahan terjadwal) dan terisi dari perubahan terjadwal bila ada. Hanya field yang berubah dikirim: jam,
  toleransi dan lokasi memakai Berlaku mulai; ganti nama dan nonaktifkan berlaku sekarang.
- Audit `attendance.schedule.updated` mencatat `effectiveFrom` dan jumlah pegawai terdampak. Tidak ada
  migration atau permission baru.

### 10.6 Catatan implementasi ATT-011-4b (2026-10-27)

- **API:** `POST /admin/attendance/schedule-changes/preview` (Lihat dampak, tanpa menulis),
  `POST /admin/attendance/schedule-changes` (Terapkan, `Idempotency-Key`), `GET …/schedule-changes` dan
  `GET …/schedule-changes/{id}` (Riwayat, berhalaman), `GET /admin/attendance/schedule-calendar` (kalender,
  50 pegawai per halaman, 1–42 hari). Mutasi butuh `attendance.schedule.manage`; baca juga boleh dengan
  `attendance.reports.read` (D-1).
- **Migration `0092`:** `attendance_schedule_change_sets`, `attendance_schedule_change_items`, dan kolom
  nullable `change_set_id` pada assignment dan roster. Aditif; rollback di header. Berbeda dari rancangan §5.3:
  `base_state` tidak disimpan terpisah karena `preview_fingerprint` sudah mencakup input, pegawai, assignment,
  versi roster terakhir per minggu, draft, libur, tukar shift, dan rencana itu sendiri; status hanya
  `applied` (transaksi gagal tidak meninggalkan baris); aksi tambahan `assignment_removed` untuk pola yang
  belum mulai. `roster_entry_cleared` menghapus entri roster pada libur yang dilewati (misalnya shift libur dari
  perubahan sebelumnya) sehingga hari itu kembali Libur.
- **Konkurensi:** kunci per pegawai dan per minggu roster memakai kunci yang sama dengan Tukar Shift
  (`attendance-roster-week:<minggu>`). Halaman roster/pola lama tidak bertransaksi; tabrakannya tertangkap oleh
  pemeriksaan pola tumpang tindih setelah penulisan dan oleh unique constraint, keduanya menjadi
  `409 SCHEDULE_CHANGED_SINCE_PREVIEW`. `Idempotency-Key` yang dipakai untuk isi lain → `422
  IDEMPOTENCY_KEY_REUSED`; shift hari ini sudah mulai → `422 SCHEDULE_CHANGE_STARTED`.
- **Salin jadwal:** libur pada minggu sumber tidak disalin (hari itu di minggu tujuan dibiarkan).
- **Atur jadwal:** pola lama yang tumpang tindih diakhiri sehari sebelum mulai (atau dihapus bila belum mulai),
  sisa sesudah periode dibuat ulang, dan "biarkan seperti sekarang" membuat pola lama khusus hari yang tidak
  dicentang. Pola tanpa shift = Libur di semua hari.
- **Ganti/Salin jadwal:** satu versi roster published baru per minggu (entri published terakhir + perubahan),
  tiap entri dikunci ke versi shift yang berlaku pada tanggalnya. Ganti jadwal maks 62 hari; Salin maks 8
  minggu tujuan.
- **Pegawai:** tidak aktif dikecualikan otomatis; berhenti di tengah rentang diubah sampai tanggal berhenti.
  Masalah yang memblokir: Tukar Shift yang masih berjalan, draft roster, shift hari ini sudah mulai, shift
  belum berlaku pada tanggalnya.
- **Hitung ulang:** perubahan yang mulai hari ini menghitung ulang hasil hari ini setelah commit (best effort,
  seperti Tukar Shift). Tanggal lampau selalu ditolak.
- `TBD`: preview belum menandai tanggal yang tetap memakai jadwal pengganti (roster) di dalam rentang Atur
  jadwal; jadwal pengganti tetap menang sesuai urutan resolver.

### 10.7 Catatan implementasi ATT-011-4c (2026-10-27)

- **Kembalikan seperti sebelumnya** adalah Perubahan Jadwal `kind = revert` (`changeSetId`, keterangan wajib)
  lewat Lihat dampak → Terapkan yang sama. Berlaku **mulai besok**, sehingga shift yang sudah berjalan hari
  ini tidak tersentuh (D-3); tanggal yang sudah lewat tidak dikembalikan.
- Kebalikan tiap item: pola yang dibuat perubahan itu dihapus (bila belum mulai) atau diakhiri hari ini; pola
  lama yang diakhiri atau dihapus dibuat ulang dari besok sampai akhir aslinya; entri roster kembali ke
  keadaan sebelum (shift dengan versi yang dikunci saat itu, Libur, atau dihapus).
- Pegawai yang jadwalnya sudah diubah lagi oleh perubahan yang lebih baru (yang belum dikembalikan), atau
  pola/entrinya diubah, dihapus, atau ditabrak pola yang dibuat langsung, diberi masalah `changed_later` yang
  memblokir; kecualikan pegawai itu dan atur ulang dengan Atur/Ganti jadwal. Mengembalikan perubahan yang
  lebih baru dulu hanya membuka jalan untuk entri jadwal per tanggal; pola yang sudah dibuat ulang tetap perlu
  diatur ulang.
- Pengembalian berlaku per pegawai: pegawai yang dikecualikan tetap dapat dikembalikan belakangan; bila semua
  pegawai sudah dikembalikan → `409 SCHEDULE_CHANGE_ALREADY_REVERTED`. Pengembalian satu change set saling
  menunggu (advisory lock). Pola dengan tanggal akhir jauh dibatasi 400 hari pertama seperti pola tanpa akhir
  (sisanya tetap dibuat ulang sampai tanggal akhir aslinya).
- Change set menyimpan `reverts_change_set_id`; audit `attendance.schedule_change.reverted`. `applied_at`
  memakai jam saat ditulis agar urutan "lebih baru" tepat. Tidak ada migration atau permission baru.

### 10.8 Catatan implementasi ATT-011-5 (2026-10-27)

- Layar **Jadwal → Kalender** (`/admin/attendance/schedules/calendar`), tab pertama di bagian Jadwal: filter
  unit, cari pegawai, rentang Minggu / 2 Minggu / Bulan (5 minggu), 50 pegawai per halaman. Sel: nama shift,
  `Libur`, `Libur nasional`, `!` (jadwal bermasalah), `—` (belum ada jadwal) dan titik untuk jadwal pengganti;
  banner jumlah pegawai tanpa jadwal pada rentang itu.
- **Atur jadwal** dan **Salin jadwal** (minggu yang tampil ke 1–8 minggu berikutnya) untuk pegawai yang dicentang
  atau unit yang dipilih; **Ganti jadwal** untuk sel yang dipilih (tanggal pertama sampai terakhir dari sel
  terpilih, keterangan wajib). Semuanya lewat **Lihat dampak**: ringkasan, libur nasional, masalah dengan tombol
  **Kecualikan**, daftar pegawai terdampak; **Terapkan** nonaktif selama ada masalah yang memblokir. Terapkan
  memakai `Idempotency-Key` yang sama untuk percobaan ulang; 409 meminta Lihat dampak lagi.
- **Riwayat perubahan** berhalaman dengan **Kembalikan seperti sebelumnya** (keterangan wajib, lalu Lihat
  dampak) untuk perubahan selain pengembalian.
- D-1: pemegang `attendance.reports.read` melihat kalender dan riwayat tanpa tombol ubah. D-8: di layar < 768px
  kalender menjadi daftar kartu per pegawai (7 hari pertama), Atur/Salin jadwal disembunyikan dengan pesan
  "Gunakan layar lebih besar untuk perubahan massal"; Ganti jadwal tetap tersedia.
- Pola jadwal dan Jadwal per tanggal lama tetap ada sampai UAT ATT-011-8 memutuskan pensiunnya. `TBD`: detail
  item per perubahan di Riwayat (API sudah ada), tanda "diganti 3 Okt oleh Siti" pada sel (API memberi
  `changeSetId`), dan sub-unit pada filter unit.

### 10.9 Catatan implementasi ATT-011-6b-1 (2026-10-27)

- Migration `0103`: `initiated_by` (`employee | supervisor | hc_legacy`), `supervisor_employee_id` dan
  `approver_snapshot` pada pengajuan lembur; jenis event baru. Pengajuan lama menjadi `hc_legacy` dan tetap
  diputuskan HC; status tetap `submitted | approved | rejected | cancelled`. Aditif; rollback di header.
- **Alur A:** pegawai (atau HC atas nama pegawai) mengajukan → atasan langsung hasil resolver APR-001
  (`DIRECT_MANAGER`, data ORG-002 selama alur OVERTIME `LEGACY`) disnapshot → hanya atasan itu yang menyetujui
  (boleh mengurangi menit) atau menolak (catatan wajib). Tanpa atasan atau atasan = dirinya →
  `422 OVERTIME_APPROVER_UNRESOLVED`. DRAFT: bila struktur memakai governance approver, orang itu yang memutuskan.
- **Alur B:** atasan memerintahkan 1–50 bawahan (keterangan wajib); setiap pegawai diverifikasi resolver;
  satu saja bukan bawahan → seluruh batch `403 OVERTIME_NOT_SUBORDINATE`. Pegawai menyetujui atau menolak;
  atasan dapat membatalkan selama belum dijawab.
- **HC:** memantau (kolom dimulai oleh, menunggu siapa, atasan), **Batalkan administratif** (alasan wajib) dan
  **Alihkan approver**; memutuskan hanya pengajuan `hc_legacy`. DRAFT: alihkan memakai
  `attendance.overtime.manage` karena `approvals.reassign` belum ada.
- **Batas waktu (D-9):** tanggal lembur paling lambat 7 hari ke belakang → `422 OVERTIME_DATE_OUT_OF_RANGE`.
- Daftar bawahan untuk perintah memakai data ORG-002 (`direct_manager_employee_id`); `TBD` saat OVERTIME
  memakai struktur ORG-004. Peringatan PP 35/2021 dan aturan jabatan tidak berhak lembur menyusul di 6b-3;
  layar Lembur Tim dan Lembur Saya di 6b-2.

## 11. Keputusan owner

### 11.1 Dicatat 2026-10-16

| ID | Pertanyaan | Keputusan |
|---|---|---|
| D-1 | Siapa yang boleh mengubah jadwal? | **Diterima:** v1 hanya HC Admin; HC Operator lihat saja. |
| D-2 | Hari libur dalam rentang jadwal massal? | **Diterima + tambahan:** otomatis Libur, dengan opsi "tetap masuk pada libur" per perubahan. Owner menambahkan: sebagian pegawai masuk pada libur sebagai **tugas normal**, sebagian lain sebagai **lembur** — keduanya didukung dan dibedakan (§5.6). |
| D-3 | Ubah jadwal tanggal lampau? | **Diterima:** tidak boleh. |
| D-4 | Perlu persetujuan kedua untuk perubahan jadwal? | **Diterima:** langsung berlaku, dengan riwayat dan Kembalikan. |
| D-5 | Aturan lembur | **Diubah dari usulan:** atasan atau pegawai dapat memulai; selalu perlu persetujuan; HC hanya diberi notifikasi kecuali unit HC sendiri; boleh lebih dari satu per hari (dijumlahkan); boleh pada hari libur; tidak ada batas maksimal per hari untuk sekarang (§7.1). |
| D-6 | Pulang cepat | **Diterima:** hanya label. |
| D-7 | Klarifikasi tanggal lampau | **Diterima:** boleh, maks 7 hari ke belakang. |
| D-8 | Jadwal massal dari HP? | **Diterima:** massal hanya laptop/tablet; HP untuk lihat dan ganti satu jadwal. |

### 11.2 Dicatat 2026-10-16 (putaran kedua)

| ID | Pertanyaan | Keputusan |
|---|---|---|
| D-5a | Interpretasi "sesuai UU" untuk persetujuan lembur | **Dikonfirmasi:** pengajuan pegawai disetujui atasan; perintah atasan perlu persetujuan pegawai; persetujuan digital di HCIS = persetujuan tertulis. |
| D-5b | Batas jam lembur PP 35/2021 | **Diterima:** peringatan di atas batas, tanpa blokir dan tanpa batas maksimal keras (§7.7). |
| D-5c | Approver lembur di unit HC | **Diterima:** atasan langsung pegawai di HC, bukan semua staf HC. |
| D-9 | Batas waktu pengajuan setelah tanggal lembur | **Diterima:** 7 hari. |
| D-10 | Lembur untuk Direktur | **Diubah dari usulan:** Direktur tidak menerima upah lembur; lembur tidak berlaku untuk jabatan Direktur — pengajuan/perintah diblokir dengan pesan jelas dan Direktur dikecualikan dari laporan lembur; aturan dapat dikonfigurasi per jabatan/role, bukan orang (§7.8). |
| D-11 | Penerima notifikasi lembur di HC | **Diterima:** hanya staf HC yang terkait unit pegawai (§7.4). |

Tidak ada keputusan produk yang masih terbuka untuk ATT-011. Butir DRAFT di bawah adalah verifikasi teknis/data saat implementasi, bukan keputusan baru; bila verifikasi mengubah perilaku yang terlihat owner, perubahan dibawa kembali ke owner.

Asumsi DRAFT yang belum diverifikasi: kapasitas worker hitung ulang di Mi8VPS (interval/batch); batas ukuran change set; ketersediaan unit-tree (sub-unit) dari ORG-004 untuk filter; kelengkapan data atasan langsung (ORG-002 `LEGACY`) untuk seluruh pegawai sebelum ATT-011-6b diaktifkan — bila belum lengkap, pengajuan lembur pegawai tanpa atasan gagal tertutup (422) dan HC harus melengkapi data struktur lebih dulu; jabatan Direktur dapat diidentifikasi sebagai position ORG-004 atau role key (§7.8); data scope unit untuk staf HC tersedia agar notifikasi D-11 tepat sasaran; angka awal 4 jam/hari dan 18 jam/minggu (§7.7) serta perlakuan acting Direktur dan lembur historis Direktur dikonfirmasi saat UAT.

## 12. Acceptance (setelah ACCEPTED, per paket)

- ATT-011-A: HC membuat shift dan mengubah jamnya berlaku mulai tanggal depan tanpa mengubah hasil lampau.
- ATT-011-B: HC menjadwalkan satu unit untuk satu semester dalam satu Perubahan Jadwal dengan preview konflik.
- ATT-011-C: HC menyalin jadwal minggu sebelumnya (termasuk yang berasal dari pola) ke minggu berikutnya.
- ATT-011-D: HC mengganti jadwal satu pegawai satu hari; pesan dampak memakai bahasa "menggantikan".
- ATT-011-E: Konflik/ambiguitas tidak bisa diterapkan dan dijelaskan tanpa istilah backend.
- ATT-011-F: Pegawai yang scan di mesin tidak pernah tampil "Tidak hadir" hanya karena belum difinalisasi.
- ATT-011-G: HC melihat siapa terlambat/tidak hadir/tidak lengkap hari ini dan membuka detail bukti satu hasil.
- ATT-011-H: HC menyelesaikan klarifikasi dari antrean "Perlu tindakan".
- ATT-011-I: Lembur dari pegawai disetujui atasan dan lembur perintah atasan disetujui pegawai; HC menerima notifikasi dan memantau, tidak menjadi approver kecuali sebagai atasan di unit HC; beberapa lembur sehari dijumlahkan; lembur pada libur tercatat tanpa mengubah status Libur; fakta scan terlihat tetapi tidak mengisi menit.
- ATT-011-O: Lembur tidak dapat diajukan/diperintahkan untuk Direktur (aturan per jabatan/role, dapat dikonfigurasi) dan Direktur tidak muncul di laporan lembur; pengajuan lebih dari 7 hari setelah tanggalnya ditolak; total di atas batas PP 35/2021 memunculkan peringatan tanpa memblokir; notifikasi lembur hanya ke staf HC unit terkait.
- ATT-011-N: Pegawai yang dijadwalkan masuk pada libur dinilai sebagai hari kerja biasa (bukan lembur) dan hari itu ditandai libur resmi untuk PAY-003.
- ATT-011-J: Pegawai melihat jadwal minggu ini dan depan, serta mengajukan klarifikasi dari riwayat.
- ATT-011-K: Missing punch tetap Tidak lengkap; tidak ada jalur yang menjadikan jam jadwal sebagai bukti.
- ATT-011-L: Cuti yang belum final tidak mengubah status; setelah final, hasil berubah tanpa tindakan manual.
- ATT-011-M: Typecheck, lint, test, build, clean migration lulus di CI; UAT sintetis di environment nyata sebelum rilis; tidak ada data pegawai nyata di test/screenshot.
