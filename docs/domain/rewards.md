# Penghargaan Pegawai

**Status:** ACCEPTED (desain Paket 1). Product Owner menyetujui arah dan rekomendasinya pada 2026-11-13. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal.
**Implementasi:** Paket 1 sisi HCIS selesai 2026-11-17 (§13). Aplikasi Al-Qur'an R1 (SQ Hub `QURAN-IMPL-001`) belum hidup, jadi sumber berstatus **belum tersedia** (`NOT_CONFIGURED`) dan layar mengatakannya. Sampai sumber tersambung, HC dapat mengimpor snapshot bulanan dari CSV sebagai jalur sementara (R-14 DRAFT). Kontrak yang HCIS butuhkan dari aplikasi Al-Qur'an ada di §12.
**Spesifikasi:** REWARD-001
**Tanggal:** 2026-11-13, implementasi 2026-11-17
**Terkait:** SQ Hub ADR-0013 dan QURAN-001 (`docs/product/quran-module-design.md` di repo SQ Hub), PERF-001, NOTIF-002, NOTIF-004, AUTH-011, ENG-LIST-001, ORG-002, ASSET-001 (pola klien antar-aplikasi)
**Roadmap:** `docs/product/hcis-capability-map.md` §4, `docs/product/feature-parity.yaml` (REWARD-001)
**Kontrak HTTP:** `docs/api/rewards.openapi.yaml`

## 1. Tujuan

Yayasan memberi **penghargaan** kepada pegawai yang paling istiqamah membaca Al-Qur'an, berdasarkan **papan skor** aplikasi Al-Qur'an. HCIS adalah tempat penghargaan itu ditetapkan, diumumkan, dan dicatat dalam riwayat pegawai.

Paket 1 menghasilkan:

- putaran penghargaan bulanan yang kandidatnya diambil otomatis dari snapshot papan skor bulanan;
- penetapan penerima oleh Kepala HCM, dengan alasan untuk kandidat yang tidak ditetapkan;
- pengumuman ke seluruh pegawai dan notifikasi ke penerima;
- sertifikat PDF untuk setiap penerima, dengan kode verifikasi publik;
- riwayat penghargaan pegawai dan daftar penerima yang bisa dilihat semua pegawai;
- menu **Al-Qur'an** yang membuka aplikasi Al-Qur'an (tautan, bukan data).

