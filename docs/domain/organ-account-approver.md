# ORG-013 — Akun Organ Yayasan sebagai approver struktural

**Status:** ACCEPTED (keputusan owner 2026-11-03). **Diimplementasikan** di resolver, Leave (cuti tahunan dan cuti terencana), oversight, kanal pemberian role, dan kotak persetujuan `/board`. Hanya berpengaruh setelah rollout workflow cuti menjadi `STRUCTURE`, dan production masih `LEGACY`. Penyimpanan principal akun, permission, role, dan route keputusan sudah ada sejak migrasi `0023_leave_approval_principals.sql`.
**Specification:** ORG-013
**Menutup:** gap W-3 di `organization-designer-ux-gap-analysis.md` dan keputusan E di `organization-designer-ux-implementation-plan.md`
**Related:** ORG-004 (`dynamic-organization-structure.md`), APR-001 (`workflows/approval-engine.md`), LEAVE-003-N, ORG-003, ORG-010, AUTH-014 (`sq-core-administrator-layers.md`), GOV-001 (`../product/organ-portal-concept.md`, DRAFT)

## Mengapa

Bagan production memuat jabatan Ketua dan Sekretaris yang dipegang akun Organ Yayasan (`holder_source = ACCOUNT`). Resolver ORG-004 saat ini menolak jabatan seperti itu dengan `INVALID_AUTHORITY_PRINCIPAL`. Akibatnya aturan yang sudah diputuskan tidak dapat berjalan di `STRUCTURE`: cuti Direktur disetujui Sekretaris Yayasan, lalu Ketua diberi tahu (LEAVE-003-N, ORG-004-O).

Owner memutuskan pada 2026-11-03: **akun Organ Yayasan boleh menjadi approver** pada langkah yang jatuh ke jabatan yang dipegangnya. Keputusan ini tidak menambah aturan bisnis, mesin, role, atau route baru. Siapa menyetujui apa tetap berasal dari bagan dan spesifikasi workflow yang sudah ada. Principal akun memakai mekanisme 0023 yang sudah ada.

## Yang sudah ada (0023)

| Bagian | Isi |
|---|---|
| Kolom langkah | `leave_request_approval_steps.approver_account_id`, XOR dengan `approver_employee_id` |
| Permission | `leave.governance.approve`, "Approve an explicitly snapshotted governance Leave step" |
| Role | `governance_leave_approver`, hanya membawa `leave.governance.approve` |
| Route | `GET /leave/approvals` dan `POST /leave/approvals/:stepId/decision` menerima sesi cookie `FOUNDATION_BOARD`, memeriksa kepemilikan `approver_account_id`, dan memeriksa `leave.governance.approve` |
| Hidrasi rantai | Principal akun wajib berupa `FOUNDATION_BOARD` yang `active` |

## Ruang lingkup

Termasuk:

- resolver struktural boleh menghasilkan principal akun untuk jabatan `ACCOUNT`;
- definisi "orang yang sama" untuk self-approval dan duplicate approver antarbentuk principal;
- kanal pemberian `governance_leave_approver` ke akun `FOUNDATION_BOARD`;
- notifikasi oversight ke jabatan `ACCOUNT` (misalnya Ketua diberi tahu);
- amandemen terbatas ORG-003-C untuk data pengajuan pada langkah milik principal itu.

Tidak termasuk:

- aturan workflow, role, permission, atau route baru;
- akses organ ke `/app` atau `/admin`. `FOUNDATION_BOARD` tetap ditolak di sana;
- akses payroll untuk Pengurus. ADR-0003 (amandemen 2026-10-27), ORG-003-F, dan ORG-010-F tetap berlaku;
- token hasil token exchange pada route keputusan (lihat ORG-013-3);
- aktivasi `STRUCTURE`. ORG-013 hanya berpengaruh bila rollout workflow tersebut sudah `STRUCTURE`, dan aktivasi itu tetap melalui `org004-operational-validation.md`;
- persetujuan akhir MPP di Karir SQ (REC-IMPL-006). Aplikasi itu memakai mesinnya sendiri dan mengikuti keputusan yang sama di repository-nya.

## Aturan

### ORG-013-1 Resolusi jabatan `ACCOUNT`

Saat traversal resolver mencapai incumbent efektif:

