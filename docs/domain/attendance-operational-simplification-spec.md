# ATT-011 — Penyederhanaan Operasional Kehadiran: Spesifikasi

**Status:** DRAFT — MENUNGGU KEPUTUSAN OWNER (lihat §11). Tidak boleh diimplementasikan sebelum §11 dijawab dan status diubah menjadi ACCEPTED.  
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

Non-goal: perubahan protokol/mesin ADMS (ATT-012), face recognition, retention foto, payroll, multi-shift per pegawai per hari, approval atasan baru untuk cuti.

## 2. Actor

| Actor | Role/permission saat ini | Peran di ATT-011 |
|---|---|---|
| HC Admin | `human_capital_admin`: `attendance.schedule.manage`, `.policy.manage`, `.clarification.manage`, `.reports.read`, `.overtime.manage`, `.records.manage`, `.shift_swap.manage` | Mengelola Shift dan Jadwal, memproses Kehadiran dan Lembur. |
| HC Operator | `human_capital`: `.clarification.manage`, `.reports.read`, `.overtime.manage` (menurut ATT-010; role grant diverifikasi ulang saat implementasi — TBD) | Memproses Kehadiran dan Lembur; **tidak** mengubah jadwal (kecuali keputusan D-1 berubah). |
| Pegawai | own data | Melihat jadwal dan kehadiran sendiri, clock-in mobile, klarifikasi, lembur, tukar shift. |
| Kepala unit / atasan | belum ada permission attendance | **TBD (D-1, D-5)**. Tidak mendapat akses baru di ATT-011 v1 kecuali owner memutuskan. |
| Sistem (worker hitung ulang) | internal | Menghitung ulang hasil harian setelah bukti/jadwal/cuti berubah. |
| Foundation Board | tidak ada akses individual | Tidak berubah. |

Tidak ada permission baru di paket ATT-011-1 s.d. ATT-011-5. Permission baru hanya bila D-1 atau D-5 memutuskan peran kepala unit/atasan; itu menjadi paket terpisah dengan test permission (AGENTS.md §7).

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
⚑ 3 tanggal libur nasional (17 Okt, ...) → tetap Libur  [ubah]
⚠ 2 pegawai bermasalah — tidak bisa diterapkan
     Budi: tidak aktif mulai 1 Nov  → dikecualikan otomatis setelah 31 Okt
     Citra: sedang mengajukan Tukar Shift 15 Okt → selesaikan dulu / kecualikan
⏪ 12 hari kerja sudah lewat akan dihitung ulang  (hanya bila D-3 mengizinkan)

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
| Libur nasional dalam rentang | Default: assignment tidak menimpa libur (resolver sudah memprioritaskan libur di atas assignment). Untuk roster entry, tanggal libur **dilewati** kecuali operator memilih "tetap masuk pada libur" (D-2). |

**Publish atomik:**

1. Hitung ulang preview di server dari input yang sama; bandingkan `preview_fingerprint` dan `base_state`. Berbeda → `409 SCHEDULE_CHANGED_SINCE_PREVIEW` ("Jadwal sudah diubah orang lain. Lihat dampak lagi.").
2. Advisory lock per pegawai dan per minggu roster terdampak (urutan stabil, sama dengan ATT-008).
3. Bila ada **DRAFT roster** manual pada minggu terdampak → `409 ROSTER_DRAFT_EXISTS` dengan nama pembuat draft. ATT-011 tidak menimpa draft diam-diam. (Setelah UI lama dipensiunkan, draft manual tidak lagi dibuat.)
4. Tulis assignment, versi roster per minggu, change set, items, dan audit dalam **satu transaksi**.
5. Antrikan hitung ulang (§6.4) untuk pasangan pegawai/tanggal terdampak yang `≤ hari ini`.

**Batas (DRAFT, dapat disesuaikan setelah uji beban di Mi8VPS):** maks 500 pegawai × 400 hari per change set; preview mengembalikan maks 200 baris detail + hitungan total.

**Tanggal lampau:** ditolak `422 SCHEDULE_CHANGE_IN_PAST` kecuali D-3 mengizinkan; bila diizinkan: hanya HC Admin, keterangan wajib, batas N hari, dan hasil terdampak dihitung ulang dengan provenance change set.