## 2. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| R-01 | Data tilawah **tidak masuk penilaian kinerja** (PERF-001), tetapi **masuk penghargaan** | ACCEPTED (Product Owner, 2026-11-13) |
| R-02 | Penghargaan **hanya berdasarkan papan skor** aplikasi Al-Qur'an | ACCEPTED (Product Owner, 2026-11-13) |
| R-03 | Putaran **bulanan**. Kandidat: **3 teratas seluruh yayasan** dan **1 teratas tiap unit**. Papan pekanan dan sepanjang masa hanya untuk tampilan | ACCEPTED (rekomendasi disetujui 2026-11-13) |
| R-04 | Sistem menyusun kandidat; **Kepala HCM menetapkan** penerima. Setiap penetapan tercatat di audit | ACCEPTED (rekomendasi disetujui 2026-11-13) |
| R-05 | Bentuk penghargaan **sertifikat dan pengumuman**, **belum uang**. Tidak ada komponen payroll | ACCEPTED (rekomendasi disetujui 2026-11-13) |
| R-06 | "Unit" untuk kandidat per unit adalah **unit papan skor** yang dipelihara di aplikasi Al-Qur'an (`quran_scoreboard_units`, QURAN-001 §9.1), dirujuk dengan `hcis:org-node:<stable_key>` | DRAFT |
| R-07 | Seorang pegawai yang menjadi kandidat yayasan dan kandidat unit sekaligus hanya menerima **satu** penghargaan, yaitu kategori yayasan. Kursi unitnya turun ke peringkat berikutnya di unit itu | DRAFT |
| R-08 | Kandidat yang tidak ditetapkan **tidak otomatis** digantikan. Kepala HCM boleh mengambil peringkat berikutnya **dari snapshot yang sama**; ia tidak bisa menambah orang di luar papan skor | DRAFT |
| R-09 | Pengambil keputusan tidak boleh memutuskan dirinya sendiri. Bila Kepala HCM menjadi kandidat, pemegang role `human_capital_admin` boleh memutuskan **kandidat itu saja** | DRAFT |
| R-10 | Kandidat dengan skor yang sebagian dari catatan *otomatis* atau *mandiri* tetap sah; labelnya ditampilkan di layar penetapan supaya Kepala HCM bisa menilai | DRAFT |
| R-11 | Bila ada peringkat sama di batas kursi (misalnya dua orang sama-sama peringkat 3 setelah penentu S-07 QURAN-001), **semua yang sama** menjadi kandidat untuk kursi itu | DRAFT |
| R-12 | Pengumuman diterbitkan atas nama Kepala HCM yang menerbitkan putaran. Nama penerima dan kategorinya adalah pengecualian tertulis atas NOTIF-002 N-10; angka skor tetap tidak dimuat | DRAFT |
| R-13 | HCIS menyimpan **seluruh snapshot bulanan yang diterima** (peringkat dan angka per cakupan, tanpa nama atau catatan tilawah) di `reward_snapshot_rows`, supaya "Ambil peringkat berikutnya" membaca snapshot yang sama tanpa bertanya lagi ke sumber dan menjadi bukti R-08 | DRAFT (agent, 2026-11-17) |
| R-14 | **Impor snapshot manual (CSV)** oleh HC sebagai jalur sementara: hanya terbuka selama sumber Al-Qur'an **belum dikonfigurasi**; permission `reward.import` (HC Admin); seluruh berkas ditolak bila satu baris salah; putaran bertanda **Impor manual CSV (sementara)**; pengimpor **tidak boleh memutuskan** kandidat dari snapshot yang ia impor (403 `REWARD_IMPORTER_DECISION`). Jalur ini tertutup otomatis begitu `QURAN_*` diisi | DRAFT (agent, 2026-11-17) |
| R-15 | Satu orang hanya satu kandidasi per putaran. Papan unit dibaca menurut urutan snapshot; orang yang sudah menjadi kandidat di papan sebelumnya dilewati, sehingga kursi turun ke peringkat berikutnya | DRAFT (agent, 2026-11-17) |
| R-16 | Baris dengan halaman 0 tidak pernah menjadi kandidat (QURAN-001 §9.2 tidak memberi baris untuk skor 0) | DRAFT (agent, 2026-11-17) |
| R-17 | Menu **Al-Qur'an** di HCIS (navigasi pegawai dan Semua Layanan) adalah tautan ke `https://quran.sabilulquran.or.id`, dibuka di tab yang sama dengan SSO senyap (QURAN-001 §2). HCIS tidak menampilkan data bacaan | DRAFT (agent, 2026-11-17) |
| R-18 | Efek penerbitan dicoba sampai 8 kali dengan jeda 5 menit yang berlipat (maks. 6 jam), lalu berstatus gagal dan menunggu **Kirim ulang** | DRAFT (agent, 2026-11-17) |
| R-19 | Pencabutan juga tunduk pada R-09: pemegang `reward.manage` tidak mencabut penghargaannya sendiri | DRAFT (agent, 2026-11-17) |

Program lain (misalnya kehadiran) bisa ditambahkan kelak sebagai **program** baru, masing-masing dengan spesifikasinya sendiri. Paket 1 hanya punya program **Tilawah**.

## 3. Aktor

| Aktor | Peran |
| --- | --- |
| Sistem | Mengambil snapshot bulanan, menyusun kandidat, mengirim notifikasi, membuat sertifikat |
| Kepala HCM (`reward.manage`) | Menyusun ulang, menetapkan atau tidak menetapkan kandidat, mengambil peringkat berikutnya, menerbitkan, membatalkan putaran, mencabut |
| HC Admin (`reward.read`, `reward.import`) | Melihat putaran dan kandidat; mengimpor snapshot CSV selama sumber belum tersedia (R-14); memutuskan kandidat Kepala HCM (R-09) |
| Pegawai | Melihat daftar penerima yang sudah terbit, riwayat dan sertifikat miliknya, membuka aplikasi Al-Qur'an |
| Publik | Memeriksa keaslian sertifikat dengan kodenya |

## 4. Alur

### 4.1 Menyusun putaran

