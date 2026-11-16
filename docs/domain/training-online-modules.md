# Pelatihan Pegawai — R4: Modul Daring

**Status:** ACCEPTED (R4 awal, di balik sakelar fitur yang mati) — spesifikasi ini mengizinkan implementasi R4 awal. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal (instruksi owner 2026-11-17). Fitur **tidak aktif di production** sampai kapasitas penyimpanan disediakan (§11).
**Spesifikasi:** TRAIN-001 (tahap R4)
**Tanggal:** 2026-11-17
**Terkait:** `docs/domain/training.md` (Paket 1), `docs/domain/training-evaluation.md` (R3), `docs/domain/training-lms-discovery.md` §8 (video, kontrol tonton), ADR-0002 (port `ObjectStorage`), ENG-LIST-001, AUTH-011, NOTIF-004

## 1. Tujuan

Program **daring** berisi modul. Modul berisi materi (video yang di-host server sendiri, atau bacaan) dan kuis opsional. Peserta terdaftar menonton video yang **tidak bisa dilewati dan tidak bisa dipercepat**; kemajuan **dihitung di server**, bukan dipercaya dari browser. Peserta yang menyelesaikan semua modul langsung mendapat **catatan pelatihan** terverifikasi, dan jamnya masuk **jam pelatihan tahunan** (Paket 1 D-07).

## 2. Batas

Termasuk: program daring, modul, materi video dan bacaan, unggah MP4 lewat port `ObjectStorage` dengan adaptor sistem berkas lokal, streaming dengan HTTP range request hanya untuk peserta terdaftar, sesi tonton dengan detak dan kredit server, kuis per modul memakai mesin tes R3, penyelesaian ke catatan pelatihan, pratinjau dan progres untuk HC, penandaan selesai manual oleh HC dengan alasan.