### 5.4 State dan transisi

```text
(input) --Lihat dampak--> preview (tidak disimpan, tidak berlaku)
preview --Terapkan--> applied        [audit attendance.schedule_change.applied]
preview --Terapkan, base berubah--> 409, kembali ke input (tidak ada perubahan)
applied --(tidak bisa diedit/dihapus)--> dikoreksi oleh change set baru (kind=revert/replacement)
```

Bila D-4 memilih alur persetujuan: `draft → submitted → applied | rejected`, dengan approver HC Admin lain; ini menambah satu paket.

### 5.5 Kegagalan, empty, forbidden, mobile

| Kondisi | Perilaku |
|---|---|
| Belum ada shift | Jadwal kosong: "Buat shift dulu" + tombol ke Shift. |
| Unit tanpa pegawai aktif | "Tidak ada pegawai aktif di unit ini pada rentang tersebut." |
| Pegawai belum punya jadwal | Sel abu-abu "—" dan banner "12 pegawai belum punya jadwal minggu ini" (filter cepat). |
| Overlap/ambiguitas | Tidak bisa diterapkan; preview menjelaskan per pegawai. Data lama yang sudah `configuration_error` tampil `!` + link "Perbaiki". |
| Shift nonaktif dipilih | Tidak muncul di pilihan. |
| Tukar shift aktif pada tanggal terdampak | ⚠ di preview; harus dikecualikan atau diselesaikan. |
| 403 | HC Operator melihat kalender **read-only** bila punya `attendance.reports.read`; tombol ubah tidak tampil. Tanpa permission: halaman forbidden. |
| Jaringan gagal saat Terapkan | Tidak ada perubahan parsial (transaksi). Pesan "Belum diterapkan. Coba lagi." Terapkan ulang memakai fingerprint yang sama (idempotent by `Idempotency-Key`). |
| Mobile < 768px | Kalender menjadi daftar per pegawai per minggu; aksi **Ganti jadwal** tersedia; **Atur/Salin jadwal massal hanya di tablet/desktop** dengan pesan "Gunakan layar lebih besar untuk perubahan massal" (D-8). |

Audit: `attendance.schedule_change.applied` (actor, kind, jumlah pegawai/tanggal, rentang, change set id), `attendance.schedule_change.reverted`. Konflik 409 tidak mengubah data dan tidak perlu audit mutasi, tetapi dicatat di log aplikasi tanpa data pribadi. Gap audit lama (J-7) tertutup karena perubahan berlaku hanya lewat change set.

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

Status backend ATT-007 tidak berubah. Label pengecualian (bukan status): Terlambat N mnt, Pulang cepat N mnt (D-6), Di luar lokasi, Belum scan pulang, Alasan diterima, Lembur N jam, Dikoreksi HC.

### 6.4 Hitung ulang otomatis (baru, backend)

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

### 7.1 Layar "Lembur" (HC)

- Tab: **Menunggu** · Disetujui · Ditolak/Dibatalkan.
- Baris: `Pegawai | Tanggal | Shift | Diajukan | Fakta scan di luar jadwal | Disetujui | Status`.
  Contoh: `Ahmad | 15 Okt | Pagi 07:00–15:00 | 2 jam | scan pulang 17:10 (+2j 10m) | – | Menunggu`.
- "Fakta scan di luar jadwal" = selisih scan pertama/terakhir terhadap jadwal, **hanya informasi**; tidak mengisi menit disetujui otomatis (I-7). Bila tidak ada scan: "Tidak ada scan di luar jadwal".
- Aksi: Setujui (menit ≤ diajukan, default = diajukan) / Tolak (catatan wajib). Massal: centang beberapa → Setujui sesuai pengajuan.
- HC dapat "Ajukan atas nama pegawai" (sudah ada).
- Pencarian pegawai penuh (bukan 100 pertama). Mobile: kartu.

### 7.2 Aturan yang harus ditetapkan (D-5)