1. **Bentuk data.** Jabatan `ACCOUNT` hanya menerima baris incumbency yang berisi `accountId`. Baris tersebut diproses dengan aturan di bawah. Baris incumbency berisi `accountId` pada jabatan `EMPLOYEE`, atau baris berisi `employeeId` pada jabatan `ACCOUNT`, tetap gagal `INVALID_AUTHORITY_PRINCIPAL`. Keduanya tidak dianggap kursi kosong.
2. **Tipe akun.** Principal akun hanya untuk akun `FOUNDATION_BOARD` tanpa `employee_id`. Bila `accountId` pada baris incumbency milik akun `EMPLOYEE`, akun itu diselesaikan sebagai principal pegawai lewat eligibility validator pegawai. Bila pegawainya tidak aktif, ia tidak eligible dan resolver mengikuti `vacancy_policy` jabatan. Bentuk lain (tipe akun lain, atau `FOUNDATION_BOARD` dengan `employee_id`) gagal `INVALID_AUTHORITY_PRINCIPAL`.
3. **Eligibility akun.** Akun `FOUNDATION_BOARD` harus `active` dan memegang `leave.governance.approve` melalui assignment `governance_leave_approver` yang efektif pada tanggal resolusi. Untuk principal akun, `requiredCapability` workflow LEAVE dipetakan ke `leave.governance.approve`, bukan `leave.approve`. Akun yang tidak memenuhi syarat dianggap tidak eligible, dan resolver mengikuti `vacancy_policy`. Kepemilikan jabatan tidak pernah memberi capability.
4. **Orang yang sama.** Dua principal dianggap orang yang sama bila memiliki akun yang sama atau `accounts.employee_id` yang sama. Invarian: anggota organ yang juga pegawai tidak boleh memegang akun `FOUNDATION_BOARD` aktif, sehingga hand-over ORG-010 §5 wajib dilakukan. Satu identitas Akun SQ hanya terpasang pada satu akun (indeks unik migrasi 0020), sehingga pelanggaran invarian ini berbentuk dua akun dengan identitas berbeda. Karena itu invarian ditegakkan dengan pencocokan email:
   - kanal pemberian menolak `governance_leave_approver` untuk akun `FOUNDATION_BOARD` bila email akun itu, atau email pada profil Akun SQ-nya, cocok dengan email pegawai aktif, dan pemberi wajib menyatakan "bukan pegawai" di alasan;
   - email dibandingkan setelah trim dan lowercase; email kosong di salah satu sisi tidak dianggap cocok, tetapi akun `FOUNDATION_BOARD` tanpa email ditolak di kanal pemberian;
   - resolver menjalankan pencocokan email yang sama saat submit, dan gagal sebagai configuration error bila cocok atau bila akun `FOUNDATION_BOARD` belum mempunyai identitas terpetakan.
5. **Self-approval.** Larangan self-approval memakai definisi orang yang sama di butir 4, termasuk pencocokan email. Larangan ini diperiksa saat submit dan diperiksa ulang saat keputusan.
6. **Duplicate approver.** Aturan APR-001 memakai kunci (tipe principal, id) setelah normalisasi orang yang sama. Dua principal akun yang berbeda tidak pernah digabung.

Kegagalan tetap fail-closed. Tidak ada fallback diam-diam ke `LEGACY`.

### ORG-013-2 Pemberian role ke akun Organ Yayasan

- Role yang dipakai adalah `governance_leave_approver` yang sudah ada. Tidak ada role atau migrasi role baru.
- Role ini tidak membawa `board.read`, data pribadi, atau payroll. Akses baca dasbor tetap lewat ORG-003/ORG-010.
- Pemberian memakai kanal SQ Hub AUTH-014, dengan pengecualian eksplisit pada invarian 7 (target wajib `EMPLOYEE`). Target `FOUNDATION_BOARD` diizinkan **hanya** dengan syarat berikut:
  - role termasuk allowlist {`governance_leave_approver`};
  - scope `organization`;
  - alasan wajib, misalnya nomor SK kepengurusan;
  - tanggal berakhir wajib, yaitu akhir masa jabatan;
  - tanpa self-grant;
  - diaudit seperti assignment lain.
- `governance_leave_approver` ditambahkan ke `HCIS_ROLES` agar invarian AUTH-014 yang lain tetap berlaku, dan `leave.governance.approve` ditambahkan ke `HCIS_PERMISSIONS` hanya untuk role ini. Target `EMPLOYEE` ditolak untuk role ini di semua kanal. Rujukan amandemen sudah dicatat di ORG-003, ORG-010 §1, dan AUTH-014.
- Capability selain `leave.governance.approve` hanya ditambahkan ketika spesifikasi workflow menetapkan langkah yang jatuh ke jabatan organ.

### ORG-013-3 Keputusan oleh principal akun