**Tidak** termasuk (tetap discovery): transcoding/HLS dan beberapa kualitas (discovery §8.3 tahap lanjutan), materi PDF/dokumen berkas, sertifikat terbitan sistem, program campuran luring+daring, adaptor S3, penyajian video oleh proses statis terpisah dengan URL bertanda tangan (§8.3 discovery; R4 awal menyajikan lewat API dengan token sesi tonton, M-08), berhenti otomatis saat tab tersembunyi di luar yang dilakukan pemutar (§12 no. 5).

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| M-01 | Program punya `delivery`: `CLASSROOM` (bawaan, Paket 1) atau `ONLINE`. Program daring tidak punya sesi terjadwal (409 `TRAINING_ONLINE_NO_SESSIONS`) dan tidak memblokir waktu pegawai. | DRAFT |
| M-02 | Satu program daring berisi 1–20 modul berurutan; satu modul 1–20 materi berurutan. Modul punya `creditHours` 0,25–40 (kelipatan 0,25) yang diisi HC. | DRAFT |
| M-03 | Materi `VIDEO` (MP4 H.264/AAC unggahan HC) atau `TEXT` (bacaan ≤ 20.000 huruf, selesai dengan konfirmasi "sudah membaca"). Berkas dokumen belum didukung. | DRAFT |
| M-04 | Video: hanya MP4 (diperiksa dari kotak `ftyp`), durasi dibaca server dari kotak `mvhd` (10 detik – 4 jam). **Batas ukuran per berkas `TRAINING_VIDEO_MAX_BYTES`, bawaan 300 MB**; **kuota total `TRAINING_MEDIA_QUOTA_BYTES`, bawaan 5 GB**. Tidak ada transcoding. | DRAFT |
| M-05 | **Sakelar fitur `TRAINING_ONLINE_ENABLED`, bawaan `0` (mati).** Saat mati, semua rute R4 menjawab 404 `TRAINING_ONLINE_DISABLED` dan program daring tidak dapat dibuat. | ACCEPTED (instruksi owner 2026-11-17) |
| M-06 | Penyimpanan **wajib lewat port `ObjectStorage`** (ADR-0002). Adaptor dipilih konfigurasi `TRAINING_MEDIA_STORAGE` (`local`, satu-satunya saat ini) dan divalidasi saat start. Adaptor `local` memakai direktori **eksplisit** `TRAINING_MEDIA_DIR`; tanpa itu fitur tetap mati. Kode domain dan rute hanya mengenal kunci objek (`training/videos/<materialId>/<uuid>.mp4`), tidak pernah path host, Mi8VPS, atau vendor. | ACCEPTED (discovery §3 no. 3, ADR-0002) |
| M-07 | Modul `DRAFT` dapat diubah (materi, video, kuis). **Terbit** (`PUBLISHED`) bila punya ≥ 1 materi dan setiap video sudah diunggah; setelah terbit modul **terkunci**. Modul `DRAFT` dapat diarsipkan; modul terbit tidak. | DRAFT |
| M-08 | Akses tonton hanya untuk **peserta terdaftar** (`ENROLLED` atau `COMPLETED`) dari program `ACTIVE`, pada modul `PUBLISHED`. Menonton membuka **sesi tonton**; hanya satu sesi aktif per peserta per materi (sesi lama berakhir). Aliran video memerlukan id sesi tonton aktif milik pemanggil; sesi berakhir setelah 30 menit tanpa detak. | ACCEPTED (discovery §8.4 no. 3, 6) |
| M-09 | Aliran video hanya menjawab **range request** (`Range: bytes=…`, 206), paling banyak 4 MB per respons, `Content-Disposition: inline`, `Cache-Control: private, no-store`. Tanpa `Range` → 416. Tidak ada URL publik dan tidak ada tombol unduh. | DRAFT |
| M-10 | **Kredit server** (discovery §8.4): pemutar mengirim detak tiap ±10 detik berisi posisi. Server mengkredit kemajuan hanya bila posisi sebelumnya bersambung dengan batas terjauh yang sudah dikredit (selisih ≤ 2 detik), dan majunya tidak lebih dari `waktu nyata sejak detak sebelumnya × 1,25 + 2 detik`, dengan waktu nyata dibatasi 30 detik per detak. Mempercepat atau melompat di browser tidak menambah kredit. | ACCEPTED (discovery §8.4); angka DRAFT |
| M-11 | Video **selesai** bila batas terkredit ≥ **95%** durasi. Bacaan selesai dengan konfirmasi. | DRAFT (discovery §12 no. 8) |
| M-12 | HC dapat menandai materi selesai untuk peserta tertentu dengan **alasan wajib** (aksesibilitas, gangguan teknis), diaudit. | ACCEPTED (discovery §8.4 pengecualian) |
| M-13 | **Kuis** modul opsional: salinan butir instrumen `TEST` R3 (snapshot), nilai minimal lulus bawaan **70**, paling banyak **3 percobaan**, nilai **tertinggi** dipakai. Kuis terbuka setelah semua materi modul selesai. Kunci tidak pernah dikirim ke browser; skor dihitung server dengan aturan R3 E-04/E-05. | DRAFT |
| M-14 | Modul selesai bila semua materinya selesai dan kuisnya lulus (bila ada). Peserta **menyelesaikan program** bila semua modul terbit selesai: dalam transaksi yang sama dibuat catatan `INTERNAL`/`PARTICIPANT`/`VERIFIED`, `completed = true`, jam = Σ `creditHours` modul terbit, tanggal mulai = tanggal didaftarkan (WIB), tanggal selesai = hari ini (WIB); peserta → `COMPLETED`; pegawai diberi tahu. Jam ini otomatis masuk rekap jam tahunan Paket 1. | DRAFT |
| M-15 | Menutup program daring (Paket 1 §6.5) tidak memerlukan sesi atau kehadiran: peserta `ENROLLED` yang belum menyelesaikan menjadi `INCOMPLETE` **tanpa** catatan; catatan peserta yang sudah selesai tetap. | DRAFT |
| M-16 | Modul tidak dapat terbit bila program tidak `ACTIVE`; modul baru tidak dapat ditambahkan ke program yang sudah ditutup atau dibatalkan. Menerbitkan modul baru setelah sebagian peserta selesai **tidak** mencabut catatan mereka; peserta lain harus menyelesaikan semua modul terbit. | DRAFT |
| M-17 | Izin memakai `training.read` (lihat modul, pratinjau video, progres) dan `training.manage` (ubah, unggah, terbitkan, tandai selesai). **Tidak ada permission baru.** | DRAFT |

## 4. Actor

| Actor | Tindakan |
| --- | --- |
| Peserta (pegawai) | Melihat modul terbit programnya, menonton video, membaca materi, mengerjakan kuis, melihat kemajuannya |
| HC dengan `training.read` | Melihat modul, materi, pratinjau video, progres per peserta, pemakaian penyimpanan |
| HC dengan `training.manage` | Membuat dan mengubah modul/materi, mengunggah video, memasang kuis, menerbitkan/mengarsipkan modul, menandai selesai manual |
| Sistem | Memeriksa berkas, menghitung kredit, menilai kuis, membuat catatan pelatihan, audit, notifikasi |

