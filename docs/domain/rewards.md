# Penghargaan Pegawai

**Status:** ACCEPTED (desain Paket 1). Product Owner menyetujui arah dan rekomendasinya pada 2026-11-13. Aturan bisnis yang belum tertulis ditandai `DRAFT` dan memakai default paling masuk akal. Implementasi menunggu modul Al-Qur'an R1 (SQ Hub `QURAN-IMPL-001`) menghasilkan snapshot bulanan pertama.
**Spesifikasi:** REWARD-001
**Tanggal:** 2026-11-13
**Terkait:** SQ Hub ADR-0013 dan QURAN-001 (`docs/product/quran-module-design.md` di repo SQ Hub), PERF-001, NOTIF-002, NOTIF-004, AUTH-011, ENG-LIST-001, ORG-002
**Roadmap:** `docs/product/hcis-capability-map.md` §4, `docs/product/feature-parity.yaml` (REWARD-001)

## 1. Tujuan

Yayasan memberi **penghargaan** kepada pegawai yang paling istiqamah membaca Al-Qur'an, berdasarkan **papan skor** modul Al-Qur'an. HCIS adalah tempat penghargaan itu ditetapkan, diumumkan, dan dicatat dalam riwayat pegawai.

Paket 1 menghasilkan:

- putaran penghargaan bulanan yang kandidatnya diambil otomatis dari snapshot papan skor bulanan;
- penetapan penerima oleh Kepala HCM, dengan alasan untuk kandidat yang tidak ditetapkan;
- pengumuman ke seluruh pegawai dan notifikasi ke penerima;
- sertifikat PDF untuk setiap penerima;
- riwayat penghargaan di halaman pegawai dan daftar penerima yang bisa dilihat semua pegawai.

## 2. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| R-01 | Data tilawah **tidak masuk penilaian kinerja** (PERF-001), tetapi **masuk penghargaan** | ACCEPTED (Product Owner, 2026-11-13) |
| R-02 | Penghargaan **hanya berdasarkan papan skor** modul Al-Qur'an | ACCEPTED (Product Owner, 2026-11-13) |
| R-03 | Putaran **bulanan**. Kandidat: **3 teratas seluruh yayasan** dan **1 teratas tiap unit**. Papan pekanan dan sepanjang masa hanya untuk tampilan | ACCEPTED (rekomendasi disetujui 2026-11-13) |
| R-04 | Sistem menyusun kandidat; **Kepala HCM menetapkan** penerima. Setiap penetapan tercatat di audit | ACCEPTED (rekomendasi disetujui 2026-11-13) |
| R-05 | Bentuk penghargaan **sertifikat dan pengumuman**, **belum uang**. Tidak ada komponen payroll | ACCEPTED (rekomendasi disetujui 2026-11-13) |
| R-06 | "Unit" untuk kandidat per unit adalah **unit papan skor** yang dipelihara di modul Al-Qur'an (`quran_scoreboard_units`, QURAN-001 §9.1), dirujuk dengan `hcis:org-node:<stable_key>` | DRAFT |
| R-07 | Seorang pegawai yang menjadi kandidat yayasan dan kandidat unit sekaligus hanya menerima **satu** penghargaan, yaitu kategori yayasan. Kursi unitnya turun ke peringkat berikutnya di unit itu | DRAFT |
| R-08 | Kandidat yang tidak ditetapkan **tidak otomatis** digantikan. Kepala HCM boleh mengambil peringkat berikutnya **dari snapshot yang sama**; ia tidak bisa menambah orang di luar papan skor | DRAFT |
| R-09 | Pengambil keputusan tidak boleh memutuskan dirinya sendiri. Bila Kepala HCM menjadi kandidat, pemegang role `human_capital_admin` boleh memutuskan **kandidat itu saja** | DRAFT |
| R-11 | Bila ada peringkat sama di batas kursi (misalnya dua orang sama-sama peringkat 3 setelah penentu S-07 QURAN-001), **semua yang sama** menjadi kandidat untuk kursi itu | DRAFT |
| R-12 | Pengumuman diterbitkan atas nama Kepala HCM yang menerbitkan putaran. Nama penerima dan kategorinya adalah pengecualian tertulis atas NOTIF-002 N-10; angka skor tetap tidak dimuat | DRAFT |
| R-10 | Kandidat dengan skor yang sebagian dari catatan *otomatis* atau *mandiri* tetap sah; labelnya ditampilkan di layar penetapan supaya Kepala HCM bisa menilai | DRAFT |