- Beberapa pengajuan approved pada tanggal yang sama: **dijumlahkan** atau **ditolak saat pengajuan kedua**. Implementasi saat ini diam-diam memakai yang terbaru (L-2) — harus diganti setelah keputusan.
- Lembur pada hari Libur/Tidak hadir: diizinkan atau ditolak.
- Batas maksimum per hari (saat ini teknis 1.440 menit).
- Tahap atasan langsung sebelum HC: ya/tidak. Bila ya, memakai snapshot-on-submit APR-001 dan menjadi paket terpisah dengan permission + test.

Audit: keputusan lembur tetap di `attendance_overtime_events`, **ditambah** `attendance.overtime.decided` di `access_audit_events` (konsisten dengan domain lain).

## 8. Pengalaman pegawai

Halaman **Kehadiran Saya** (`/app/attendance`):

1. **Hari ini**: shift, status, jam masuk/pulang, tombol Absen Masuk/Pulang bila absen HP aktif.
2. **Jadwal saya**: minggu ini + minggu depan (baru); tanggal yang diganti ditandai "Jadwal diganti: Shift Siang". Aksi "Tukar shift" dari tanggal (ATT-008, aturan tetap).
3. **Riwayat**: 30 hari; baris Tidak lengkap/Terlambat/Tidak hadir punya tombol **Ajukan klarifikasi** (baru untuk tanggal lalu, batas D-7).
4. **Klarifikasi saya**: status + batalkan bila masih Menunggu (baru di UI; API sudah ada). Notifikasi in-app saat diputuskan (baru, memakai NOTIF in-app yang sudah ada).
5. **Lembur saya**: ajukan, status, batalkan (sudah ada).

Link anchor mati (`#`) diganti tab nyata. Semua bagian dirancang mobile-first (pegawai kebanyakan memakai HP).

## 9. Ringkasan permission

| Aksi | Permission | Perubahan |
|---|---|---|
| Lihat Shift/Jadwal | `attendance.schedule.manage` **atau** `attendance.reports.read` (read-only) | Read-only untuk reports.read: baru, test wajib |
| Ubah Shift, Atur/Ganti/Salin Jadwal | `attendance.schedule.manage` | — |
| Lihat Kehadiran/detail | `attendance.reports.read` | — |
| Perbaiki jam | `attendance.records.manage` | — |
| Klarifikasi, tinjau absen HP, foto | `attendance.clarification.manage` | — |
| Lembur | `attendance.overtime.manage` | — |
| Tukar shift (HC) | `attendance.shift_swap.manage` | — |
| Hitung ulang rentang | `attendance.policy.manage` | — |
| Penyelesaian cuti | `attendance.resolution.manage` | — |

Backend tetap authoritative; UI menyembunyikan aksi, bukan mengamankannya.

## 10. Paket implementasi

Setiap paket = satu PR, dapat di-merge dan dirilis sendiri melalui OPS-MI8-REL-001 dengan persetujuan owner. Urutan: P0 → P1 → P2 → (P3 ∥ P4) → P5 → P6 → P7 → P8.