## 5. State

```text
Modul:   DRAFT -> PUBLISHED   (HC; syarat M-07)
         DRAFT -> ARCHIVED    (HC, alasan 5–500)
Sesi tonton: ACTIVE -> ENDED  (sesi baru untuk materi yang sama, atau 30 menit tanpa detak)
Progres materi: (belum) -> COMPLETED   (WATCHED / READ / HC_MANUAL)
```

## 6. Unggah video

`PUT /admin/training/materials/:id/video` dengan badan mentah `Content-Type: video/mp4`, diteruskan sebagai aliran ke `ObjectStorage.put` dengan batas byte M-04 (413 `TRAINING_VIDEO_TOO_LARGE`; 507 `TRAINING_MEDIA_QUOTA_EXCEEDED` bila kuota terlampaui). Setelah tersimpan, server membaca kotak MP4 lewat `ObjectStorage.read` (range): tanpa `ftyp` atau `mvhd` yang valid → objek dihapus, 400 `TRAINING_VIDEO_INVALID`; durasi di luar 10 detik–4 jam → 400 `TRAINING_VIDEO_DURATION`. Video pengganti menghapus objek lama setelah yang baru tercatat. Isi berkas tidak pernah masuk log atau audit; audit hanya id, ukuran, durasi, dan SHA-256.

## 7. Menonton dan kredit

1. `POST /training/me/materials/:id/playbacks` → `{ playbackId, durationSeconds, creditedSeconds, completed }`. Sesi aktif lain untuk materi itu diakhiri.
2. Pemutar memuat `GET /training/me/materials/:id/stream?playback=<id>` dengan range request.
3. Tiap ±10 detik: `POST /training/me/playbacks/:id/heartbeat { position }`. Server menerapkan M-10/M-11 dan menjawab `{ creditedSeconds, completed, programCompleted }`. Sesi yang sudah berakhir → 409 `TRAINING_PLAYBACK_ENDED`.

Pemutar web: tanpa kontrol bawaan untuk maju; posisi yang melewati batas terkredit dikembalikan; `playbackRate` dikunci 1; tanpa menu unduh (`controlsList="nodownload"`, menu konteks dimatikan); jeda saat tab tersembunyi; melanjutkan dari batas terkredit. Semua ini hanya kenyamanan: penentu selesai adalah server (discovery §8.4).

## 8. Audit (ke `training_audit_events`)

`training.module.created`, `training.module.updated`, `training.module.published`, `training.module.archived`, `training.material.created`, `training.material.removed`, `training.material.video_uploaded`, `training.material.completed` (metadata `via`: `WATCHED`/`READ`/`HC_MANUAL`; alasan sebagai `note` untuk manual), `training.quiz.attempted` (skor, lulus; tanpa jawaban), `training.record.created` (penyelesaian program daring). Detak tidak diaudit per detak.

## 9. Penyimpanan (migrasi `0155`)

```text
training_programs.delivery          kolom baru, bawaan CLASSROOM
training_modules                    modul; salinan butir kuis (jsonb)
training_materials                  materi; kunci objek, ukuran, durasi, sha256 (tanpa isi berkas)
training_material_progress          batas terkredit per peserta per materi, selesai
training_playbacks                  sesi tonton
training_quiz_attempts              percobaan kuis dengan skor
```

Isi video ada di `ObjectStorage`, bukan database. Rollback `-- Down:` di berkas migrasi; objek video dihapus terpisah dari direktori media.

## 10. API

Pegawai: `GET /training/me/programs/:id/modules`, `POST /training/me/materials/:id/playbacks`, `POST /training/me/playbacks/:id/heartbeat`, `GET /training/me/materials/:id/stream`, `POST /training/me/materials/:id/read`, `GET /training/me/modules/:id/quiz`, `POST /training/me/modules/:id/quiz/attempts`.

HC: `GET /admin/training/online/storage`, `GET|POST /admin/training/programs/:id/modules`, `PATCH /admin/training/modules/:id`, `POST /admin/training/modules/:id/publish`, `POST /admin/training/modules/:id/archive`, `POST /admin/training/modules/:id/materials`, `POST /admin/training/materials/:id/remove`, `PUT /admin/training/materials/:id/video`, `GET /admin/training/materials/:id/stream`, `GET /admin/training/programs/:id/online-progress`, `POST /admin/training/materials/:id/progress/:employeeId/complete`.

