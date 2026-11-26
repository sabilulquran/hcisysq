# Kesiapan pilot Cuti Tahunan Taman Tahfizh dan pembukaan HCIS — bukti 2026-11-26

**Spec ID:** OPS-PILOT-TT-001 (catatan bukti), melengkapi OPS-CLOSE-001 dan OPS-OPEN-001
**Tanggal:** 2026-11-26
**Sumber:** pembacaan baca-saja `ssh mi8vps-root` terhadap `sqcore_hcis`; satu uji kering di
production yang **selalu di-ROLLBACK** (§4); uji otomatis di repository (§6).
**Batas yang dijaga:** tidak ada baris rollout yang ditulis, tidak ada kelompok hak cuti yang
diubah, tidak ada undangan yang dikirim, dan tidak ada akun yang diaktifkan di production.

---

## 1. Ringkasan

| Cakupan | Status | Penghambat yang tersisa |
| --- | --- | --- |
| **Pilot** | **Belum selesai.** Prasyarat teknis sudah lengkap dan terbukti; keempat sasaran owner belum terbukti dengan orang sungguhan | Kelompok hak cuti peserta (HC), penetapan pegawai pilot (HCM), pengiriman undangan dan masuk pertama (HC lalu peserta), baris rollout dari layar (HCM) |
| **Pembukaan umum** | **Belum selesai** | Menunggu hasil pilot, ditambah daftar §9 |

## 2. Rilis yang berjalan — cocok dengan catatan

| Yang diperiksa | Hasil 2026-11-26 |
| --- | --- |
| Proses `hcis` | `cwd` di `/srv/hcis/releases/hcis-df406452-20261125/apps/api`, pid tidak berubah sejak restart API 25 Nov 20:58 WIB |
| Proses `hcis-web` | `…/hcis-df406452-20261125/apps/web/dist`, pid tidak berubah sejak cutover 25 Nov 20:56 WIB |
| Migrasi | 158, tertinggi `0186_help_center_annual_leave_quota.sql` |
| Tanggal efektif aturan semester | `2027-01-01`, terbaca di lingkungan proses API |
| Baris rollout / undangan / pengajuan | 0 / 0 / 0 |
| Akun `active` / `invited` | 4 / 75 |
| Pegawai aktif tanpa kelompok hak cuti | 91 |

Isi dan bukti rilisnya: `docs/development/production-release-verification-2026-11-25-df406452.md`.

## 3. Aturan kuota di production

Dihitung oleh **kode yang sedang berjalan** (`dist/` rilis `df406452`), dengan **kalender kerja
production** dan tanggal efektif yang dibaca dari lingkungan proses API. Pemohonnya sintetis
(`non_education`, mulai kerja 2021-07-01), diajukan 26 November 2026.

| # | Tanggal cuti | Hari kerja | Pemakaian sebelumnya | Hasil |
| --- | --- | --- | --- | --- |
| A1 | 7–9 Des 2026 | 3 | — | **Diterima**, triwulan Okt–Des, batas 3 |
| A2 | 7–10 Des 2026 | 4 | — | **Ditolak** `PERIOD_LIMIT_EXCEEDED`, sisa 3 |
| A3 | 14–15 Des 2026 | 2 | Okt–Des 2 | **Ditolak**, sisa 1 |
| A4 | 28 Des 2026–5 Jan 2027 | 7 | — | **Ditolak** `CROSS_PERIOD_REQUEST_UNSUPPORTED`, dibaca dengan aturan triwulan karena mulainya sebelum 1 Januari |
| A5 | 4–11 Jan 2027 | 6 | — | **Diterima**, semester Jan–Jun, batas 6 |
| A6 | 4–12 Jan 2027 | 7 | — | **Ditolak**, sisa 6 |
| A7 | 29 Mar–5 Apr 2027 | 6 | — | **Diterima** — melewati batas triwulan lama, masih satu semester |
| A8 | 29 Jun–2 Jul 2027 | 4 | — | **Ditolak** `CROSS_PERIOD_REQUEST_UNSUPPORTED`: "harus berada dalam satu semester" |
| A9 | 3–5 Mei 2027 | 3 | Jan–Mar 4 | **Ditolak**, sisa semester 2 |
| A10 | 3–4 Mei 2027 | 2 | Jan–Mar 4 | **Diterima**, sisa sesudahnya 0 |
| A11 | 6 Des 2027 | 1 | 3 + 3 + 6 = 12 | **Ditolak**, sisa 0: setahun tetap 12 |

