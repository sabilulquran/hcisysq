# AUTH-014 — Tiga lapis administrator: sisi HCIS

**Status:** ACCEPTED product decision (owner, 2026-10-27); implementasi belum dimulai. Revisi 2 setelah review keamanan independen 2026-10-27.
**Related:** ADR-0006 (keputusan), AUTH-010, AUTH-011, AUTH-012, AUTH-013, ORG-008, ORG-010, EMP-005, DOC-002, `HUB-IMPL-003`.
**Supersedes:** aturan "hanya Super Admin yang memberi peran" di AUTH-011 (keputusan owner 2026-10-16), sejauh menyangkut *siapa* yang boleh memberi. Larangan self-grant, allowlist role/permission, kewajiban mandat, dan atomisitas audit **tidak** diubah.

Dokumen ini hanya mengatur HCIS. Perubahan di SQ Hub dan Keycloak ditulis sebagai kebutuhan di §7; repository SQ Hub tidak ada di checkout ini dan tidak disentuh.

---

## 1. Ringkasan

| Pertanyaan | Jawaban setelah AUTH-014 |
|---|---|
| Siapa yang memberi peran HCIS? | Admin Platform, dari SQ Hub, lewat kanal mesin ke HCIS |
| Apakah HCIS tahu siapa Admin Platform? | Tidak. HCIS mengenali kanal, lalu memverifikasi manusia pelakunya dari token yang ditandatangani Keycloak |
| Apakah masih perlu akun SUPER_ADMIN terpisah? | Tidak untuk pekerjaan harian. Tetap ada sebagai break-glass nonaktif |
| Siapa Admin Modul HCIS? | Role baru `hcis_module_admin`, scope organisasi, diberikan oleh Admin Platform |
| Apakah Admin Modul boleh memberi peran? | Tidak. Tidak pada peran apa pun, pada scope apa pun |
| Apakah Admin Modul boleh menyentuh akun orang? | Tidak. Tidak membuat, menonaktifkan, mengundang, atau mereset |

---

## 2. Kanal pemberian peran dari Admin Platform

### 2.1 Bentuk kanal

Tiga endpoint internal baru, mengikuti pola yang sudah ada di
`apps/api/src/modules/employees/staff-identity-routes.ts`,
`apps/api/src/modules/organization-directory/routes.ts`, dan
`apps/api/src/modules/organization-directory/machine-auth.ts`:

```
POST   /internal/v1/role-administration/accounts/:accountId/role-assignments
DELETE /internal/v1/role-administration/role-assignments/:assignmentId
GET    /internal/v1/role-administration/catalog
```

`GET /catalog` mengembalikan role HCIS yang dapat diberikan beserta permission, kewajiban scope, dan kewajiban mandat, supaya layar SQ Hub tidak perlu menyalin daftar peran HCIS ke dalam kodenya. Daftar itu tetap milik HCIS.

Seperti kedua route internal yang sudah ada, setiap balasan — termasuk `503` dan setiap penolakan — menulis `Cache-Control: no-store` sebelum apa pun yang lain. `GET /catalog` memuat seluruh peta peran dan permission HCIS dan tidak boleh tersimpan di perantara mana pun.

### 2.2 Dua hal yang harus dibuktikan, bukan satu

Review keamanan 2026-10-27 menemukan lubang paling serius pada rancangan pertama: kanal hanya membuktikan "permintaan ini dari SQ Hub", sedangkan **siapa manusianya dikirim sebagai dua field JSON biasa**. SQ Hub yang dikuasai penyerang — atau satu Admin Platform yang nakal — cukup menyebut `subject` orang lain untuk melewati larangan self-grant dan membuat audit menuding orang yang tidak bersalah. Seluruh klaim "HCIS memverifikasi sendiri" runtuh pada satu nilai yang dipilih pihak yang tidak dipercaya.

Karena itu permintaan membawa **dua bukti terpisah**, dan keduanya wajib:

| Bukti | Bentuk | Membuktikan |
|---|---|---|
| **Token mesin** | `Authorization: Bearer <client-credentials token>` | permintaan datang dari SQ Hub |
| **Assertion aktor** | `X-SQ-Actor-Assertion: <JWT>` | manusia tertentu benar-benar sedang bertindak |

Assertion aktor adalah token yang diterbitkan Keycloak untuk sesi manusia itu melalui **token exchange** (RFC 8693) oleh SQ Hub, dengan audience HCIS. HCIS memverifikasinya terhadap JWKS realm, sama seperti token mesin, dan **mengambil identitas aktor dari assertion itu, bukan dari body permintaan**. Field `actor` di body dihapus; bila ada, permintaan ditolak `400`.

Bila token exchange tidak tersedia di realm, kanal **tidak dihidupkan**. Itu adalah gate F4 (§6), bukan hal yang boleh dikompromikan dengan kembali ke klaim polos.

| Parameter | Nilai |
|---|---|
| Issuer | `HCIS_ROLE_ADMIN_TOKEN_ISSUER` |
| Audience | `HCIS_ROLE_ADMIN_TOKEN_AUDIENCE` |
| Client allowlist | `HCIS_ROLE_ADMIN_ALLOWED_CLIENTS` = `sq-hub-role-administration` |
| Scope wajib | `role-administration.manage` |
| Audience assertion aktor | `HCIS_ROLE_ADMIN_ACTOR_AUDIENCE` |
| Umur maksimum assertion aktor | 120 detik (`iat` diperiksa, bukan hanya `exp`) |
| Saklar | `HCIS_ROLE_ADMIN_ENABLED` (`"1"` untuk hidup; selain itu `503 ROLE_ADMIN_CHANNEL_DISABLED`) |

Client-nya **bukan** `sq-hub-identity-management`. ADR-0006 R-1 butir 1 mensyaratkan `manage-users` dan kewenangan memberi peran berada pada akun mesin yang berbeda, supaya satu secret yang bocor tidak membuka keduanya; rancangan pertama melanggar syaratnya sendiri dengan memakai satu client untuk keduanya.

Token mesin juga wajib berbentuk token client-credentials: HCIS menolak token yang membawa klaim pengguna (`sub` yang bukan service account, atau `preferred_username`) pada header `Authorization`. Tanpa pemeriksaan itu, token pengguna biasa dari client yang ada di allowlist dapat lolos — keterbatasan yang terwarisi dari pola lama dan tidak berbahaya untuk pencarian pegawai read-only, tetapi berbahaya untuk pemberian peran.