- Keputusan memakai `GET /leave/approvals` dan `POST /leave/approvals/:stepId/decision` yang sudah ada, beserta transisi, audit event, concurrency, dan notifikasi APR-001. Tidak ada state baru.
- **v1 hanya menerima sesi cookie.** Route keputusan tetap menolak bearer, sehingga ORG-010-E tidak berubah.
- Jalur token exchange untuk Portal Organ Yayasan berstatus `TBD`. Jalur itu membutuhkan amandemen ORG-010 tersendiri dengan syarat minimum:
  - audience terpisah dari `GOVERNANCE_SUMMARY_AUDIENCE`;
  - allowlist `azp` hanya berisi client portal, bukan Hub;
  - bukti `acr`/TOTP untuk mutasi;
  - test 401 ORG-010 diperbarui dan menyebut satu-satunya pengecualian.
- **Batas data (amandemen terbatas ORG-003-C).** Data pengajuan bernama hanya dikembalikan untuk langkah yang dimiliki principal itu. Isinya jenis pengajuan, nama dan jabatan pengaju, periode, dan alasan pengajuan. Riwayat langkah hanya memuat status, waktu, dan jabatan approver, tanpa `decision_note` approver lain dan tanpa lampiran. Dasbor `/board` tetap agregat.
- Tampilan v1 (`DRAFT`): sampai Portal Organ Yayasan tersedia, kotak persetujuan tampil di `/board` memakai route di atas.
- **Amandemen 2026-11-13 (permintaan owner, ORG-010-P).** Bila HCIS mengisi `ORGAN_PORTAL_URL`, `/board` untuk akun Organ Yayasan hanya berisi "Persetujuan Organ Yayasan" (kotak persetujuan ini, tanpa perubahan) dan tautan ke Portal Organ Yayasan; dasbor agregat menjawab `403 ORGAN_PORTAL_ONLY`. Route `/leave/approvals` dan keputusan tidak berubah, dan `decisions[].href` tetap `/board`. Di ORGAN-IMPL-001 R2 kotak persetujuan pindah ke portal.

### ORG-013-4 Notifikasi oversight

- Penerima oversight dihitung dari `positionKey` langkah final yang tersimpan di konteks resolusi, bukan dari `approver_employee_id`. Dengan begitu langkah final milik akun, misalnya Sekretaris, tetap menghasilkan oversight ke Ketua.
- Penerima boleh berupa jabatan `ACCOUNT` dan disimpan sebagai `account_id` pada notification intent.
- Notifikasi bersifat informasi. Penerima tidak memerlukan capability approval, dan notifikasi tidak memberinya.

## Audit

Satu event riwayat baru: `leave.oversight.unresolved` di `leave_request_events`, berisi kode resolver saja, ditulis bila penerima oversight gagal di-resolve. Saat ini event itu hanya terlihat lewat query database; tampilannya untuk HC berstatus `TBD`. Event approval dan oversight yang sudah ada mencatat principal akun lewat `actor_account_id`. Pemberian dan pencabutan assignment memakai audit role assignment yang ada.

## Data, migrasi, dan rollback

- Tidak ada kolom, role, atau permission baru. Perubahan ada di resolver, kanal pemberian, dan perhitungan oversight.
- Rollback:
  1. Hentikan resolusi principal akun untuk submit baru, dengan flag atau dengan mengembalikan rollout workflow ke `LEGACY`.
  2. Daftar langkah `pending` yang memakai `approver_account_id`, lalu selesaikan atau batalkan sesuai prosedur HC yang terdokumentasi. Reassignment cuti APR-001 belum ada (`TBD`).
  3. Baru setelah itu cabut assignment.

## Test wajib

- jabatan `ACCOUNT` dengan akun `FOUNDATION_BOARD` aktif yang memegang `leave.governance.approve` menghasilkan langkah `approver_account_id`;
- akun tanpa capability, akun suspended, atau akun inactive mengikuti `vacancy_policy` (BLOCK menghasilkan error, CLIMB naik);
- akun `EMPLOYEE` pada jabatan `ACCOUNT` menghasilkan `approver_employee_id`, dan bila pegawainya tidak aktif, resolver mengikuti `vacancy_policy`;
- bentuk data salah (akun pada jabatan `EMPLOYEE`, pegawai pada jabatan `ACCOUNT`, `FOUNDATION_BOARD` dengan `employee_id`) gagal `INVALID_AUTHORITY_PRINCIPAL`;
- akun `FOUNDATION_BOARD` dan akun `EMPLOYEE` aktif dengan identitas berbeda tetapi email sama ditolak di kanal pemberian dan menghasilkan configuration error di resolver;
- kanal mana pun menolak `governance_leave_approver` untuk target `EMPLOYEE`;
- self-approval lewat akun, `employee_id`, atau email yang sama ditolak saat submit dan saat keputusan;
- dua principal akun berbeda (Sekretaris dan Ketua) tidak digabung oleh dedupe;
- cuti Direktur di `STRUCTURE`: Sekretaris (akun) menyetujui, Ketua (akun) mendapat notification intent, Pembina tidak;
- token tukar, termasuk token governance summary, ditolak 401 di route keputusan;
- `FOUNDATION_BOARD` tetap 403 di `/app` dan `/admin`;
- kanal AUTH-014 menolak target `FOUNDATION_BOARD` untuk role di luar allowlist, tanpa tanggal berakhir, atau tanpa alasan;
- respons inbox tidak memuat `decision_note` approver lain atau lampiran;
- mode `LEGACY` tidak berubah perilakunya.