- **Pemicu:** setiap tanggal 3 pukul 06.00 WIB, sesudah papan bulanan final (QURAN-001 §9.3). Penjadwal berjalan di proses API tiap 10 menit, di balik saklar yang sama dengan penjadwal lain (`MEETING_RUNNER_ENABLED`). Kepala HCM juga bisa memicu manual (**Susun ulang**) untuk bulan yang sudah final.
- **Precondition:** program Tilawah aktif; belum ada putaran yang tidak dibatalkan untuk bulan itu. Penjadwal hanya menyusun bila belum ada putaran **apa pun** untuk bulan itu; sesudah pembatalan, hanya orang yang menyusun ulang.
- **Langkah:**
  1. HCIS memanggil `GET /internal/quran/v1/scoreboards/monthly?month=YYYY-MM` sekali (kontrak §12). Panggilan memakai identitas layanan HCIS (client-credentials, audiens `sq-hub-quran`, scope `quran.scoreboard.read`).
  2. Snapshot disimpan utuh sebagai bukti (R-13). Setiap `personId` (`hcis:employee:<uuid>`) dipetakan ke `employees.id`.
  3. Kandidat disusun menurut R-03, R-07, R-11, R-15, dan R-16, beserta peringkat, halaman, hari aktif, khatam, label, versi snapshot, versi Directory, dan tanda `directory_stale`. Bila tanda itu menyala, layar penetapan menampilkannya.
  4. Putaran tersimpan dengan status `PENDING_DECISION`, audit `reward.round.created`, notifikasi in-app ke pemegang `reward.manage`.
- **Gagal:**
  - Sumber **belum dikonfigurasi** (`NOT_CONFIGURED`): tidak ada percobaan otomatis. Layar menampilkan "Sumber belum tersedia"; **Susun ulang** menjawab 409 `REWARD_SOURCE_NOT_CONFIGURED`; jalur R-14 terbuka.
  - Aplikasi Al-Qur'an tidak bisa dihubungi (`UNAVAILABLE`): dicoba ulang tiap jam selama 3 hari. Layar admin menampilkan "Papan skor belum bisa diambil". Tidak ada putaran setengah jadi. Sesudah 3 hari percobaan otomatis berhenti, pemegang `reward.manage` menerima notifikasi, dan tombol **Susun ulang** tetap tersedia (409 `REWARD_SOURCE_UNAVAILABLE` bila masih gagal; bukan 5xx).
  - Bulan belum final (`409 period_not_final` dari sumber, atau bulan yang menurut HCIS belum final): ditunggu, tidak dianggap galat.
  - `personId` tidak dikenal atau pegawainya tidak aktif: kandidat tetap tercatat dengan tanda **tidak bisa ditetapkan** (`UNRESOLVED`, alasan `UNKNOWN_PERSON` atau `INACTIVE_EMPLOYEE`), dan kursinya bisa diisi peringkat berikutnya (R-08).
  - Papan skor kosong: putaran tersimpan tanpa kandidat dan langsung bisa dibatalkan.
  - Jawaban sumber yang tidak cocok dengan kontrak §12 (bulan lain, field asing, peringkat tidak urut, orang ganda) dianggap `UNAVAILABLE`; HCIS **tidak pernah** menyusun kandidat dari jawaban itu.

### 4.1a Impor snapshot manual (R-14 DRAFT)

- **Aktor:** HC Admin (`reward.import`).
- **Precondition:** sumber belum dikonfigurasi; bulan sudah final; belum ada putaran hidup untuk bulan itu.
- **Input:** bulan, catatan sumber data (5–500 karakter), berkas CSV dengan kolom `cakupan,peringkat,nip,halaman,hari_aktif,khatam,label`. `cakupan` berisi `YAYASAN` atau unit (`hcis:org-node:<stable_key>`, stable key saja, atau nama persis unit di struktur terbit hari ini). `label` kosong, `otomatis`, `mandiri`, atau `otomatis|mandiri`. Pemisah koma atau titik koma; halaman boleh memakai koma desimal.
- **Validasi:** baris judul persis; papan `YAYASAN` wajib ada; NIP harus dikenal HCIS; unit harus dikenal dan unik; tidak ada NIP ganda dalam satu cakupan. Satu masalah menolak seluruh berkas (400 `INVALID_REWARD_IMPORT` dengan nomor baris).
- **Hasil:** satu transaksi: `reward_snapshot_imports` (hash SHA-256, jumlah baris, catatan, pengimpor; berkasnya tidak disimpan), audit `reward.snapshot.imported`, lalu putaran seperti §4.1 langkah 2–4 dengan `source_kind = MANUAL_IMPORT` dan versi `manual:sha256:<hash>`.
- **Batas:** pengimpor tidak boleh memutuskan kandidat dari snapshot itu; keputusan tetap pada Kepala HCM.