### 2.3 Isi permintaan

```jsonc
{
  "requestId": "<uuid dari SQ Hub, unik, dicatat di kedua sisi>",
  "roleId": "<uuid role HCIS>",
  "scopeType": "organization",
  "organizationalUnitId": null,
  "reason": "<mandat, wajib untuk role istimewa>",
  "startsOn": null,
  "endsOn": null
}
```

Identitas aktor **tidak ada di sini**. Ia datang dari assertion §2.2.

`requestId` wajib unik. Kolom `hub_request_id` mendapat unique index per aksi; `requestId` yang sudah pernah dipakai ditolak `409 ROLE_ADMIN_REQUEST_REPLAYED` tanpa mengubah apa pun. Tanpa ini, satu permintaan yang direkam dapat diputar ulang selama token mesin masih hidup untuk memulihkan assignment yang baru saja dicabut — dan rekonsiliasi dua sisi (ADR-0006 R-1 butir 5) justru akan menganggapnya cocok, karena dua event HCIS bertemu satu event Hub dengan `requestId` yang sama.

### 2.4 Apa yang HCIS periksa sendiri

Berurutan; kegagalan di mana pun berarti tidak ada assignment dan tidak ada audit event perubahan, hanya log penolakan.

1. **Kanal hidup** — jika tidak, `503 ROLE_ADMIN_CHANNEL_DISABLED`.
2. **Token mesin** sah, berbentuk client-credentials, client ada di allowlist, scope `role-administration.manage` ada — jika tidak, `401`/`403`.
3. **Assertion aktor** ada, sah terhadap JWKS realm, audience benar, umur ≤ 120 detik — jika tidak, `401 ROLE_ADMIN_ACTOR_ASSERTION_INVALID`.
4. **Resolusi aktor.** `iss` + `sub` dari assertion dicocokkan ke `accounts.identity_issuer` + `accounts.identity_subject`. Tepat satu baris (dijamin unique partial index `accounts_identity_issuer_subject_unique`, migration 0020), akun `active`, dan bila `principal_type = 'EMPLOYEE'` maka employee-nya juga `active`. Gagal: `403 ROLE_ADMIN_ACTOR_UNRESOLVED`. **Tidak ada pencocokan lewat email atau nama.**
5. **`requestId` belum pernah dipakai** — jika sudah, `409 ROLE_ADMIN_REQUEST_REPLAYED`.
6. **Larangan self-grant.** `resolvedActor.id === accountId` ditolak `403 ROLE_DELEGATION_FORBIDDEN`, pada pemberian maupun pencabutan, dievaluasi terhadap manusia hasil langkah 4.
7. **Invarian domain yang sudah ada:** target wajib `principal_type = 'EMPLOYEE'`; role wajib ada di `HCIS_ROLES`; seluruh permission role wajib ada di `HCIS_PERMISSIONS`; `assertAssignmentScope` dan `assertAssignmentDates`; mandat dan scope organisasi wajib untuk `human_capital_admin`, `human_capital_lead`, `foundation_board_viewer`, dan `hcis_module_admin`; pencabutan token aktivasi untuk role di luar bundle operasional HC.
8. **Larangan permission identitas.** Lihat §2.6.

### 2.5 Satu pelonggaran yang dilakukan dengan sadar

Rancangan pertama menulis "invarian domain yang sudah ada, tanpa pelonggaran". Itu tidak benar, dan bila diterapkan apa adanya kanal ini tidak akan pernah bisa memberi apa pun. `requireDelegation` (`role-assignment.ts`) menuntut dua hal yang tidak mungkin dipenuhi aktor mana pun di bawah rancangan ini:

- `hasEffectiveOrganizationPermission(actor, "access.roles.assign")` — migration 0057 mencabut permission itu dari `human_capital_admin`, dan ADR-0006 D-5 melarangnya diberikan selamanya, jadi tidak ada pegawai yang bisa memilikinya; dan
- tanpa `access.roles.delegate`, `canDelegateRole` hanya menerima role `human_capital` berisi `HC_OPERATIONAL_PERMISSIONS` — bukan `hcis_module_admin`, bukan `human_capital_lead`, bukan peran payroll.

Maka **pelonggarannya dinyatakan di sini, bukan disembunyikan di implementasi**:

> Kewenangan memberi peran pada jalur `sq_hub` berasal dari kanal, bukan dari permission yang dipegang aktor. `canDelegateRole` menerima parameter channel; untuk `"sq_hub"` ia berperilaku seperti `delegated === true`, dan kedua pemeriksaan `hasEffectiveOrganizationPermission` di atas dilewati.

Artinya HCIS **tidak** memverifikasi bahwa aktor berwenang — SQ Hub yang melakukannya. Yang HCIS verifikasi adalah: aktor itu manusia nyata yang benar-benar bertindak (§2.2–2.4 langkah 3–4), bukan dirinya sendiri (langkah 6), permintaannya belum pernah diputar (langkah 5), dan peran yang diminta ada di dalam batas yang HCIS tetapkan sendiri (langkah 7–8). Itu lebih sempit dari klaim rancangan pertama dan harus dibaca apa adanya: **kompromi penuh SQ Hub berarti penyerang dapat memberi peran HCIS apa pun kepada akun mana pun selain akun aktor yang ia pakai.** Batas kerusakannya adalah §2.6 dan §7 H-9/H-10, bukan pemeriksaan kewenangan di HCIS.

### 2.6 Larangan permission identitas

`access.roles.assign`, `access.roles.delegate`, dan `access.governance.manage` dikumpulkan menjadi `IDENTITY_PERMISSIONS`. Larangannya dipasang di **`canDelegateRole` dan `HCIS_PERMISSIONS`**, bukan di route — jadi berlaku untuk **kedua** jalur, termasuk break-glass.

Rancangan pertama memasangnya di route saja. Akibatnya break-glass SUPER_ADMIN (yang `canDelegateRole`-nya berjalan dengan `delegated === true`) tetap bisa membuat dan memberi role berisi `access.roles.assign`, membuka kembali persis lingkaran eskalasi yang D-5 ada untuk menutupnya, secara permanen dan tanpa menyentuh kanal.