Program lain (misalnya kehadiran) bisa ditambahkan kelak sebagai **program** baru, masing-masing dengan spesifikasinya sendiri. Paket 1 hanya punya program **Tilawah**.

## 3. Aktor

| Aktor | Peran |
| --- | --- |
| Sistem | Mengambil snapshot bulanan, menyusun kandidat, mengirim notifikasi, membuat sertifikat |
| Kepala HCM (`reward.manage`) | Menetapkan atau tidak menetapkan kandidat, mengambil peringkat berikutnya, menerbitkan, membatalkan putaran |
| HC (`reward.read`) | Melihat putaran dan kandidat |
| Pegawai | Melihat daftar penerima yang sudah terbit, riwayat dan sertifikat miliknya |

## 4. Alur

### 4.1 Menyusun putaran

- **Pemicu:** setiap tanggal 3 pukul 06.00 WIB, sesudah papan bulanan final (QURAN-001 §9.3). Kepala HCM juga bisa memicu manual untuk bulan yang sudah final.
- **Precondition:** program Tilawah aktif; belum ada putaran yang tidak dibatalkan untuk bulan itu.
- **Langkah:**
  1. HCIS memanggil `GET /internal/quran/v1/scoreboards/monthly?month=YYYY-MM` sekali. Respons berisi satu snapshot untuk cakupan yayasan dan setiap unit R-06. Panggilan memakai identitas layanan HCIS (client-credentials, audiens `sq-hub-quran`, scope `quran.scoreboard.read`).
  2. Setiap `personId` (`hcis:employee:<uuid>`) dipetakan ke `employees.id`.
  3. Kandidat disusun menurut R-03, R-07, dan R-11, beserta peringkat, halaman, hari aktif, khatam, label, versi snapshot, versi Directory, dan tanda `directory_stale`. Bila tanda itu menyala, layar penetapan menampilkannya.
  4. Putaran tersimpan dengan status `PENDING_DECISION`, audit `reward.round.created`, notifikasi in-app ke pemegang `reward.manage`.
- **Gagal:**
  - Modul Al-Qur'an tidak bisa dihubungi: dicoba ulang tiap jam selama 3 hari. Layar admin menampilkan "Papan skor belum bisa diambil". Tidak ada putaran setengah jadi. Sesudah 3 hari percobaan otomatis berhenti, pemegang `reward.manage` menerima notifikasi, dan tombol **Susun ulang** tetap tersedia.
  - Bulan belum final (`409 period_not_final`): ditunggu, tidak dianggap galat.
  - `personId` tidak dikenal atau pegawainya tidak aktif: kandidat tetap tercatat dengan tanda **tidak bisa ditetapkan**, dan kursinya bisa diisi peringkat berikutnya (R-08).
  - Papan skor kosong: putaran tersimpan tanpa kandidat dan langsung bisa dibatalkan.

### 4.2 Menetapkan

Kepala HCM membuka putaran dan, untuk setiap kandidat:

- **Tetapkan** → kandidat `AWARDED`, audit `reward.candidate.awarded`.
- **Tidak ditetapkan** dengan alasan 5–500 karakter → `DECLINED`, audit `reward.candidate.declined`.
- **Ambil peringkat berikutnya** untuk kursi itu → kandidat baru dari snapshot yang sama, audit `reward.candidate.replacement_added`.

Keputusan bisa diubah (`AWARDED` ↔ `DECLINED`) selama putaran masih `PENDING_DECISION`; setiap perubahan teraudit (`reward.candidate.decision_changed`). Pengambil keputusan tidak boleh kandidat itu sendiri (R-09): 403 `REWARD_SELF_DECISION`.

Kandidat `UNRESOLVED` tidak bisa ditetapkan. Kursinya bisa diisi lewat **Ambil peringkat berikutnya**, atau dibiarkan kosong; ia tidak menghalangi penerbitan.

### 4.3 Menerbitkan