## Implementasi

| Bagian | Lokasi |
|---|---|
| Opt-in resolver (`accountCapability`, `allowAccountRecipient`) dan principal akun | `apps/api/src/modules/organization/resolver.ts`, `domain.ts` |
| Klasifikasi akun dan pencocokan email | `PostgresOrganizationRepository.validateAccount` |
| Opt-in Leave, snapshot, dan oversight dari jabatan | `apps/api/src/modules/leave/organization-authority.ts` (`allowAccountPrincipal`), `employee-routes.ts`, `planned-leave-routes.ts` |
| Pemeriksaan ulang self-approval saat keputusan | `governanceActorIsRequester`, dipanggil di `POST /leave/approvals/:stepId/decision` |
| Kanal pemberian dan allowlist target | `apps/api/src/modules/auth/role-assignment.ts` |
| Preview "Cek persetujuan" HC untuk cuti | `apps/api/src/modules/organization/admin-routes.ts` |
| Kotak persetujuan `/board` (v1, `DRAFT`) | `apps/web/src/components/board/BoardApprovalsSection.tsx` |
| Test | `apps/api/test/org013-organ-account-approver.test.ts`, `org013-organ-account-approver.postgres.test.ts` |

Tindak lanjut yang sudah ditutup:

- **Kanal SQ Hub (HCIS).** Lookup `GET /internal/v1/role-administration/accounts` kini menjawab akun `FOUNDATION_BOARD` dengan `principalType`, dan `grantable` hanya bergantung pada status akunnya. `GET /internal/v1/role-administration/catalog` memberi setiap role `targetPrincipalTypes` (`["FOUNDATION_BOARD"]` hanya untuk `governance_leave_approver`) dan `endDateRequired`. Akun `SUPER_ADMIN` tetap dijawab 404. Pemberian tetap ditolak `createRoleAssignment` untuk role lain. Sisi Hub, yaitu menyaring role per tipe target dan mewajibkan tanggal berakhir, dikerjakan di repository SQ Hub. Sampai sisi Hub selesai, Hub yang lama tetap aman karena HCIS menolak kombinasi yang salah dengan `ROLE_TARGET_INVALID`.
- **Diagnostik oversight.** Bila penerima oversight gagal di-resolve (misalnya akun Ketua `CONFLICT`), riwayat pengajuan mendapat event `leave.oversight.unresolved` yang hanya berisi kode resolver, tanpa id akun atau pesan. Event ini ditulis dalam savepoint tersendiri sehingga tidak dapat menggagalkan keputusan akhir.

Workflow lain yang memakai resolver yang sama (perjalanan dinas, pinjaman, pengaturan kerja, lembur, penilaian kinerja) tidak ikut opt-in. Untuk workflow itu jabatan akun tetap gagal `INVALID_AUTHORITY_PRINCIPAL`.

## Acceptance criteria

- ORG-013-A: di `STRUCTURE`, jabatan `ACCOUNT` dengan akun `FOUNDATION_BOARD` aktif yang memegang `leave.governance.approve` menghasilkan langkah approval milik akun itu.
- ORG-013-B: kepemilikan jabatan tanpa capability tidak pernah menghasilkan approver.
- ORG-013-C: akun `EMPLOYEE` selalu diselesaikan sebagai principal pegawai. Orang yang sama ditentukan oleh akun atau `employee_id`, dan akun organ yang emailnya cocok dengan pegawai aktif ditolak. Self-approval diperiksa saat submit dan saat keputusan. Dedupe memakai kunci principal.
- ORG-013-D: principal akun memutuskan lewat route `/leave/approvals` yang sudah ada, hanya dengan sesi cookie, dengan transisi dan audit APR-001, tanpa akses `/app` atau `/admin`.
- ORG-013-E: `governance_leave_approver` hanya membawa `leave.governance.approve`, dan hanya dapat diberikan ke akun `FOUNDATION_BOARD` lewat allowlist AUTH-014 dengan alasan dan tanggal berakhir. Target `EMPLOYEE` selalu ditolak.
- ORG-013-F: perilaku `LEGACY` tidak berubah. SHADOW tetap tidak membuat langkah atau oversight, tetapi diagnostik shadow dan preview resolusi boleh berubah.
- ORG-013-G: oversight dihitung dari jabatan langkah final, termasuk bila langkah final milik akun.