Role yang membawa salah satunya ditolak `403 ROLE_IDENTITY_PERMISSION_FORBIDDEN`, diperiksa terhadap permission yang tersimpan di `role_permissions`, bukan terhadap daftar yang dikirim pemanggil.

### 2.7 Audit

`role.assignment.created` dan `role.assignment.removed` tetap dipakai, atomik bersama mutasinya. `access_audit_events.actor_account_id` sudah ada sejak migration 0004 dan sudah ditulis; yang **baru** hanya dua kolom:

| Field | Jalur SQ Hub | Jalur break-glass |
|---|---|---|
| `actor_account_id` (sudah ada) | akun lokal hasil resolusi assertion | akun SUPER_ADMIN |
| `actor_source` (baru) | `"sq_hub"` | `"hcis_break_glass"` |
| `hub_request_id` (baru, unique) | `requestId` dari SQ Hub | `null` |

`actor_source = "hcis_break_glass"` adalah penanda ADR-0006 R-1 butir 6: pemakaian break-glass harus dapat difilter di layar audit dan tidak boleh tenggelam di antara pemberian normal.

### 2.8 Satu urutan yang berbeda dari AUTH-011, disengaja

AUTH-011 menegaskan pemeriksaan grantor berjalan **sebelum** validasi input. Kanal ini tidak bisa begitu untuk `requestId` dan body, karena body harus diurai dulu. Yang tetap dipertahankan: identitas aktor diverifikasi dari header (langkah 2–4) **sebelum** body dibaca, dan tidak ada apa pun yang ditulis sebelum seluruh langkah §2.4 lulus. Perbedaannya hanya pada urutan pesan galat, bukan pada apa yang tersimpan.

---

## 3. Nasib `principal_type = 'SUPER_ADMIN'`

Tidak ada kolom yang dihapus, tidak ada akun yang dihapus, tidak ada `principal_type` yang diubah. Yang berubah adalah artinya.

| Hal | Sekarang | Setelah AUTH-014 |
|---|---|---|
| `principalType === "SUPER_ADMIN"` di `assertRoleGrantor` | satu-satunya jalan memberi peran | salah satu dari dua jalan, dan yang kedua |
| Akun `admin@hcis.sabilulquran.or.id` | aktif, dipakai harian | `status = 'inactive'`, dihidupkan hanya untuk break-glass |
| Kewenangan grantor break-glass | berasal dari `hasLegacySuperAdminCompatibility` | berasal dari `assertRoleGrantor(actor, "break_glass")`, **lepas dari shim** |
| Form pemberian peran di `/admin/access` HCIS | tampil untuk SUPER_ADMIN | tetap tampil untuk SUPER_ADMIN; pengguna lain melihat daftar read-only dengan tautan "Kelola di SQ Hub" |

### 3.1 Break-glass tidak boleh bergantung pada shim yang dijadwalkan dihapus

Hari ini SUPER_ADMIN lolos `requireDelegation` **hanya** karena `hasEffectiveOrganizationPermission` memintas lewat `hasLegacySuperAdminCompatibility`; untuk principal non-`EMPLOYEE` tidak ada jalur lain. Jadi penghapusan shim itu — yang AUTH-011 memang jadwalkan — diam-diam mematikan satu-satunya jalan cadangan, dan tidak ada yang tahu sampai hari SQ Hub mati.

Aturannya:

1. Di fase F3, kewenangan grantor break-glass dipindahkan ke `assertRoleGrantor(actor, "break_glass")` dan pemeriksaan `hasEffectiveOrganizationPermission` di `requireDelegation` dilewati untuk jalur itu, persis seperti jalur `sq_hub`. Setelah F3, break-glass tidak lagi membutuhkan shim untuk memberi peran.
2. `hasLegacySuperAdminCompatibility` **tidak boleh dihapus sebelum** sebuah latihan break-glass berhasil dijalankan dengan shim dimatikan sementara. Syarat ini ditambahkan ke daftar syarat AUTH-011, dan pencabutan shim tetap bukan bagian AUTH-014 — dikerjakan **setelah F7**.

### 3.2 Prosedur break-glass, beserta alat yang belum ada

1. Operator mencatat alasan di runbook Mi8VPS sebelum bertindak.
2. Akun break-glass diaktifkan lewat perintah CLI tercatat.
3. Pekerjaan dikerjakan; setiap aksi menghasilkan audit `actor_source = "hcis_break_glass"`.
4. Akun dikembalikan ke `inactive` segera setelah selesai.
5. Kredensial break-glass dirotasi setelah setiap pemakaian.

Langkah 2 dan 5 **belum punya alat**. `bootstrap-super-admin.ts` menolak bekerja bila SUPER_ADMIN sudah ada, `assertAccountManagementTarget` melarang SUPER_ADMIN menjadi target pengelolaan akun lewat API, dan tidak ada perintah pengubah status maupun pemutar kredensial. Tanpa keduanya, satu-satunya jalan adalah SQL manual di Mi8VPS, dan F1 tidak dapat dijalankan sebagaimana tertulis.

Dua perintah CLI baru karena itu menjadi **prasyarat F1**, bukan pekerjaan belakangan:

- `break-glass:set-status <active|inactive>` — satu-satunya pengubah status akun SUPER_ADMIN, menulis audit `actor_source = "hcis_break_glass"`;
- `break-glass:rotate-credential` — memutar kredensial dan menulis audit yang sama.

Keduanya tetap di belakang variabel lingkungan sekali-pakai seperti `HCIS_ALLOW_SUPER_ADMIN_BOOTSTRAP` yang sudah ada.

Akun break-glass wajib sudah tertaut ke Akun SQ dan **sudah pernah diuji login** sebelum F4. Ini pelajaran langsung dari kejadian yang memicu AUTH-014: lapis cadangan yang belum pernah diuji bukan lapis cadangan.

Satu hal yang sudah benar dan tidak perlu diubah: `getSession` menyaring `accounts.status = 'active'`, jadi mengembalikan akun ke `inactive` benar-benar memutus sesi yang sedang berjalan, bukan hanya login berikutnya.

---

## 4. Admin Modul HCIS

### 4.1 Role baru

