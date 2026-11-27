# OPS-CLOSE-001 — Daftar penutupan HCIS sebelum dibuka ke seluruh pegawai

**Spec ID:** OPS-CLOSE-001
**Status:** ASSESSMENT (read-only) — 2026-11-20. Dokumen ini tidak mengubah gate mana pun; ia mencatat posisi tiap butir beserta buktinya.
**Gate induk:** `docs/product/scope.md` ("Pilot ready", "Production ready") lewat `docs/operations/hcis-readiness-gates-2026-10-16.md` (OPS-READY-001). Keputusan pembukaan dicatat di `docs/operations/go-live-decision-record-template.md` (OPS-GOLIVE-001).
**Rilis production saat dokumen ini ditulis:** `hcis-7fd89146-20261126` (cutover 26 Nov 16:16 WIB, verify OK pada percobaan kedua setelah satu kegagalan resolver DNS di perangkat, lock dilepas), migrasi tertinggi `0186_help_center_annual_leave_quota.sql`, seluruh 158 migrasi bundel terpasang, **nol migrasi diterapkan pada rilis ini**; bukti `docs/development/production-release-verification-2026-11-26-7fd89146.md`. Rilis sebelumnya `hcis-df406452-20261125` (bukti `…-2026-11-25-df406452.md`), `hcis-27f10ccd-20261125` (bukti `…-2026-11-25-27f10ccd.md`), `hcis-f6edebd4-20261125` (bukti `…-2026-11-25-f6edebd4.md`), `hcis-b3adc898-20261124` (bukti `…-2026-11-24-b3adc898.md`) dan `hcis-734be5ca-20261124` (bukti `…-2026-11-24-734be5ca.md`).
**Sumber angka production:** pengukuran owner sendiri pada 2026-11-20 dan pengukuran baca-saja lanjutan pada 2026-11-23 (§3). Penulis dokumen ini tidak punya akses production dan tidak menurunkan ulang angka tersebut.
**Sumber angka repository:** `origin/main` pada `2535444f` (merge #406, 2026-11-23).
**Koreksi terakhir:** 2026-11-23, putaran keempat — satu temuan yang **mengubah prasyarat pilot**: sebelum #406, kursi yang pejabatnya ada tetapi akunnya belum aktif diperlakukan sebagai kursi kosong, sehingga rantai memanjat melewatinya tanpa jejak (§1, §3, W1, L3). Bentuk bagannya diukur untuk pertama kalinya (**63 ikatan wewenang dan 29 jabatan, seluruhnya `CLIMB_TO_PARENT`**), batas cakupan yang tersisa pada kursi akun organ dicatat (V22 baru), §4 diukur ulang pada `2535444f`, dan §9 kini menyebut OPS-OPEN-001.
**Pembaruan 2026-11-24 (rilis):** `hcis-734be5ca-20261124` dirilis ke production. **Sepuluh migrasi** yang menunggu sejak 18 November masuk sekaligus (`0172`, `0174`–`0178`, `0180`–`0183`), termasuk tarif uang saku SK 01.111/YSQ/VII/2026 dan saklar TRIP-002 D-22. Dengan itu §4 berubah bentuk lagi: tidak ada lagi migrasi yang tertahan, dan "segala sesuatu sesudah `127b6068`" bukan lagi patokan — patokannya kini `734be5ca`. Yang **tidak** berubah: tidak ada akun yang diaktifkan, tidak ada undangan yang dikirim, tidak ada pilot yang dinyalakan, dan uang saku perjalanan dinas mendarat dalam keadaan **terkunci** (`trip_per_diem_activation` 0 baris, diukur baca-saja sesudah rilis).

**Pembaruan 2026-11-25 (rilis perbaikan audit).** `hcis-f6edebd4-20261125` dirilis ke production atas permintaan owner, **tanpa satu pun migrasi** (`0184` sudah masuk pada `b3adc898`), backup pra-rilis tetap diambil, gerbang kandidat lulus 7/7, verifikasi lulus pada percobaan pertama. Ketiga perbaikan audit di bawah — dan dua yang menyertainya — kini **ada di production**; bukti `docs/development/production-release-verification-2026-11-25-f6edebd4.md`. Yang **tidak** berubah: tidak ada akun yang diaktifkan, tidak ada undangan yang dikirim, tidak ada pilot yang dinyalakan, `organization_rollout_settings` tetap 0 baris (`LEGACY`), dan uang saku dinas tetap terkunci (`trip_per_diem_activation` 0 baris). Perbaikan 1–3 baru terasa setelah akun pegawai diaktifkan.

**Pembaruan 2026-11-27 (unit pilot berpindah ke General Affair).** HCM memindahkan pilot Cuti Tahunan dari Taman Tahfizh ke **General Affair** dan menetapkan dua peserta (OPS-PILOT-GA-001, `docs/operations/pilot-cuti-general-affair-2026-11-27.md`). Pembacaan baca-saja 2026-11-27: bagan terbit menempatkan General Affair di bawah Bidang Operasional, dengan kursi Kepala Bidang Operasional **kosong**, sehingga penyetuju unit mendaki ke Direktur. Production tidak berubah sejak 2026-11-26 (0 baris rollout, 0 undangan, 0 pengajuan). Dokumen Taman Tahfizh menjadi riwayat.

**Pembaruan 2026-11-26 (bukti kesiapan pilot).** Uji kering di production yang selalu di-ROLLBACK membuktikan, dengan kode rilis `df406452` dan kalender production, aturan 3 hari per triwulan untuk cuti yang mulai sebelum 1 Januari 2027 dan 6 hari per semester sejak tanggal itu (setahun tetap 12), serta bahwa satu baris rollout pada node Taman Tahfizh membuat pengajuan membaca bagan terbit (kepala unit → penyetuju unit) sementara unit lain tetap LEGACY. Ditemukan dan diperbaiki: kelompok hak cuti kosong dijawab **500**, bukan 409, dan tanggal yang tidak ada di kalender (mis. 30 Februari) juga 500 pada semua route cuti (menunggu rilis). Ditemukan: kalender libur production hanya berisi 2026-08-25. Uji rangkai baru merangkai keempat sasaran pilot; klien HTTP undangan SQ Hub kini teruji. Kesiapan pilot dan pembukaan dicatat terpisah di `docs/operations/pilot-tt-readiness-evidence-2026-11-26.md`. Yang **tidak** berubah di production: 0 baris rollout, 0 undangan, 0 pengajuan, 91 pegawai aktif tanpa kelompok hak cuti.

**Pembaruan 2026-11-25 (rilis ketiga hari ini).** `hcis-df406452-20261125` dirilis pukul 20:56 WIB dengan migrasi aditif `0185` dan `0186`, verify lulus percobaan pertama; bukti `docs/development/production-release-verification-2026-11-25-df406452.md`. Isinya LEAVE-003 R2: batas pemakaian Cuti Tahunan 6 hari kerja per semester untuk cuti yang **mulai 1 Januari 2027** (tanggal ditetapkan owner hari ini, dipasang di `final.env` pukul 20:58 WIB); cuti yang mulai sebelumnya tetap 3 hari per triwulan. Hak tahunan tetap 12. W15 **tetap tertutup**. Yang **tidak** berubah: `organization_rollout_settings` 0 baris, `account_activation_invitations` 0 baris, `leave_requests` 0 baris.

**Pembaruan 2026-11-25 (rilis kedua hari ini).** `hcis-27f10ccd-20261125` dirilis pukul 12:17 WIB, **tanpa satu pun migrasi**, verify lulus percobaan pertama; bukti `docs/development/production-release-verification-2026-11-25-27f10ccd.md`. Isinya: saklar mode persetujuan per unit kini dapat dinyalakan **dan diakhiri dari layar** (sebelumnya kedua route-nya tidak dipanggil dari mana pun, jadi saklar routing hanya dapat disentuh lewat `psql` dan jalan mundur pilot tidak punya tombol), dan dialog **Tolak** pada layar Persetujuan pindah ke dalam halaman. W15 **tetap tertutup**: tidak ada perubahan `main` yang menunggu rilis sesudahnya. Yang **tidak** berubah: `organization_rollout_settings` 0 baris, `account_activation_invitations` 0 baris, akun aktif 4, migrasi tetap 156 dengan tertinggi `0184`.

**Pembaruan 2026-11-25 (owner memilih pilot; satu penghambat baru terukur).** Owner memutuskan membuka bertahap lewat pilot **Cuti Tahunan di Taman Tahfizh**, dan meminta pengaturan khusus unit itu disiapkan agar data atasan cukup dipelihara di bagan. Aktivasi massal menunggu hasil pilot. Pengukuran baca-saja yang menyertainya menemukan penghambat yang daftar ini belum pernah catat: **kelompok hak cuti (`employees.leave_entitlement_group`) kosong untuk 91 dari 97 pegawai aktif** — 4 `education`, 2 `non_education`, dan **nol** yang terisi di unit pilot. Cuti Tahunan individual hanya berlaku untuk `non_education` (`docs/domain/leave-policy-ysq.md`), sehingga pengajuan dari pegawai yang kelompoknya kosong dijawab `409 UNSUPPORTED_ENTITLEMENT_GROUP` **sebelum rantai penyetuju disentuh**. Dicatat sebagai **W16** di §5. Kesiapan unit pilot, prasyaratnya, dan pemisahan "diperlukan untuk pilot" dari "sisa pekerjaan sebelum pembukaan penuh" ada di `docs/operations/pilot-cuti-taman-tahfizh-2026-11-25.md` (OPS-PILOT-TT-001); panduan pesertanya di `docs/operations/panduan-pilot-cuti-taman-tahfizh.md`. Yang **tidak** berubah: tidak ada akun yang diaktifkan, dan **belum pernah ada satu undangan aktivasi pun sepanjang umur sistem** (`account_activation_invitations` nol baris, diukur 2026-11-25).

**Pembaruan 2026-11-24 (audit kesiapan pembukaan, dan perbaikan yang lahir darinya).** Audit menjalankan 82 skenario sintetis lewat HTTP dan layar, membaca production baca-saja, dan menemukan **dua cacat yang menghalangi pembukaan** serta satu ketidakcocokan label. Ketiganya sudah diperbaiki, dibuktikan uji otomatis, dan **dirilis ke production 25 November** (lihat pembaruan di atas):

1. **Penyetuju unit tidak dapat mengajukan cutinya sendiri** (ORG-004 D-R6). Rung penyetuju unit yang jatuh kepada pemohon memang dibuang — itu yang APR-001 dan LEAVE-004-G minta — tetapi dibuang tanpa jejak, sehingga pemeriksaan di hilir membacanya sebagai "approver unit belum dikonfigurasi" dan menolak `409 UNIT_APPROVER_MISSING`. Di production ini mengenai **delapan dari sembilan** pegawai yang menjadi penyetuju unit, karena mereka penyetuju bagi unitnya sendiri. Kini rantainya berjalan dengan atasan langsung saja; `UNIT_ONLY` yang tidak punya rung lain ditolak sebagai `UNIT_APPROVER_SELF` pada kedua mode. Uji: `apps/api/test/org004-unit-approver-self-leave.postgres.test.ts`.
2. **Pemohon tidak pernah diberi tahu keputusan cutinya** (LEAVE-010-F). Setiap penyetuju menerima notifikasi, pemohon tidak satu pun; niatnya sudah ditulis ke `leave_notification_outbox` sejak awal, tetapi tidak ada yang membaca outbox itu. Kini keputusan akhir menulis tepat satu notifikasi dalam aplikasi untuk pemohon, tanpa catatan penolakannya. Uji: `apps/api/test/leave010-requester-decision-notification.postgres.test.ts`.
3. **Katalog "Semua Layanan" menuliskan sendiri label tiap layanan** (SVC-001). Uang Muka Dinas tertulis "Tersedia" sementara server menolak setiap pengajuan dengan `409 TRIP_PER_DIEM_NOT_ACTIVE` (L10). Kini `GET /me/services` membacakan gerbang server apa adanya dan layar memakai jawabannya. Ini **tidak menjawab W11**, yang tetap keputusan owner: yang berubah hanya kejujuran label, bukan isi menunya.

Dua hal lain ikut diperbaiki: `POST /admin/leave/approvals/:stepId/reassign` menutup celah APR-001 "Reassignment" untuk cuti — sebelumnya satu langkah yang penyetujunya kehilangan akses hanya dapat dibebaskan dengan menyunting basis data — dan indikator "Atasan langsung siap" di layar Konfigurasi Cuti kini menghitung pegawai yang sudah dirutekan bagan sebagai siap, sehingga layar berhenti menyuruh HC mengisi kolom yang tidak dibaca siapa pun.

**Kalimat di bawah ini didahului rilis 24–25 November dan tidak diperbarui satu per satu:** setiap "belum dirilis" yang menunjuk #383, #384, #386, #387, #390, #391, #395, #396, #399, #405, atau #406 sudah tidak berlaku — seluruhnya ada di `hcis-734be5ca-20261124` (§4), dan perbaikan audit #412 ada di `hcis-f6edebd4-20261125`. **Pada 2026-11-25 tidak ada lagi perubahan `main` yang menunggu rilis.**

**Koreksi ketiga:** 2026-11-23 — W2 diperbaiki (**95**, bukan 96, pegawai terhalang penyetuju; angka yang sama dirapikan di §1, §5, dan W4), kelengkapan email per unit masuk untuk pertama kalinya (**22 dari 96**, §3, W3, V3 ditutup), cakupan bagan diganti dari "hampir seluruh" menjadi **96 dari 96** hasil penelusuran data (§1, W1, L3, V17 ditutup), dan §4 diubah bentuknya: patokannya kini "segala sesuatu setelah `127b6068`" ditambah daftar migrasi yang belum dirilis — kini **sembilan**, bertambah `0182` dari #399 — sementara cacah PR tinggal keterangan bertanggal dengan commit `main`-nya disebut.
**Koreksi kedua:** 2026-11-23 — katalog klasifikasi jabatan ORG-011 diukur untuk pertama kalinya dan ternyata **nol** (§3, L16, L10, W15), jalur mesin absensi kini enam hari sunyi (§3, W5, V19), V9 terjawab, dan §4 diukur ulang pada `9b842958`. Angka akun, penyetuju unit, cuti, kasbon, dan payroll **tidak bergerak** antara 2026-11-20 dan 2026-11-23. Putaran kedua pada tanggal yang sama menutup tiga hal yang sempat terbaca sebagai ketidakcocokan: selisih 96/97 ternyata selisih predikat dan menyingkap satu catatan `active` yang `removed_at`-nya terisi (§3, V21); 74 akun `invited` tanpa undangan tercatat ternyata keadaan wajar, bukan data hilang (§3, W3, V2); dan rincian penyetuju unit 2026-11-20 (8 + 1 + 1) **keliru saat dituliskan** — yang benar 7 + 1 + 1, datanya tidak berubah (§1, §3, W2, W3).
**Koreksi pertama:** 2026-11-20 — urutan penghambat disusun ulang (kesiapan akun penyetuju, W3/W2, kini yang pertama), W1 (bagan organisasi ternyata terisi), W7 dan W8 (uji Human Capital Management), W5 (keadaan jalur mesin absensi), W12 (bukti restore sebagian), dan §4 (garis rilis diukur ulang pada `b2fa31dd`).

> **Empat hal yang sering dicampur, dan tidak dicampur di dokumen ini.**
>
> 1. **Pratinjau resolusi baca-saja bukan bukti routing.** Menelusuri bagan organisasi dan mendapatkan nama penyetuju hanya menjawab *siapa yang seharusnya menyetujui*. Ia tidak membuktikan orang itu punya akun aktif, punya izin yang diperlukan, atau bahwa pengajuan nyata benar-benar sampai kepadanya. Kesiapan akun dan izin penyetuju baru teruji ketika bagan itu **dipakai untuk routing**, bukan ketika ia dibaca.
> 2. **PR yang di-merge bukan rilis.** Kode di `main` tidak ada di production sampai ada catatan rilis bertanggal.
> 3. **Rilis bukan penyalaan.** Kode yang terpasang di balik saklar mati tidak melakukan apa pun.
> 4. **Penyalaan bukan pengujian.** Saklar menyala tanpa satu pun transaksi nyata tetap berstatus *Aktif belum diuji*.
>
> Status di dokumen ini naik hanya bila buktinya berasal dari tingkat yang benar, dan cakupan bukti itu ditulis apa adanya — termasuk bagian yang **belum terverifikasi**.

## 1. Kesimpulan yang harus dibaca lebih dulu

**HCIS belum dipakai sebagai sistem kerja oleh siapa pun di production.** Untuk 97 pegawai aktif hanya ada **4 akun aktif** (1 `EMPLOYEE`, 2 `FOUNDATION_BOARD`, 1 lain), ditambah **74 akun yang masih `invited`** — dan `invited` bukan aktif. Tidak ada satu pun pengajuan cuti, kasbon, atau reimbursement sepanjang umur sistem, dan tidak ada satu pun periode payroll.

Dua hal yang sudah terjadi dan tidak boleh dihapus dari gambaran ini. Pertama, **Human Capital Management sudah menguji absensi HP (clock in/out) dan alur utama memakai akun aktif** (konfirmasi owner 2026-11-20); cakupan rincinya tidak tercatat, jadi pengujian itu tidak menutup alur yang belum disebut. Kedua, **penyerapan kehadiran dari mesin ADMS pernah berjalan dengan data nyata** dan **5.202 slip gaji hasil impor historis tersimpan**. Tetapi jalur mesin itu sekarang sunyi: perangkat terakhir menghubungi HCIS **17 November 14:36**, scan terakhir **17 November 09:10**, dan dalam sepekan sebelum 2026-11-20 hanya mengirim **4 log kehadiran** berbanding **28.087 handshake protokol** (§3). Pada 2026-11-23 jalur itu sudah **enam hari** tanpa kehadiran, dan **nol scan dalam tiga hari terakhir sebelum pemeriksaan**. Ini satu-satunya butir di daftar ini yang **memburuk sendiri hanya karena waktu berjalan**: kehadiran yang tidak terkirim tidak dapat disusun ulang belakangan.

**Penghambat nomor satu untuk pembukaan: penyetuju cutinya sendiri belum bisa bertindak.** Pengukuran owner (baca saja, production), angka yang berlaku adalah pembacaan 2026-11-23: dari sembilan unit berpegawai aktif, **tujuh unit punya penyetuju cuti yang akunnya masih berstatus `invited`**, dan **satu unit penyetujunya tidak punya akun sama sekali** — Yayasan Sabilul Quran. Hanya **satu** unit yang penyetujunya berakun aktif: Human Capital Management. Rincian 2026-11-20 yang sempat ditulis di dokumen ini menyebut delapan unit `invited`; **angka itu keliru saat dituliskan**, bukan keadaan yang berubah (§3).

Kode menolak penyetuju yang akunnya bukan `active`: `409 APPROVER_ACCOUNT_NOT_READY`, dengan pesan `Akun approver <nama> belum aktif.` (`apps/api/src/modules/leave/employee-routes.ts:345-350`). Penjagaan yang sama ada di cuti berencana, pengaturan kerja ATT-015, kasbon, reimbursement, perjalanan dinas, dan uang muka dinas — tujuh modul memakai pemeriksaan yang sama.

Artinya, memakai jumlah pegawai per unit di §3: **95 dari 96 pegawai aktif yang layak diproses berada di unit yang penyetuju cutinya belum bisa bertindak.** Hanya satu pegawai — yang unitnya Human Capital Management — berada di unit dengan penyetuju berakun aktif, dan orang itu **tidak** termasuk yang terhalang. Dengan cacah baris `status='active'` saja, angkanya 96 dari 97; penyebut kelayakan yang benar adalah 96 (§3, V21).

**Ini mengubah urutan penghambat.** Mengisi kolom atasan langsung tidak memperbaiki keadaan ini sedikit pun: pengajuan yang lolos tahap atasan tetap gagal di tahap penyetuju unit dengan `409`. Jadi yang pertama menghalangi adalah **kesiapan akun penyetuju (W3, lalu W2)**, bukan data atasan (W1). W1 tetap wajib — tanpa atasan, pengajuan bahkan tidak sampai ke tahap penyetuju unit — tetapi ia penghambat kedua, bukan pertama. Apakah dan kapan akun-akun penyetuju itu diaktifkan adalah **keputusan HCM dan owner, dan belum diambil**; dokumen ini hanya mencatat keadaannya.

Untuk rekonsiliasi, tiga angka yang harus dibaca bersama dan tidak saling menggantikan: (1) 95 dari 97 pegawai aktif punya kolom atasan lama yang kosong; (2) dua yang terisi pun **atasannya berakun `invited`**, jadi nol pegawai aktif hari ini punya rantai yang seluruh pesertanya siap; (3) `organization_rollout_settings` tetap **0 baris**, jadi cuti memang masih mengambil atasan dari Detail Pegawai dan penyetuju dari Konfigurasi Cuti — **bagan organisasi tidak ikut dibaca sama sekali di jalur yang sedang berjalan.**

**Penghambat nomor dua: rantai persetujuan production belum tersambung ke sumber data atasan yang sudah ada.** Angka yang biasa dikutip — 95 dari 97 pegawai aktif tanpa `direct_manager_employee_id` — benar, tetapi ia mengukur **satu kolom saja**, yaitu kolom yang dibaca mode `LEGACY`. Ia bukan ukuran "data atasan tidak ada".

Data atasannya sebagian besar **memang ada**, di bagan organisasi yang sudah terbit. Pengukuran owner 2026-11-20 (baca saja) mencatat bagan itu benar-benar terisi di production: 16 change set terbit (terakhir 2026-11-10), 1.111 `organization_nodes`, 474 `organization_positions`, 374 `organization_incumbencies`, 1.439 `organization_memberships`, dan 555 `organization_authority_bindings` — di antaranya 215 `SUPERVISORY_PARENT`, 104 `UNIT_APPROVER`, 3 `OVERSIGHT_PARENT`, 3 `GOVERNANCE_APPROVER` — dengan `organization_reporting_overrides` kosong. Penelusuran bagan pada 2026-11-23 memberi angkanya, menggantikan kata "hampir seluruh" yang sebelumnya dipakai: **96 dari 96 pegawai aktif yang layak diproses menemukan kepala** lewat binding `LEADER` dengan pendakian node pada change set terbit yang berlaku. Lapisan koordinatornya memang sudah ada — SDIT Tahfizh tersebar ke lima kepala (19/15/7/3/2), Pesantren Tahfizh ke enam (9/5/4/3/1/1), General Affair ke dua (9/3), Taman Tahfizh seluruhnya ke satu — dan kursi kosong, jabatan rangkap, serta sub-bagian tanpa kepala tidak menggagalkan satu pun karena pendakian melewatinya.

Jadi yang kurang bukan datanya, melainkan **sambungannya**, dan hanya ada dua cara menutupnya: (a) kolom `LEGACY` diisi dari bagan, atau (b) rollout workflow dipindahkan dari `LEGACY` ke `STRUCTURE` supaya resolver membaca bagan secara langsung (L3). Selama tidak satu pun dari keduanya dikerjakan, mode production tetap `LEGACY` — `organization_rollout_settings` kosong, sehingga `OrganizationRolloutService` jatuh ke `LEGACY` (`apps/api/src/modules/organization/repository.ts:777`) — dan resolver `LEGACY` membangun rantai hanya dari dua kolom: `employees.direct_manager_employee_id` dan `organizational_units.leave_approver_employee_id`. Bila kolom atasan kosong, `resolveLeaveLineApprovalChain` melempar `DIRECT_MANAGER_MISSING` ("Atasan langsung belum dikonfigurasi") dan pengajuan **gagal tertutup**, bukan jatuh ke HC (`apps/api/src/modules/leave/domain/approval-chain.ts`).

Resolver yang sama dipakai enam modul: cuti (`leave/employee-routes.ts`), cuti berencana (`leave/planned-leave-routes.ts`), pengaturan kerja ATT-015 (`attendance/work-arrangement-routes.ts`), kasbon (`loans/routes.ts`), reimbursement (`reimbursements/routes.ts`), dan perjalanan dinas (`trips/routes.ts`); lembur memakai jalur sejenis lewat `attendance/overtime-approver.ts`. Artinya, bila HCIS dibuka hari ini **tanpa mengerjakan (a) atau (b)**, 95 dari 97 pegawai akan menemui penolakan di hampir setiap layanan yang mereka coba, dan penolakannya terbaca sebagai kesalahan sistem, bukan sebagai data yang belum diisi.

**Dua hal yang tidak boleh ikut diklaim.** Pertama, angka 96 dari 96 itu berasal dari **penelusuran data bagan production** — bukan simulasi, tetapi juga **bukan pengajuan nyata yang dirutekan**, dan bukan hasil resolver production, karena ORG-004 `SHADOW` tetap belum dijalankan (L3, V17). Yang terbukti adalah bagannya memuat kepala untuk setiap orang, bukan bahwa resolver akan menjawab sama pada setiap kasus. Kedua, dan ini yang lebih penting: **pratinjau baca-saja hanya mengatakan siapa yang *seharusnya* menyetujui, bukan bahwa orang itu *bisa* menyetujui.** Kesiapan akun dan izin penyetuju baru benar-benar teruji ketika bagan dipakai untuk routing pengajuan nyata. Pada 2026-11-20 hanya ada **4 akun aktif**, sementara **74 akun lain masih berstatus `invited`** — dan `invited` bukan aktif. Penyetuju yang ditemukan bagan bisa saja belum punya akun aktif atau belum punya izin yang diperlukan; itu tidak akan terlihat sampai routing dinyalakan.

Jalur isi massal untuk kolom `LEGACY` masih dalam pengerjaan: impor pegawai EMP-004 tidak membawa kolom atasan sama sekali (tidak ada rujukan `direct_manager` di `apps/api/src/modules/employees/application/` maupun `infrastructure/`); satu-satunya jalur tulis yang sudah ada adalah `PATCH /admin/employees/:employeeId/manager` — satu pegawai per panggilan, izin `approvals.policy.manage` — dan **PR #395** (penetapan atasan langsung massal dengan dry-run wajib) **di-merge 2026-11-23 sebagai `9b842958`** dan **dirilis `734be5ca` 2026-11-24**, jadi jalur itu kini ada di production (§4).

**Temuan yang mengubah prasyarat pilot, 2026-11-23: sebuah kursi yang pejabatnya belum berakun aktif dulu dilewati diam-diam, bukan ditolak.** Sampai PR #406, resolver `STRUCTURE` memperlakukan kursi yang pejabatnya tertulis di bagan dan orangnya bekerja — tetapi akun HCIS-nya masih `invited` — persis seperti kursi yang tidak ada penghuninya: `vacancy_policy` dibaca, dan `CLIMB_TO_PARENT` membuat rantai naik satu tingkat. Tanpa galat, tanpa catatan, tanpa apa pun di layar. Pada unit kandidat pilot akibatnya konkret: **langkah persetujuan kepala unit hilang, dua langkah menyusut menjadi satu orang, cutinya tetap disetujui, dan tidak ada yang memberi tahu siapa pun.**

Ini bukan konfigurasi sudut. Pengukuran owner 2026-11-23 (baca saja) terhadap bagan terbit production: **seluruh 63 ikatan wewenang dan seluruh 29 jabatan memakai `CLIMB_TO_PARENT`, tanpa satu pun pengecualian** (§3) — jadi tidak ada satu kursi pun yang kebijakannya akan menahan keadaan itu. Temuan ini **ditemukan oleh pengujian ujung-ke-ujung #405 dan diperbaiki oleh #406**: kursi yang pejabatnya ada tetapi belum layak kini **menolak** dengan kalimat yang menyebut kursinya, orangnya, dan apa yang harus dilakukan; kursi yang benar-benar kosong tetap mengikuti `vacancy_policy`; pelaksana tugas berakun aktif tetap menyelamatkan kursinya. Keduanya **dirilis `734be5ca` 2026-11-24**, dan production tetap `LEGACY` sehingga perilaku hari ini tidak berubah sampai ada unit yang dipindahkan ke `STRUCTURE`. Rinciannya di L3; apa yang tersisa ada di V22.

**Temuan baru 2026-11-23, di luar cakupan pembukaan tetapi menyentuh lebih dari satu modul: katalog klasifikasi jabatan ORG-011 masih nol.** Pengukuran baca-saja 2026-11-23: `job_classifications` **0 baris** (0 yang berlaku hari ini), `employment_placements` dengan `job_classification_code` **0 dari 96**, `organization_positions` dengan `job_classification_code` **0 dari 474**. Akibatnya melewati batas satu modul: uang saku perjalanan dinas TRIP-002 menentukan golongan pegawai dari pemetaan **kode klasifikasi → golongan** (`trip_per_diem_golongan_map`, D-20), sehingga tanpa satu pun kode terikat di mana pun **tidak ada pegawai yang golongannya dapat diresolusi**, dan uang muka perjalanan tidak dapat berjalan untuk siapa pun — bukan karena fiturnya belum jadi, melainkan karena data yang menopangnya belum ada. Butir ini **tidak** ditarik ke cakupan pembukaan: ia tetap L16 dan L10 di §7. Yang berubah adalah angkanya — bukan "sebagian terisi", melainkan nol.

**Laporan mana pun yang menyatakan "semua PRD sudah selesai" tidak menjawab pertanyaan ini.** PRD yang selesai berarti kode sudah di-merge. Dokumen ini memisahkan "sudah di-merge" dari "sudah dirilis", "sudah menyala", "sudah pernah dipakai", dan "sudah terbukti merutekan".

## 2. Kosakata status

Lima status, dipakai persis seperti ini dan tidak dicampur:

| Status | Arti |
|---|---|
| **Belum selesai** | Pekerjaannya belum rampung di repository. |
| **Selesai belum dirilis** | Sudah di-merge ke `main`, tetapi belum ada di rilis production yang berjalan. |
| **Dirilis belum aktif** | Sudah ada di production, tetapi di balik saklar yang mati atau menunggu data, sehingga belum melakukan apa pun. |
| **Aktif belum diuji** | Hidup di production, tetapi belum pernah dijalankan dengan data nyata atau realistis. |
| **Sudah diuji** | Hidup di production dan terbukti bekerja, dengan bukti bertanggal. |

Setiap butir membawa lima keterangan: **status**, **bukti bertanggal**, **penghambat**, **langkah berikutnya**, **kriteria selesai**. Butir yang tidak dapat dipastikan dari repository ditulis **belum terverifikasi** dan masuk §8 beserta cara memeriksanya — tidak ada butir yang diam-diam dianggap beres.

## 3. Potret production — 2026-11-20

Angka di bawah ini diukur owner sendiri pada 2026-11-20 dan dipakai apa adanya.

**Diukur ulang baca-saja pada 2026-11-23: tidak ada yang bergerak.** Akun tetap 74 `invited`, 1 `EMPLOYEE` aktif, 2 `FOUNDATION_BOARD` aktif, 1 `SUPER_ADMIN` aktif. Penyetuju cuti per unit tetap 7 unit berakun `invited`, 1 unit tanpa akun sama sekali, 1 unit berakun aktif. Undangan aktivasi yang pernah tercatat tetap **nol**. `leave_requests`, `employee_loans`, dan `payroll_periods` tetap 0. Pegawai aktif dengan `management_scope <> 'MANAGED'` **0** (V9 terjawab).

Tiga hal yang sempat terbaca sebagai ketidakcocokan, dan ketiganya sudah terjawab pada 2026-11-23:

1. **Rincian penyetuju unit: angka 2026-11-20 keliru, datanya tidak berubah.** Yang benar adalah pembacaan 2026-11-23 — **7 `invited` + 1 tanpa akun + 1 `active` = sembilan unit**. Rincian 2026-11-20 yang sempat ditulis (8 + 1 + 1) berjumlah sepuluh untuk sembilan unit; itu salah hitung saat menuliskannya, **bukan perubahan data**. Kesimpulannya sama pada kedua tanggal: hanya satu unit yang penyetujunya berakun aktif.
2. **74 akun `invited` dengan nol undangan tercatat adalah keadaan yang wajar, bukan data yang hilang.** `invited` adalah salah satu status normal sebuah akun (`apps/api/src/modules/auth/account-activation.ts:19`, bersama `active`, `suspended`, `inactive`), sedangkan `account_activation_invitations` adalah tabel tersendiri yang baru terisi ketika undangan benar-benar **dikirim** (`apps/api/src/modules/auth/activation-invitation.ts:185`). Jadi 74 akun itu memang dibuat dalam keadaan menunggu aktivasi, dan undangannya tidak pernah berangkat. Tidak ada yang rusak atau hilang; yang belum terjadi adalah pengirimannya (W3).
3. **Selisih 96 versus 97 adalah selisih predikat, dan menyingkap satu catatan yang saling bertentangan** — lihat dua baris pertama tabel di bawah dan V21.

| Fakta | Angka |
|---|---|
| Pegawai `status='active'` | 97 — cacah baris berstatus aktif |
| Pegawai `status='active' AND removed_at IS NULL` | **96 — ini angka kelayakan proses** |
| Pegawai `status='active' AND removed_at IS NOT NULL` | **1** — catatan yang saling bertentangan (V21) |
| Akun `active` **total** | 4 (1 `EMPLOYEE`, 2 `FOUNDATION_BOARD`, 1 lain) |
| Akun `invited` | **74** — berstatus diundang, **bukan aktif** |
| Akun (seluruh status) | 81 (dari pencocokan jumlah pada pemeriksaan restore, §W12) |
| Pegawai `active` tanpa `direct_manager_employee_id` | **95 dari 97** — ini ukuran satu kolom `LEGACY`, bukan ukuran ketersediaan data atasan (§1) |
| Pegawai `active` tanpa unit | 0 |
| `payroll_periods` / `payroll_results` | 0 / 0 |
| `payslips` (impor historis) | 5.202 |
| `payroll_policy_versions` per kunci | `BASIC_MULTIPLIER`, `BPJS_KESEHATAN`, `CONTRACT_RATES`, `EARLY_SERVICE`, `FAMILY`, `FUNCTIONAL_ALLOWANCE`, `OVERTIME`, `PERFORMANCE`, `POSITIONAL_ALLOWANCE`, `SALARY_SCALE`, `TEACHING_HOURS`, `VARIANCE_THRESHOLD` masing-masing 1; `THR` 2. **Tidak ada** `PPH21_SETTINGS`, `PPH21_TER`, `PPH21_ANNUAL`, `PAYSLIP_LAYOUT` |
| `organization_rollout_settings` | **0 baris** → setiap workflow `LEGACY` |
| `employment_rollout_settings` | 0 baris |
| `employments` / `employment_terms` | 326 / 326 |
| `employment_placements` | 96 (96 employment berbeda) |
| `attendance_schedule_assignments` | 93 |
| `attendance_daily_records` | 2.127 |
| `attendance_events` | 2.855 |
| `attendance_biometric_credentials` | 0 |
| `attendance_adms_request_journal` | 932.271 |
| `leave_requests` / `employee_loans` / `reimbursement_claims` | 0 / 0 / 0 |

Pegawai aktif per unit: SDIT Tahfizh 46, Pesantren Tahfizh 22, General Affair 12, Taman Tahfizh 9, Keuangan 2, Yayasan Sabilul Quran 2, Bidang Pendidikan 2, Divisi Media 1, Human Capital Management 1.

**Mana yang dipakai, 96 atau 97 — diukur 2026-11-23.** Kedua angka benar untuk pertanyaan yang berbeda, dan selisihnya tepat satu baris:

| Predikat | Hasil |
|---|---|
| `status='active'` | 97 |
| `status='active' AND removed_at IS NULL` | 96 |
| `status='active' AND removed_at IS NOT NULL` | 1 |

**96 adalah angka yang benar untuk setiap pernyataan tentang kelayakan proses**, karena predikat yang lebih ketat itulah yang dipakai sistem: resolver ORG-004 menilai seorang incumbent layak hanya bila `e.status = 'active' AND e.removed_at IS NULL AND e.management_scope = 'MANAGED'` (`apps/api/src/modules/organization/repository.ts:806`; syarat ketiga tidak mengubah apa pun hari ini karena pegawai aktif di luar pengelolaan HCIS berjumlah 0, V9), dan kelayakan gerbang rilis TRIP-002 pada PR #398 memakai `status='active' AND removed_at IS NULL` (§4). **97 hanya benar untuk "berapa baris pegawai berstatus aktif"**, bukan untuk berapa orang yang dapat dilayani sebuah alur.

Angka lain di dokumen ini yang ditulis "dari 97" berasal dari pengukuran 2026-11-20 dan tidak diukur ulang per predikat; yang sudah pasti adalah penyebut kelayakannya 96. Satu baris yang membuat keduanya berbeda — pegawai berstatus `active` yang `removed_at`-nya terisi — adalah keadaan yang saling bertentangan dan menunggu keputusan HC (V21).

### Bagan organisasi di production — 2026-11-20

Diukur owner sendiri, baca saja. Bagan ini **terisi**, dan itu mengubah cara membaca W1.

| Fakta | Angka |
|---|---|
| Change set terbit | 16 (terakhir 2026-11-10) |
| `organization_nodes` | 1.111 |
| `organization_positions` | 474 |
| `organization_incumbencies` | 374 |
| `organization_memberships` | 1.439 |
| `organization_authority_bindings` | 555 — di antaranya 215 `SUPERVISORY_PARENT`, 104 `UNIT_APPROVER`, 3 `OVERSIGHT_PARENT`, 3 `GOVERNANCE_APPROVER` |
| `organization_reporting_overrides` | 0 |

Yang **tidak** dibuktikan oleh angka-angka ini: bahwa persetujuan benar-benar sampai ke orang yang ditunjuk bagan. Resolusi baca-saja menjawab *siapa yang seharusnya*, bukan *siapa yang bisa*; selama `organization_rollout_settings` kosong, bagan ini belum dipakai untuk merutekan apa pun (§1, L3).

**Bentuk bagan yang berlaku — diukur 2026-11-23.** Ini pengukuran pertama atas kebijakan kekosongannya, dan hasilnya seragam:

| Fakta | Angka |
|---|---|
| Ikatan wewenang pada bagan yang berlaku, memakai `CLIMB_TO_PARENT` | **63 dari 63** |
| Jabatan pada bagan yang berlaku, memakai `CLIMB_TO_PARENT` | **29 dari 29** |
| Kursi yang dipegang akun (ORG-013) | 2 |
| Pendudukan akun | 2 |
| Binding `GOVERNANCE_APPROVER` | 1 |

Angka 63 dan 29 **tidak menggantikan** 555 `organization_authority_bindings` dan 474 `organization_positions` di tabel sebelumnya, dan keduanya tidak bertentangan: kedua tabel itu berkolom `change_set_id` (`apps/api/migrations/0019_dynamic_organization.sql`), jadi 555 dan 474 mencacah baris di **seluruh 16 change set terbit**, sedangkan 63 dan 29 adalah bagan **yang berlaku**, yaitu satu change set. Penulis dokumen ini tidak mengukur ulang keduanya; yang dipastikan hanyalah bahwa skemanya memang berjenjang per change set, sehingga kedua angka menjawab pertanyaan yang berbeda.

Keseragaman itulah yang membuat temuan D-R5 penting: `CLIMB_TO_PARENT` di **setiap** kursi berarti tidak ada satu pun titik pada bagan yang akan menahan rantai ketika pejabatnya belum berakun aktif (§1, L3).

### Kelengkapan email dan akun per unit — 2026-11-23

Diukur owner sendiri, baca saja. Penyebutnya adalah 96 pegawai yang layak diproses (§3 di atas, V21); dengan cacah baris `status='active'` saja angkanya 23 dari 97.

| Unit | Aktif | Tanpa email | Akun aktif |
|---|---|---|---|
| SDIT Tahfizh | 46 | 10 | 0 |
| Pesantren Tahfizh | 22 | 7 | 0 |
| General Affair | 12 | 4 | 0 |
| Taman Tahfizh | 9 | 1 | 0 |
| Keuangan | 2 | 0 | 0 |
| Bidang Pendidikan | 2 | 0 | 0 |
| Divisi Media | 1 | 0 | 0 |
| Yayasan Sabilul Quran | 1 | 0 | 0 |
| Human Capital Management | 1 | 0 | **1** |
| **Jumlah** | **96** | **22** | **1** |

**22 dari 96 pegawai aktif tidak punya email**, dan email adalah syarat keras jalur undangan: pegawai tanpa email ditolak `409 EMPLOYEE_EMAIL_MISSING` sebelum SQ Hub dipanggil, karena Akun SQ wajib punya email (W3). Ini menutup V3, yang sebelumnya berbunyi "belum diukur". Kolom "Akun aktif" mengulang apa yang sudah diketahui dari sisi lain: delapan dari sembilan unit tidak punya satu pun akun aktif.

**Untuk pilot, Taman Tahfizh terhitung kecil.** Dari 9 pegawai aktifnya, **tepat satu orang tidak punya email sekaligus tidak punya akun sama sekali**; delapan sisanya, termasuk kepala unit, sudah punya email dengan akun berstatus `invited`. Jadi kebutuhan data untuk membuka unit itu adalah satu email dan satu pembuatan akun, ditambah aktivasi delapan akun yang sudah ada. Angka ini dicatat sebagai fakta; **memilih unit pilot dan waktunya tetap keputusan HCM dan owner yang belum diambil.**

### Katalog klasifikasi jabatan (ORG-011) di production — 2026-11-23

Diukur owner sendiri, baca saja. Ini pengukuran pertama atas katalog ini, dan hasilnya **nol di setiap kolom**.

| Fakta | Angka |
|---|---|
| `job_classifications` | **0 baris** (0 yang berlaku hari ini) |
| `employment_placements` dengan `job_classification_code` | **0 dari 96** |
| `organization_positions` dengan `job_classification_code` | **0 dari 474** |
| Pegawai aktif dengan `management_scope <> 'MANAGED'` | **0** — diukur bersama angka di atas karena menentukan penyebutnya: tidak ada pegawai aktif yang dikecualikan (V9) |

Kolom yang diukur adalah kolom yang memang dipakai ORG-011: spesifikasi `docs/domain/job-classification-grade.md` §3.1–§3.3 menetapkan katalog pada `job_classifications` (ditambah `job_grades` yang opsional) dan pengikatannya pada `organization_positions.job_classification_code` serta `employment_placements.job_classification_code`; migrasi `0110_job_classification_foundation.sql` membuat katalognya dan `0112_job_classification_bindings.sql` menambahkan kedua kolom pengikat itu. Resolver `bindingsOn` di `apps/api/src/modules/organization/job-classification-resolver.ts` membaca persis kedua kolom tersebut — `COALESCE(placement.job_classification_code, position_row.job_classification_code)` — dan tidak ada tabel atau rute ketiga yang menyimpan klasifikasi efektif seorang pegawai. Jadi angka nol di atas bukan akibat salah kolom.

Yang **tidak** dibuktikan angka-angka ini: bahwa katalog kosong itu salah. Roadmap §C memang menyatakan katalog production sengaja dibiarkan kosong untuk diisi HC (L16). Yang baru di sini adalah akibatnya yang melewati satu modul: dengan nol kode terikat di mana pun, resolusi golongan TRIP-002 (D-20) tidak menghasilkan apa pun untuk siapa pun, sehingga perkiraan dan pengajuan uang muka perjalanan dijawab `409 TRIP_PER_DIEM_GOLONGAN_UNMAPPED` untuk seluruh pegawai (L10). **Kapan katalog diisi, dan oleh siapa, adalah keputusan HCM dan owner yang belum diambil**; dokumen ini hanya mencatat keadaannya.

**96**, bukan 97, adalah populasi yang diperiksa gerbang, dan selisihnya sudah terjawab (§3): gerbang memakai `status='active' AND removed_at IS NULL`, sedangkan 97 adalah cacah baris `status='active'` saja. Satu baris di antaranya berstatus aktif tetapi sudah ditandai terhapus (V21).

### Jalur mesin absensi — 2026-11-20

Diukur owner sendiri pada 2026-11-20:

| Fakta | Angka |
|---|---|
| Kontak terakhir perangkat ke HCIS | **17 November 14:36** |
| Log kehadiran yang benar-benar dikirim dalam sepekan sebelumnya | **4** |
| Handshake protokol pada periode yang sama | **28.087** |
| Unit yang pernah menghasilkan scan | **Hanya SDIT Tahfizh** |
| Taman Tahfizh | Punya jadwal, **nol** scan |
| Pesantren Tahfizh | Tidak punya jadwal, tidak punya scan |

**Diukur ulang 2026-11-23, dan hanya butir ini yang memburuk.** Kontak terakhir perangkat tetap **17 November 14:36** dan scan terakhir **17 November 09:10**, artinya jalur mesin sudah **enam hari** tidak menghasilkan kehadiran; **nol scan dalam tiga hari terakhir sebelum pemeriksaan**. Ini satu-satunya butir di daftar ini yang memburuk hanya karena waktu berjalan, dan akibatnya tidak dapat diperbaiki belakangan: **kehadiran yang tidak terkirim tidak dapat disusun ulang**. Butir lain yang tertahan menunggu keputusan tetap pada keadaan yang sama bila ditunda; butir ini kehilangan data setiap hari.

Pembacaan yang harus disebut terang-terangan:

- 4 akun aktif untuk 97 pegawai berarti sistem ini belum punya pengguna.
- 4 log kehadiran berbanding 28.087 handshake, dan perangkat yang diam sejak 17 November, berarti jalur mesin **tidak sedang menghasilkan kehadiran hari ini** — perangkatnya menyapa, tetapi tidak mengirim data. Ini mengubah W5 dari "satu-satunya alur yang berjalan" menjadi "alur yang pernah berjalan, untuk satu unit, dan sekarang sunyi".
- 0 pengajuan cuti, kasbon, dan reimbursement berarti seluruh APR-001 belum pernah menyala sekali pun, bukan sekadar jarang dipakai.
- 0 periode payroll berarti PAY-003 belum pernah menghitung apa pun di production; 5.202 `payslips` seluruhnya berasal dari impor historis PAY-001.
- 932.271 baris `attendance_adms_request_journal` berbanding 2.855 `attendance_events`: jurnal itu log permintaan mentah mesin, bukan ukuran pemakaian oleh manusia.
- `attendance_biometric_credentials` = 0 **adalah kebijakan, bukan celah** (lihat §7 butir L15).

## 4. Garis rilis: apa yang di `main` tetapi belum di production

**Garis rilisnya satu kalimat, dan kalimat itu tidak ikut basi: production menjalankan `hcis-7fd89146-20261126` sejak 26 November 2026 16:16 WIB, jadi segala sesuatu yang masuk ke `main` sesudah `7fd89146` belum ada di production.** Pada tanggal itu garis rilisnya **kosong** untuk kode: `7fd89146` adalah `origin/main` (perbaikan 409 kelompok hak cuti dan tanggal mustahil, #421, tanpa migrasi). Migrasi tertinggi yang sudah diterapkan adalah **`0186_help_center_annual_leave_quota.sql`** (seluruh 158 berkas bundel). Rilis terakhir `df406452` (25 Nov 20:56 WIB, LEAVE-003 R2 #418, migrasi aditif `0185`–`0186`) menyusul empat rilis beruntun: `734be5ca` (24 Nov 10:20 WIB, sepuluh migrasi tertunda), `b3adc898` (24 Nov 15:07 WIB, ADMS-R2d #411 dengan migrasi aditif `0184`), `f6edebd4` (25 Nov 09:27 WIB, perbaikan audit kesiapan #412, **tanpa migrasi**), dan `27f10ccd` (25 Nov 12:17 WIB, persiapan pilot #415, **tanpa migrasi**). Sebelum rangkaian itu production berhenti di `hcis-127b6068-20261118` dengan migrasi tertinggi `0167_payroll_thr_non_permanent.sql` sejak 18 November.

**Yang menentukan risiko rilis adalah daftar migrasi yang belum diterapkan, bukan cacah PR.** Sesudah rilis 2026-11-24 dan 2026-11-25 daftar itu **kosong**: kesepuluh migrasi yang menunggu sudah diterapkan (`0172`, `0174`, `0175`, `0176`, `0177`, `0178`, `0180`, `0181`, `0182`, `0183`), dengan backup `pg_dump -Fc` diambil lebih dulu dan gerbang kandidat lulus 7/7. Ia akan terisi lagi pada perubahan skema berikutnya. Ia hanya bertambah bila ada perubahan skema, sehingga tidak bergerak ketika dokumen di-merge — itulah sebabnya ia yang dipakai sebagai patokan.

**Cacah PR adalah potret bertanggal, bukan angka yang berlaku selamanya.** Diukur pada `origin/main` = **`2535444f`**, 2026-11-23: dua puluh dua PR belum dirilis — tiga belas fitur dan sembilan dokumen. Empat PR masuk sejak potret sebelumnya (`4ce2cae9`) — #400, #404, #405, #406 — dan **tidak satu pun membawa migrasi**, sehingga daftar migrasi di bawah tetap sembilan. Angka ini naik setiap kali satu PR dokumen masuk, termasuk koreksi dokumen ini sendiri, sehingga kenaikannya tidak dengan sendirinya berarti ada tambahan risiko rilis. Baca tabel di bawah sebagai isi garis rilis pada commit itu, dan commit `main` yang disebut sebagai tanggal kedaluwarsanya.

| PR | Commit merge | Isi | Migrasi | Status |
|---|---|---|---|---|
| #398 | `734be5ca` | TRIP-002 D-22: uang saku terkunci sampai dinyalakan; gerbang katalog pindah dari rilis ke penyalaan fitur | `0183` | Dirilis `734be5ca` 2026-11-24 |
| #406 | `2535444f` | ORG-004 D-R5: kursi yang pejabatnya belum layak menolak, bukan dilewati | — | Dirilis `734be5ca` 2026-11-24 |
| #405 | `ecc2ae99` | ORG-004: pengujian ujung-ke-ujung alur cuti mode `STRUCTURE` lewat route API | — | Dirilis `734be5ca` 2026-11-24 |
| #400 | `860a1c92` | EMP-005 S2B §8.7: menolak pengaju di luar pengelolaan HCIS di setiap modul self-service | — | Dirilis `734be5ca` 2026-11-24 |
| #404 | `d851288e` | Dokumen OPS-CLOSE-001 (koreksi lanjutan 2026-11-23) | — | Dirilis `734be5ca` 2026-11-24 |
| #403 | `4ce2cae9` | Dokumen OPS-OPEN-001 (kriteria go/no-go pembukaan dan rencana pilot terbatas) | — | Dirilis `734be5ca` 2026-11-24 |
| #399 | `1e5d46fd` | ORG-004 perbaikan saklar rollout beserta testnya | `0182` | Dirilis `734be5ca` 2026-11-24 |
| #402 | `1ccb7e6c` | Dokumen OPS-CLOSE-001 (jawaban atas tiga selisih) | — | Dirilis `734be5ca` 2026-11-24 |
| #401 | `ced6592d` | Dokumen OPS-CLOSE-001 (koreksi 2026-11-23) | — | Dirilis `734be5ca` 2026-11-24 |
| #395 | `9b842958` | ORG-001 penetapan atasan langsung massal dengan dry-run wajib, usulan atasan dari bagan | — | Dirilis `734be5ca` 2026-11-24 |
| #397 | `2e4e70d4` | Dokumen OPS-CLOSE-001 (koreksi 2026-11-20) | — | Dirilis `734be5ca` 2026-11-24 |
| #396 | `b2fa31dd` | LEAVE-UX-001 / UX-FLOW-001 satu langkah per layar: 14 alur bertahap jadi wizard, route baru `/app/leave/annual` (frontend saja) | — | Dirilis `734be5ca` 2026-11-24 |
| #394 | `e51a8fea` | Dokumen OPS-CLOSE-001 (pembaruan untuk #391) | — | Dirilis `734be5ca` 2026-11-24 |
| #393 | `34fe9608` | Dokumen OPS-CLOSE-001 (pembaruan untuk #383) | — | Dirilis `734be5ca` 2026-11-24 |
| #391 | `838d1e24` | LOAN-002 jalur tulis pemetaan kursi persetujuan untuk HC | `0181` | Dirilis `734be5ca` 2026-11-24 |
| #392 | `03d05ea3` | Dokumen OPS-CLOSE-001 (daftar penutupan, versi pertama) | — | Dirilis `734be5ca` 2026-11-24 |
| #383 | `c84dd4dd` | ADR-0008 B5 Pengurus Yayasan membaca gaji per orang, di balik `GOVERNANCE_PAYROLL_READ_ENABLED` yang mati | `0180` | Dirilis `734be5ca` 2026-11-24 |
| #390 | `2560b04f` | PERF-001 jalur keberatan pegawai | `0176` | Dirilis `734be5ca` 2026-11-24 |
| #387 | `7df37cf3` | PERF-001 rubrik kinerja berversi per kelompok jabatan + siklus semesteran | `0175` | Dirilis `734be5ca` 2026-11-24 |
| #384 | `64fe64bf` | LOAN-002 rantai persetujuan kasbon berbasis kursi | `0177`, `0178` | Dirilis `734be5ca` 2026-11-24 |
| #389 | `89a096e2` | TRIP-002 tarif uang saku per SK 01.111/YSQ/VII/2026 | `0172` | Dirilis `734be5ca` 2026-11-24 |
| #386 | `61d05a9b` | LEAVE-009 C1 masa kritis tanpa tinjauan HC, TRIP-001 C4 dinas mundur 7 hari, NOTIF-003 D18 jendela pengingat 04.00–23.00 | `0174` | Dirilis `734be5ca` 2026-11-24 |
| #388 | `ce516098` | Dokumen: catatan verifikasi rilis `hcis-127b6068-20261118` | — | Dirilis `734be5ca` 2026-11-24 |
| #385 | `127b6068` | Spesifikasi PAY-004 dan REIMB-002 (dokumen saja) | — | Dirilis `127b6068` 2026-11-18 |

Dua catatan supaya angkanya tidak dibaca keliru:

- **#385 bukan PR yang tertahan.** Commit merge-nya *adalah* `127b6068`, yaitu rilis yang sedang berjalan, jadi isinya sudah ada di production. PR dokumen yang tertahan adalah #388, #392, #393, dan #394.
- Koreksi owner 2026-11-20 menyebut "sembilan PR fitur dan empat PR dokumen" dan memasukkan #385 ke dalam daftar dokumen. Terhadap `b2fa31dd` yang terbaca di repository saat itu, jumlahnya **delapan fitur dan empat dokumen**, dengan #385 sudah dirilis dan #388 sebagai PR dokumen keempat. Selisih satu PR fitur itu tidak ditemukan di `127b6068..b2fa31dd`; dicatat di sini apa adanya, bukan dibulatkan ke salah satu angka.

**PR yang masuk sejak pengukuran 2026-11-20.** #395 — penetapan atasan langsung massal dengan dry-run wajib (ORG-001) — **sudah di-merge sebagai `9b842958`**. Ini PR yang menjawab jalur isi massal W1; sesuai §2 dokumen ini, merge bukan rilis, jadi jalur itu belum ada di production. **#399** (ORG-004, perbaikan saklar rollout) masuk sebagai `1e5d46fd` dan **membawa migrasi `0182`** — satu-satunya dari empat PR terakhir yang menambah risiko rilis. #397, #401, #402, dan #403 adalah dokumen.

**Tidak ada PR yang masih terbuka pada 2026-11-24 (`734be5ca`).** #398 — yang sempat menunggu keputusan owner tentang seberapa keras gerbang golongan boleh menahan rilis — dijawab pada 2026-11-24: pemeriksaan katalog dibatasi pada **peluncuran fitur uang saku** (TRIP-002 D-22), bukan pada setiap rilis. PR itu diperluas sesuai keputusan tersebut, ditinjau independen satu putaran (yang menemukan satu lubang nyata: penyelesaian uang muka tetap menghitung uang harian saat fitur mati, sehingga gerbang rilis harus tetap memeriksa uang muka yang sudah dicairkan — diperbaiki), lalu di-merge dan dirilis pada hari yang sama.

Terhadap katalog yang nol (§3), pemeriksaan kesiapan uang saku tetap melaporkan `CATALOGUE_EMPTY` dan `EMPLOYEE_UNRESOLVED` untuk seluruh 96 pegawai aktif — tetapi yang ditahannya adalah **penyalaan fitur**, bukan rilisnya. Rilis 2026-11-24 lewat dengan katalog tetap nol, dan uang saku mendarat terkunci (`trip_per_diem_activation` 0 baris). Fitur itu baru dapat dinyalakan setelah HC mengisi katalog klasifikasi, pemetaan golongan, dan tarifnya; penyalaannya diperiksa ulang setiap kali, termasuk bila pernah dimatikan lalu dinyalakan lagi.

Saklar `GOVERNANCE_PAYROLL_READ_ENABLED` milik #383 tetap mati (§6). Rilisnya sudah tidak menahan apa pun sejak 2026-11-25 (W15 tertutup); yang tersisa adalah keputusan menyalakan saklarnya.

### Migrasi

| | |
|---|---|
| Diterapkan di production | **156 berkas, tertinggi `0184_adms_mapping_reassigned.sql`** (diukur baca-saja 2026-11-25 sesudah rilis `f6edebd4`). Sebelum rangkaian rilis 24–25 November: 145 berkas, tertinggi `0167_payroll_thr_non_permanent.sql` |
| Di bundel rilis production `f6edebd4` | 156 berkas `.sql`, seluruhnya terpasang; rilis ini sendiri menerapkan **nol** |
| Di `origin/main` (`f6edebd4`, 2026-11-25) | 156 berkas `.sql` |
| **Belum ada di production** | tidak ada |

Daftar inilah patokan garis rilis. Ia bertambah satu sejak pengukuran 2026-11-20 — `0182` dari #399 — dan **tidak bergerak sama sekali** oleh lima PR berikutnya, baik yang dokumen maupun yang menyentuh kode: #403, #404, #400, #405, dan #406. Bila kelak hanya cacah PR yang naik sementara daftar ini tetap, risiko rilisnya memang tidak berubah.

**Nomor `0168`–`0171` dan `0173` tidak ada sebagai berkas, dan memang tidak pernah ada.** Nomor-nomor itu sempat terpakai lalu ditinggalkan saat penomoran ulang ketika beberapa PR bertabrakan; riwayatnya masih terbaca di `eb7cb663`, `b5b38cc1`, `8cc03998`, `ee70b7e2`. Pemeriksaan `apps/api/migrations/` pada `b2fa31dd` menunjukkan **`0179` juga tidak ada**, karena alasan yang sama — koreksi owner menyebut lima nomor, berkasnya yang hilang ada enam. Ini dicatat eksplisit supaya tidak ada yang kelak menyimpulkan ada migrasi yang hilang. Identitas migrasi adalah nama berkas penuh, bukan awalannya (`apps/api/migrations/production-history-manifest.json`), jadi lompatan nomor bukan masalah selama tidak ada nama berkas yang dipakai ulang.

## 5. Cakupan wajib pra-pembukaan

Butir di bagian ini adalah yang harus benar sebelum ~97 pegawai diberi akses. Butir di luar itu ada di §7 dan **tidak** boleh ditarik ke sini.

**Urutan penghambat, menurut bukti 2026-11-20.** Nomor W tidak berubah supaya rujukan dari dokumen lain tetap berlaku; yang berubah adalah urutan mengerjakannya:

1. **W3 lalu W2 — kesiapan akun penyetuju.** 95 dari 96 pegawai aktif yang layak diproses berada di unit yang penyetuju cutinya belum berakun aktif (7 unit `invited`, 1 unit tanpa akun; §3). Selama ini benar, setiap pengajuan berhenti di `409 APPROVER_ACCOUNT_NOT_READY`, apa pun isi kolom atasan.
2. **W1 — sumber data atasan tersambung.** Tetap wajib: tanpa atasan, pengajuan tidak sampai ke tahap penyetuju unit. Datanya sebagian besar sudah ada di bagan organisasi, tetapi jalur yang berjalan belum membacanya.
3. ~~**W15 — rilis `main`**~~ **tertutup 2026-11-25**: empat rilis beruntun (`734be5ca`, `b3adc898`, `f6edebd4`, `27f10ccd`) membawa seluruh `main` ke production, perbaikan audit kesiapan dan persiapan pilot termasuk. Tidak ada lagi perilaku yang tertahan di `main`.
4. **W16 — kelompok hak cuti** (baru 2026-11-25). Mendahului W4 untuk Cuti Tahunan, dan mendahului W3 maupun W2 dalam arti yang berbeda: ia menolak pengajuan lebih awal daripada keduanya, sebelum rantai penyetuju dibaca sama sekali. Mengerjakan W2 dan W3 lebih dulu tanpa W16 menghasilkan unit berisi orang yang dapat masuk, penyetuju yang siap, dan nol pengajuan yang dapat dibuat.
5. Sisanya (W4–W14) menyusul, sesuai ketergantungan yang ditulis di tiap baris.

| # | Butir | Status |
|---|---|---|
| W1 | Sumber data atasan tersambung ke rantai persetujuan | Dirilis belum aktif |
| W2 | Penyetuju cuti per unit | Dirilis belum aktif |
| W3 | Akun untuk 97 pegawai | Dirilis belum aktif |
| W4 | Cuti dan izin (LEAVE-001/002/008/009/010, APR-001) | Dirilis belum aktif |
| W5 | Penyerapan kehadiran dari mesin ADMS | Sudah diuji |
| W6 | Layanan kehadiran di atas penyerapan (ATT-002/007/008/015) | Dirilis belum aktif |
| W7 | Clock In/Out mobile (ATT-006) | Sudah diuji |
| W8 | Slip gaji pegawai (PAY-001/PAY-002) | Sudah diuji |
| W9 | Notifikasi in-app dan WhatsApp (NOTIF-003/004) | Aktif belum diuji |
| W10 | Isi Pengumuman dan Pusat Bantuan (NOTIF-002, HELP-001) | Dirilis belum aktif |
| W11 | Perilaku modul yang belum siap saat pintu dibuka | Belum selesai |
| W12 | Cadangan dan pemulihan | Aktif belum diuji |
| W13 | Keamanan dan matriks izin | Belum terverifikasi |
| W14 | Kepemilikan operasional, insiden, stop, rollback | Belum selesai |
| W15 | Merilis `main` ke production | **Tertutup 2026-11-25.** `734be5ca` dan `b3adc898` (24 Nov) lalu `f6edebd4` dan `27f10ccd` (25 Nov); sesudahnya tidak ada perubahan `main` yang menunggu rilis (§4) |
| W16 | Kelompok hak cuti pegawai (`education` / `non_education`) | **Belum selesai** (baru 2026-11-25) |

### W1 — Sumber data atasan tersambung ke rantai persetujuan

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Kolom, layar, resolver, **dan bagan organisasinya** ada di production. Yang belum ada adalah sambungan di antara keduanya: rantai persetujuan membaca kolom `LEGACY` yang kosong, bukan bagan yang terisi, sehingga ia tidak merutekan apa pun. |
| **Bukti bertanggal** | Pengukuran owner 2026-11-20, dua-duanya baca saja. (1) **Kolom `LEGACY`:** 95 dari 97 pegawai aktif tanpa `direct_manager_employee_id`. (2) **Bagan organisasi, terisi:** 16 change set terbit (terakhir 2026-11-10), 1.111 `organization_nodes`, 474 `organization_positions`, 374 `organization_incumbencies`, 1.439 `organization_memberships`, 555 `organization_authority_bindings` (215 `SUPERVISORY_PARENT`, 104 `UNIT_APPROVER`, 3 `OVERSIGHT_PARENT`, 3 `GOVERNANCE_APPROVER`), `organization_reporting_overrides` kosong. (3) **Penelusuran bagan, diukur 2026-11-23: 96 dari 96 pegawai aktif yang layak diproses menemukan kepala** — lewat binding `LEADER` dengan pendakian node pada change set terbit yang berlaku. Lapisan koordinator memang sudah ada di bagan: SDIT Tahfizh tersebar ke lima kepala (19/15/7/3/2), Pesantren Tahfizh ke enam (9/5/4/3/1/1), General Affair ke dua (9/3), Taman Tahfizh seluruhnya ke satu. Kursi kosong, jabatan rangkap, dan sub-bagian tanpa kepala tidak menggagalkan satu pun, karena pendakian melewatinya. Ini menggantikan kata **"hampir seluruh"** yang sebelumnya dipakai di sini. Kode: `resolveLeaveLineApprovalChain` melempar `DIRECT_MANAGER_MISSING` bila kolom kosong (`apps/api/src/modules/leave/domain/approval-chain.ts`); mode resolusi jatuh ke `LEGACY` karena `organization_rollout_settings` kosong (`apps/api/src/modules/organization/repository.ts:777`). Metrik `without_direct_manager` di ringkasan Portal Organ mengukur kolom itu, bukan bagan (`apps/api/src/modules/governance/summary.ts:181`). |
| **Yang masih belum diketahui** | Dua hal, dan keduanya tidak boleh ditutup dengan angka 96 dari 96 di atas. (1) **Angka itu berasal dari penelusuran data bagan production, bukan dari resolver yang berjalan.** Ia bukan simulasi — datanya nyata dan ditelusuri apa adanya — tetapi ia juga bukan pengajuan nyata yang dirutekan, dan ORG-004 `SHADOW` tetap belum pernah dijalankan. Jadi yang terbukti adalah **bagannya memang memuat kepala untuk setiap orang**, bukan bahwa resolver production akan memberi jawaban yang sama pada setiap kasus (V17, L3). Temuan #405/#406 menunjukkan jaraknya bukan teoretis: sampai #406, resolver memanjat melewati kursi yang pejabatnya belum berakun aktif, sehingga rantai yang terbaca "teresolusi" bisa saja rantai yang kehilangan satu langkah — dan seluruh 63 ikatan serta 29 jabatan pada bagan yang berlaku memakai `CLIMB_TO_PARENT` (§1, §3, L3). (2) **Kesiapan akun dan izin penyetuju hanya teruji saat bagan benar-benar dipakai untuk routing.** Resolusi baca-saja mengatakan siapa yang *seharusnya* menyetujui; ia tidak membuktikan orang itu punya akun aktif atau izin untuk menyetujui. Pada 2026-11-20 hanya 4 akun aktif, sementara **74 akun masih `invited`** — dan `invited` bukan aktif. |
| **Penghambat** | Memilih salah satu dari dua jalur, lalu mengerjakannya. **(a) Isi kolom `LEGACY` dari bagan:** jalur isi massal belum ada di production — EMP-004 tidak membawa kolom atasan, satu-satunya jalur tulis yang hidup adalah `PATCH /admin/employees/:employeeId/manager` (satu pegawai per panggilan, izin `approvals.policy.manage`), dan **PR #395** yang menambahkan penetapan massal dengan dry-run wajib **sudah dirilis** (`9b842958`, rilis `734be5ca` 2026-11-24), sehingga jalur itu kini hidup di production (§4). Kalimat "jalur isi massal belum ada di production" di awal baris ini tidak lagi berlaku. **(b) Pindah ke `STRUCTURE`:** resolver langsung membaca bagan, tetapi itu menuntut gate ORG-004 — unit pilot, `SHADOW`, perbandingan dengan `LEGACY`, go/no-go — yang seluruhnya masih MISSING (L3). |
| **Langkah berikutnya** | (1) Owner memilih (a) atau (b); keduanya sah, tetapi menjalankan keduanya setengah-setengah tidak menutup apa pun. (2) Bila (b): jalankan `SHADOW` lebih dulu — cakupan bagannya sudah terukur 96 dari 96 lewat penelusuran data, dan `SHADOW` yang membuktikan resolver production memberi jawaban yang sama. (3) Bila (a): jalur isi massalnya sudah ada di production sejak rilis `734be5ca` 2026-11-24, jadi langsung isi massal dengan dry-run bersih dan jalur rollback yang jelas, karena itu **perubahan data production** (AGENTS.md §2). (4) Apa pun jalurnya, pegawai yang memang tidak punya atasan (mis. Ketua Yayasan) ditangani eksplisit, bukan dibiarkan kosong. (5) Sejalan dengan W3, pastikan penyetuju yang ditunjuk bagan punya akun **aktif**, bukan `invited`. |
| **Kriteria selesai** | Rantai persetujuan production menemukan penyetuju untuk setiap pegawai aktif yang harus memakai HCIS — lewat kolom yang terisi (`without_direct_manager` = 0 pada `GET /governance/summary`) atau lewat mode `STRUCTURE` yang menyala — setiap sisa punya alasan tertulis yang diterima owner, **dan** satu pengajuan nyata dari pegawai di tiap unit benar-benar sampai ke penyetujunya dan diputuskan. Pratinjau resolusi saja tidak menutup butir ini. |

### W2 — Penyetuju cuti per unit

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Penyetujunya **sudah ditetapkan** untuk kesembilan unit berpegawai aktif, tetapi hampir semuanya belum bisa bertindak karena akunnya belum aktif. Jadi butir ini bukan lagi soal konfigurasi yang kosong, melainkan soal akun. |
| **Bukti bertanggal** | Pengukuran owner, baca saja terhadap production; angka yang berlaku adalah pembacaan **2026-11-23**: dari 9 unit berpegawai aktif, **7 unit penyetuju cutinya berakun `invited`** dan **1 unit penyetujunya tidak punya akun sama sekali** (Yayasan Sabilul Quran). Hanya Human Capital Management yang penyetujunya berakun aktif. Rincian 2026-11-20 yang sempat ditulis di sini (8 + 1 + 1, berjumlah sepuluh untuk sembilan unit) **keliru saat dituliskan dan diperbaiki pada 2026-11-23; datanya sendiri tidak berubah** (§3). Dengan jumlah pegawai per unit di §3, itu berarti **95 dari 96 pegawai aktif yang layak diproses** berada di unit yang penyetujunya belum bisa bertindak — bukan 96, karena satu pegawai Human Capital Management justru berada di satu-satunya unit yang penyetujunya berakun aktif. Angka 96 yang sempat tertulis di sini pada 2026-11-23 keliru dan diperbaiki pada koreksi berikutnya hari yang sama. Kode: penyetuju yang akunnya bukan `active` ditolak `409 APPROVER_ACCOUNT_NOT_READY`, pesan `Akun approver <nama> belum aktif.` (`apps/api/src/modules/leave/employee-routes.ts:345-350`); penjagaan yang sama ada di `leave/planned-leave-routes.ts`, `attendance/work-arrangement-routes.ts`, `loans/routes.ts`, `reimbursements/routes.ts`, `trips/routes.ts`, dan `trip-advances/routes.ts`. Resolver `LEGACY` tetap menuntut **keduanya** — atasan langsung dan penyetuju unit; tanpa penyetuju unit, pengajuan ditolak `UNIT_APPROVER_MISSING` ("Kepala Satuan Kerja / Unit Approver belum dikonfigurasi", `apps/api/src/modules/leave/organization-authority.ts`). Penyetuju dihitung ada hanya bila orangnya `active` dan masih dikelola HCIS (`apps/api/src/modules/board/aggregates.ts`). **Catatan 2026-11-23, dari bukti CI sintetis** (`apps/api/test/org004-structure-leave-flow.postgres.test.ts`): mode `STRUCTURE` sempat menolak penyetuju dengan akun bukan `active` sebagai `409 AUTHORITY_INELIGIBLE` tanpa menyebut nama siapa pun, dan — dengan `CLIMB_TO_PARENT`, yang pengukuran owner hari yang sama tunjukkan dipakai **seluruh 63 ikatan wewenang dan seluruh 29 jabatan** pada bagan terbit tanpa satu pun pengecualian — **melewati kursi itu diam-diam** sehingga rantainya naik ke kursi induk. **Keduanya diperbaiki hari yang sama lewat ORG-004 D-R5** (`docs/domain/dynamic-organization-structure.md`): kursi yang pejabatnya ada tetapi akunnya belum siap bukan kursi kosong dan tidak lagi dilewati, dan keadaan akun dijawab `409 APPROVER_ACCOUNT_NOT_READY` pada kedua mode dengan kalimat yang menyebut kursi dan orangnya. Perbaikannya **dirilis `734be5ca` 2026-11-24**; karena production tetap `LEGACY`, yang berlaku tetap jalur `LEGACY` di atas dan baris ini tidak naik status — yang menahan bukan lagi rilis, melainkan keadaan akun penyetuju. **Sejak rilis `f6edebd4` 2026-11-25** satu hal berubah di jalur `LEGACY` itu sendiri: penyetuju unit yang mengajukan cutinya sendiri tidak lagi ditolak `UNIT_APPROVER_MISSING` (ORG-004 D-R6). |
| **Penghambat** | Belum diukur. Mengisi atasan langsung saja tidak cukup: bila unit tidak punya penyetuju, pengajuan tetap gagal tertutup. Bagan organisasi production memang memuat **104 binding `UNIT_APPROVER`** (§3), tetapi binding itu hanya terbaca oleh mode `STRUCTURE`; selama production `LEGACY`, yang dibaca tetap `organizational_units.leave_approver_employee_id`. Sama seperti W1, adanya binding di bagan bukan bukti routing. |
| **Langkah berikutnya** | (1) Ini butir pertama yang harus ditutup, bersama W3: selama akun penyetuju belum aktif, tidak ada pengajuan yang bisa lewat di 8 dari 9 unit. **Kapan dan siapa yang diaktifkan adalah keputusan HCM dan owner, dan belum diambil** — dokumen ini tidak memperlakukannya sebagai tindakan yang sudah disetujui. (2) Unit Yayasan Sabilul Quran perlu penanganan tersendiri: penyetujunya belum punya akun sama sekali, jadi ia bukan sekadar menunggu aktivasi. (3) Baca metrik `units_without_approver` pada `GET /governance/summary` dengan akun Organ Yayasan sebagai pemeriksaan silang — perlu diingat metrik itu mengukur *ada atau tidaknya* penyetuju, bukan *bisa atau tidaknya* ia bertindak. |
| **Kriteria selesai** | Setiap unit berpegawai aktif punya penyetuju yang **berakun `active`**, dan satu pengajuan uji per unit benar-benar melewati langkah penyetuju unit tanpa `409 APPROVER_ACCOUNT_NOT_READY`. |

### W3 — Akun untuk 97 pegawai

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Alur aktivasi ada di production; 93 pegawai belum punya akun aktif. **Ini penghambat pertama**, karena yang belum aktif bukan hanya pegawai biasa, melainkan hampir seluruh penyetuju unit (W2). |
| **Bukti bertanggal** | Pengukuran owner 2026-11-20: 4 akun `active` total (1 di antaranya `EMPLOYEE`), **74 akun `invited`**, dan 81 akun untuk seluruh status (dari pencocokan jumlah pada pemeriksaan restore, W12). Pada 2026-10-16 OPS-READY-001 mencatat 4 `active`, 75 `invited`, 2 `inactive` — artinya dalam lima minggu angka aktif **tidak bergerak**. Pengukuran yang sama menunjukkan 7 dari 9 penyetuju unit berakun `invited` — angka 8 yang sempat ditulis untuk 2026-11-20 keliru dan diperbaiki pada 2026-11-23 (§3) — 1 unit penyetujunya tanpa akun, dan kedua atasan langsung yang kolomnya sudah terisi juga berakun `invited`. Jalur undangan lewat SQ Hub dipasang 2026-11-04 (`production-release-verification-2026-11-04-b28efeef.md`: `STAFF_ACTIVATION_ALLOWED_CLIENTS=hcis-api`, `HCIS_STAFF_VERIFY_BASE_URL` diperbaiki). **Pengukuran ulang 2026-11-23: angka akun tidak bergerak sama sekali — 74 `invited`, 1 `EMPLOYEE` aktif, 2 `FOUNDATION_BOARD` aktif, 1 `SUPER_ADMIN` aktif — dan undangan aktivasi yang pernah tercatat berjumlah nol.** Nol undangan tercatat berdampingan dengan 74 akun `invited` **bukan data yang hilang**: `invited` adalah salah satu status normal sebuah akun (`apps/api/src/modules/auth/account-activation.ts:19`), sedangkan baris `account_activation_invitations` baru dibuat ketika undangan benar-benar dikirim (`apps/api/src/modules/auth/activation-invitation.ts:185`). Jadi 74 akun itu memang dibuat dalam keadaan menunggu aktivasi, dan undangannya tidak pernah berangkat — yang belum terjadi adalah pengirimannya, bukan pencatatannya. |
| **Penghambat** | Tiga hal, semuanya di jalur undangan AUTH-002-INVITE (`docs/domain/account-activation.md`). (1) **Email wajib:** pegawai tanpa email ditolak `409 EMPLOYEE_EMAIL_MISSING` sebelum SQ Hub dipanggil, karena Akun SQ wajib punya email. **Diukur 2026-11-23: 22 dari 96 pegawai aktif yang layak diproses tidak punya email** — SDIT Tahfizh 10, Pesantren Tahfizh 7, General Affair 4, Taman Tahfizh 1, lima unit lainnya nol (§3). Sebanyak itulah undangan yang akan ditolak sebelum berangkat bila dikirim hari ini. (2) **Pemberitahuan WhatsApp terhalang daftar izin:** `WHATSAPP_RECIPIENT_MODE=allowlist` berlaku di production sejak 2026-11-11, jadi setiap NIP di luar `WHATSAPP_ALLOWLIST` menerima hasil `not_allowlisted` dan tidak dikirimi apa pun. Mengirim 97 undangan hari ini berarti 97 pegawai tidak tahu undangannya ada. Butir ini terikat pada W9. (3) **Jendela 14 hari:** akun `invited` yang undangannya `issued` naik otomatis menjadi `active` hanya bila pegawai masuk **dalam 14 hari** (`DRAFT`); lewat itu HC mengirim ulang. Undangan dari Oktober — 75 `invited` pada 2026-10-16 — hampir pasti sudah lewat. Selain itu, OPS-READY-001 P9 (pemulihan kata sandi / fallback manual) masih **MISSING**. |
| **Langkah berikutnya** | (1) **Dahulukan penyetuju.** Selama 8 dari 9 penyetuju unit berakun `invited`, tidak ada pengajuan yang bisa lewat di unit mereka, berapa pun jumlah pegawai yang diundang sesudahnya. Siapa yang diaktifkan dan kapan adalah **keputusan HCM dan owner yang belum diambil**; yang bisa dipastikan dari sini hanyalah bahwa tanpa itu W2, W4, dan W6 tidak dapat ditutup. (2) Lengkapi email 22 pegawai yang belum punya; jumlah dan sebarannya per unit sudah diukur (§3), jadi yang tersisa adalah pengumpulan datanya, bukan pengukurannya. (3) Tangani penyetuju Yayasan Sabilul Quran yang belum punya akun sama sekali. Bila gelombang pertama jatuh ke Taman Tahfizh, kebutuhan datanya terhitung kecil: satu orang tanpa email dan tanpa akun, delapan lainnya tinggal diaktifkan (§3) — **pemilihan unit pilot itu sendiri keputusan HCM dan owner yang belum diambil.** (4) Putuskan jalur pemulihan kata sandi (P9) sebelum gelombang pertama, karena 97 orang akan lupa kata sandi. (5) Kirim undangan **bergelombang per unit**, bukan 97 sekaligus, dan tambahkan NIP gelombang itu ke `WHATSAPP_ALLOWLIST` lebih dulu — atau lepas mode daftar izin sesuai W9 — supaya undangannya benar-benar sampai dan kegagalan terbaca per gelombang. |
| **Kriteria selesai** | Setiap penyetuju unit punya akun `active`, setiap pegawai aktif yang harus memakai HCIS punya akun `active`, jalur reset kata sandi tertulis, dan satu gelombang penuh (satu unit) sudah masuk tanpa tiket terbuka. |

### W4 — Cuti dan izin

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Seluruh LEAVE-001/002, LEAVE-008 penundaan, LEAVE-009 masa kritis, LEAVE-010 pembatalan, dan APR-001 ada di production, tetapi tidak melakukan apa pun karena W1–W3. |
| **Bukti bertanggal** | Pengukuran owner 2026-11-20, diukur ulang 2026-11-23 dan tetap sama: `leave_requests` = 0 sepanjang umur sistem. OPS-READY-001 sudah mencatat 0 pada 2026-10-16 dengan kalimat yang sama: "no real leave workflow use yet". Satu bagian LEAVE-009 (C1, masa kritis tanpa tinjauan HC) ada di PR #386 dan **belum dirilis**. Konfirmasi owner 2026-11-20 menyebut Human Capital Management sudah menguji "alur utama" dengan akun aktif (W7, W8); untuk cuti, `leave_requests` tetap 0 pada tanggal yang sama, jadi pengujian itu tidak meninggalkan pengajuan cuti di production dan baris ini tidak naik status. **Bukti CI 2026-11-23 (sintetis, bukan production):** satu alur Cuti Tahunan penuh dalam mode `STRUCTURE` kini berjalan lewat route API sungguhan — pengajuan, tiap keputusan, status akhir, dan rantai tersimpannya — di atas fixture berbentuk satu unit nyata yang seluruh pemohonnya `direct_manager_employee_id`-nya NULL (`apps/api/test/org004-structure-leave-flow.postgres.test.ts`). Artinya jalur `STRUCTURE` terbukti tidak membutuhkan kolom atasan lama sampai keputusan terakhir, bukan hanya sampai resolusi. Ini bukti perilaku kode; **baris ini tetap tidak naik status**, karena `leave_requests` di production tetap 0 dan tidak ada unit yang dipilih untuk pilot. |
| **Penghambat** | Berurutan: **W3 dan W2 lebih dulu** (95 dari 96 pegawai aktif yang layak diproses berada di unit yang penyetujunya berakun `invited` atau tanpa akun, sehingga pengajuan berhenti di `409 APPROVER_ACCOUNT_NOT_READY`), **baru W1**. Tidak ada penghambat kode yang diketahui. |
| **Langkah berikutnya** | Setelah W3, W2, dan W1: satu pengajuan cuti nyata per unit, melewati seluruh rantai sampai keputusan, dengan tanggal dan nomor pengajuannya dicatat. Yang diuji adalah **routing-nya**, bukan layarnya: pengajuan harus benar-benar sampai ke penyetuju dan diputuskan olehnya. |
| **Kriteria selesai** | Minimal satu pengajuan per unit berpegawai aktif selesai disetujui atau ditolak, saldo cuti berubah sesuai LEAVE-002, dan notifikasi penyetuju sampai (W9). Status naik ke **Sudah diuji** hanya dengan bukti bertanggal itu. |

### W5 — Penyerapan kehadiran dari mesin ADMS

| | |
|---|---|
| **Status** | **Sudah diuji** sebagai mekanisme, dengan batas yang sekarang jauh lebih sempit daripada yang pernah ditulis di dokumen ini: terbukti pernah menyerap kehadiran nyata, **untuk satu unit saja, dan jalurnya sedang sunyi**. |
| **Bukti bertanggal** | Pengukuran owner 2026-11-20: 932.271 baris `attendance_adms_request_journal`, 2.855 `attendance_events`, 2.127 `attendance_daily_records`, 93 `attendance_schedule_assignments`. OPS-READY-001 2026-10-16: 2 perangkat ADMS, 438 punch dalam 7 hari. Bukti canary fisik: `docs/development/attendance-adms-physical-canary-evidence.md`; ledger paritas ATT-005 mencatat 7 baris fisik terverifikasi (`docs/domain/attendance-wdms-full-physical-parity-ledger.md`). |
| **Keadaan jalur mesin pada 2026-11-20** | Diukur owner: perangkat **terakhir menghubungi HCIS 17 November 14:36**; dalam sepekan sebelumnya perangkat mengirim **4 log kehadiran** berbanding **28.087 handshake protokol**; **hanya SDIT Tahfizh** yang pernah menghasilkan scan; **Taman Tahfizh punya jadwal tetapi nol scan**; **Pesantren Tahfizh tidak punya keduanya**. Artinya jalur mesin saat ini tidak menghasilkan kehadiran, dan dua dari tiga unit bersekolah belum pernah terbukti memakainya sama sekali. |
| **Keadaan jalur mesin pada 2026-11-23** | Diukur owner, baca saja: kontak terakhir perangkat tetap **17 November 14:36**, scan terakhir **17 November 09:10**, dan **nol scan dalam tiga hari sebelum pemeriksaan**. Jalur mesin karena itu sudah **enam hari** tidak menghasilkan kehadiran. Inilah satu-satunya butir di daftar ini yang **memburuk hanya karena waktu berjalan**: kehadiran yang tidak terkirim **tidak dapat disusun ulang belakangan**, sehingga setiap hari penundaan adalah data yang hilang permanen, bukan pekerjaan yang tertunda. |
| **Penghambat** | (1) Perangkat menyapa tetapi tidak mengirim data, dan per 2026-11-23 sudah **enam hari** diam — penyebabnya belum diketahui. (2) Cakupan unit: satu unit terbukti, dua unit tidak. (3) Paritas fisik baru 7 baris; sisanya menunggu sesi di lokasi yang disetujui owner (`docs/operations/adms-physical-verification-checklist.md`). (4) 93 penugasan jadwal untuk 97 pegawai aktif menyisakan selisih yang belum dijelaskan. |
| **Langkah berikutnya** | (1) Cari tahu mengapa 28.087 handshake hanya menghasilkan 4 log, dan mengapa perangkat diam sejak 17 November — ini mendahului semua butir lain di baris ini. (2) Buktikan satu scan nyata di Taman Tahfizh, lalu sediakan jadwal dan satu scan di Pesantren Tahfizh. (3) Ukur ulang jumlah perangkat ADMS aktif dan punch 7 hari terakhir. (4) Jelaskan selisih 97 pegawai aktif vs 93 penugasan jadwal. (5) Jadwalkan sesi verifikasi fisik untuk sisa baris ledger. |
| **Kriteria selesai** | Perangkat mengirim log kehadiran secara rutin kembali, **ketiga unit** berjadwal pernah menghasilkan scan nyata, setiap pegawai aktif yang wajib absen punya penugasan jadwal, dan sisa baris ledger paritas berstatus `verified` atau diputuskan owner untuk dilewati. |

### W6 — Layanan kehadiran di atas penyerapan

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Klarifikasi ATT-002, lembur ATT-007, tukar shift ATT-008, serta tugas luar/WFH ATT-015 ada di production tetapi memakai rantai persetujuan yang sama dengan W1. |
| **Bukti bertanggal** | Kode: `attendance/overtime-approver.ts` memakai `workflowKey: "OVERTIME"` dan membaca `direct_manager_employee_id`; `attendance/work-arrangement-routes.ts` memakai resolver bersama. Spesifikasi sudah menyebut risikonya sejak awal: daftar asumsi `DRAFT` di `docs/domain/attendance-operational-simplification-spec.md` menulis bahwa bila data atasan belum lengkap, "pengajuan lembur pegawai tanpa atasan gagal tertutup (422) dan HC harus melengkapi data struktur lebih dulu". |
| **Penghambat** | W1, W2, W3. |
| **Langkah berikutnya** | Setelah W1: satu pengajuan lembur dan satu klarifikasi nyata, lalu satu pengajuan tugas luar/WFH, masing-masing sampai keputusan. |
| **Kriteria selesai** | Satu contoh per jenis pengajuan selesai dengan bukti bertanggal. |

### W7 — Clock In/Out mobile (ATT-006)

| | |
|---|---|
| **Status** | **Sudah diuji.** Human Capital Management sudah menguji absensi HP (clock in/out) dengan akun aktif. |
| **Bukti bertanggal** | Konfirmasi owner **2026-11-20**: Human Capital Management telah menguji absensi HP (clock in/out) memakai akun aktif. Cakupan rincinya — alur mana saja, peran mana, unit mana, pada tanggal berapa — tidak tercatat, jadi pengujian ini tidak menutup alur yang belum disebut. Saklarnya sendiri: `docs/development/production-release-verification-2026-11-04-e402c38a.md`, `MOBILE_ATTENDANCE_ENABLED=1` ditambahkan ke `/srv/hcis/shared/final.env` pada 2026-11-04 16:5x UTC, keyring media terbatas sudah ada, `BIOMETRIC_COLLECTION_ENABLED` tetap kosong. Sebelum itu Clock In/Out menjawab `runtime_disabled`. |
| **Penghambat** | Kebijakan retensi/purge foto **belum ditetapkan** dan implementasi sengaja tidak mengarang angka retensi serta belum menambahkan auto-purge (`docs/domain/attendance-engine-mobile.md`). Membuka ke 97 orang berarti foto kehadiran mulai menumpuk tanpa aturan hapus. Butir ini tetap terbuka meskipun pengujiannya sudah ada. |
| **Uji berikutnya** | Yang belum teruji bukan lagi "apakah fiturnya jalan", melainkan: (1) **perubahan yang di-merge sesudah pengujian itu** — terutama #396 yang mengubah seluruh alur bertahap menjadi wizard satu langkah per layar, dan belum dirilis (§4); (2) **perbedaan antarunit dan antarperan** — pengujian dilakukan dari satu sisi, sementara 9 unit dan beberapa peran punya jadwal, lokasi, dan izin yang berbeda; (3) **jalur mesin absensi**, yang pada 2026-11-20 justru paling sunyi: perangkat terakhir menghubungi HCIS 17 November 14:36, 4 log kehadiran berbanding 28.087 handshake dalam sepekan sebelumnya, hanya SDIT Tahfizh yang pernah menghasilkan scan, Taman Tahfizh berjadwal tanpa scan, Pesantren Tahfizh tanpa keduanya (W5). |
| **Kriteria selesai** | Retensi foto tertulis, dan clock in/out terbukti bekerja di luar cakupan yang sudah diuji: minimal satu pasang punch nyata dari unit yang berbeda, pada rilis yang sudah memuat #396. |

### W8 — Slip gaji pegawai (PAY-001/PAY-002)

| | |
|---|---|
| **Status** | **Sudah diuji** sebatas alur utama yang dikonfirmasi owner; belum diuji lintas unit dan lintas peran. |
| **Bukti bertanggal** | Konfirmasi owner **2026-11-20**: Human Capital Management telah menguji alur utama HCIS memakai akun aktif. Cakupan rincinya — alur mana saja, peran mana, unit mana, pada tanggal berapa — tidak tercatat, jadi pengujian ini tidak menutup alur yang belum disebut. Data: pengukuran owner 2026-11-20, 5.202 `payslips`, seluruhnya impor historis. OPS-READY-001 2026-10-16 mencatat angka yang sama (5.202) dan menyimpulkan HCIS hidup terutama untuk "payslip reading and attendance ingest". |
| **Penghambat** | W3: dengan 4 akun aktif dan 74 akun masih `invited`, pembacaan slip belum pernah terjadi dalam skala apa pun. Selain itu, PAY-001/PAY-002 tetap jalur slip resmi sampai owner menutup parallel run PAY-003 (AGENTS.md §5) — jadi yang dibuka ke pegawai adalah slip impor, bukan hasil hitung. |
| **Uji berikutnya** | (1) Perubahan yang di-merge sesudah pengujian HCM dan belum dirilis (§4). (2) Perbedaan antarunit dan antarperan: pegawai biasa, pegawai yang slipnya tidak lengkap, dan peran HC melihat hal yang berbeda. (3) Setelah gelombang akun pertama: minta beberapa pegawai membuka slipnya dan memastikan isinya cocok dengan slip kertas bulan yang sama. |
| **Kriteria selesai** | Minimal satu pegawai per unit mengonfirmasi slipnya benar, dengan tanggal konfirmasinya dicatat. |

### W9 — Notifikasi in-app dan WhatsApp

| | |
|---|---|
| **Status** | **Aktif belum diuji** untuk pengiriman nyata di luar daftar izin. |
| **Bukti bertanggal** | `docs/development/production-release-verification-2026-11-11-c78e8b6b.md`: `final.env` berisi `WHATSAPP_ADAPTER=kirim` dan `WHATSAPP_RECIPIENT_MODE=allowlist`, sehingga WhatsApp nyata hanya sampai ke NIP yang ada di daftar izin. `final.env` tidak berubah sejak 2026-11-13 15:35 WIB (`production-release-verification-2026-11-17-ee273bc5.md`). Runner pengingat berjalan di dalam proses API (`MEETING_RUNNER_ENABLED` tidak ada → menyala) dan `api.log` tidak menunjukkan kegagalan tick sejak 2026-11-02 (`production-release-verification-2026-11-02-78eadd09.md`). |
| **Penghambat** | Daftar izin adalah pengaman yang benar selama HCIS pra-pembukaan (NOTIF-001 ditutup dengan catatan itu, `docs/domain/reminders.md` §8), tetapi ia juga **menghalangi undangan akun sampai ke pegawai** (W3 penghambat 2), jadi kedua butir harus dibuka bersama. Melepasnya ke 97 orang adalah keputusan tersendiri: sepuluh aturan pengingat NOTIF-003 masih berstatus `DRAFT`, dan jendela pengingat 04.00–23.00 (D18) ada di PR #386 yang **belum dirilis**. Email memang tidak dibangun (D-10 `DRAFT`). |
| **Langkah berikutnya** | (1) ~~Rilis #386~~ — sudah dirilis 2026-11-24, jendela pengingat 04.00–23.00 kini berlaku. (2) Owner menyetujui sepuluh aturan pengingat atau mematikan yang belum disetujui. (3) Lepas daftar izin satu unit lebih dulu, bukan seluruh yayasan. |
| **Kriteria selesai** | Satu unit menerima notifikasi nyata selama satu minggu penuh tanpa keluhan pesan salah sasaran atau salah jam, lalu daftar izin dilepas bertahap. |

### W10 — Isi Pengumuman dan Pusat Bantuan

| | |
|---|---|
| **Status** | **Dirilis belum aktif.** Fiturnya ada; isinya dikirim sebagai draf untuk ditinjau HC sebelum terbit. |
| **Bukti bertanggal** | `docs/product/hcis-capability-map.md` §9: "The initial content ships as drafts for HC to review before publishing". Apakah HC sudah menerbitkannya belum diukur. |
| **Penghambat** | 97 orang yang masuk pertama kali akan mencari penjelasan; pusat bantuan kosong atau berisi draf membuat beban jatuh ke HC lewat WhatsApp pribadi. |
| **Langkah berikutnya** | HC meninjau dan menerbitkan isi HELP-001 untuk layanan yang benar-benar dibuka (cuti, kehadiran, slip gaji), dan menulis satu pengumuman pembukaan. |
| **Kriteria selesai** | Topik bantuan untuk setiap layanan yang dibuka berstatus terbit, dan pengumuman pembukaan tayang. |

### W11 — Perilaku modul yang belum siap saat pintu dibuka

| | |
|---|---|
| **Status** | **Belum selesai.** Belum ada keputusan tertulis tentang apa yang dilihat 97 pegawai untuk modul yang dirilis tetapi belum siap dipakai. |
| **Bukti bertanggal** | Kasbon, reimbursement, perjalanan dinas, kinerja, pelatihan, kartu pegawai, kepanitiaan, dan kalender semuanya **ada di production** (§7). Semuanya memakai rantai persetujuan W1 atau data master yang masih kosong. `docs/product/hcis-capability-map.md` "Coming-soon rule" mensyaratkan status ditampilkan dengan jujur dan tidak ada data operasional palsu — tetapi aturan itu ditulis untuk layar yang belum dibangun, bukan untuk layar yang sudah dibangun dan akan gagal tertutup. |
| **Penghambat** | Tanpa keputusan ini, pembukaan menghasilkan menu penuh yang sebagian besar menjawab 422/409. Itu merusak kepercayaan pada sistem lebih lama daripada menu yang lebih pendek. |
| **Langkah berikutnya** | Owner memutuskan satu dari dua: (a) buka hanya menu yang W1–W10 sudah tutup (kehadiran, cuti, slip gaji, notifikasi, bantuan) dan sembunyikan sisanya sampai siap; atau (b) buka semuanya dengan label "belum dibuka" yang jujur di tiap modul. Rekomendasi: (a), karena lebih sedikit yang harus dijelaskan ke 97 orang. |
| **Kriteria selesai** | Keputusan tertulis di catatan go-live (OPS-GOLIVE-001), dan layar yang dibuka cocok dengan keputusan itu. |

### W12 — Cadangan dan pemulihan

| | |
|---|---|
| **Status** | **Aktif belum diuji** untuk latihan penuh. Yang sudah terbukti pada 2026-11-20 adalah **berkasnya**, bukan **sistemnya**: dump semalam utuh dan pulih dengan isi lengkap, tetapi tidak ada bukti HCIS dapat berjalan di atas database hasil pulihan itu. |
| **Bukti bertanggal — rantai backup, 2026-11-20** | Pemeriksaan owner 2026-11-20, baca saja terhadap production ditambah satu database sekali pakai. **Salinan luar host berjalan**: set mendarat setiap hari di remote terenkripsi, terbaru `set-20261119T190001Z` pada 02:00 WIB. (Catatan koreksi: klaim lama bahwa penyalinan luar host berhenti pada 18 Oktober **salah** — itu berasal dari berkas penanda yang basi, dan tidak lagi berlaku.) SHA-256 dump cocok. Restore ke database sekali pakai selesai **36 detik tanpa error**. Seluruh hitungan cocok persis dengan production: 328 `employees`, 81 `accounts`, 5.202 `payslips`, 2.855 `attendance_events`, 2.127 `attendance_daily_records`, 326 `employments`, 145 migrasi, 231 tabel. Database sekali pakai itu sudah di-drop. **Pemeriksaan ini dijalankan tanpa persetujuan owner per-pelaksanaan yang disyaratkan OPS-MI8-DRILL-001** — dicatat di sini karena itu fakta tentang buktinya, bukan catatan kaki. |
| **Apa yang dibuktikan dan apa yang tidak** | **Dibuktikan:** berkas cadangan terbaru utuh, dapat dipulihkan, dan isinya lengkap — tidak ada kehilangan baris diam-diam. **Tidak dibuktikan:** bahwa HCIS **berjalan** di atas database hasil pulihan. Itu justru inti OPS-MI8-DRILL-001 (`docs/operations/hcis-isolated-restore-drill.md` §1: OPS-MI8-BAK-001 membuktikan dump *restores*, bukan bahwa HCIS bisa *run*). Jadi pemeriksaan 2026-11-20 mempersempit risiko, tidak menutupnya. |
| **Bukti latihan penuh terakhir** | OPS-READY-001 gate P5 **DONE** dengan latihan restore terisolasi PASS 2026-10-16 (`docs/operations/hcis-restore-drill-2026-10-16.md`), 6/6 smoke check, 48 detik. Latihan itu berjalan pada rilis `hcis-3b670849-20261016` dengan **55** migrasi (tertinggi `0055_adms_operational_management`). Production hari ini membawa **155** (tertinggi `0183`). Backup pra-rilis tetap diambil tiap rilis; yang terakhir `/srv/hcis/backups/pre-release/hcis-734be5ca-20261124-20261124T031907Z.dump` (2026-11-24, 40.774.423 byte). |
| **Penghambat** | Sembilan puluh migrasi memisahkan skema yang pernah diuji **dijalankan** dari skema yang ada sekarang, dan OPS-READY-001 sendiri menulis kriteria "Repeat after major schema changes". Latihan penuh OPS-MI8-DRILL-001 **menuntut persetujuan owner untuk setiap pelaksanaan** dan belum dijalankan lagi sejak 2026-10-16. Gate R5 masih **PARTIAL**: pemulihan dari **kehilangan ponsel** (salinan Drive ke host lain, bundel rahasia) belum pernah diuji. |
| **Langkah berikutnya** | (1) Owner menyetujui satu pelaksanaan OPS-MI8-DRILL-001, lalu latihan penuh dijalankan pada skema `0167` — sampai HCIS benar-benar dinyalakan di atas database pulihan, bukan berhenti di `pg_restore`. (2) Jalankan satu latihan pemulihan di luar host sebelum 97 orang mulai menulis data nyata. |
| **Kriteria selesai** | Latihan penuh pada skema terkini PASS dan tercatat sebagai `docs/operations/hcis-restore-drill-<tanggal>.md`, dan latihan di luar host PASS sekali. |

### W13 — Keamanan dan matriks izin

| | |
|---|---|
| **Status** | **Belum terverifikasi** untuk sisa temuan. |
| **Bukti bertanggal** | OPS-READY-001 gate R2 **PARTIAL** per 2026-10-16: 0 Critical; SEC-16 dan SEC-02 diperbaiki, SEC-01 risikonya diterima owner; SEC-05, SEC-06, dan bagian API SEC-07 diperbaiki dan hidup di `hcis-081ba89e-20261022` (2026-10-23); **bagian SPA/edge SEC-07 masih terbuka** pada tanggal itu. Apakah sudah ditutup sesudahnya tidak terbaca dari repository. |
| **Penghambat** | Matriks izin AUTH-011 pernah melewatkan 51 rute dan test matriksnya pernah dilewati di CI (SEC-02/03, diperbaiki #107 pada 2026-10-16). Membuka ke 97 orang memperbesar akibat setiap lubang izin yang tersisa. |
| **Langkah berikutnya** | (1) Periksa status SEC-07 bagian SPA/edge. (2) Jalankan ulang review keamanan terhadap rute yang ditambahkan sejak 2026-10-16 — PAY-003, EMP-011, ORG-013/014/015, LOAN, REIMB, TRIP-002, PERF — karena semuanya menyentuh izin, audit, atau data gaji. |
| **Kriteria selesai** | Tidak ada temuan High terbuka, setiap Medium diperbaiki atau diterima tertulis di catatan go-live, dan test matriks izin hijau di CI. |

### W14 — Kepemilikan operasional, insiden, stop, dan rollback

| | |
|---|---|
| **Status** | **Belum selesai.** |
| **Bukti bertanggal** | OPS-READY-001 gate P6 **MISSING** per 2026-10-16: peran hanya disebut sebagai placeholder, tidak ada kanal peringatan (OPS-MI8-BAK-001 §8), RPO/RTO masih `TBD`. Gate R3 **PARTIAL**: operator dan owner ada secara de facto lewat persetujuan rilis di chat, bukan sebagai peran bernama dengan cadangan. |
| **Penghambat** | Selama HCIS tidak punya pengguna, tidak ada yang terdampak bila ia mati. Begitu 97 orang memakainya untuk absen dan cuti, "siapa yang dihubungi saat sistem mati" menjadi pertanyaan nyata, dan jawabannya belum tertulis. |
| **Langkah berikutnya** | Owner mengisi `docs/operations/go-live-decision-record-template.md` §2 dan §4: nama pemilik insiden dan cadangannya, kanal peringatan, RPO/RTO, serta siapa yang berwenang menghentikan dan me-rollback. |
| **Kriteria selesai** | Catatan go-live terisi dan ditandatangani; satu uji kanal peringatan berhasil. |

### W15 — Merilis `main` ke production

| | |
|---|---|
| **Status** | **Dirilis 2026-11-24.** `hcis-734be5ca-20261124` cutover 10:20 WIB; dua puluh tiga PR yang menunggu sejak `127b6068` ikut masuk, bersama **sepuluh migrasi** terakhir, sehingga daftar migrasi yang tertahan kosong (§4). |
| **Bukti bertanggal** | §4. Rilis 2026-11-24: preflight OK, backup `pg_dump -Fc` 40.774.423 byte sebelum migrasi, sepuluh migrasi diterapkan, gerbang kandidat PASS 7/7, cutover, verify OK (api/web release, /health, /ready, no-store, symlink, worker, tiga pemeriksaan publik), lock dilepas. Diukur baca-saja sesudahnya: migrasi tertinggi `0183`, 155 terpasang; `trip_per_diem_activation` 0 baris (uang saku terkunci); `trip_advances` 0; `trip_per_diem_rates` 6 (disemai `0172` dari SK). |
| **Penghambat** | Dua di antaranya menyentuh perilaku yang relevan untuk pembukaan: #386 (jendela pengingat 04.00–23.00, masa kritis cuti tanpa tinjauan HC) dan #389 (tarif uang saku). Empat migrasi dari rantai LOAN-002/PERF-001 membawa tabel baru yang belum pernah ada di production. #383 menambah jalur baca data gaji per orang — rilisnya aman karena `GOVERNANCE_PAYROLL_READ_ENABLED` mati, tetapi **penyalaannya** adalah keputusan owner tersendiri dan bukan bagian dari rilis ini. Penghambat yang sempat menunggu di depan — gerbang rilis TRIP-002 yang akan menghentikan rilis selama katalog klasifikasi masih nol — **sudah hilang** sejak keputusan owner 2026-11-24 (TRIP-002 D-22, §4): pemeriksaan itu kini syarat **menyalakan** fitur uang saku, bukan syarat merilis, dan production menerimanya dalam keadaan uang saku terkunci. |
| **Langkah berikutnya** | Rilis `main` lewat OPS-MI8-REL-001 dengan pengaman teknis yang biasa: dry-run bersih, backup sebelum migrasi, gate kandidat, rollback bila verifikasi gagal, tidak pada jam 19 UTC, laporan sesudahnya. Kesembilan migrasi diterapkan dalam satu rilis. |
| **Kriteria selesai** | Catatan `production-release-verification-<tanggal>-<sha>.md` baru dengan `verify OK` dan migrasi tertinggi `0182` (angka ini mengikuti daftar migrasi di §4, bukan cacah PR). |

### W16 — Kelompok hak cuti pegawai

| | |
|---|---|
| **Status** | **Belum selesai.** Kolom, layar, dan jalur auditnya ada dan berjalan; yang kosong adalah datanya. |
| **Bukti bertanggal** | Pengukuran baca-saja 2026-11-25 atas `employees` berstatus `active`: **kosong 91**, `education` 4, `non_education` 2. Keenam yang terisi adalah sisa pengujian, bukan hasil klasifikasi yang sistematis. Di unit pilot Taman Tahfizh, **kesembilan** pegawainya kosong, demikian pula penyetuju unitnya. |
| **Mengapa ini penghambat, bukan kerapian data** | `assertAnnualLeaveEntitlementGroup` (`apps/api/src/modules/leave/domain/annual-leave-policy.ts`) menolak setiap pengajuan Cuti Tahunan dari pegawai yang kelompoknya bukan `non_education`, dengan `409 UNSUPPORTED_ENTITLEMENT_GROUP`. Penolakan itu terjadi di dalam `validateAnnualLeaveRequest`, **sebelum** `resolveLeaveAuthorities` dipanggil — jadi ia mendahului W1, W2, dan W3, dan menyembunyikan apakah ketiganya sudah benar. |
| **Yang masih belum diketahui** | Siapa yang `education` dan siapa yang `non_education` untuk 91 orang itu. Spesifikasi melarang HCIS menebaknya: *"it must not infer the classification solely from unit or job-title strings"* (`docs/domain/leave-policy-ysq.md`). Jadi tidak ada migrasi, skrip, atau default yang sah untuk menutup butir ini. |
| **Penghambat** | Keputusan HC per pegawai. Jalurnya sudah ada di layar: **Admin → Konfigurasi Cuti**, izin `leave.configuration.manage`, `PATCH /admin/leave/employees/:employeeId/entitlement-group`, teraudit sebagai `leave.entitlement_group.changed`. Pegawai berstatus `OUTSIDE_HCIS` ditolak 409 di jalur yang sama. |
| **Langkah berikutnya** | (1) Untuk pilot: klasifikasikan peserta pilot lebih dulu — usul dan dasarnya di OPS-PILOT-TT-001 §5.1. (2) Untuk pembukaan penuh: klasifikasikan 91 pegawai aktif, dan putuskan secara eksplisit bagaimana kepala unit pendidikan dihitung, karena tidak ada aturan tertulis yang menentukannya. |
| **Kriteria selesai** | Setiap pegawai aktif dalam cakupan pembukaan punya kelompok hak cuti yang terisi, **dan** satu pengajuan Cuti Tahunan nyata dari pegawai `non_education` lolos validasi kelompok. Indikator di layar Konfigurasi Cuti (`entitlementGroupConfigured`) mencacah kolomnya, jadi ia menutup bagian pertama saja. |

## 6. Saklar fitur: apa yang mati dan apa yang menunggu di baliknya

`final.env` tidak berubah sejak **2026-11-13 15:35 WIB** (2462 byte, `production-release-verification-2026-11-17-ee273bc5.md`).

| Saklar / kebijakan | Keadaan di production | Yang menunggu di baliknya |
|---|---|---|
| `MOBILE_ATTENDANCE_ENABLED` | `1` sejak 2026-11-04 | — (menyala; lihat W7) |
| `WHATSAPP_ADAPTER` / `WHATSAPP_RECIPIENT_MODE` | `kirim` / `allowlist` sejak 2026-11-11 | Pengiriman nyata ke seluruh pegawai (W9) |
| `GOVERNANCE_SUMMARY_ALLOWED_CLIENTS` | `sq-hub,sq-organ` sejak 2026-11-13 | — (Portal Organ R1 menyala) |
| `BIOMETRIC_COLLECTION_ENABLED` | **Tidak ada → mati.** Ini kebijakan, bukan celah | Pengumpulan template biometrik ATT-005, yang menunggu gate keamanan, retensi, dan manajemen kunci tersendiri |
| `GOVERNANCE_DECISIONS_ENABLED` | Tidak ada → mati (default `false`) | ORG-015: anggota organ memutuskan langkah persetujuan dari Portal Organ (R2) |
| `GOVERNANCE_PAYROLL_READ_ENABLED` | Tidak ada → mati (default `false`); kodenya dirilis 2026-11-24 (#383, migrasi `0180`) dan tetap mati | ADR-0008 B5: Pengurus Yayasan membaca gaji per orang. Menyalakannya menuntut `GOVERNANCE_SUMMARY_ENABLED=true` lebih dulu (`apps/api/src/config/env.ts`). Ini jalur baca data gaji per orang, jadi penyalaannya adalah keputusan owner, bukan langkah operasional |
| `LOAN_PAYROLL_DEDUCTION_ENABLED` | Tidak ada → `0` (dipastikan 2026-11-17) | LOAN-001 Paket 2: potongan angsuran otomatis lewat payroll; menunggu PAY-003 menjadi jalur slip resmi |
| `REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED` | Tidak ada → `0` (dipastikan 2026-11-13 dan 2026-11-17) | REIMB-001 §9: penyerahan reimbursement ke payroll; menunggu hal yang sama |
| `TRAINING_ONLINE_ENABLED` | Tidak ada → `0` (dipastikan 2026-11-17) | TRAIN-001 R4: modul daring dengan video; menunggu kapasitas media disediakan |
| `QURAN_SCOREBOARD_URL` + `QURAN_MACHINE_*` | Tidak ada satu pun kunci `QURAN_*` (dipastikan 2026-11-17) | REWARD-001: kandidat penghargaan dari papan nilai tilawah Al-Qur'an; sementara HC boleh impor CSV bulanan (`DRAFT`) |
| `ASET_SQ_PERSON_CUSTODY_URL` + `ASET_SQ_MACHINE_*` | Tiga kunci ada, tidak berubah (dipastikan 2026-11-17) | ASSET-001 dinyatakan "switched off in production" di peta kapabilitas sampai klien Keycloak `hcis-aset-custody`, flag dan jalur privat di Aset SQ siap. **Belum terverifikasi** apakah yang kurang tinggal di sisi Aset SQ |
| `ORGAN_PORTAL_URL` | Belum terverifikasi | Tautan dari HCIS ke Portal Organ |
| `ORG_DIRECTORY_EXPORT_ENABLED` | Belum terverifikasi (peta kapabilitas menyatakan ekspor menyala dan ditarik platform; tidak ada catatan rilis yang menyebut kuncinya) | ORG-006 Direktori Organisasi |
| `HCIS_ROLE_ADMIN_ENABLED` | Bukan `1` per 2026-11-01 → rute menjawab `503` | AUTH-014 fase F5: administrasi peran lewat kanal SQ Hub |
| `STAFF_IDENTITY_VERIFY_ENABLED` | Belum terverifikasi | Verifikasi identitas staf saat aktivasi |

### Kebijakan payroll yang belum punya versi

`payroll_policy_versions` punya satu versi untuk seluruh sebelas kunci wajib (`POLICY_KEYS` di `apps/api/src/modules/payroll/policy.ts`) ditambah `VARIANCE_THRESHOLD`, dan dua untuk `THR`. Yang **tidak ada**:

| Kunci | Akibat kekosongannya |
|---|---|
| `PPH21_SETTINGS` | Mesin memakai `DEFAULT_PPH21_SETTINGS`, yaitu "semuanya mati": PPh21 tidak ditanggung yayasan, premi BPJS Kesehatan yang dibayar yayasan tidak dihitung sebagai penghasilan kena pajak, dan TER harian untuk non-tetap mati. **Keputusan owner 2026-11-17 sudah dibangun tetapi belum berlaku di production.** |
| `PPH21_TER` | Tanpa tabel TER yang berlaku pada tanggal gajian, perhitungan menolak bila PPh21 ditanggung yayasan diaktifkan. |
| `PPH21_ANNUAL` | PPh21 tahunan Pasal 17, bukti potong 1721-A1, dan rekap e-Bupot tidak punya dasar. |
| `PAYSLIP_LAYOUT` | Slip memakai tata letak lama; blok "Ditanggung yayasan" yang diputuskan owner 2026-11-17 tidak muncul. |
| `PERFORMANCE_PERCENT` | Opsional menurut kode, tetapi tanpa versinya hasil PERF-001 tidak pernah menjadi tunjangan kinerja. |

Kesimpulannya untuk PAY-003: mesinnya ada di production, tetapi **tidak satu pun keputusan pajak owner 2026-11-17 berlaku di sana**. Itu status **Dirilis belum aktif**, bukan "payroll selesai".

## 7. Pengembangan lanjutan — di luar cakupan pembukaan

Butir di bawah ini **tidak** perlu ditutup sebelum pintu dibuka, selama W11 diputuskan. Daftarnya ada supaya tidak ada yang mengira butir ini sudah beres.

| # | Butir | Status | Bukti bertanggal | Penghambat | Langkah berikutnya | Kriteria selesai |
|---|---|---|---|---|---|---|
| L1 | PAY-003 mesin payroll, PPh21, THR | Dirilis belum aktif | 2026-11-20, diukur ulang 2026-11-23: 0 `payroll_periods`, 0 `payroll_results`; empat kebijakan PPh21/layout tidak ada (§6) | PAY-001/PAY-002 tetap jalur resmi sampai owner menutup parallel run (AGENTS.md §5); `docs/development/pay003-parallel-run-2026-10.md` | Isi `PPH21_SETTINGS`, `PPH21_TER`, `PPH21_ANNUAL`, `PAYSLIP_LAYOUT`; jalankan satu periode bayangan | Satu periode payroll selesai dan cocok dengan slip jalur lama, lalu owner menutup parallel run |
| L2 | EMP-005/006/010 riwayat kepegawaian | Dirilis belum aktif | 2026-11-20: `employment_rollout_settings` 0 baris → mode `OFF`; 326 `employments`, 96 `employment_placements`. Baseline dimuat 2026-11-03, koreksi 2026-11-04 | Runbook `employment-pilot-activation-runbook.md` langkah 1–7 belum satu pun dijalankan; 115 `BASELINE_END_UNKNOWN` dan 47 `BASELINE_CONTRACT_END_UNKNOWN` saat pemuatan | Jalankan langkah 1–7 runbook, mulai dari backup dan `SHADOW` | Mode `AUTHORITATIVE` dengan tujuh kriteria keluar runbook §7 terpenuhi |
| L3 | ORG-004 `STRUCTURE` dan ORG-013 kursi organ | Dirilis belum aktif — **tetapi lihat W1** | 2026-11-20: `organization_rollout_settings` 0 baris → semua `LEGACY`, jadi bagan **tidak dibaca sama sekali** di jalur yang berjalan. Bagan itu sendiri terisi: 16 change set terbit (terakhir 2026-11-10), 1.111 `organization_nodes`, 474 `organization_positions`, 374 `organization_incumbencies`, 1.439 `organization_memberships`, 555 `organization_authority_bindings` (215 `SUPERVISORY_PARENT`, 104 `UNIT_APPROVER`), `organization_reporting_overrides` kosong. OPS-READY-001 2026-10-16 mencatat 15 change set PUBLISHED **Temuan #405/#406, 2026-11-23 — mengubah prasyarat pilot:** sebelum #406 kursi yang pejabatnya ada tetapi akunnya belum aktif diperlakukan sebagai kursi kosong, sehingga `CLIMB_TO_PARENT` membuat rantai memanjat melewatinya tanpa galat dan tanpa catatan; pada unit kandidat pilot itu berarti langkah kepala unit hilang dan dua langkah menyusut jadi satu orang, dengan cuti tetap disetujui. Bentuk bagannya membuat ini berlaku di mana-mana: **63 dari 63 ikatan wewenang dan 29 dari 29 jabatan memakai `CLIMB_TO_PARENT`** (§3). #406 menarik garisnya ulang (D-R5 `DRAFT`, `docs/domain/dynamic-organization-structure.md`): kursi berpejabat yang belum layak **menolak** dan menyebut kursi, orang, serta jalan keluarnya; kursi yang benar-benar kosong tetap mengikuti `vacancy_policy`; pelaksana tugas (`ACTING`) berakun aktif tetap menyelamatkan kursinya. Keduanya **dirilis `734be5ca` 2026-11-24**, dan `LEGACY` tidak tersentuh sehingga production hari ini tidak berubah sampai ada unit yang dipindahkan | Gate P1–P3 dan P10 OPS-READY-001 masih MISSING: unit pilot belum dipilih, SHADOW belum dijalankan, go/no-go belum ditandatangani. **Batas cakupan yang tersisa, dan ini bukan prinsip:** perbaikan D-R5 **tidak mencakup kursi yang dipegang akun Organ Yayasan** (ORG-013-1) — pelewatan diam-diam yang sama masih hidup di jalur itu, dan production memang memilikinya: 2 kursi dipegang akun, 2 pendudukan akun, 1 binding `GOVERNANCE_APPROVER` (§3). Membukanya kembali adalah perubahan tersendiri yang **belum diputuskan**; sampai itu terjadi, kursi organ diperiksa dengan membaca status akunnya (V22). **Dua akibat yang akan terlihat begitu `STRUCTURE` menyala,** keduanya memang yang diminta D-R5: (1) sebagian besar pemberitahuan pengawasan berhenti selama akun masih `invited` — **tidak ada keputusan yang gagal karenanya**, jalurnya terisolasi dan kegagalannya tercatat sebagai `leave.oversight.unresolved`; (2) layar pratinjau HC berubah dari "sebagian besar teresolusi" menjadi "sebagian besar bermasalah" sambil menampilkan kode mentah `AUTHORITY_INELIGIBLE`, sehingga **layar itu masih menyimpan ambiguitas yang sudah ditutup di jalur cuti** — menyelaraskannya pekerjaan tersendiri yang belum dikerjakan | Pilih unit pilot, jalankan `SHADOW`, bandingkan dengan `LEGACY`, lalu aktifkan `STRUCTURE` per workflow. Cakupan bagannya sendiri sudah terukur 96 dari 96 lewat penelusuran data 2026-11-23 (V17 terjawab, §1); yang `SHADOW` tambahkan adalah bukti bahwa **resolver yang berjalan** memberi jawaban yang sama | Nol ketidakcocokan tak terjelaskan di `SHADOW` dan catatan go/no-go ditandatangani. Baris ini **naik dari lanjutan menjadi jalur pra-pembukaan** bila owner memilih `STRUCTURE` sebagai cara menutup W1 |
| L4 | Portal Organ R1 (ORG-010/ORG-014) | Sudah diuji, sekali | `production-release-verification-2026-11-13-e54353aa.md`: Portal Organ dinyalakan di SQ Hub 2026-11-13 01:33 UTC; pertukaran `azp = sq-organ` terbukti pada sign-in pertama owner sebagai anggota organ (satu baris audit `governance.summary.served`). 2 akun `FOUNDATION_BOARD` aktif per 2026-11-20 | Baru satu sesi nyata; ringkasan yang dibaca organ akan menampilkan "95 pegawai tanpa atasan langsung" sampai W1 ditutup | Minta anggota organ membuka ringkasan setelah W1 selesai | Kedua akun organ pernah membuka ringkasan dan daftar pegawai setelah data atasan terisi |
| L5 | Portal Organ R2 / keputusan organ (ORG-015) | Dirilis belum aktif | `production-release-verification-2026-11-18-127b6068.md`: rute `GET`/`POST /governance/decisions` menjawab `404` selama `GOVERNANCE_DECISIONS_ENABLED` mati; migrasi 0166 hanya menambah satu kolom kosong | Urutan ORGAN-IMPL-001-r2-keycloak §5 baru sampai langkah 4. Langkah 6 (probe `acr` harus bernilai `"2"` setelah pertukaran token) **butuh sesi nyata, jadi langkah owner** dan merupakan gerbang ADR-0012 D4 | Daftarkan `decision_path`/`decision_audience` di Admin Center (langkah 5), jalankan probe (langkah 6), lalu nyalakan kedua flag mulai dari HCIS | `acr` selamat melewati pertukaran token dan satu keputusan organ nyata tercatat |
| L6 | LOAN-001 kasbon dan LOAN-002 rantai kursi | Dirilis belum aktif | 2026-11-20, diukur ulang 2026-11-23: 0 `employee_loans`. LOAN-002 lengkap di `main` — rantai kursi #384 (migrasi 0177/0178) dan jalur tulis pemetaan kursi #391 (migrasi 0181, di-merge 2026-11-20 02:13 UTC) — tetapi tidak satu pun sudah dirilis | Rantai `LEGACY` kasbon berdiri di atas W1. Registri kursi di production kosong karena HC belum mengisinya — tabelnya sendiri sudah ada sejak rilis 2026-11-24 | ~~Rilis #384 dan #391~~ sudah dirilis 2026-11-24; yang tersisa: HC memetakan kursi persetujuan | Satu pengajuan kasbon nyata melewati rantai kursi sampai pencairan |
| L7 | REIMB-001 reimbursement | Dirilis belum aktif | 2026-11-20: 0 `reimbursement_claims` | W1; penyerahan ke payroll mati di balik `REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED=0` | Setelah W1: satu klaim nyata sampai verifikasi Keuangan dan pembayaran di luar payroll | Satu klaim selesai dibayar dengan bukti bertanggal |
| L8 | REIMB-002 reimbursement pengadaan | **Belum selesai** | `docs/domain/procurement-reimbursement.md` berstatus `DRAFT`; AGENTS.md §5 melarang implementasinya sampai owner menjawab §13. Spesifikasinya masuk production lewat #385 sebagai dokumen saja | Menunggu jawaban owner atas §13 | Owner menjawab §13 | Spesifikasi naik ke ACCEPTED, implementasi dimulai |
| L9 | PAY-004 penjagaan honorarium dari kehadiran | **Belum selesai** | `docs/domain/honorarium-attendance-guard.md` berstatus `DRAFT`; AGENTS.md §5 melarang implementasinya sampai owner menjawab §15 | Menunggu jawaban owner atas §15 | Owner menjawab §15 | Spesifikasi naik ke ACCEPTED |
| L10 | TRIP-001/TRIP-002 perjalanan dinas dan uang saku | Dirilis, uang saku **terkunci** | **Dirilis 2026-11-24:** tarif per SK 01.111/YSQ/VII/2026 (migrasi `0172`, enam baris tarif disemai, dipastikan baca-saja sesudah rilis), mundur 7 hari D18 (#386), dan saklar uang saku TRIP-002 D-22 (migrasi `0183`). Saklarnya mendarat **mati** (`trip_per_diem_activation` 0 baris), jadi perkiraan uang harian dan pengajuan uang muka menjawab 409 `TRIP_PER_DIEM_NOT_ACTIVE` sampai HC menyalakannya — dan penyalaan itu ditolak selama katalog klasifikasi, pemetaan golongan, atau tarifnya belum lengkap. **Diukur 2026-11-23:** katalog klasifikasi jabatan nol di setiap kolom (L16, §3) | W1; tarif uang saku belum ada di production; **dan sekarang juga datanya sendiri** — golongan pegawai ditentukan dari pemetaan kode klasifikasi ORG-011 ke golongan (`trip_per_diem_golongan_map`, D-20), sehingga dengan **0** kode terikat pada placement maupun kursi, **tidak ada satu pun pegawai yang golongannya dapat diresolusi**. Uang muka perjalanan karena itu tidak dapat berjalan untuk siapa pun: setiap perkiraan dan setiap pengajuan dijawab `409 TRIP_PER_DIEM_GOLONGAN_UNMAPPED`. Ini bukan fitur yang belum selesai, melainkan data yang menopangnya yang belum ada | Rilisnya sudah selesai (W15). Yang tersisa milik HC: mengisi katalog klasifikasi beserta pemetaan golongannya (L16), lalu menyalakan saklar uang saku — penyalaan itu sendiri yang memeriksa kelengkapannya. Mengisi katalog adalah **keputusan HCM dan owner yang belum diambil** | Satu perjalanan dinas nyata dengan uang muka dan penyelesaiannya |
| L11 | PERF-001 kinerja | Dirilis belum aktif | Rubrik berversi dan siklus semesteran (#387, migrasi 0175) dan jalur keberatan (#390, migrasi 0176) **dirilis 2026-11-24**; belum pernah dipakai | W1; `PERFORMANCE_PERCENT` tidak punya versi, jadi hasil kinerja tidak menjadi tunjangan | ~~Rilis #387 dan #390~~ sudah dirilis 2026-11-24; yang tersisa: HC menyusun rubrik | Satu siklus penilaian selesai, termasuk satu keberatan yang diproses |
| L12 | TRAIN-001 modul daring (R4) | Dirilis belum aktif | `TRAINING_ONLINE_ENABLED` tidak ada → `0`, dipastikan 2026-11-17. Kode mewajibkan `TRAINING_MEDIA_DIR` bila dinyalakan | Kapasitas media di Mi8VPS belum disediakan | Sediakan direktori media dan kapasitas, lalu nyalakan | Satu modul daring ditonton sampai selesai oleh pegawai nyata |
| L13 | ASSET-001 aset pegawai | Dirilis belum aktif | Peta kapabilitas: dimatikan di production sampai klien Keycloak `hcis-aset-custody`, flag dan jalur privat Aset SQ, serta pengaturan `ASET_SQ_*` HCIS siap. Tiga kunci `ASET_SQ_*` ada di `final.env`, tidak berubah per 2026-11-17 | Sisi Aset SQ; **belum terverifikasi** apa tepatnya yang kurang | Periksa di repository Aset SQ apa yang masih kurang | Satu pegawai membuka Asset Saya dan melihat aset nyata |
| L14 | REWARD-001 penghargaan pegawai | Dirilis belum aktif | Tidak ada kunci `QURAN_*` di `final.env` maupun di environment proses API (dipastikan 2026-11-17, jumlah 0) | Al-Qur'an R1 belum menyediakan kontrak snapshot (`rewards.md` §12) | Sementara: HC impor CSV bulanan (`DRAFT`). Permanen: tunggu Al-Qur'an R1 | Satu penghargaan bulanan terbit dengan kandidat dari sumber nyata |
| L15 | ATT-005 pengumpulan biometrik | Dirilis belum aktif — **disengaja** | `BIOMETRIC_COLLECTION_ENABLED` tidak ada di `final.env` (dipastikan 2026-11-04 dan setiap preflight rilis). `mi8vps-hcis-release.md` §67 menjadikan "absen atau `0`" sebagai syarat preflight; OPS-READY-001 gate P7 **DONE** dengan kriteria "Keep checking at each release preflight"; `attendance-adms-capability-matrix.md` dan `attendance-device-admin-verification.md` menyatakan ia tetap OFF sampai gate keamanan, retensi, manajemen kunci, dan perangkat keras terkendali terpenuhi | — | Jangan ubah. Pastikan tetap absen di tiap preflight | Tidak ada; ini keadaan yang dikehendaki. `attendance_biometric_credentials` = 0 adalah **kebijakan yang dipatuhi, bukan celah** |
| L16 | ORG-011 katalog klasifikasi jabatan | Dirilis belum aktif — **nol, bukan sebagian** | **Diukur 2026-11-23, baca saja, pengukuran pertama atas katalog ini: `job_classifications` 0 baris (0 berlaku hari ini), `employment_placements` dengan `job_classification_code` 0 dari 96, `organization_positions` dengan `job_classification_code` 0 dari 474** (§3; kolomnya dipastikan benar terhadap `docs/domain/job-classification-grade.md` §3.1–§3.3, migrasi `0110`/`0112`, dan `job-classification-resolver.ts`). Roadmap §C, status 2026-11-17: "Katalog production dibiarkan kosong untuk diisi HC. Payroll belum membaca klasifikasi" | Kekosongan ini **tidak lagi berdiri sendiri**: TRIP-002 memetakan kode klasifikasi ke golongan (D-20), jadi nol kode berarti nol golongan untuk seluruh pegawai (L10), dan dan sejak keputusan owner 2026-11-24 kekosongan itu menahan **penyalaan** fitur uang saku, bukan rilisnya (TRIP-002 D-22, §4). Rilis 2026-11-24 membuktikannya: ia lewat dengan katalog tetap nol, dan uang saku mendarat terkunci. PAY-003 tetap belum punya titik sambung (spec §4.1) | **Keputusan HCM dan owner yang belum diambil:** apakah, kapan, dan dengan kode apa katalog diisi. Butir ini tidak menunggu kode — tidak ada pekerjaan repository yang tersisa untuk membuatnya terisi | Katalog terisi, pemetaan golongan TRIP-002 terisi, dan resolver dipakai payroll |
| L17 | DOC-003 nomor surat | Dirilis belum aktif — interim | Keputusan owner 2026-11-12: buku nomor surat yayasan pindah ke Sekretariat SQ (SEK-001), menggantikan D-01. Implementasi HCIS berjalan hanya sampai cutover | Menunggu Sekretariat SQ | Jangan kembangkan lebih jauh di HCIS | HCIS membaca buku Sekretariat SQ |
| L18 | ORG-006 Direktori Organisasi | Belum terverifikasi | Peta kapabilitas menyatakan ekspor production menyala dan ditarik platform; tidak ada catatan rilis yang menyebut `ORG_DIRECTORY_EXPORT_ENABLED` | — | Periksa kunci di `final.env` | Keadaan saklar tercatat bertanggal |
| L19 | MIG-002 migrasi dan pembekuan sistem lama | **Belum selesai** | OPS-READY-001 gate R1/R4/R6 **MISSING** per 2026-10-16: belum ada rehearsal, sistem lama bahkan belum teridentifikasi di repository; rencana `docs/migration/legacy-migration-and-freeze-plan.md` berstatus DRAFT/DISCOVERY | Owner belum menyebut sistem lama dan administratornya (D1) | Owner menjawab MIG-002 D1 | Rehearsal cutover berhasil dan rekonsiliasinya cocok |
| L20 | ORG-007 multi legal entity | Ditunda | Peta kapabilitas: DEFERRED atas arahan owner 2026-11-11; ADR-0005 tetap PROPOSED sebagai rujukan | — | Tidak ada | Tidak ada sampai entity kedua benar-benar dibutuhkan |

## 8. Butir yang belum terverifikasi dan cara memeriksanya

Butir berikut tidak dapat dipastikan dari repository pada 2026-11-20, diperbarui 2026-11-23. Tidak satu pun dari butir ini boleh dianggap beres sampai diperiksa. Semua pemeriksaan di bawah ini **baca saja**; inspeksi read-only via `ssh mi8vps` / `ssh mi8vps-root` selalu diperbolehkan (AGENTS.md §2).

| # | Yang belum diketahui | Cara memverifikasi |
|---|---|---|
| V1 | ~~Berapa unit tanpa penyetuju cuti aktif (W2)~~ | **Terjawab 2026-11-20.** Kesembilan unit berpegawai aktif punya penyetuju yang ditetapkan, tetapi 8 di antaranya berakun `invited` dan 1 tanpa akun sama sekali; hanya 1 unit penyetujunya berakun aktif. Lihat W2 — butir ini pindah dari "belum terverifikasi" menjadi penghambat pertama |
| V2 | Berapa akun `inactive`, dan berapa undangan yang masih dalam jendela 14 hari (W3) | Sebagian terjawab 2026-11-20: 4 `active`, **74 `invited`**, 81 akun seluruh status. Diperbarui 2026-11-23: angka akun tidak bergerak (74 `invited`; 1 `EMPLOYEE`, 2 `FOUNDATION_BOARD`, 1 `SUPER_ADMIN` aktif), dan **undangan aktivasi yang pernah tercatat berjumlah nol**. Kombinasi itu sudah dijelaskan dan jinak: `invited` adalah status awal akun yang menunggu aktivasi (`auth/account-activation.ts:19`), sementara `account_activation_invitations` hanya terisi saat undangan dikirim (`auth/activation-invitation.ts:185`). Akibatnya nyata tetapi sederhana: jendela 14 hari **tidak punya titik mulai yang tercatat** karena belum ada undangan yang berangkat. Yang tersisa: `SELECT status, principal_type, count(*) FROM accounts GROUP BY 1,2` untuk rincian penuh per jenis principal, di dalam `BEGIN READ ONLY … ROLLBACK` |
| V3 | ~~Berapa pegawai aktif tanpa email login (W3)~~ | **Terjawab 2026-11-23: 22 dari 96** pegawai aktif yang layak diproses (23 dari 97 bila `removed_at` tidak disaring). Sebarannya per unit ada di §3: SDIT Tahfizh 10, Pesantren Tahfizh 7, General Affair 4, Taman Tahfizh 1, lima unit lainnya nol. Sebanyak itulah undangan yang akan ditolak `409 EMPLOYEE_EMAIL_MISSING` bila dikirim hari ini (W3) |
| V4 | Apakah ada punch mobile ATT-006 nyata sejak 2026-11-04 (W7) | `SELECT source, count(*) FROM attendance_events GROUP BY 1` — kolom `source` bernilai `adms`, `mobile`, atau `manual` (`apps/api/migrations/0046_attendance_workforce_engine.sql`), read-only |
| V5 | Apakah ada pegawai yang benar-benar membuka slip gajinya (W8) | Cari audit event baca slip untuk principal `EMPLOYEE` pada rentang sejak 2026-10-01, read-only |
| V6 | Keadaan `GOVERNANCE_SUMMARY_ENABLED`, `ORG_DIRECTORY_EXPORT_ENABLED`, `STAFF_IDENTITY_VERIFY_ENABLED`, `ORGAN_PORTAL_URL` di production (§6, L18) | Periksa keberadaan kunci di `/srv/hcis/shared/final.env` **berdasarkan nama kunci saja, tanpa membaca nilainya**, sebagaimana dilakukan di catatan rilis 2026-11-13 dan 2026-11-17 |
| V7 | Apakah bagian SPA/edge SEC-07 sudah ditutup sejak 2026-10-16 (W13) | Baca `docs/operations/hcis-security-review-2026-10-16.md` dan telusuri PR yang menyebut SEC-07 setelah 2026-10-23 |
| V8 | Apakah latihan restore pernah diulang setelah skema `0167` (W12) | Cari berkas `docs/operations/hcis-restore-drill-*.md` bertanggal setelah 2026-10-16 |
| V9 | ~~Berapa pegawai aktif yang `management_scope <> 'MANAGED'` ("di luar pengelolaan HCIS")~~ | **Terjawab 2026-11-23: 0.** Tidak ada satu pun pegawai aktif yang ditandai di luar pengelolaan HCIS, jadi penyebut W1 tidak berkurang sama sekali. PR #400 yang terbuka (§4) mencatat pembacaan sejalan pada tanggal yang sama: `MANAGED` 328, `OUTSIDE_HCIS` 0 untuk seluruh status |
| V10 | Berapa role assignment HC yang ada sekarang | OPS-READY-001 mencatat hanya 2 pada 2026-10-16 (1 Human Capital, 1 Human Capital Administrator). hitung `account_role_assignments` yang masih berlaku, digabung ke `roles`, read-only. Dua orang tidak cukup untuk melayani 97 pegawai |
| V11 | Siapa saja yang ada di daftar izin WhatsApp (W9) | Periksa nilai daftar izin di `final.env` lewat operator; jangan salin nomor atau NIP ke dokumen mana pun |
| V12 | Apakah isi HELP-001 sudah terbit atau masih draf (W10) | Buka layar admin Pusat Bantuan dengan akun HC, atau hitung baris berstatus terbit, read-only |
| V13 | Berapa perangkat ADMS aktif dan berapa punch dalam 7 hari terakhir (W5) | Read-only `count(*)` pada tabel perangkat dan `attendance_events` dengan filter tanggal, seperti pada OPS-READY-001 §1 |
| V14 | Mengapa 93 penugasan jadwal untuk 97 pegawai aktif (W5) | Bandingkan daftar pegawai aktif dengan `attendance_schedule_assignments`, read-only; empat selisih itu bisa jadi pegawai yang memang tidak absen |
| V15 | Apa yang masih kurang di sisi Aset SQ untuk ASSET-001 (L13) | Periksa repository Aset SQ: klien Keycloak `hcis-aset-custody`, flag ASQ-004, dan jalur privat |
| V16 | Apakah entri worker untuk penyegaran proyeksi kepegawaian sudah ada (L2) | Baca `sq-core-worker.sh` di Mi8VPS dan Mi8VPS Platform Runbook; runbook langkah 6 |
| V17 | ~~Berapa persis cakupan bagan organisasi~~ | **Terjawab 2026-11-23 sebatas datanya: 96 dari 96** pegawai aktif yang layak diproses menemukan kepala, lewat binding `LEADER` dengan pendakian node pada change set terbit yang berlaku; kursi kosong, rangkap, dan sub-bagian tanpa kepala tidak menggagalkan satu pun (§1, W1). Sumbernya **penelusuran data bagan production — bukan simulasi, tetapi juga bukan pengajuan nyata yang dirutekan**. Yang tersisa karena itu bukan lagi cakupan bagannya, melainkan kecocokan dengan resolver yang berjalan: ORG-004 `SHADOW` pada unit pilot, dibandingkan dengan `LEGACY` per pegawai (L3) |
| V18 | Apakah penyetuju yang ditunjuk bagan punya **akun aktif dan izin** yang diperlukan (W1, W2, W3) | Tidak terjawab oleh pratinjau baca-saja. Cocokkan daftar penyetuju hasil resolusi dengan status akun di `accounts` dan dengan `account_role_assignments`, read-only; lalu buktikan dengan satu pengajuan nyata yang benar-benar dirutekan |
| V19 | Mengapa perangkat ADMS mengirim 4 log kehadiran berbanding 28.087 handshake, dan mengapa diam sejak 17 November 14:36 (W5) — **per 2026-11-23 sudah enam hari, dengan scan terakhir 17 November 09:10 dan nol scan dalam tiga hari terakhir** | Baca `attendance_adms_request_journal` per jenis permintaan dan per perangkat untuk rentang 10–23 November, read-only, lalu bandingkan dengan log perangkat di lokasi. **Butir ini mendesak dengan cara yang berbeda dari butir lain di tabel ini:** yang lain menunggu dan tetap sama, yang ini kehilangan kehadiran setiap hari dan kehilangannya tidak dapat disusun ulang |
| V20 | Apakah katalog klasifikasi jabatan akan diisi, kapan, dan dengan kode apa (L16, L10) | **Bukan pertanyaan yang dijawab pemeriksaan**: ini keputusan HCM dan owner yang belum diambil. Keadaannya sendiri sudah terukur dan nol (§3, 2026-11-23). Yang dapat diperiksa ulang kelak: `SELECT count(*) FROM job_classifications`, serta cacah `job_classification_code` non-NULL pada `employment_placements` dan `organization_positions`, read-only |
| V21 | **Satu catatan pegawai berstatus `active` dengan `removed_at` terisi** — mana yang benar, statusnya atau penghapusannya (§3) | Diukur 2026-11-23: `status='active'` 97, `status='active' AND removed_at IS NULL` 96, `status='active' AND removed_at IS NOT NULL` **1**. Dua penanda itu saling bertentangan: satu mengatakan pegawainya aktif, satu lagi mengatakan catatannya sudah dihapus. Dokumen ini **tidak menebak mana yang keliru**; itu keputusan data milik HC. Yang dapat dipastikan dari sini: selama bertentangan, orang itu dihitung oleh laporan yang memakai `status='active'` saja tetapi **tidak** dilayani oleh alur yang memakai predikat ketat (resolver ORG-004 `repository.ts:806`, gerbang TRIP-002). Pemeriksaan ulang: ketiga `count(*)` di atas, read-only |
| V22 | **Status akun pada 2 kursi yang dipegang akun Organ Yayasan** — satu-satunya tempat pelewatan diam-diam D-R5 masih hidup (L3) | Perbaikan #406 sengaja tidak mencakup kursi akun organ (ORG-013-1), sebagai **batas cakupan, bukan prinsip**; membukanya kembali adalah perubahan tersendiri yang belum diputuskan. Sampai itu terjadi, keadaannya diperiksa dengan **membaca status akunnya**, bukan dengan menunggu penolakan: cocokkan 2 pendudukan akun dan 1 binding `GOVERNANCE_APPROVER` pada bagan yang berlaku (§3) dengan status di `accounts`, read-only. Bila akunnya belum `active`, kursi itu akan dilewati diam-diam begitu `STRUCTURE` menyala |

## 9. Hubungan dengan dokumen lain

- `docs/operations/hcis-readiness-gates-2026-10-16.md` (OPS-READY-001) tetap berlaku sebagai penilaian gate; dokumen ini tidak menggantikannya. Status gate yang dikutip di sini bertanggal **2026-10-16** dan belum tentu masih sama.
- `docs/operations/hcis-opening-criteria-and-pilot-plan-2026-11-23.md` (OPS-OPEN-001, dari PR #403) adalah pasangan dokumen ini dan dibaca bersamanya: **OPS-CLOSE-001 menyatakan posisi** — di mana tiap butir berdiri hari ini beserta buktinya — sementara **OPS-OPEN-001 menyatakan syarat** — apa yang harus benar sebelum pintu dibuka, beserta rencana pilot terbatasnya. Pertanyaan "sudah sampai mana?" dijawab di sini; pertanyaan "kapan boleh dibuka?" dijawab di sana.
- `docs/operations/go-live-decision-record-template.md` (OPS-GOLIVE-001) adalah tempat keputusan pembukaan ditandatangani; W11, W13, dan W14 bermuara ke sana.
- `docs/development/mi8vps-hcis-release.md` (OPS-MI8-REL-001) adalah satu-satunya jalur rilis; W15 dijalankan lewat itu.
- `docs/product/hcis-capability-map.md` adalah arah produk, bukan bukti implementasi, dan menyatakan itu sendiri di bagian penutupnya. Dokumen ini menyediakan sisi buktinya.
- `docs/development/employment-pilot-activation-runbook.md` adalah runbook L2.

Dokumen ini diperbarui ketika salah satu butirnya berubah status, dengan bukti bertanggal baru. Butir tidak boleh naik status tanpa bukti.