### 4.2 Menetapkan

Kepala HCM membuka putaran dan, untuk setiap kandidat:

- **Tetapkan** → kandidat `AWARDED`, audit `reward.candidate.awarded`.
- **Tidak ditetapkan** dengan alasan 5–500 karakter → `DECLINED`, audit `reward.candidate.declined`.
- **Ambil peringkat berikutnya** untuk kursi yang kosong (`DECLINED` atau `UNRESOLVED`) → kandidat baru dari snapshot yang sama, audit `reward.candidate.replacement_added`. Peringkat sama ikut bersama (R-11). Satu kursi hanya bisa diisi sekali; kandidat yang kursinya sudah diisi tidak bisa ditetapkan lagi (409 `REWARD_CANDIDATE_LOCKED`).

Keputusan bisa diubah (`AWARDED` ↔ `DECLINED`) selama putaran masih `PENDING_DECISION`; setiap perubahan teraudit (`reward.candidate.decision_changed`). Pengambil keputusan tidak boleh kandidat itu sendiri (R-09): 403 `REWARD_SELF_DECISION`. Pegawai yang tidak lagi aktif tidak bisa ditetapkan (409 `REWARD_CANDIDATE_UNRESOLVED`).

Kandidat `UNRESOLVED` tidak bisa ditetapkan. Kursinya bisa diisi lewat **Ambil peringkat berikutnya**, atau dibiarkan kosong; ia tidak menghalangi penerbitan.

### 4.3 Menerbitkan

- **Precondition:** status `PENDING_DECISION`; setiap kandidat `CANDIDATE` sudah menjadi `AWARDED` atau `DECLINED` (kandidat `UNRESOLVED` boleh tetap); minimal satu `AWARDED`; semua penerima masih aktif. Lainnya 409 `REWARD_ROUND_NOT_READY`.
- **Hasil:** dalam satu transaksi: status `PUBLISHED`, penghargaan dibuat (nama penerima dan label kategori dibekukan), audit `reward.round.published`, dan tugas efek samping dicatat di `reward_outbox`. Efek dikerjakan sesudah commit dan oleh penjadwal, dengan percobaan ulang (R-18); kegagalan efek samping tidak membatalkan penerbitan dan tampil di layar putaran sebagai "Belum terkirim" dengan tombol **Kirim ulang**. Efeknya:
  - notifikasi in-app ke setiap penerima (NOTIF-004);
  - pengumuman ke seluruh pegawai aktif (NOTIF-002) berisi nama penerima dan kategorinya, **tanpa** angka skor (R-12);
  - sertifikat PDF untuk setiap penerima: nama, kategori ("Terbaik Tilawah Yayasan — Peringkat 1", "Terbaik Tilawah SMPIT"), bulan, nama Kepala HCM, kode verifikasi acak 130 bit, dan tautan pemeriksaan `/verifikasi/penghargaan/<kode>`;
  - penghargaan muncul di riwayat pegawai.
- Putaran yang sudah terbit **tidak bisa diubah**. Kesalahan dikoreksi dengan **mencabut** satu penghargaan (alasan wajib, audit `reward.award.revoked`, R-19). Penghargaan yang dicabut tetap ada di audit, hilang dari daftar penerima, sertifikatnya tidak bisa diunduh lagi, dan pemeriksaan publik menyatakannya **dicabut**.

### 4.4 Membatalkan

Putaran `PENDING_DECISION` bisa dibatalkan dengan alasan → `CANCELLED`, audit `reward.round.cancelled`. Bulan yang sama lalu bisa disusun ulang.

## 5. Status