`hcis_module_admin` — "Admin Modul HCIS". Scope organisasi wajib, mandat wajib, diberikan hanya oleh Admin Platform lewat kanal §2. Role key wajib ditambahkan ke **`HCIS_ROLES`**; tanpa itu `canDelegateRole` menolaknya dan role hasil migration F2 tidak akan pernah bisa diberikan.

### 4.2 Yang masuk kewenangannya

Pengaturan modul, data acuan, periode, dan hal teknis operasional. Semua permission sudah ada di katalog; tidak ada yang baru.

| Kelompok | Permission |
|---|---|
| Jadwal dan kebijakan kehadiran | `attendance.schedule.manage`, `attendance.policy.manage`, `attendance.shift_swap.manage`, `attendance.calculation.run` |
| Perangkat absensi (non-destruktif) | `attendance.devices.read`, `attendance.devices.configure`, `attendance.devices.operate`, `attendance.devices.export`, `attendance.devices.technical` |
| Konfigurasi cuti | `leave.configuration.manage` |
| Konfigurasi payroll | `payroll.policies.manage`, `payroll.periods.manage` |

### 4.3 Klasifikasi lengkap sisa katalog

Rancangan pertama menyebut "template dokumen" sebagai kewenangan Admin Modul dan memasukkan `documents.manage`. Itu keliru: `documents.manage` menjaga persetujuan, penolakan, dan penerbitan dokumen untuk pegawai tertentu (`apps/api/src/modules/documents/routes.ts`), yaitu pekerjaan HC, bukan konfigurasi. **Template dokumen belum punya permission tersendiri**; bila nanti dibuat, ia masuk Admin Modul (`TBD`, §8).

Tabel ini menutup seluruh katalog, sehingga migration pencabutan F6 punya daftar yang pasti.

| Permission | Tempatnya | Alasan |
|---|---|---|
| `access.roles.assign`, `access.roles.delegate`, `access.governance.manage` | **tidak ada** (§2.6) | tidak boleh dipegang role HCIS mana pun |
| `access.manage`, `access.accounts.temporary_reactivate` | peran kerja HC | menyentuh akun orang |
| `employees.manage`, `employees.read.all` | peran kerja HC | data pribadi pegawai |
| `employment.read`, `employment.manage`, `employment.correct` | peran kerja HC | riwayat kerja orang tertentu |
| `organization.manage` | peran kerja HC | struktur organisasi, bukan pengaturan modul |
| `approvals.policy.manage` | `human_capital_lead` | siapa menyetujui apa (ORG-008-8) |
| `leave.validate`, `leave.approve`, `leave.hc.approve` | peran kerja | keputusan, bukan konfigurasi |
| `leave.evidence.read` | peran kerja HC | dokumen seorang pegawai |
| `attendance.records.manage`, `attendance.resolution.read`, `attendance.resolution.manage`, `attendance.clarification.manage`, `attendance.overtime.manage`, `attendance.reports.read` | peran kerja HC | mengubah dan membaca catatan kehadiran orang |
| `attendance.devices.destructive`, `.biometrics`, `.firmware` | diberikan eksplisit, terpisah | AUTH-011; risiko tinggi |
| `payslips.import`, `payslips.publish` | peran kerja HC | menjalankan payroll |
| `payroll.profiles.manage`, `payroll.inputs.manage`, `payroll.calculate`, `payroll.submit`, `payroll.approve`, `payroll.reopen.approve`, `payroll.loans.manage`, `payroll.payments.confirm`, `payroll.reports.read.organization`, `payroll.transfers.read.organization` | peran kerja Keuangan | angka seorang pegawai, bukan bentuk perhitungannya |
| `documents.read`, `documents.manage`, `documents.discipline.manage`, `documents.correct` | peran kerja HC | dokumen seorang pegawai |
| `board.read` | `foundation_board_viewer` | ORG-010 |

### 4.4 Akibat pada `human_capital_admin`

Setelah AUTH-014, bundle itu menjadi **peran kerja HC saja**: permission di §4.2 dicabut darinya. Pencabutan adalah migration tersendiri di fase F6, **setelah** `hcis_module_admin` dibuat, diberikan, dan terbukti bekerja. Sampai F6 kedua role tumpang tindih; itu disengaja, karena tumpang tindih sementara tidak memutus siapa pun sedangkan pencabutan dini memutus.

---

## 5. Perubahan teknis di HCIS

| # | Perubahan | Berkas |
|---|---|---|
| 1 | Role `hcis_module_admin` + pemetaan permission §4.2 | migration baru (aditif) |
| 2 | Kolom audit **baru** `actor_source`, `hub_request_id` (+ unique index pada `hub_request_id` per aksi). `actor_account_id` sudah ada sejak 0004 | migration baru (aditif, nullable) |
| 3 | `MODULE_ADMIN_ROLE_KEY`, `MODULE_ADMIN_PERMISSIONS`, `IDENTITY_PERMISSIONS` | `apps/api/src/modules/auth/permissions.ts` |
| 4 | `hcis_module_admin` ditambahkan ke **`HCIS_ROLES`**; `IDENTITY_PERMISSIONS` dikeluarkan dari `HCIS_PERMISSIONS` dan ditolak di `canDelegateRole` (kedua jalur) | `apps/api/src/modules/auth/role-assignment.ts` |
| 5 | `assertRoleGrantor(actor, channel)`; `canDelegateRole(role, delegated, channel)`; pemeriksaan `hasEffectiveOrganizationPermission` dilewati untuk kedua channel (§2.5, §3.1); mandat untuk role baru | `apps/api/src/modules/auth/role-assignment.ts` |
| 6 | Verifikasi assertion aktor + resolusi issuer/subject | `apps/api/src/modules/auth/oidc-identity-mapping.ts`, `organization-directory/machine-auth.ts` |
| 7 | Pemeriksaan token client-credentials pada header `Authorization` | `organization-directory/machine-auth.ts` |
| 8 | Route internal §2.1, dengan `Cache-Control: no-store` dan penolakan replay | `apps/api/src/modules/auth/role-administration-routes.ts` (baru) |
| 9 | CLI `break-glass:set-status`, `break-glass:rotate-credential` (prasyarat F1) | `apps/api/src/modules/auth/cli/` |
| 10 | Env + validasi | `apps/api/src/config/env.ts` |
| 11 | Kontrak endpoint internal | `docs/api/openapi.yaml` |
| 12 | `/admin/access`: notis read-only + tautan "Kelola di SQ Hub", filter `actorSource` di layar audit | `apps/web` |
| 13 | Pencabutan permission §4.2 dari `human_capital_admin` | migration terpisah, fase F6 |
| 14 | Hapus form pemberian peran dan pengelolaan akun dari `/admin/access`; menu menjadi "Peran & Akses" baca saja; sapu penunjuk di `AdminEmployeeDetailPage` dan `AdminPage` (§8) | `apps/web` — fase F5b |
| 15 | Pengalihan `/admin/access` dan halaman penunjuk berbatas waktu untuk URL tanpa padanan (§8.4) | `apps/web/src/router.tsx` — fase F5b |
| 16 | Pita konteks, warna header berbeda, prefiks judul tab, penanda di mobile, pendaratan di akar ruang, konfirmasi form belum tersimpan (§9) | `apps/web/src/layouts/CoreShell.tsx`, `AdminShell.tsx`, `components/shell/SpaceSwitcher.tsx` |
| 17 | Penjaga route dievaluasi ulang saat kewenangan berubah; jatuh ke ruang pegawai atau akhiri sesi (§9.5) | `apps/web/src/lib/authorization.ts`, `router.tsx` |