| Paket | Isi | API/kontrak | Migration + rollback | Test minimum |
|---|---|---|---|---|
| **P0** (bukan ATT-011) | Perbaiki placeholder SQL filter Evidence Mobile (K-5). | Tidak berubah. | Tidak ada. | API test filter tanggal + review state; permission 403. |
| **ATT-011-1** Bahasa & navigasi | Menu "Waktu & Kehadiran", kamus istilah §3, label status/enum Indonesia, hapus UUID dari layar, redirect route lama, gating menu berdasar permission data, pencarian pegawai lembur penuh, hapus halaman mati. | Tidak berubah. | Tidak ada. Rollback = rilis sebelumnya. | Route auth test tiap route baru/redirect; test label (tidak ada enum mentah); forbidden state; typecheck/lint/build. |
| **ATT-011-2** Hitung ulang otomatis | §6.4: antrean + worker + pemicu ADMS/jadwal/cuti; status "Sedang diperbarui"; Finalisasi → Hitung ulang rentang. | `POST /admin/attendance/recompute` (rentang) menggantikan `POST /finalize/:date` (yang lama tetap alias 1 rilis); field `recomputePending` pada daily read. OpenAPI diperbarui. | Tabel `attendance_recompute_requests` (additive). Rollback: rilis lama mengabaikan tabel; `DROP TABLE` aman karena data turunan; result versions yang sudah dibuat tetap valid. | Scan ADMS → result tanpa finalisasi; cuti approved/validated → `leave`; cuti belum final → tidak berubah; publish jadwal → hitung ulang; missing punch tetap `incomplete`; idempotent (tidak ada versi duplikat); bukti tidak berubah; ACK ADMS tidak menunggu engine; worker retry/backoff. |
| **ATT-011-3** Kehadiran workspace | §6.1-6.3: tab Hari ini/Perlu tindakan/Laporan, panel detail, aksi dari panel, kartu mobile. | `GET /admin/attendance/daily/{employeeId}/{workDate}` (detail/provenance, tanpa ciphertext); `GET /admin/attendance/action-queue`. | Tidak ada. | 403 per permission; detail tidak membocorkan foto/kunci; incomplete tampil "– ?"; antrean menggabungkan jenis yang benar; mobile layout smoke. |
| **ATT-011-4** Perubahan Jadwal (backend) | §4.2 shift berlaku mulai tanggal + tolak nonaktif dipakai; §5.3 change set preview/apply/revert. | `POST /admin/attendance/schedule-changes/preview`, `POST /admin/attendance/schedule-changes` (Idempotency-Key, fingerprint), `GET …/schedule-changes`, `GET …/schedule-changes/{id}`, `GET /admin/attendance/schedule-calendar?unitId&from&to`. OpenAPI `attendance-workforce.openapi.yaml`. | Tabel change set + items; kolom nullable `change_set_id` di assignments/rosters; `effective_from` versi shift boleh masa depan. Rollback: rilis lama tetap membaca assignment/roster biasa (hasil change set adalah baris normal) → tetap benar; kolom/tabel baru diabaikan; tidak ada data lama dihapus. Recovery: change set dapat di-revert dengan change set baru. | Pola baru di atas pola lama → split benar, nol overlap; ganti 1 tanggal → versi roster baru, minggu lain tidak tersentuh; libur nasional default dilewati; draft roster → 409; base berubah → 409; idempotent retry; transaksi atomik (gagal di tengah = nol perubahan); tanggal lampau sesuai D-3; nonaktif shift dipakai → 409; versi shift masa depan tidak mengubah hasil hari ini; permission 403; audit tercatat; resolver ATT-007 menghasilkan jadwal yang sama dengan preview (property test). |
| **ATT-011-5** Jadwal planner UI | §5.2 kalender, wizard, Lihat dampak, Ganti/Salin, Riwayat; Shift UI §4.1. Assignment/Roster lama → Tampilan lanjutan read-only. | Memakai P4. | Tidak ada. | UI test wizard + preview + 409 handling; empty/forbidden/mobile; UAT sintetis 10 skenario §12. |
| **ATT-011-6** Lembur | §7 sesuai D-5. | Bila D-5 = jumlahkan: perubahan perhitungan `overtime_minutes` (engine). Bila tolak duplikat: `409 OVERTIME_ALREADY_APPROVED`. Tambah fakta scan pada list. | Mungkin tidak ada; bila perlu partial unique index untuk satu approved per hari → rollback `DROP INDEX`. | Aturan D-5; fakta scan tidak mengisi menit; audit `attendance.overtime.decided`; permission. |
| **ATT-011-7** Pegawai | §8. | Jadwal ke depan memakai `GET /attendance/me/schedule?from&to` yang sudah ada (≤ 31 hari); `POST /attendance/clarifications` mendapat batas server-side yang sekarang belum ada: tanggal depan ditolak dan tanggal lampau maks D-7 hari (`422 CLARIFICATION_DATE_OUT_OF_RANGE`). | Tidak ada. | Pegawai hanya melihat jadwal sendiri; batas tanggal klarifikasi; cancel klarifikasi; notifikasi keputusan; mobile. |
| **ATT-011-8** Pensiun UI lama | Hapus Assignment/Roster lama dari navigasi setelah UAT P5 diterima owner; endpoint lama tetap (dipakai ATT-008 dan kompatibilitas) tetapi pembuatan draft manual dinonaktifkan di UI. | Endpoint draft roster: deprecate di OpenAPI. | Tidak ada. | Route test; ATT-008 tetap lulus. |