| Objek | Status | Transisi |
| --- | --- | --- |
| Putaran | `PENDING_DECISION` → `PUBLISHED` atau `CANCELLED` | §4.1–4.4 |
| Kandidat | `CANDIDATE` → `AWARDED` atau `DECLINED`, dan `AWARDED` ↔ `DECLINED` selama putaran `PENDING_DECISION`; `UNRESOLVED` bila tidak bisa ditetapkan (status akhir) | §4.1–4.2 |
| Penghargaan | `ACTIVE` → `REVOKED` | §4.3 |
| Efek penerbitan | `PENDING` → `DONE`, atau `FAILED` sesudah 8 percobaan; **Kirim ulang** mengembalikan ke `PENDING` | §4.3 |

## 6. API

| Rute | Permission | Input | Galat |
| --- | --- | --- | --- |
| `GET /admin/rewards/source` | `reward.read` | — | 403 `REWARD_FORBIDDEN`; status sumber dijawab 200 (`NOT_CONFIGURED`, `UNAVAILABLE`, `NOT_FINAL`, `AVAILABLE`) |
| `GET /admin/rewards/rounds` | `reward.read` | `page`, `pageSize`, `status`, `month` | 403 `REWARD_FORBIDDEN` |
| `GET /admin/rewards/rounds/{id}` | `reward.read` | — | 404 `REWARD_ROUND_NOT_FOUND` |
| `GET /admin/rewards/rounds/{id}/events` | `reward.read` | `page`, `pageSize` | — |
| `POST /admin/rewards/rounds` | `reward.manage` | `month` (bulan final) | 409 `REWARD_ROUND_EXISTS`, 409 `REWARD_PERIOD_NOT_FINAL`, 409 `REWARD_SOURCE_NOT_CONFIGURED`, 409 `REWARD_SOURCE_UNAVAILABLE` |
| `POST /admin/rewards/imports` | `reward.import` | `month`, `note`, `csv` | 400 `INVALID_REWARD_IMPORT` (dengan `problems`), 409 `REWARD_MANUAL_IMPORT_CLOSED`, 409 `REWARD_PERIOD_NOT_FINAL`, 409 `REWARD_ROUND_EXISTS` |
| `POST /admin/rewards/candidates/{id}/award` | `reward.manage`, atau jalur R-09 | — | 403 `REWARD_SELF_DECISION`, 403 `REWARD_IMPORTER_DECISION`, 409 `REWARD_CANDIDATE_LOCKED`, 409 `REWARD_CANDIDATE_UNRESOLVED` |
| `POST /admin/rewards/candidates/{id}/decline` | `reward.manage`, atau jalur R-09 | `reason` 5–500 | sama |
| `POST /admin/rewards/candidates/{id}/next-rank` | `reward.manage` | — | 409 `REWARD_CANDIDATE_LOCKED`, 409 `REWARD_NO_NEXT_RANK` |
| `POST /admin/rewards/rounds/{id}/publish` | `reward.manage` | — | 409 `REWARD_ROUND_NOT_READY` |
| `POST /admin/rewards/rounds/{id}/cancel` | `reward.manage` | `reason` 5–500 | 409 `REWARD_ROUND_NOT_CANCELLABLE` |
| `POST /admin/rewards/awards/{id}/revoke` | `reward.manage` | `reason` 5–500 | 403 `REWARD_SELF_DECISION`, 409 `REWARD_AWARD_ALREADY_REVOKED` |
| `POST /admin/rewards/outbox/{id}/retry` | `reward.manage` | — | 409 `REWARD_EFFECT_DONE` |
| `GET /rewards/recipients` | pegawai aktif | `page`, `pageSize`, `month` | — |
| `GET /me/rewards`, `GET /me/rewards/{id}/certificate` | pegawai pemilik | `page`, `pageSize` | 404 untuk milik orang lain atau yang dicabut; 409 `REWARD_CERTIFICATE_NOT_READY` |
| `GET /public/rewards/verify/{code}` | publik | — | 404 `REWARD_CERTIFICATE_NOT_FOUND`, 429 `RATE_LIMITED` |

Input tidak valid dijawab 400 `INVALID_REWARD_REQUEST`. Kontrak OpenAPI: `docs/api/rewards.openapi.yaml`. Rute award/decline tercatat di manifest AUTH-011 dengan `reward.read` sebagai lantai; handler memeriksa `reward.manage` atau jalur R-09. Kode verifikasi di URL publik tidak masuk log API maupun log server SPA.