Migration 1, 2, 13 dan perubahan 3–8 menyentuh otorisasi; setiap PR-nya wajib melewati satu putaran review independen sebelum merge.

### Keterbatasan yang diterima, bukan diselesaikan

`/internal/v1/*` dilayani listener yang sama dengan seluruh API, tanpa mTLS dan tanpa pembatasan sumber. Pola yang sudah ada begitu, dan AUTH-014 mewarisinya untuk endpoint yang memberi peran. Pembatasan sumber di tingkat jaringan Mi8VPS adalah pekerjaan tersendiri yang belum dijadwalkan; sampai itu ada, keamanan kanal bertumpu sepenuhnya pada dua token §2.2.

---

## 6. Rencana bertahap

Prinsipnya: **aditif lebih dulu, pencabutan paling akhir; setiap fase punya jalan mundur yang tidak bergantung pada fase berikutnya; tidak ada fase yang mencabut jalan masuk sebelum penggantinya terbukti bekerja.**

| Fase | Isi | Risiko akses | Jalan mundur |
|---|---|---|---|
| **F0** | ADR-0006 + AUTH-014 (dokumentasi; PR ini) | nihil | revert commit |
| **F1** | CLI break-glass (§5 baris 9). Akun break-glass ditautkan ke Akun SQ dan **diuji login**, lalu dikembalikan ke `inactive`. Prosedur masuk runbook Mi8VPS | nihil (menambah jalan masuk) | CLI tidak dipakai; akun tetap seperti sekarang |
| **F2** | Migration aditif: role `hcis_module_admin`, dua kolom audit, unique index. Belum ada pemegang role | nihil | `DROP COLUMN`; `DROP ROLE` **hanya setelah** memverifikasi `account_role_assignments` tidak punya baris untuk role itu (FK), jika ada maka role dibiarkan tanpa pemegang |
| **F3** | Kode: `assertRoleGrantor(actor, channel)`; break-glass lepas dari shim (§3.1); `IDENTITY_PERMISSIONS` ditolak di `canDelegateRole` untuk **kedua** jalur; jalur `sq_hub` ada tetapi route belum terdaftar | rendah — perilaku break-glass setara, sumber kewenangannya berubah | revert kode; database tidak berubah |
| **F4** | Prasyarat: token exchange tersedia di realm (§2.2) dan F1 lulus. Route internal didaftarkan dengan `HCIS_ROLE_ADMIN_ENABLED` **mati** | nihil (`503`) | saklar tetap mati |
| **F5** | Saklar dihidupkan. SQ Hub memberi satu peran uji ke satu akun uji, lalu mencabutnya. Diverifikasi: assignment benar; audit `actor_source = "sq_hub"` ada; self-grant ditolak; assertion palsu/kedaluwarsa ditolak; replay `requestId` ditolak; permission identitas ditolak | rendah; jalur lama utuh | matikan saklar; jalur break-glass tidak tersentuh |
| **F5a** | SQ Hub bisa memberi/mencabut peran HCIS **dan** mengelola akun (buat, nonaktifkan, reset kata sandi); diverifikasi owner dari ujung ke ujung | nihil (menambah kemampuan) | matikan saklar kanal |
| **F5b** | Baru setelah F5a tercatat lulus: hapus form pemberian peran dan pengelolaan akun dari HCIS beserta penunjuknya; menu menjadi "Peran & Akses" baca saja (§8) | rendah — API break-glass tetap hidup, hanya pintunya di UI yang hilang | revert perubahan frontend; tidak ada perubahan database |
| **F6** | Setelah F5 stabil (minimal dua minggu pemakaian nyata): berikan `hcis_module_admin` kepada pemegang yang dituju, **amati**, lalu migration pencabutan permission §4.2 dari `human_capital_admin` | sedang — satu-satunya fase yang mencabut | migration pembalik mengembalikan permission ke bundle |
| **F7** | Latihan break-glass penuh dengan shim dimatikan sementara (§3.1 butir 2). Akun SUPER_ADMIN dikembalikan ke `inactive` sebagai keadaan normal | rendah | aktifkan kembali lewat prosedur break-glass |

Pencabutan `hasLegacySuperAdminCompatibility` **bukan** bagian AUTH-014; syaratnya milik AUTH-011, ditambah syarat §3.1 butir 2, dan dikerjakan setelah F7.

### Yang tidak boleh terjadi di fase mana pun

- Tidak ada fase yang membuat `assertRoleGrantor` menolak SUPER_ADMIN. F7 pun tidak menolaknya — hanya menonaktifkan akunnya.
- Tidak ada fase yang mencabut permission dari role yang sedang dipakai sebelum penggantinya diberikan dan diamati.
- Tidak ada fase yang mengubah `principal_type`, `identity_issuer`, `identity_subject`, kredensial, atau sesi akun mana pun.
- Kanal tidak dihidupkan tanpa assertion aktor. Tidak ada mode "sementara pakai klaim polos".
- Tidak ada jeda di mana sebuah kewenangan tidak tersedia di kedua tempat. Layar HCIS dihapus hanya setelah penggantinya di SQ Hub terbukti dipakai (F5a sebelum F5b).
- F5 tidak dijalankan pada hari yang sama dengan rilis payroll atau penutupan periode kehadiran.