Kesimpulannya: cuti yang **mulai sebelum 1 Januari 2027** dibatasi 3 hari kerja per triwulan, dan
cuti yang **mulai sejak 1 Januari 2027** dibatasi 6 hari kerja per semester, dengan total setahun
tetap 12.

## 4. Pengajuan membaca Struktur Organisasi terbit — uji kering di production

Satu transaksi di `sqcore_hcis`: memasang sementara baris rollout `leave.annual · STRUCTURE`
pada node Taman Tahfizh, mengaktifkan sementara tiga akun peran pilot, memanggil resolver dan
pratinjau dari rilis yang berjalan, lalu **ROLLBACK**. Jumlah baris rollout, akun aktif, akun
invited, pengajuan, undangan, dan pegawai tanpa kelompok **identik sebelum dan sesudahnya**,
dibaca dari sesi basis data terpisah (pid sesi pengamat berbeda dari sesi uji kering). Dijalankan
26 November 2026 pukul 15:49 WIB dengan `scripts/mi8/pilot-tt-dryrun.mjs`, yang juga memasang
`idle_in_transaction_session_timeout` 30 detik agar transaksi yang macet tidak menahan kunci baris.

| # | Keadaan | Hasil |
| --- | --- | --- |
| B1 | Rosaliana, tanpa baris rollout (hari ini) | Ditolak `DIRECT_MANAGER_MISSING` — data atasan lama kosong, jadi LEGACY tidak dapat dipakai |
| — | Node yang dipakai | **Taman Tahfizh Sabilul Qur'an**, dari bagan terbit "Kursi Staf Kasir untuk peran kasbon" (berlaku 2026-11-10) |
| B2 | STRUCTURE, akun penyetuju masih `invited` | Ditolak `APPROVER_ACCOUNT_NOT_READY`: "Akun Pipit Fithriyah pada kursi Kepala belum aktif … bagan organisasi tidak perlu diubah" |
| B3 | Rosaliana (Tata Usaha), STRUCTURE, akun aktif | Sumber `STRUCTURE`, rantai **Pipit Fithriyah → Muchsalmina** |
| B4 | Pipit sebagai pemohon | Rantai **Muchsalmina** (langkah dirinya sendiri dibuang) |
| B5 | Ida Parida (Guru) | Rantai **Pipit Fithriyah → Muchsalmina**, mendaki dari node Guru |
| B6 | Pegawai unit lain | Tetap LEGACY (`DIRECT_MANAGER_MISSING`): baris pilot tidak meluas |
| C1 | Pratinjau lengkap Rosaliana 7–9 Des 2026 | 3 hari kerja, triwulan Okt–Des batas 3, rantai Pipit → Muchsalmina |
| C2 | Pratinjau lengkap Rosaliana 4–11 Jan 2027 | 6 hari kerja, semester Jan–Jun batas 6, rantai Pipit → Muchsalmina |

Satu sumber data atasan tetap di bagan: kolom atasan lama tidak diisi dan tidak dibaca di bawah
STRUCTURE. **Tidak ada perubahan bagan yang diperlukan.**

## 5. Jalur Akun SQ — sejauh mana terbukti tanpa mengirim undangan