Sumber yang bermasalah **tidak pernah** dijawab 5xx (pola ASSET-001): spesifikasi awal menulis 503 untuk `REWARD_SOURCE_UNAVAILABLE`; implementasi memakai 409 dengan kode yang sama supaya layar membedakan "sumber bermasalah" dari galat HCIS.

## 7. Permission

| Permission | Arti | Pembawa |
| --- | --- | --- |
| `reward.read` | Melihat putaran, kandidat, sumber, dan audit penghargaan | `human_capital_admin`, `human_capital_lead` |
| `reward.import` | Mengimpor snapshot CSV selama sumber belum tersedia (R-14) | `human_capital_admin` (DRAFT) |
| (jalur R-09) | Memutuskan kandidat yang merupakan Kepala HCM, hanya kandidat itu | `human_capital_admin` |
| `reward.manage` | Menyusun ulang, menetapkan, menerbitkan, membatalkan, mencabut, kirim ulang | `human_capital_lead` (Kepala HCM) (DRAFT) |

- Migration `0154_reward_permissions.sql`, berscope organisasi. Super Admin tidak menerimanya lewat kompatibilitas legacy.
- Setiap permission punya tes otomatis, termasuk 403 untuk pegawai biasa dan untuk keputusan atas diri sendiri.
- Pegawai biasa hanya melihat daftar penerima yang sudah terbit dan riwayat miliknya sendiri.

## 8. Data

Migration `0153_rewards.sql`, tabel baru saja.

| Tabel | Isi |
| --- | --- |
| `reward_programs` | kode (`TILAWAH`), nama, sumber (`al-quran.monthly-scoreboard`), aktif |
| `reward_fetch_attempts` | percobaan otomatis per bulan: jumlah, kegagalan pertama, percobaan terakhir, hasil (kode singkat), waktu berhenti |
| `reward_snapshot_imports` | impor CSV R-14: bulan, hash SHA-256, jumlah baris, catatan, pengimpor |
| `reward_rounds` | program, bulan, status, jenis sumber (`QURAN_API`/`MANUAL_IMPORT`), versi snapshot, versi dan `asOf` Directory, `directory_stale`, waktu ambil, pembuat (kosong = sistem), alasan batal, diterbitkan oleh/pada, pengumuman |
| `reward_snapshot_rows` | snapshot yang diterima (R-13): cakupan, unit, `personId`, pegawai, peringkat, halaman, hari aktif, khatam, label |
| `reward_candidates` | putaran, kategori (`FOUNDATION`, `UNIT`), unit, kursi, peringkat, angka dan label dari snapshot, pegawai, status, alasan, diputuskan oleh/pada, kandidat yang digantikan |
| `reward_awards` | pegawai, kandidat asal, kategori dan labelnya, nama penerima, bulan, kode verifikasi sertifikat, status, alasan cabut, PDF sertifikat |
| `reward_outbox` | putaran, penghargaan, jenis efek (notifikasi, pengumuman, sertifikat), status, percobaan, galat terakhir (kode singkat) |
| `reward_audit_events` | semua event §4 |

Angka skor disalin dari snapshot sebagai **bukti** saat putaran disusun, tidak dihitung ulang di HCIS. Rollback: tabel baru saja, tanpa mengubah tabel lain; perintah `DROP` ada di kepala migration dan hanya dipakai sebelum putaran pertama terbit (sesudahnya register penghargaan diekspor dulu).

## 9. Layar

| Layar | Siapa | Isi |
| --- | --- | --- |
| Admin → Penghargaan (`/admin/rewards`) | `reward.read` | Status sumber, daftar putaran per bulan dengan status; pagination server-side (ENG-LIST-001). **Susun ulang** untuk `reward.manage` bila sumber dikonfigurasi; **Impor snapshot** untuk `reward.import` bila belum |
| Detail putaran | `reward.read`, aksi untuk `reward.manage` (dan R-09) | Kandidat per kursi dengan angka, label otomatis/mandiri, sumber dan versi snapshot, tanda Directory tertinggal dan impor manual, tombol Tetapkan, Tidak ditetapkan, Ambil peringkat berikutnya, Terbitkan, Batalkan, Cabut, Kirim ulang; jejak audit berhalaman |
| Penghargaan (pegawai, `/app/rewards`) | semua pegawai | Tautan Al-Qur'an, riwayat saya dengan unduh sertifikat, penerima yang sudah terbit per bulan dan kategori; pagination server-side (ENG-LIST-001) |
| Menu Al-Qur'an | semua pegawai | Tautan ke aplikasi Al-Qur'an di navigasi pegawai dan Semua Layanan (R-17) |
| Verifikasi sertifikat (`/verifikasi/penghargaan/<kode>`) | publik dengan kode | Nama, kategori, bulan, dan status sah atau dicabut; tanpa data lain. Dibatasi laju per alamat IP (DRAFT: 30 permintaan per menit) |