### Verifikasi tiap fase

Typecheck, lint, test API dan frontend, build. Test positif/negatif wajib: aktor tidak terselesaikan; assertion hilang, kedaluwarsa, audience salah, tanda tangan salah; token mesin berisi klaim pengguna; client di luar allowlist; scope hilang; `requestId` diputar ulang; self-grant; permission identitas lewat **kedua** jalur; role di luar `HCIS_ROLES`; scope dan tanggal tidak sah; target bukan `EMPLOYEE`; kanal mati. Gate yang tidak dapat dijalankan dilaporkan apa adanya, tidak diklaim lulus (AGENTS.md §7).

---

## 7. Kebutuhan di SQ Hub dan Keycloak

Ditulis sebagai kebutuhan, bukan perubahan. Repository SQ Hub tidak disentuh dari sini.

### 7.1 Keycloak

| # | Kebutuhan | Catatan |
|---|---|---|
| K-1 | Tambahkan `manage-users` **hanya** pada `sq-hub-identity-management` | bukan pada akun mesin lain; ADR-0006 R-1 butir 1 |
| K-2 | Buat akun mesin **terpisah** `sq-hub-role-administration` dengan client scope `role-administration.manage`, audience HCIS, dan **tanpa** `manage-users` | satu secret bocor tidak membuka keduanya |
| K-3 | Jangan pernah berikan `impersonation`, `manage-clients`, `manage-realm`, `manage-identity-providers`, `realm-admin` ke akun mesin mana pun | ADR-0006 D-2 |
| K-4 | Aktifkan token exchange untuk `sq-hub-role-administration`, terbatas pada audience HCIS | prasyarat §2.2 dan gate F4 |
| K-5 | Jadwalkan rotasi secret seluruh akun mesin | ADR-0006 R-1 butir 2 |
| K-6 | Pastikan `sub` manusia yang masuk SQ Hub sama dengan `identity_subject` di HCIS | tanpa ini kanal gagal-tertutup di §2.4 langkah 4 |

### 7.2 SQ Hub

| # | Kebutuhan | Catatan |
|---|---|---|
| H-1 | Layar pemberian peran per aplikasi di `/admin/access`, memakai `GET /internal/v1/role-administration/catalog` sebagai sumber daftar peran | jangan menyalin daftar peran HCIS ke kode Hub |
| H-2 | Sertakan assertion aktor hasil token exchange pada setiap panggilan, dan `requestId` unik | tanpa assertion HCIS menolak |
| H-3 | Periksa keanggotaan `platform_administrators` sebelum memanggil HCIS | HCIS tidak memverifikasi kewenangan (§2.5); pemeriksaan ini **bukan** lapis tambahan, melainkan satu-satunya pemeriksaan kewenangan yang ada |
| H-4 | Larang penghapusan pengguna Keycloak di tingkat aplikasi; sediakan hanya buat, nonaktifkan, reset kata sandi | ADR-0006 R-3 |
| H-5 | Catat setiap pemberian peran di audit Hub dengan `requestId` yang sama | ADR-0006 R-1 butir 5 |
| H-6 | Rate limit dan review keamanan tersendiri untuk `/admin/access` | prasyarat yang muncul karena pemusatan ini |
| H-7 | Tampilkan peringatan bila HCIS menolak dengan `ROLE_ADMIN_ACTOR_UNRESOLVED` | menandakan K-6 belum beres, bukan kesalahan operator |
| H-8 | Tangani `503 ROLE_ADMIN_CHANNEL_DISABLED` sebagai keadaan normal selama F4 | jangan tampilkan sebagai kerusakan |
| **H-9** | **Penambahan baris `platform_administrators` membutuhkan dua Admin Platform berbeda (empat mata), dan tidak seorang pun boleh menambahkan dirinya sendiri** | tanpa ini, satu Admin Platform membuat Admin Platform kedua lalu memakainya untuk memberi dirinya apa pun — larangan self-grant di HCIS tidak menyentuh lubang ini. ADR-0006 R-6 |
| **H-10** | **Reset kata sandi dilarang di SQ Hub untuk akun yang merupakan Admin Platform atau memegang peran istimewa modul; akun seperti itu hanya lewat konsol Keycloak** | reset kata sandi adalah impersonation dengan satu baris log; tanpa batas ini `manage-users` memberi satu Admin Platform jalan menjadi Admin Platform lain. ADR-0006 R-6 |
| **H-11** | **Daftar Admin Platform dan setiap perubahannya dipublikasikan ke layar audit yang dapat dibaca owner tanpa akses database** | lingkaran eskalasi yang tersisa berada di luar HCIS, jadi deteksinya juga harus di luar HCIS |
| **H-12** | **Layar Admin Platform membawa penanda konteks sendiri yang setara dengan §9.2** | tanpa itu kebingungan "sedang jadi admin atau pegawai" hanya berpindah dari HCIS ke SQ Hub |

---

## 8. Layar HCIS yang ikut pindah

**Keputusan owner 2026-10-27:** begitu sebuah kewenangan tidak lagi berada di HCIS, layar dan menunya di HCIS **dihapus**, bukan dibiarkan menganggur atau sekadar dikunci izin. Tidak boleh ada halaman yang masih ada tetapi selalu menolak.

Hari ini satu menu, **"Account & Akses"** (`/admin/access`), memuat empat hal yang di bawah AUTH-014 jatuh ke dua lapis berbeda.

### 8.1 Apa yang hilang, apa yang tinggal