- **Precondition:** status `PENDING_DECISION`; setiap kandidat `CANDIDATE` sudah menjadi `AWARDED` atau `DECLINED` (kandidat `UNRESOLVED` boleh tetap); minimal satu `AWARDED`. Lainnya 409 `REWARD_ROUND_NOT_READY`.
- **Hasil:** dalam satu transaksi: status `PUBLISHED`, penghargaan dibuat, audit `reward.round.published`, dan tugas efek samping dicatat di outbox. Notifikasi, pengumuman, dan sertifikat dikerjakan dari outbox dengan percobaan ulang; kegagalan efek samping tidak membatalkan penerbitan dan tampil di layar putaran sebagai "Belum terkirim" dengan tombol kirim ulang. Efek sampingnya:
  - notifikasi in-app ke setiap penerima (NOTIF-004);
  - pengumuman ke seluruh pegawai aktif (NOTIF-002) berisi nama penerima dan kategorinya, **tanpa** angka skor (DRAFT);
  - sertifikat PDF untuk setiap penerima: nama, kategori ("Terbaik Tilawah Yayasan — Peringkat 1", "Terbaik Tilawah SMPIT"), bulan, nama Kepala HCM, dan kode verifikasi acak minimal 128 bit;
  - penghargaan muncul di riwayat pegawai.
- Putaran yang sudah terbit **tidak bisa diubah**. Kesalahan dikoreksi dengan **mencabut** satu penghargaan (alasan wajib, audit `reward.award.revoked`). Penghargaan yang dicabut tetap ada di audit, hilang dari daftar penerima, dan sertifikatnya tidak lagi lolos verifikasi.

### 4.4 Membatalkan

Putaran `PENDING_DECISION` bisa dibatalkan dengan alasan → `CANCELLED`, audit `reward.round.cancelled`. Bulan yang sama lalu bisa disusun ulang.

## 5. Status

| Objek | Status | Transisi |
| --- | --- | --- |
| Putaran | `PENDING_DECISION` → `PUBLISHED` atau `CANCELLED` | §4.1–4.4 |
| Kandidat | `CANDIDATE` → `AWARDED` atau `DECLINED`, dan `AWARDED` ↔ `DECLINED` selama putaran `PENDING_DECISION`; `UNRESOLVED` bila tidak bisa ditetapkan (status akhir) | §4.1–4.2 |
| Penghargaan | `ACTIVE` → `REVOKED` | §4.3 |

## 6. API

| Rute | Permission | Input | Galat |
| --- | --- | --- | --- |
| `GET /admin/rewards/rounds` | `reward.read` | `page`, `pageSize`, `status`, `month` | 403 `REWARD_FORBIDDEN` |
| `GET /admin/rewards/rounds/{id}` | `reward.read` | — | 404 `REWARD_ROUND_NOT_FOUND` |
| `POST /admin/rewards/rounds` | `reward.manage` | `month` (bulan final) | 409 `REWARD_ROUND_EXISTS`, 409 `REWARD_PERIOD_NOT_FINAL`, 503 `REWARD_SOURCE_UNAVAILABLE` |
| `POST /admin/rewards/candidates/{id}/award` | `reward.manage`, atau jalur R-09 | — | 403 `REWARD_SELF_DECISION`, 409 `REWARD_CANDIDATE_LOCKED`, 409 `REWARD_CANDIDATE_UNRESOLVED` |
| `POST /admin/rewards/candidates/{id}/decline` | `reward.manage`, atau jalur R-09 | `reason` 5–500 | sama |
| `POST /admin/rewards/candidates/{id}/next-rank` | `reward.manage` | — | 409 `REWARD_NO_NEXT_RANK` |
| `POST /admin/rewards/rounds/{id}/publish` | `reward.manage` | — | 409 `REWARD_ROUND_NOT_READY` |
| `POST /admin/rewards/rounds/{id}/cancel` | `reward.manage` | `reason` 5–500 | 409 `REWARD_ROUND_NOT_CANCELLABLE` |
| `POST /admin/rewards/awards/{id}/revoke` | `reward.manage` | `reason` 5–500 | 409 `REWARD_AWARD_ALREADY_REVOKED` |
| `POST /admin/rewards/outbox/{id}/retry` | `reward.manage` | — | 409 `REWARD_EFFECT_DONE` |
| `GET /rewards/recipients` | pegawai aktif | `page`, `pageSize`, `month` | — |
| `GET /me/rewards`, `GET /me/rewards/{id}/certificate` | pegawai pemilik | — | 404 untuk milik orang lain |
| `GET /public/rewards/verify/{code}` | publik | — | 404, 429 |