| Yang diperiksa | Hasil |
| --- | --- |
| Route undangan SQ Hub `POST /internal/v1/staff-activation/invite` di `127.0.0.1:3302`, tanpa token | **401** — route ada; menurut HUB-IMPL-024 route itu hanya ada bila `STAFF_ACTIVATION_ALLOWED_CLIENTS` terisi |
| Path tetangga yang tidak ada, tanpa token | **404** — pembanding bahwa 401 di atas bukan jawaban umum |
| Kunci konfigurasi HCIS (`SQ_HUB_APPLICATION_ACCESS_URL`, `SQ_HUB_MACHINE_CLIENT_ID/SECRET`, `OIDC_ISSUER`) | ada (dibaca 2026-11-25, OPS-PILOT-TT-001 §4.2) |
| Token mesin HCIS diterima Keycloak dan SQ Hub | **belum dibuktikan.** Pengujian dengan kredensial mesin dari server ditolak oleh pengaman sesi agen, dan tidak diputari. Bukti yang tersisa datang dari undangan pertama yang sungguhan, atau dari operator yang menjalankan pengecekan token itu sendiri |
| Email Keycloak benar-benar terkirim | **belum dibuktikan**; tidak ada satu undangan pun sepanjang umur sistem |

## 6. Empat sasaran owner — bukti otomatis, bukti production, dan yang tersisa

Uji baru `apps/api/test/ops-pilot-tt-001-flow.postgres.test.ts` merangkai urutan OPS-PILOT-TT-001
§5 dalam satu uji, dengan bagan sintetis berbentuk sama dengan production (`CLIMB_TO_PARENT`,
anak node tanpa ikatan, kolom atasan lama kosong): baris rollout dari route admin dan audit
`organization.rollout.changed` → penolakan `APPROVER_ACCOUNT_NOT_READY` → undangan dan aktivasi
pada masuk pertama untuk tiga peran pilot → penolakan `UNSUPPORTED_ENTITLEMENT_GROUP` (409) →
pengajuan dengan rantai dari bagan → Setujui dua langkah → pemberitahuan "disetujui" →
Tolak dengan alasan → pemberitahuan "ditolak" tanpa alasan → **Akhiri** dan audit
`organization.rollout.ended`, besok kembali LEGACY, rantai tersimpan tidak bergerak.

| Sasaran | Bukti otomatis | Bukti production | Yang tersisa |
| --- | --- | --- | --- |
| 1. Undangan Akun SQ berfungsi | `activation-invitation.postgres` (14), uji rangkai di atas, dan uji baru `sq-hub-staff-activation-client` (16) untuk permintaan HTTP yang sungguh dikirim HCIS | Route SQ Hub ada (§5) | Satu undangan nyata dan masuk pertama penerimanya |
| 2. Pengajuan ke penyetuju yang benar | Uji rangkai, `org004-structure-leave-flow`, `org004-rollout-switch` | Uji kering §4: Pipit → Muchsalmina dari bagan terbit | Satu pengajuan nyata setelah baris rollout ditulis |
| 3. Setujui dan Tolak dari layar | Uji rangkai (route keputusan), `org004-structure-leave-flow` | Dialog Tolak sudah di production sejak `27f10ccd` | Satu Setujui dan satu Tolak oleh penyetuju sungguhan |
| 4. Pemohon menerima hasil | Uji rangkai (STRUCTURE), `leave010-requester-decision-notification` (LEGACY) | — | Pemohon melihat pemberitahuan di lonceng HCIS |

Pemberitahuan hasil dikirim **di dalam aplikasi** (lonceng HCIS). Keputusan cuti tidak mengirim
WhatsApp; daftar izin WhatsApp (OPS-PILOT-TT-001 §5.4) hanya menyangkut pesan undangan dan
ringkasan harian penyetuju.

## 7. Bug yang ditemukan dan diperbaiki dalam perubahan ini

**Pegawai tanpa kelompok hak cuti dijawab 500, bukan 409.** Pemeriksaan kelompok melempar galat
milik modul kebijakan (`AnnualLeavePolicyError`) yang tidak dipetakan route mana pun, sehingga
pratinjau dan pengiriman Cuti Tahunan jatuh sebagai galat server. Inilah penolakan pertama yang
akan ditemui peserta pilot bila kelompoknya belum diisi (OPS-PILOT-TT-001 §5.1 menyebut 409; yang
berjalan di production adalah 500). Sekarang pemeriksaan itu melempar galat kebijakan pengajuan
yang sudah dipetakan setiap route Cuti Tahunan ke **409 `UNSUPPORTED_ENTITLEMENT_GROUP`**, dan
pesannya membedakan:

- kelompok **kosong**: "Kelompok hak cuti Anda belum ditetapkan oleh Human Capital, sehingga Cuti
  Tahunan belum dapat diajukan. Hubungi Human Capital.";
- kelompok **`education`**: "Cuti Tahunan individual hanya berlaku untuk kelompok tenaga
  non-pendidikan." (tidak berubah).

**Tanggal yang tidak ada di kalender juga dijawab 500** (ditemukan putaran tinjauan independen).
Route cuti hanya memeriksa bentuk `YYYY-MM-DD`, sehingga `2026-02-30` sampai ke PostgreSQL sebagai
`$1::date` dan galatnya tidak dipetakan. Sekarang semua route cuti memakai satu skema
`isoCalendarDate` (`apps/api/src/modules/leave/iso-date.ts`) dan tanggal seperti itu ditolak
sebagai `400` biasa untuk isian yang tidak sah.

Kedua perbaikan ini **dirilis 26 November 2026 16:16 WIB** sebagai `hcis-7fd89146-20261126`,
tanpa migrasi; bukti `docs/development/production-release-verification-2026-11-26-7fd89146.md`.

### Bukti uji perubahan ini (2026-11-26)

| Gate | Hasil |
| --- | --- |
| Typecheck | lulus |
| Lint | 0 error (64 peringatan lama) |
| Suite API, database `hcis_pr` yang baru dibuat ulang, dengan `HCIS_AUTH011_TEST_DATABASE_URL` sehingga AUTH-011, ORG-010, ORG-013, dan ADR-0008 ikut berjalan | **3357 lulus, 1 dilewati, 293 berkas** |
| Build | lulus |
| Uji baru | `ops-pilot-tt-001-flow.postgres` (2), `sq-hub-staff-activation-client` (16), satu kasus baru di `leave-policy` |
| Uji yang diperbaiki | `trip-per-diem-activation.postgres` memakai "hari ini + 30" yang hari ini jatuh pada Sabtu–Minggu (0 hari kerja); kini selalu mulai Senin |
| Tinjauan independen | satu putaran; tujuh temuan, semuanya ditutup (tanggal mustahil 500, klaim sesi kedua, batas waktu transaksi menganggur, satu kasus uji kering yang tidak membuktikan apa pun, dua asersi uji yang kurang, nama pegawai yang tidak terkait tercetak) |

## 8. Temuan data — kalender libur

`leave_calendar_exceptions` di production berisi **satu** tanggal (2026-08-25, libur) dan **nol**
untuk 2027. Hari libur nasional dan cuti bersama yang tidak dicatat dihitung sebagai hari kerja,
sehingga cuti yang melewatinya memakan kuota lebih banyak dari semestinya — misalnya cuti yang
melewati 25 Desember 2026. Ini **data HC**: tanggal libur nasional bersifat publik, tetapi cuti
bersama mana yang diikuti yayasan adalah keputusan HC, dan agen tidak mengisinya.

## 9. Kesiapan pilot — yang masih harus dilakukan

Urutannya mengikuti OPS-PILOT-TT-001 §5. Satu-satunya akun staf aktif yang memegang izin yang
dibutuhkan (`leave.configuration.manage`, `access.manage`, `approvals.policy.manage`) adalah akun HC
**M. Imadduddin Muqoyim**.