| Isi `/admin/access` hari ini | Nasibnya | Alasan |
|---|---|---|
| Form "Tambah role tambahan" dan tombol "Cabut" per assignment | **dihapus dari HCIS** | pemberian peran pindah ke Admin Platform |
| "Account Organ Yayasan": pembuatan undangan aktivasi, status akun, reaktivasi sementara (EMP-005) | **dihapus dari HCIS** | akun orang adalah lapis Admin Platform |
| Tombol ubah status akun per pegawai | **dihapus dari HCIS** | sama |
| Daftar pemegang peran (siapa memegang apa, sejak kapan, mandatnya) | **tinggal, baca saja** | HC perlu tahu ke siapa pekerjaan dialirkan; ini membaca, bukan memberi |
| Katalog "Role system" (definisi peran HCIS dan permission-nya) | **tinggal, baca saja** | definisi peran adalah milik HCIS; SQ Hub justru membacanya lewat `GET /catalog` (§2.1) |
| Tautan peran–jabatan dan peringatan ketidakcocokan Kepala HC (ORG-008-9) | **tinggal, pindah kewenangan ke Admin Modul** | menautkan peran ke kursi adalah data acuan; ia tidak memberi peran, hanya memunculkan peringatan |

Hasilnya: menu "Account & Akses" **diganti** menjadi **"Peran & Akses"** yang seluruhnya baca saja, kecuali tautan peran–jabatan. Permission penjaganya berubah dari `access.manage` menjadi permission baca; `access.manage` tidak lagi menjaga layar HCIS mana pun.

Di halaman itu, satu-satunya jalan ke tindakan adalah tautan keluar ke SQ Hub: "Pemberian peran dan pengelolaan akun ada di SQ Hub" dengan tautan langsung ke layar Admin Platform. Bukan tombol yang menolak, bukan form yang disembunyikan.

### 8.2 Titik lain yang menunjuk ke layar lama

`AdminEmployeeDetailPage` memuat tautan ke `/admin/access`, dan `AdminPage` (ringkasan) memuat kartu "Account & Akses" yang hanya tampil bila akun punya `access.manage`. Keduanya ikut berubah pada rilis yang sama: tautan menjadi tautan ke SQ Hub, kartu ringkasan menjadi kartu baca saja atau hilang bila akun tidak memegang permission baca. Menghapus halaman tanpa menyapu penunjuknya meninggalkan tautan mati, yang sama buruknya dengan halaman yang menolak.

### 8.3 Urutan: SQ Hub dulu, baru HCIS dihapus

Aturan kerasnya: **tidak boleh ada jeda di mana kewenangannya tidak ada di kedua tempat.**

Urutannya menjadi bagian §6 sebagai dua fase baru:

| Fase | Isi | Prasyarat |
|---|---|---|
| **F5a** | SQ Hub sudah bisa memberi dan mencabut peran HCIS, dan sudah bisa mengelola akun (buat, nonaktifkan, reset kata sandi). Diverifikasi owner dengan satu pemberian nyata dari ujung ke ujung | F5 lulus; K-1, K-2, K-4 selesai |
| **F5b** | Baru setelah F5a: HCIS menghapus form pemberian peran, pengelolaan akun, dan penunjuknya (§8.1, §8.2). Menu berganti nama menjadi "Peran & Akses" | **F5a lulus dan tercatat**, bukan sekadar "SQ Hub sudah dirilis" |

F5b adalah penghapusan layar, bukan penghapusan API. Route API lama (`POST /admin/access/accounts/:id/role-assignments` dan kawan-kawan) tetap hidup untuk jalur break-glass sampai F7, karena itulah jalan cadangan ketika SQ Hub mati. Yang hilang adalah pintunya di UI pegawai biasa, bukan kemampuan sistemnya.

### 8.4 Deep link ke layar yang sudah dihapus

Orang menyimpan URL dan mengirimnya lewat pesan. Tiga perlakuan, dan yang di tengah sengaja dibatasi waktunya:

1. `/admin/access` → **dialihkan** ke "Peran & Akses" yang baru. Bukan 404, bukan halaman menolak.
2. URL yang tidak punya padanan sama sekali (misalnya layar undangan aktivasi) → **satu halaman penunjuk** berisi satu kalimat dan satu tautan ke SQ Hub, hidup **maksimal satu siklus rilis**, lalu route-nya dihapus seluruhnya.
3. Setelah masa itu → 404 biasa, sama seperti URL yang tidak pernah ada.

Halaman penunjuk di nomor 2 adalah satu-satunya pengecualian terhadap "jangan tinggalkan halaman menganggur", dan ia bukan halaman yang menolak: ia tidak pernah mencoba memuat data dan tidak pernah mengembalikan 403. Tanggal matinya ditulis di komentar route, bukan diserahkan pada ingatan.

---

## 9. Ruang admin dan ruang pegawai tidak boleh tercampur

**Keputusan owner 2026-10-27:** akun yang sedang bertindak sebagai admin tidak boleh sekaligus menampilkan ruang pegawai, supaya tidak pernah ambigu sedang berada di mana.

Masalahnya nyata dan akan bertambah, bukan berkurang: setelah AUTH-014 orang yang sama bisa menjadi pegawai, Admin Modul HCIS, dan Admin Platform SQ Hub sekaligus. Solusinya **bukan** melarang satu orang memegang ketiganya — itu justru mengembalikan masalah berganti akun yang AUTH-014 ada untuk menyelesaikannya. Solusinya adalah membuat konteks yang sedang dipakai tidak pernah ambigu.

### 9.1 Satu konteks aktif, tidak pernah dua

| Aturan | Isinya |
|---|---|
| **Satu konteks per tab** | sebuah tab berada di ruang pegawai **atau** ruang administrasi, tidak pernah keduanya |
| **Ruang admin bersih dari ruang pegawai** | tidak ada kartu self-service, tidak ada "cuti saya", tidak ada slip gaji pribadi, tidak ada notifikasi pribadi di ruang admin. `AdminShell` tidak merender elemen ruang pegawai sama sekali |
| **Ruang pegawai bersih dari administrasi** | tidak ada pintasan tindakan administratif di ruang pegawai; satu-satunya jalan masuk adalah pemindah ruang |
| **Akun tanpa data pegawai** | akun break-glass tidak punya ruang pegawai; pemindah ruang tidak muncul untuknya |

`CoreShell` sudah memisahkan `space`, dan `SpaceSwitcher` sudah menjadi satu-satunya pintu. Yang kurang adalah penandanya cukup halus sehingga owner tetap bisa bingung: satu segmen tab aktif di header, tanpa perbedaan lain.

### 9.2 Penanda konteks yang tidak bisa dilewatkan