Kontrak: `docs/api/training-online.openapi.yaml`. Modul per program dibatasi M-02 (≤ 20 modul × 20 materi, daftar terbatas); progres per peserta berhalaman (ENG-LIST-001).

## 11. Kapasitas dan penyimpanan untuk mengaktifkan R4

Perkiraan dari discovery §8.2 dengan ±100 peserta:

| Ukuran | 480p (±0,8 Mbps) | 720p (±1,5 Mbps) |
| --- | --- | --- |
| Per jam materi (disk) | ±360 MB | ±650 MB |
| Kuota bawaan 5 GB memuat | ±14 jam materi | ±7–8 jam materi |
| Lalu lintas keluar 1 jam materi × 100 peserta | ±36 GB | ±65 GB |
| 10 penonton bersamaan | ±8 Mbps | ±15 Mbps |

Syarat menyalakan `TRAINING_ONLINE_ENABLED=1` di production (keputusan owner, bukan otomatis):

1. Direktori media `TRAINING_MEDIA_DIR` di volume dengan ruang kosong ≥ kuota + 20%, **di luar** direktori rilis (rilis Mi8VPS berganti direktori per versi).
2. Kebijakan backup video terpisah dari backup database harian (video tidak dimasukkan ke backup harian off-host).
3. Bandwidth keluar dan, bila di belakang Cloudflare Tunnel, kepatuhan ketentuan lalu lintas video (discovery §8.3, `TBD`).
4. Batas ukuran dan kuota disetel sesuai ruang nyata (`TRAINING_VIDEO_MAX_BYTES`, `TRAINING_MEDIA_QUOTA_BYTES`).

Untuk Mi8VPS lite, rekomendasi: tetap mati; nyalakan setelah pindah server atau setelah volume media terpisah tersedia. Port `ObjectStorage` memungkinkan adaptor S3 ditambahkan tanpa mengubah domain.

## 12. Acceptance criteria

- TRAIN-R4-A: dengan sakelar mati, semua rute R4 menjawab 404 `TRAINING_ONLINE_DISABLED` dan program daring tidak dapat dibuat.
- TRAIN-R4-B: video lebih besar dari batas → 413; bukan MP4 → 400 dan tidak tersimpan; kuota terlampaui → 507.
- TRAIN-R4-C: aliran video hanya untuk peserta terdaftar dengan sesi tonton aktif miliknya; orang lain 404; tanpa `Range` 416; respons 206 dengan `Content-Range` dan paling banyak 4 MB.
- TRAIN-R4-D: detak yang maju lebih cepat dari waktu nyata atau melompati batas terkredit tidak menambah kredit; detak wajar menambah kredit; selesai pada 95%.
- TRAIN-R4-E: kuis terkunci sampai semua materi selesai; tidak ada kunci di respons; paling banyak 3 percobaan; nilai tertinggi dipakai.
- TRAIN-R4-F: menyelesaikan semua modul membuat tepat satu catatan terverifikasi dengan jam Σ `creditHours`, yang masuk rekap jam tahunan.
- TRAIN-R4-G: modul terbit terkunci; penandaan selesai manual memerlukan alasan dan diaudit.
- TRAIN-R4-H: adaptor `ObjectStorage` lokal dan palsu lulus contract test yang sama (ADR-0002).

## 13. Asumsi DRAFT yang perlu dikonfirmasi pemilik produk

| # | Pertanyaan | Default yang dipakai |
| --- | --- | --- |
| M-02 | Berapa jam kredit sebuah modul? | Diisi HC per modul (0,25–40 jam) |
| M-04 | Batas ukuran dan kuota video? | 300 MB per berkas, 5 GB total |
| M-09 | Seberapa ketat pembatasan unduhan? | Range wajib, 4 MB per respons, token sesi tonton; tidak dapat mencegah perekaman layar |
| M-10 | Toleransi kredit? | ×1,25 waktu nyata + 2 detik, maks 30 detik per detak |
| M-11 | Ambang selesai menonton? | 95% durasi |
| M-13 | Aturan kuis? | Lulus 70, 3 percobaan, nilai tertinggi |
| M-14 | Tanggal catatan daring? | Mulai = tanggal didaftarkan, selesai = tanggal menyelesaikan |
| M-15 | Peserta daring yang belum selesai saat program ditutup? | `INCOMPLETE` tanpa catatan |