Area dengan review tambahan (AGENTS.md §8): P2 dan P4 (migration + engine trigger), P6 bila mengubah perhitungan lembur, paket permission bila D-1/D-5 menambah peran.

## 11. Keputusan owner (wajib sebelum ACCEPTED)

| ID | Pertanyaan | Usulan default |
|---|---|---|
| D-1 | Siapa yang boleh mengubah jadwal: hanya HC Admin, atau juga kepala unit/sekolah untuk unitnya sendiri? | v1 hanya HC Admin; HC Operator lihat saja. |
| D-2 | Hari libur nasional/kalender di dalam rentang jadwal massal: otomatis Libur untuk semua, atau ada shift (misal satpam) yang tetap masuk? | Otomatis Libur; HC bisa memilih "tetap masuk pada libur" per perubahan. |
| D-3 | Boleh mengubah jadwal untuk tanggal yang sudah lewat? Jika ya, maksimal berapa hari ke belakang? | Tidak boleh; tanggal lampau diselesaikan lewat Perbaiki jam/Terima alasan. |
| D-4 | Perubahan jadwal langsung berlaku setelah "Lihat dampak", atau perlu persetujuan HC Admin kedua? | Langsung berlaku (dengan riwayat + bisa dikembalikan). |
| D-5 | Lembur: siapa mengajukan, perlu persetujuan atasan dulu atau cukup HC, boleh lebih dari satu per hari (dijumlahkan), boleh di hari libur, batas maksimal per hari? | Pegawai/HC mengajukan; cukup HC; dijumlahkan; boleh di hari libur; maks 8 jam/hari (TBD). |
| D-6 | Pulang cepat: cukup ditandai, atau menjadi status tersendiri? | Cukup ditandai. |
| D-7 | Pegawai boleh mengajukan klarifikasi untuk tanggal yang sudah lewat? Maksimal berapa hari? | Ya, maks 7 hari. |
| D-8 | Apakah HC perlu mengatur jadwal massal dari HP, atau cukup dari laptop? | Massal dari laptop/tablet; HP untuk lihat dan ganti satu jadwal. |

Asumsi DRAFT yang belum diverifikasi: kapasitas worker hitung ulang di Mi8VPS (interval/batch), batas ukuran change set, dan apakah unit-tree (sub-unit) tersedia lengkap dari ORG-004 untuk filter.

## 12. Acceptance (setelah ACCEPTED, per paket)

- ATT-011-A: HC membuat shift dan mengubah jamnya berlaku mulai tanggal depan tanpa mengubah hasil lampau.
- ATT-011-B: HC menjadwalkan satu unit untuk satu semester dalam satu Perubahan Jadwal dengan preview konflik.
- ATT-011-C: HC menyalin jadwal minggu sebelumnya (termasuk yang berasal dari pola) ke minggu berikutnya.
- ATT-011-D: HC mengganti jadwal satu pegawai satu hari; pesan dampak memakai bahasa "menggantikan".
- ATT-011-E: Konflik/ambiguitas tidak bisa diterapkan dan dijelaskan tanpa istilah backend.
- ATT-011-F: Pegawai yang scan di mesin tidak pernah tampil "Tidak hadir" hanya karena belum difinalisasi.
- ATT-011-G: HC melihat siapa terlambat/tidak hadir/tidak lengkap hari ini dan membuka detail bukti satu hasil.
- ATT-011-H: HC menyelesaikan klarifikasi dari antrean "Perlu tindakan".
- ATT-011-I: HC memproses lembur sesuai D-5 dengan fakta scan terlihat.
- ATT-011-J: Pegawai melihat jadwal minggu ini dan depan, serta mengajukan klarifikasi dari riwayat.
- ATT-011-K: Missing punch tetap Tidak lengkap; tidak ada jalur yang menjadikan jam jadwal sebagai bukti.
- ATT-011-L: Cuti yang belum final tidak mengubah status; setelah final, hasil berubah tanpa tindakan manual.
- ATT-011-M: Typecheck, lint, test, build, clean migration lulus di CI; UAT sintetis di environment nyata sebelum rilis; tidak ada data pegawai nyata di test/screenshot.