State yang diperiksa: loading, kosong ("Belum ada putaran"), sumber belum tersedia ("Sumber belum tersedia"), galat sumber ("Papan skor belum bisa diambil"), forbidden, dan tampilan HP.

Kandidat dalam detail putaran tidak berhalaman: jumlahnya dibatasi kursi putaran (3 kursi yayasan, satu per unit papan skor, ditambah seri dan pengganti). Ini pengecualian tertulis atas ENG-LIST-001.

## 10. Batas

- Tidak menjadi masukan PERF-001 dan tidak menjadi komponen payroll atau tunjangan (R-01, R-05).
- HCIS tidak menyimpan catatan tilawah, tanda ayat, atau papan skor harian. HCIS hanya menyimpan salinan snapshot bulanan yang diterima (peringkat dan angka, R-13) sebagai bukti.
- HCIS tidak menulis apa pun ke aplikasi Al-Qur'an.

## 11. Kriteria penerimaan Paket 1

1. Putaran bulanan tersusun otomatis sesudah papan bulanan final, dengan kandidat sesuai R-03 dan R-07.
2. Kandidat tidak bisa ditambahkan dari luar snapshot.
3. Penetapan, penolakan, penggantian, penerbitan, pembatalan, pencabutan, dan impor manual menghasilkan audit event.
4. Keputusan atas diri sendiri ditolak, dan jalur R-09 hanya berlaku untuk kandidat Kepala HCM.
5. Penerbitan mengirim notifikasi, pengumuman, dan sertifikat; putaran terbit tidak bisa diubah.
6. Pegawai biasa tidak bisa membuka layar admin (tes permission).
7. Kegagalan sumber tidak menghasilkan putaran setengah jadi.
8. Selama sumber belum dikonfigurasi, layar menyatakan "Sumber belum tersedia" dan tidak ada kandidat yang dikarang.

Bukti: `apps/api/test/rewards.test.ts` (aturan, adaptor, PDF, penjaga rute), `apps/api/test/rewards.postgres.test.ts` (alur penuh di skema nyata, penjadwal, impor manual), `apps/web/src/pages/Rewards.test.tsx`, manifest AUTH-011.

## 12. Kontrak snapshot v1 untuk aplikasi Al-Qur'an (catatan untuk tim SQ Hub)

Ini kontrak yang **HCIS butuhkan** dari QURAN-001 §11.3 agar REWARD-001 berjalan. HCIS memvalidasinya dengan ketat (`apps/api/src/modules/rewards/quran-scoreboard-client.ts`); jawaban lain diperlakukan sebagai sumber tidak tersedia, bukan sebagai kandidat.

**Permintaan**

```
GET {QURAN_SCOREBOARD_URL}/internal/quran/v1/scoreboards/monthly?month=YYYY-MM
Authorization: Bearer <token client-credentials realm sq-staff>
Accept: application/json
```

- Token: client khusus HCIS (usulan nama `hcis-quran-scoreboard`), grant client-credentials, parameter `audience=sq-hub-quran` dan `scope=quran.scoreboard.read`. Aplikasi Al-Qur'an menerima token hanya bila audiens dan scope cocok dan client terdaftar sebagai konsumen; setiap pembacaan dicatat di `quran_audit`.
- Batas waktu HCIS 10 detik per permintaan.

**Jawaban 200** (`application/json`, tanpa field lain):