| # | Langkah | Siapa | Bukti yang diperlukan | Status |
| --- | --- | --- | --- | --- |
| P1 | Tetapkan kelompok hak cuti peserta (usul `DRAFT`: Rosaliana `non_education`; Pipit keputusan HC; tujuh Guru `education`) | HC, Admin → Konfigurasi Cuti | Audit `leave.entitlement_group.changed` per pegawai | **Menunggu HC** |
| P2 | Tetapkan pegawai pilot (usul: Rosaliana) | HCM | Keputusan tertulis | **Menunggu HCM** |
| P3 | Isi hari libur dan cuti bersama sampai akhir pilot (dan 2027) | HC | Baris kalender; pratinjau yang melewati tanggal libur menghitung benar | **Menunggu HC** (disarankan, tidak mutlak) |
| P4 | Rilis perbaikan 409 dan tanggal mustahil (§7) | Operator (agen) | Catatan verifikasi rilis | **Selesai 2026-11-26 16:16 WIB** — `hcis-7fd89146-20261126` |
| P5 | Kirim aktivasi: Muchsalmina, Pipit, lalu pegawai pilot; ketiganya masuk sekali dan mengisi kata sandinya sendiri | HC, lalu orangnya | Baris `account_activation_invitations` `issued` lalu selesai; akun `active`; audit `auth.activation.invitation_completed` | **Menunggu penetapan penerima (P2) dan HC** |
| P6 | Tulis baris rollout Taman Tahfizh · Cuti Tahunan · `STRUCTURE` dari layar | HCM, Admin → Struktur Organisasi → Mode persetujuan per unit | Audit `organization.rollout.changed`; pratinjau pemohon menunjukkan Pipit → Muchsalmina | **Siap secara teknis** (§4), menunggu P1–P5 |
| P7 | Satu pengajuan nyata, Setujui, satu pengajuan nyata, Tolak | Pegawai pilot, Pipit, Muchsalmina | Baris `leave_requests` + langkah tersimpan + `in_app_notifications` `leave.request.decided.*` | **Belum** |
| P8 | Putuskan ukuran keberhasilan (OPS-PILOT-TT-001 §8: A/B/C) | Owner | Keputusan tertulis | **Menunggu owner** |
| P9 | Daftar izin WhatsApp untuk peserta | Operator | Baris env, restart API | Opsional |

## 10. Kesiapan pembukaan umum — yang masih harus dilakukan

Terpisah dari §9; daftar lengkapnya OPS-PILOT-TT-001 §9 dan OPS-CLOSE-001.

| Bidang | Yang tersisa | Siapa | Bukti yang diperlukan |
| --- | --- | --- | --- |
| Hasil pilot | §9 selesai dan dinilai | Owner | Catatan hasil pilot |
| Kelompok hak cuti | 91 pegawai aktif belum diklasifikasi | HC | Hitungan 0 pegawai aktif tanpa kelompok |
| Email | Pegawai aktif tanpa email tidak dapat diundang | HC | Hitungan pegawai aktif tanpa email |
| Akun | 75 akun `invited`; aktivasi massal menunggu pilot | HC | Undangan terkirim dan akun aktif per unit |
| Penyetuju unit lain | Sebagian besar penyetuju unit belum berakun aktif | HC | Akun aktif per penyetuju |
| Mode persetujuan unit lain | Tetap LEGACY dengan kolom atasan diisi, atau menyusul STRUCTURE (D11) | Owner bersama HCM | Keputusan, lalu baris rollout per unit |
| Kalender libur | Libur nasional dan cuti bersama 2027 | HC | Baris kalender 2027 |
| Pemulihan kata sandi, kepemilikan insiden, latihan restore penuh, menu di luar cakupan, Pusat Bantuan, ADMS, katalog klasifikasi jabatan | Lihat OPS-PILOT-TT-001 §9 (D4–D10) | Owner / HC / operator | Sesuai tiap butir |
| Keputusan pembukaan | Satu OPS-GOLIVE-001 terisi penuh (G13) | Owner | Dokumen keputusan |

## 11. Hubungan dengan dokumen lain

- `docs/operations/pilot-cuti-taman-tahfizh-2026-11-25.md` (OPS-PILOT-TT-001) — rencana pilot.
- `docs/development/hcis-closure-list.md` (OPS-CLOSE-001) — posisi butir penutupan.
- `docs/development/leave-003-r2-semester-quota-2026-11-25.md` (LEAVE-003 R2) — aturan kuota.