Input tidak valid dijawab 400 `INVALID_REWARD_REQUEST`. Kontrak OpenAPI ditulis bersama implementasi.

## 7. Permission

| Permission | Arti | Pembawa |
| --- | --- | --- |
| `reward.read` | Melihat putaran, kandidat, dan audit penghargaan | `human_capital_admin`, `human_capital_lead` |
| (jalur R-09) | Memutuskan kandidat yang merupakan Kepala HCM, hanya kandidat itu | `human_capital_admin` |
| `reward.manage` | Menyusun ulang, menetapkan, menerbitkan, membatalkan, mencabut | `human_capital_lead` (Kepala HCM) (DRAFT) |

- Super Admin tidak menerimanya lewat kompatibilitas legacy.
- Setiap permission baru punya tes otomatis, termasuk 403 untuk pegawai biasa dan untuk keputusan atas diri sendiri.
- Pegawai biasa hanya melihat daftar penerima yang sudah terbit dan riwayat miliknya sendiri.

## 8. Data

| Tabel | Isi |
| --- | --- |
| `reward_programs` | kode (`TILAWAH`), nama, sumber (`al-quran.monthly-scoreboard`), aktif |
| `reward_rounds` | program, bulan, status, versi snapshot sumber, versi dan `asOf` Directory, `directory_stale`, waktu ambil, alasan batal, diterbitkan oleh/pada |
| `reward_outbox` | putaran, jenis efek (notifikasi, pengumuman, sertifikat), status, percobaan, galat terakhir |
| `reward_candidates` | putaran, kategori (`FOUNDATION`, `UNIT`), unit, kursi, peringkat, angka dan label dari snapshot, pegawai, status, alasan, diputuskan oleh/pada |
| `reward_awards` | pegawai, kandidat asal, kategori, bulan, kode verifikasi sertifikat, status, alasan cabut |
| `audit_events` | semua event §4 |

Angka skor disalin dari snapshot sebagai **bukti** saat putaran disusun, tidak dihitung ulang di HCIS. Migrasi menyertakan rencana rollback: tabel baru saja, tanpa mengubah tabel lain.

## 9. Layar

| Layar | Siapa | Isi |
| --- | --- | --- |
| Admin → Penghargaan | `reward.read` | Daftar putaran per bulan dengan status; pagination server-side (ENG-LIST-001) |
| Detail putaran | `reward.read`, aksi untuk `reward.manage` | Kandidat per kursi dengan angka, label otomatis/mandiri, tombol Tetapkan, Tidak ditetapkan, Ambil peringkat berikutnya, Terbitkan, Batalkan |
| Penghargaan (pegawai) | semua pegawai | Penerima yang sudah terbit per bulan dan kategori; pagination server-side (ENG-LIST-001) |
| Riwayat saya | pegawai | Penghargaan milik sendiri dan tombol unduh sertifikat |
| Verifikasi sertifikat | publik dengan kode | Nama, kategori, bulan, dan status sah atau dicabut; tanpa data lain. Dibatasi laju per alamat IP (DRAFT: 30 permintaan per menit) |

State yang wajib diperiksa: loading, kosong ("Belum ada putaran"), galat sumber ("Papan skor belum bisa diambil"), forbidden, dan tampilan HP.

## 10. Batas

- Tidak menjadi masukan PERF-001 dan tidak menjadi komponen payroll atau tunjangan (R-01, R-05).
- HCIS tidak menyimpan catatan tilawah, tanda ayat, atau papan skor harian. HCIS hanya menyimpan salinan snapshot kandidat sebagai bukti.
- HCIS tidak menulis apa pun ke modul Al-Qur'an.

## 11. Kriteria penerimaan Paket 1

1. Putaran bulanan tersusun otomatis sesudah papan bulanan final, dengan kandidat sesuai R-03 dan R-07.
2. Kandidat tidak bisa ditambahkan dari luar snapshot.
3. Penetapan, penolakan, penggantian, penerbitan, pembatalan, dan pencabutan menghasilkan audit event.
4. Keputusan atas diri sendiri ditolak, dan jalur R-09 hanya berlaku untuk kandidat Kepala HCM.
5. Penerbitan mengirim notifikasi, pengumuman, dan sertifikat; putaran terbit tidak bisa diubah.
6. Pegawai biasa tidak bisa membuka layar admin (tes permission).
7. Kegagalan sumber tidak menghasilkan putaran setengah jadi.