```json
{
  "schemaVersion": 1,
  "month": "2026-10",
  "snapshotVersion": "string, 1–200 karakter, tetap untuk snapshot yang sama",
  "finalizedAt": "2026-11-02T17:00:00.000Z",
  "directory": { "version": "string", "asOf": "2026-11-02T16:00:00.000Z", "stale": false },
  "scopes": [
    {
      "scope": "FOUNDATION",
      "unitId": null,
      "entries": [
        {
          "personId": "hcis:employee:<uuid huruf kecil>",
          "unitId": "hcis:org-node:<uuid> atau null",
          "rank": 1,
          "pages": 120.5,
          "activeDays": 25,
          "khatam": 1,
          "labels": ["AUTO", "SELF_REPORTED"]
        }
      ]
    },
    { "scope": "UNIT", "unitId": "hcis:org-node:<uuid>", "entries": [] }
  ]
}
```

Aturan yang diperiksa HCIS:

| Field | Aturan |
| --- | --- |
| `schemaVersion` | tepat `1`; perubahan yang tidak kompatibel menaikkan versi |
| `month` | sama dengan bulan yang diminta |
| `snapshotVersion` | stabil: permintaan ulang untuk bulan yang sama mengembalikan versi yang sama selama snapshot tidak diganti |
| `directory` | versi dan `asOf` Organization Directory yang dipakai, `stale` sesuai QURAN-001 §9.4 |
| `scopes` | tepat satu `FOUNDATION` dengan `unitId: null`; nol atau lebih `UNIT` dengan `unitId` unik dari `quran_scoreboard_units`; paling banyak 201 cakupan |
| `entries` | urut menurut `rank` menaik; satu orang sekali per cakupan; paling banyak 5.000 baris per cakupan; orang dengan skor 0 **tidak** diberi baris |
| `rank` | bilangan bulat ≥ 1, peringkat bersama sesudah penentu S-07 (hari aktif, lalu khatam) boleh sama |
| `pages` | ≥ 0, paling banyak satu desimal |
| `activeDays` | 0–31; `khatam` 0–1000 |
| `labels` | subset `AUTO` (catatan otomatis) dan `SELF_REPORTED` (catatan mandiri) |
| tanpa | nama, NIP, `sub`, jam membaca, rentang ayat |

**Jawaban lain**

| Kondisi | Jawaban yang diharapkan | Perlakuan HCIS |
| --- | --- | --- |
| Bulan belum final | `409 {"code":"period_not_final"}` | menunggu, bukan galat |
| Token salah | `401` | token dibuang, dicoba lagi pada percobaan berikutnya |
| Lainnya | `4xx`/`5xx` apa pun | sumber tidak tersedia; dicoba tiap jam selama 3 hari |

**Konfigurasi HCIS** (semua atau tidak sama sekali, `AUTH_MODE=oidc`): `QURAN_SCOREBOARD_URL` (origin SQ Hub, tanpa query), `QURAN_MACHINE_CLIENT_ID`, `QURAN_MACHINE_CLIENT_SECRET`, opsional `QURAN_SCOREBOARD_AUDIENCE` (bawaan `sq-hub-quran`). Client harus khusus; HCIS menolak memakai client SQ Hub, Aset SQ, atau login HCIS. Begitu diisi, impor manual R-14 tertutup.

## 13. Implementasi Paket 1 (2026-11-17)

- API: `apps/api/src/modules/rewards/` (`domain.ts` aturan murni, `quran-scoreboard-client.ts` port dan adaptor, `service.ts` penyusunan putaran, outbox, penjadwal, `certificate-pdf.ts` PDF tanpa dependensi, `routes.ts`).
- Web: `apps/web/src/pages/AdminRewardsPage.tsx`, `EmployeeRewardsPage.tsx`, `PublicRewardVerifyPage.tsx`, `apps/web/src/lib/rewards.ts`; menu Al-Qur'an di `layouts/AppShell.tsx` dan `lib/employeeServices.ts`.
- Migration `0153_rewards.sql`, `0154_reward_permissions.sql`; manifest `docs/domain/AUTH-011-admin-route-permissions.json`.
- Rilis: tanpa `QURAN_*` di `final.env`, fitur berjalan dengan sumber "belum tersedia" dan jalur CSV. Mengaktifkan sumber cukup mengisi tiga nilai itu sesudah client `hcis-quran-scoreboard` dibuat di realm `sq-staff` dan QURAN-IMPL-001 R1 hidup.