1. **Pita konteks yang selalu terlihat** di ruang administrasi, melekat di atas header, tidak ikut menggulung, berbunyi: **"Mode Administrasi HCIS — <nama peran yang sedang dipakai>"**. Di ruang pegawai tidak ada pita; ketiadaannya adalah penandanya.
2. **Warna header berbeda** antara kedua ruang, cukup kontras untuk dikenali dari sudut mata, dan tetap memenuhi kontras WCAG AA.
3. **Judul tab browser diawali `[Admin]`** di ruang administrasi, supaya tab yang berjejer pun terbaca.
4. **Penanda yang sama hadir di mobile.** Pita tidak boleh dikorbankan di layar sempit; justru di sanalah sidebar tidak terlihat dan konteks paling mudah hilang.

Nama peran di pita penting: "Mode Administrasi HCIS — Admin Modul" berbeda dari "— Human Capital", dan itu menjawab pertanyaan kedua yang akan segera muncul, yaitu *admin yang mana*.

### 9.3 Perpindahan harus disengaja

- Pemindah ruang tetap ada (orang yang sama memang boleh punya dua-duanya) tetapi perpindahan **selalu mendarat di akar ruang tujuan** (`/app` atau `/admin`), tidak pernah mempertahankan halaman yang sedang dibuka. Mendarat di tempat yang sama dengan tampilan berbeda persis adalah sumber kebingungan yang dikeluhkan.
- Bila ada formulir yang belum tersimpan, perpindahan **meminta konfirmasi** lebih dulu.
- Perpindahan tidak membuat sesi baru dan tidak meminta login ulang. Ini perpindahan tampilan, bukan perpindahan identitas — justru itu intinya.

### 9.4 Deep link

| Keadaan | Perilaku |
|---|---|
| Membuka URL `/admin/...` sementara tab berada di ruang pegawai | konteks berpindah ke administrasi, halaman yang diminta dibuka, pita konteks muncul, dan satu toast "Mode Administrasi aktif" ditampilkan sekali. Tanpa layar antara — gesekan tambahan di setiap tautan akan dimatikan orang, sedangkan pita tetap terlihat selamanya |
| Membuka URL `/admin/...` tanpa kewenangan untuk halaman itu | tidak ada halaman administrasi yang terbuka sebagian. Dialihkan ke ruang pegawai dengan satu pesan yang menyebut halaman mana yang ditolak |
| Membuka URL `/admin/...` oleh akun tanpa kewenangan administrasi apa pun | sama seperti di atas; menu administrasi memang tidak pernah muncul untuknya |
| Membuka URL ruang pegawai oleh akun break-glass tanpa data pegawai | dialihkan ke `/admin` dengan pesan bahwa akun ini tidak punya ruang pegawai |

### 9.5 Sesi yang sedang berjalan saat kewenangannya berubah

Admin Platform dapat mencabut peran seseorang saat orang itu sedang membuka ruang administrasi. Yang terjadi:

1. Penjaga route dievaluasi ulang pada navigasi berikutnya dan pada pemuatan ulang konteks otorisasi; halaman yang tidak lagi diizinkan **tidak dibuka**.
2. Bila akun kehilangan seluruh kewenangan administrasi, konteks jatuh ke ruang pegawai dengan satu pesan yang jelas — bukan layar kosong dan bukan menu yang masih tampil tetapi setiap kliknya 403.
3. Bila akun itu juga tidak punya data pegawai aktif (kasus break-glass), sesi diakhiri.
4. Tidak ada menu administrasi yang bertahan di layar setelah kewenangannya hilang. Menu yang tersisa setelah izinnya dicabut adalah bentuk lain dari "halaman menganggur" yang §8 larang.

Pencabutan tidak memutus sesi yang sedang berjalan secara paksa di tengah pekerjaan; perubahan terasa pada navigasi berikutnya. Itu pilihan sadar: pemutusan seketika di tengah pengisian formulir menghilangkan pekerjaan orang, sedangkan API tetap menolak setiap tindakan yang sudah tidak diizinkan, jadi tidak ada kewenangan nyata yang bocor dalam jeda itu.

### 9.6 Catatan untuk SQ Hub

Kebutuhan yang sama berlaku di sana dan ditambahkan ke §7.2 sebagai **H-12**: layar Admin Platform di SQ Hub harus membawa penanda konteks sendiri yang setara, supaya "sedang jadi Admin Platform" tidak tertukar dengan "sedang jadi pegawai yang membuka SQ Hub". Tanpa itu, kebingungan yang dihapus dari HCIS hanya berpindah tempat.

---

## 10. Asumsi yang belum diverifikasi

| Tanda | Asumsi |
|---|---|
| `DRAFT` | Admin Modul HCIS dipegang satu orang pada awalnya; batas kebijakan jumlah pemegang belum ditetapkan |
| `DRAFT` | Jeda pengamatan F5→F6 dua minggu adalah angka yang masuk akal, bukan dari dokumen mana pun |
| `DRAFT` | Umur maksimum assertion aktor 120 detik; dipilih sebagai angka wajar untuk satu klik di layar Hub |
| `DRAFT` | `payroll.profiles.manage` dan `payroll.inputs.manage` ditempatkan di peran kerja Keuangan (§4.3). Bila PAY-003 memutuskan lain, §4.2 menyesuaikan |
| `TBD` | Permission tersendiri untuk template dokumen belum ada; bila dibuat, ia masuk Admin Modul |
| `TBD` | Apakah realm `sq-staff` sudah mendukung token exchange. Bila tidak, F4 tertahan sampai K-4 selesai |
| `DRAFT` | Daftar pemegang peran tetap ada di HCIS sebagai tampilan baca saja karena HC diperkirakan membutuhkannya untuk mengalirkan pekerjaan. Bila ternyata tidak dipakai, halaman itu ikut dihapus dan HC membacanya di SQ Hub |
| `DRAFT` | Masa hidup halaman penunjuk deep link (§8.4) ditetapkan satu siklus rilis |
| `TBD` | Apakah aplikasi SQ Core lain (Aset SQ, SPMB, Karir SQ) memakai kanal berbentuk sama. Rancangan §2 sengaja tidak memuat apa pun yang khas HCIS selain katalog perannya |
