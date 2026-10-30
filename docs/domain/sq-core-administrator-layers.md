# AUTH-014 — Tiga lapis administrator: sisi HCIS

**Status:** ACCEPTED product decision (owner, 2026-10-27). Implementasi berjalan sejak 2026-10-30: F1, F2, dan F3 selesai. Revisi 6.
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

### 2.9 Kanal administrasi akun, bukan hanya peran

Review kedua menemukan lubang yang akan membuat orang baru tidak bisa bekerja sama sekali: **membuat Akun SQ di Keycloak bukan membuat akun HCIS.** Baris `accounts` di HCIS hari ini hanya lahir dari tiga tempat — `POST /admin/access/employee-accounts`, `POST /admin/access/board-accounts`, dan CLI bootstrap. Tidak ada penyediaan otomatis saat login OIDC: `oidc-identity-mapping.ts` hanya **memperbarui** `identity_issuer`/`identity_subject` pada akun yang sudah ada.

Jadi bila §8 menghapus layar pembuatan akun sementara kanal hanya melayani peran, pegawai baru akan punya Akun SQ, masuk ke HCIS, dan tidak mendapat apa pun. Itu persis jeda yang F5a/F5b ada untuk mencegahnya.

Kanal §2 karena itu diperluas, dengan otentikasi, resolusi aktor, anti-replay, dan audit yang sama persis:

```
POST  /internal/v1/account-administration/accounts          # buat akun HCIS untuk pegawai yang sudah ada
POST  /internal/v1/account-administration/accounts/:id/activation   # terbitkan undangan aktivasi
PATCH /internal/v1/account-administration/accounts/:id/status       # aktif / nonaktif
```

Batasnya sama ketatnya dengan kanal peran: target wajib pegawai yang sudah ada dan aktif di HCIS (akun tidak menciptakan orang), aktor tidak boleh menjadi targetnya sendiri, akun `FOUNDATION_BOARD` tetap menuntut jalur governance yang terpisah, dan akun `SUPER_ADMIN` **tidak pernah** menjadi target kanal ini — ia hanya tersentuh CLI break-glass (§3.2).

Scope mesinnya terpisah dari kanal peran: `account-administration.manage`. Satu kebocoran tidak membuka keduanya, sejalan dengan ADR-0006 R-1 butir 1.

### 2.10 Dua hal yang tetap ditulis HCIS sendiri ke akun

Pemisahan "akun orang milik Admin Platform" tidak berlaku mutlak, dan menutupinya akan membuat dua sistem menulis status akun tanpa ada yang tahu. Dua penulis otomatis di HCIS **tetap ada** dan disebut di sini supaya tidak mengejutkan:

| Penulis | Kapan | Alasan tetap di HCIS |
|---|---|---|
| `deactivateAccountsForEndedEmployment` | saat employment berakhir | konsekuensi data kepegawaian, bukan keputusan administrator; menundanya berarti akun orang yang sudah berhenti tetap hidup sampai ada yang ingat |
| `expireTemporaryReactivations` | tugas malam | membatalkan reaktivasi yang masa berlakunya habis (EMP-005) |

Keduanya menonaktifkan, tidak pernah mengaktifkan, sehingga arah kesalahannya selalu tertutup. Yang tetap menjadi kebutuhan SQ Hub: menampilkan status akun HCIS apa adanya dan tidak menganggap dirinya satu-satunya penulis (§7.2 H-13).

---

## 3. Nasib `principal_type = 'SUPER_ADMIN'`

Tidak ada kolom yang dihapus, tidak ada akun yang dihapus, tidak ada `principal_type` yang diubah. Yang berubah adalah artinya.

| Hal | Sekarang | Setelah AUTH-014 |
|---|---|---|
| `principalType === "SUPER_ADMIN"` di `assertRoleGrantor` | satu-satunya jalan memberi peran | salah satu dari dua jalan, dan yang kedua |
| Akun `admin@hcis.sabilulquran.or.id` | aktif, dipakai harian | `status = 'inactive'`, dihidupkan hanya untuk break-glass |
| Kewenangan grantor break-glass | berasal dari `hasLegacySuperAdminCompatibility` | berasal dari `assertRoleGrantor(actor, "break_glass")`, **lepas dari shim** |
| Form pemberian peran di `/admin/access` HCIS | tampil untuk SUPER_ADMIN | **tidak ada lagi di UI** sejak F5b (§8.1), termasuk untuk SUPER_ADMIN. Break-glass memakai API langsung, yang tetap hidup sampai F7 |

### 3.1 Break-glass tidak boleh bergantung pada shim yang dijadwalkan dihapus

Hari ini SUPER_ADMIN lolos `requireDelegation` **hanya** karena `hasEffectiveOrganizationPermission` memintas lewat `hasLegacySuperAdminCompatibility`; untuk principal non-`EMPLOYEE` tidak ada jalur lain. Jadi penghapusan shim itu — yang AUTH-011 memang jadwalkan — diam-diam mematikan satu-satunya jalan cadangan, dan tidak ada yang tahu sampai hari SQ Hub mati.

Aturannya:

1. Di fase F3, kewenangan grantor break-glass dipindahkan ke `assertRoleGrantor(actor, "break_glass")` dan pemeriksaan `hasEffectiveOrganizationPermission` di `requireDelegation` dilewati untuk jalur itu, persis seperti jalur `sq_hub`. Setelah F3, break-glass tidak lagi membutuhkan shim untuk memberi peran.
2. Memindahkan pemeriksaan grantor saja **tidak cukup**, dan review kedua benar menunjuknya: seluruh kaki lain dari pekerjaan break-glass masih menumpang shim yang sama. `GET /admin/access` — satu-satunya cara mengetahui `accountId` dan `roleId` — menuntut `access.manage`; seluruh route akun menuntut `access.manage` atau `access.governance.manage`; dan `resolveAuthorizationContext` mengembalikan daftar kosong untuk principal non-`EMPLOYEE` tanpa shim. Memindahkan satu lapis lalu menghapus shim hanya memindahkan kegagalan senyapnya satu tingkat ke bawah.

   Maka F3 memindahkan **seluruh** kewenangan break-glass ke jalur channel, bukan hanya pemberian peran: pembacaan katalog dan daftar, serta route akun yang dibutuhkan prosedur §3.2, semuanya menerima `channel === "break_glass"` sebagai sumber kewenangan.
3. `hasLegacySuperAdminCompatibility` **tidak boleh dihapus sebelum** satu latihan break-glass **penuh** — membaca daftar, memberi peran, mencabutnya, dan mengelola satu akun — berhasil dijalankan dengan shim dimatikan sementara. Latihan yang hanya menguji pemberian peran tidak memenuhi syarat ini. Pencabutan shim tetap bukan bagian AUTH-014 — dikerjakan **setelah F7**.

### 3.2 Prosedur break-glass, beserta alat yang belum ada

1. Operator mencatat alasan di runbook Mi8VPS sebelum bertindak.
2. Akun break-glass diaktifkan lewat perintah CLI tercatat.
3. Pekerjaan dikerjakan; setiap aksi menghasilkan audit `actor_source = "hcis_break_glass"`.
4. Akun dikembalikan ke `inactive` segera setelah selesai.
5. Kredensial break-glass dirotasi setelah setiap pemakaian.

Langkah 2 dan 5 tadinya **tidak punya alat sama sekali**: `bootstrap-super-admin.ts` menolak bekerja bila SUPER_ADMIN sudah ada, `assertAccountManagementTarget` melarang SUPER_ADMIN menjadi target pengelolaan akun lewat API, dan tidak ada perintah pengubah status maupun pemutar kredensial. Satu-satunya jalan adalah SQL manual di Mi8VPS — dan itulah yang membuat akun ini pernah tidak terpakai sama sekali.

**Selesai di F1 (2026-10-30):** satu perintah `auth:break-glass` dengan dua mode, keduanya pratinjau-dulu dan hanya bekerja pada `principal_type = 'SUPER_ADMIN'`:

- `--set-status <active|inactive>` — satu-satunya pengubah status akun break-glass; mencabut sesi hidup saat menonaktifkan;
- `--rotate-credential` — memutar kata sandi, TOTP, dan recovery code **bersama-sama**, lalu mencabut sesi hidup.

Keduanya menuntut `HCIS_ALLOW_BREAK_GLASS=1`, menolak menebak bila ada lebih dari satu akun `SUPER_ADMIN`, mewajibkan `--reason`, dan menulis audit (`auth.break_glass.status_changed`, `auth.break_glass.credential_rotated`). Prosedurnya di `docs/operations/auth-014-break-glass.md`.

Auditnya ditulis ke `auth_audit_events`, bukan `access_audit_events`, karena kolom `actor_source` baru lahir di F2 dan F1 tidak boleh bergantung pada fase sesudahnya. Pemberian peran lewat break-glass tetap mendapat `actor_source = "hcis_break_glass"` begitu F2 dan F3 terpasang.

#### Koreksi urutan: akun break-glass tetap aktif sampai F5a

Rancangan menulis F1 diakhiri dengan mengembalikan akun ke `inactive`. Kenyataannya akun itu **sedang dipakai setiap hari** untuk memberi peran, karena SQ Hub belum bisa. Menonaktifkannya sekarang berarti tidak ada seorang pun yang dapat memberi peran di HCIS — persis kegagalan yang seluruh rencana ini susun untuk dihindari.

Jadi: akun break-glass **tetap aktif** sampai F5a lulus. `inactive` sebagai keadaan normal tetap F7, seperti tertulis di §6. Yang F1 wajibkan adalah akun itu **tertaut ke Akun SQ dan terbukti bisa login** — dan itu sudah terpenuhi lewat pemulihan manual 2026-10-30 (user Keycloak `sysadmin`, ditautkan dengan `auth:map-oidc-identity`).

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
| Tautan peran–jabatan (ORG-008-9) | `organization.role_seat_links.manage` (**baru**) |

Dua permission baru lahir bersama AUTH-014, keduanya karena layar yang bertahan di HCIS harus punya penjaga yang benar:

- **`organization.role_seat_links.manage`** menggantikan `assertRoleGrantor` sebagai penjaga `PUT /admin/access/role-seat-links/:roleKey`. Hari ini route itu Super Admin saja, dengan alasan "menetapkan kursi yang diikuti sebuah peran adalah bagian dari memberi peran itu". Alasan itu gugur di bawah AUTH-014: tautan ini tidak memberi peran, ia hanya memunculkan peringatan ketidakcocokan. Dibiarkan apa adanya, satu-satunya kendali yang tersisa di halaman "baca saja" hanya bisa dipakai dengan menghidupkan akun break-glass. Namanya sengaja di namespace `organization.`, bukan `access.roles.`, supaya tidak pernah tertukar dengan permission identitas §2.6.
- **`access.read`** menjaga `GET /admin/access` dan `GET /admin/access/role-seat-checks`. Tanpa permission baca tersendiri, klaim "`access.manage` tidak lagi menjaga layar HCIS mana pun" tidak bisa benar: kedua endpoint itu menuntut `access.manage` hari ini, dan melepas penjaga di frontend saja hanya menghasilkan halaman yang 403 setiap kali dimuat. `access.read` dipegang `hcis_module_admin` dan peran kerja HC, dan `canAccessAdminPath` memakainya menggantikan `access.manage`.

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
| 17 | Penjaga route membedakan "ditolak", "sudah pindah", dan "tidak ada"; jatuh ke ruang pegawai atau akhiri sesi (§9.4, §9.5) | `apps/web/src/lib/authorization.ts`, `router.tsx` |
| 18 | Kanal administrasi akun §2.9 dan scope mesinnya | `role-administration-routes.ts` atau modul sejenis, `config/env.ts` |
| 19 | Permission baru `access.read` dan `organization.role_seat_links.manage`; penjaga `GET /admin/access`, `GET /admin/access/role-seat-checks`, dan `PUT /admin/access/role-seat-links/:roleKey` disesuaikan | migration aditif, `permissions.ts`, `employees/admin-org-access-routes.ts` |
| 20 | `GET /admin/access` tidak lagi menyaring katalog role dengan `canDelegateRole` untuk pembaca; pembaca `access.read` melihat seluruh katalog dan seluruh pemegang peran | `employees/admin-org-access-routes.ts` |
| 21 | Endpoint baca `access_audit_events` + layar audit akses HCIS dengan filter `actor_source` (§8.2.1) — prasyarat F5b | API baru, `apps/web` |
| 22 | `/auth/me` dan login lokal mengembalikan nama peran organisasi efektif, untuk pita konteks (§9.2) | `auth/service.ts`, `auth/permissions.ts`, `apps/web/src/types/hcis.ts` |
| 23 | Hapus lonceng notifikasi pribadi dari ruang administrasi (§9.1) | `AdminShell.tsx`, `CoreShell.tsx` |
| 24 | Seluruh kewenangan break-glass lepas dari shim, bukan hanya pemberian peran (§3.1 butir 2) | `auth/permissions.ts`, `employees/admin-org-access-routes.ts` |

Migration 1, 2, 13 dan perubahan 3–8 menyentuh otorisasi; setiap PR-nya wajib melewati satu putaran review independen sebelum merge.

### Keterbatasan yang diterima, bukan diselesaikan

`/internal/v1/*` dilayani listener yang sama dengan seluruh API, tanpa mTLS dan tanpa pembatasan sumber. Pola yang sudah ada begitu, dan AUTH-014 mewarisinya untuk endpoint yang memberi peran. Pembatasan sumber di tingkat jaringan Mi8VPS adalah pekerjaan tersendiri yang belum dijadwalkan; sampai itu ada, keamanan kanal bertumpu sepenuhnya pada dua token §2.2.

---

## 6. Rencana bertahap

Prinsipnya: **aditif lebih dulu, pencabutan paling akhir; setiap fase punya jalan mundur yang tidak bergantung pada fase berikutnya; tidak ada fase yang mencabut jalan masuk sebelum penggantinya terbukti bekerja.**

| Fase | Isi | Risiko akses | Jalan mundur |
|---|---|---|---|
| **F0** | ADR-0006 + AUTH-014 (dokumentasi; PR ini) | nihil | revert commit |
| **F1** ✅ 2026-10-30 | CLI break-glass (§5 baris 9) dan runbook-nya. Akun break-glass tertaut ke Akun SQ dan **terbukti bisa login**. Akun **tetap aktif** sampai F5a (§3.2) | nihil (menambah alat, tidak mengubah perilaku) | CLI tidak dipakai; akun tetap seperti sekarang |
| **F2** ✅ 2026-10-30 | Migration aditif `0110`: role `hcis_module_admin` dengan 12 permission konfigurasi, kolom `actor_source` dan `hub_request_id`, unique index anti-replay. Belum ada pemegang role; `human_capital_admin` belum kehilangan apa pun | nihil | `DROP COLUMN`; `DROP ROLE` **hanya setelah** memverifikasi `account_role_assignments` tidak punya baris untuk role itu (FK), jika ada maka role dibiarkan tanpa pemegang |
| **F3** ✅ 2026-10-30 | Kode: `assertRoleGrantor(actor, channel)`; kewenangan break-glass lepas dari shim; `IDENTITY_PERMISSIONS` ditolak di `canDelegateRole` dan dikeluarkan dari `HCIS_PERMISSIONS`, berlaku **kedua** jalur; `hcis_module_admin` masuk `HCIS_ROLES` dengan mandat wajib; audit menulis `actor_source` dan `hub_request_id`; jalur `sq_hub` ada tetapi route belum terdaftar | rendah — perilaku break-glass setara, sumber kewenangannya berubah | revert kode; database tidak berubah |
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
| **H-13** | **SQ Hub memakai kanal §2.9 untuk akun HCIS, dan menampilkan status akun HCIS apa adanya tanpa menganggap dirinya satu-satunya penulis** | membuat pengguna Keycloak tidak membuat akun HCIS; dan HCIS tetap menonaktifkan akun sendiri saat employment berakhir serta saat reaktivasi sementara habis (§2.10) |

---

## 8. Layar HCIS yang ikut pindah

**Keputusan owner 2026-10-27:** begitu sebuah kewenangan tidak lagi berada di HCIS, layar dan menunya di HCIS **dihapus**, bukan dibiarkan menganggur atau sekadar dikunci izin. Tidak boleh ada halaman yang masih ada tetapi selalu menolak.

Hari ini satu menu, **"Account & Akses"** (`/admin/access`, judul halamannya sendiri "Account, Role & Scope"), memuat hal-hal yang di bawah AUTH-014 jatuh ke tiga tempat berbeda — dan **bukan** hanya di situ. Inventarisnya harus lengkap sebelum satu baris pun dihapus, karena yang terlewat akan menjadi tombol yang menolak selamanya.

### 8.1 Apa yang hilang, apa yang tinggal

| Isi `/admin/access` hari ini | Nasibnya | Alasan |
|---|---|---|
| Form "Tambah role tambahan" dan tombol "Cabut" per assignment | **dihapus dari HCIS** | pemberian peran pindah ke Admin Platform |
| "Account Organ Yayasan": undangan aktivasi dan status akun organ yayasan | **dihapus dari HCIS** | akun orang adalah lapis Admin Platform; penggantinya kanal §2.9 |
| Tombol ubah status akun per pegawai | **dihapus dari HCIS** | sama |
| Kartu ringkasan "Pegawai aktif tanpa account" dan kotak salin tautan aktivasi | **dihapus dari HCIS** | keduanya adalah ajakan menyediakan akun; tanpa layar penyedianya mereka menunjuk ke tempat yang sudah tidak ada |
| **Reaktivasi sementara (EMP-005)** | **tinggal, tetap bisa diubah oleh HC** | lihat §8.1.1 — ini koreksi terhadap rancangan sebelumnya |
| Daftar pemegang peran (siapa memegang apa, sejak kapan, mandatnya) | **tinggal, baca saja** | HC perlu tahu ke siapa pekerjaan dialirkan; ini membaca, bukan memberi |
| Katalog "Role system" (definisi peran HCIS dan permission-nya) | **tinggal, baca saja** | definisi peran milik HCIS; SQ Hub justru membacanya lewat `GET /catalog` (§2.1). Lihat catatan penyaringan di bawah |
| Tautan peran–jabatan dan peringatan ketidakcocokan Kepala HC (ORG-008-9) | **tinggal, dapat diubah Admin Modul** | menautkan peran ke kursi adalah data acuan; penjaganya menjadi `organization.role_seat_links.manage` (§4.2) |

Hasilnya: menu "Account & Akses" **diganti** menjadi **"Peran & Akses"**, baca saja kecuali tautan peran–jabatan. Penjaganya menjadi `access.read` (§4.2), dan `access.manage` tidak lagi menjaga layar HCIS mana pun — klaim itu baru benar setelah `access.read` ada, bukan sebelumnya.

Di halaman itu, satu-satunya jalan ke tindakan yang sudah pindah adalah tautan keluar ke SQ Hub: "Pemberian peran dan pengelolaan akun ada di SQ Hub", dengan tautan langsung ke layar Admin Platform. Bukan tombol yang menolak, bukan form yang disembunyikan.

Satu jebakan pada dua baris "baca saja" itu: `GET /admin/access` hari ini menyaring katalog peran dengan `canDelegateRole`, memakai `access.roles.delegate` milik pemanggil. Pembaca HC yang tidak memegang `delegate` hanya akan melihat satu peran, `human_capital` — halaman "baca saja" yang nyaris kosong justru bagi orang yang dibuatkan. Penyaringan itu masuk akal ketika daftarnya memberi makan sebuah form pemberian peran; setelah form-nya hilang, ia hanya menyembunyikan informasi. Pembaca `access.read` melihat seluruh katalog dan seluruh pemegang peran (§5 baris 20).

#### 8.1.1 Reaktivasi sementara tidak ikut pindah

Rancangan sebelumnya menyapu reaktivasi sementara bersama pengelolaan akun. Itu keliru dan akan menghilangkan kemampuan itu dari semua orang sekaligus:

- `account_temporary_reactivations`, route pemberian dan pencabutannya, dan tugas malam `expireTemporaryReactivations` seluruhnya milik HCIS. SQ Hub tidak punya konsepnya, jadi tidak ada penggantinya di sana;
- permission `access.accounts.temporary_reactivate` sengaja berada **di luar** `ADMIN_PERMISSIONS`, sehingga `hasLegacySuperAdminCompatibility` tidak pernah memberikannya. Break-glass pun akan menerima `403` pada route itu, bahkan lewat curl;
- §4.3 sendiri sudah menempatkannya di peran kerja HC, bukan di Admin Platform.

Jadi: reaktivasi sementara **tetap di HCIS**, tetap dikendalikan `access.accounts.temporary_reactivate`, dan panelnya tetap berada di tempatnya sekarang — melekat pada kartu akun pegawai, bukan di bagian "Account Organ Yayasan" seperti tertulis sebelumnya.

#### 8.1.2 Membuat akun HCIS harus punya pengganti sebelum layarnya hilang

Membuat Akun SQ di Keycloak **bukan** membuat akun HCIS; HCIS tidak menyediakan akun secara otomatis saat login OIDC. Tanpa kanal §2.9, F5b akan membuat pegawai baru mustahil dilayani: Akun SQ ada, akun HCIS tidak, dan tidak ada layar untuk membuatnya. Karena itu §2.9 adalah prasyarat F5b, dan kriteria kelulusan F5a diperketat (§8.3).

### 8.2 Permukaan lain yang mengelola akun, bukan sekadar menunjuk

Review kedua menemukan bahwa `/admin/access` **bukan** satu-satunya tempat akun dikelola. `AdminEmployeeDetailPage` tidak hanya menautkan ke sana: ia memanggil `prepareEmployeeAccount` dan `issueAccountActivation` sendiri, yaitu **membuat akun dan menerbitkan tautan aktivasi**, dengan akses route dijaga `employees.manage` sementara API-nya menuntut `access.manage`. Dibiarkan, tombol "Siapkan account & link aktivasi" akan bertahan di setiap halaman detail pegawai dan menolak selamanya — persis yang D-6 larang.

Yang ikut berubah pada rilis yang sama dengan F5b:

| Permukaan | Perubahan |
|---|---|
| `AdminEmployeeDetailPage` — tombol siapkan akun dan terbitkan aktivasi | **dihapus**, diganti satu baris status akun baca saja dan tautan ke SQ Hub |
| `AdminEmployeeDetailPage` — tautan ke `/admin/access` | menjadi tautan ke "Peran & Akses" yang baru |
| `AdminPage` — kartu "Account & Akses" dan metriknya | menjadi kartu baca saja, atau hilang bila akun tidak memegang `access.read`. Metriknya memanggil `getAccessAdmin`, yang penjaganya ikut berpindah ke `access.read` |
| `canAccessAdminPath` | `access.manage` diganti `access.read` untuk `/admin/access`, dan dikeluarkan dari daftar permission yang membuka `/admin` — tanpa itu akun yang hanya punya `access.manage` mendapat shell administrasi dengan menu kosong |

Menghapus halaman tanpa menyapu penunjuk dan kembarannya meninggalkan tautan mati dan tombol menolak, yang sama buruknya dengan halaman menganggur.

### 8.2.1 Audit yang bisa dibaca adalah prasyarat, bukan pelengkap

`access_audit_events` ditulis di belasan tempat dan **tidak dibaca di mana pun**: tidak ada endpoint yang menyeleksinya, dan satu-satunya layar audit di `apps/web` adalah audit perangkat ADMS. Artinya penanda `actor_source` (§2.7) dan janji ADR-0006 R-1 butir 6 — "pemakaian break-glass harus dapat difilter di layar audit" — hari ini menggambarkan layar yang tidak ada. Audit SQ Hub memuat peristiwa Hub, bukan pemberian peran HCIS.

Maka satu endpoint baca dan satu layar audit akses HCIS, dengan filter `actor_source`, menjadi **prasyarat F5b**: tepat pada saat tindakan berpindah ke tempat lain, kemampuan memeriksa apa yang terjadi tidak boleh justru nol.

### 8.3 Urutan: SQ Hub dulu, baru HCIS dihapus

Aturan kerasnya: **tidak boleh ada jeda di mana kewenangannya tidak ada di kedua tempat.**

Urutannya menjadi bagian §6 sebagai dua fase baru:

| Fase | Isi | Prasyarat |
|---|---|---|
| **F5a** | SQ Hub bisa memberi dan mencabut peran HCIS, **dan** mengelola akun HCIS lewat kanal §2.9 — bukan sekadar mengelola pengguna Keycloak. Diverifikasi owner dari ujung ke ujung: satu pemberian peran nyata, **dan satu pegawai baru dilayani dari nol sampai bisa masuk HCIS** | F5 lulus; §2.9 terpasang; K-1, K-2, K-4 selesai |
| **F5b** | Baru setelah F5a: HCIS menghapus form pemberian peran, pengelolaan akun, dan kembarannya di halaman detail pegawai (§8.1, §8.2). Menu menjadi "Peran & Akses" | **F5a lulus dan tercatat**; `access.read` dan layar audit akses (§8.2.1) sudah ada |

Kriteria F5a sengaja menyebut "pegawai baru dilayani dari nol". Kriteria lama, "SQ Hub bisa mengelola akun", akan dicentang oleh pengelolaan pengguna Keycloak saja, padahal itu tidak menghasilkan satu pun baris akun di HCIS.

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
| **Ruang admin bersih dari ruang pegawai** | tidak ada kartu self-service, tidak ada "cuti saya", tidak ada slip gaji pribadi, dan **tidak ada lonceng notifikasi pribadi** di ruang admin |
| **Ruang pegawai bersih dari administrasi** | tidak ada pintasan tindakan administratif di ruang pegawai; satu-satunya jalan masuk adalah pemindah ruang |
| **Akun tanpa data pegawai** | akun break-glass tidak punya ruang pegawai; pemindah ruang tidak muncul untuknya |

`CoreShell` sudah memisahkan `space`, dan `SpaceSwitcher` sudah menjadi satu-satunya pintu masuk ke administrasi. Tetapi pemisahannya belum sebersih yang dinyatakan di atas, dan review kedua benar menunjuknya: **ruang administrasi hari ini sudah merender elemen ruang pegawai.** `AdminShell` mengambil `getMyNotifications` untuk principal `EMPLOYEE` dan `CoreShell` merender lonceng notifikasi pribadi yang menautkan ke `/app/notifications`, di header ruang administrasi. Itu bukan hanya pencampuran konteks; ia juga lompatan antarruang yang melewati aturan §9.3 (mendarat di akar) dan konfirmasi formulir belum tersimpan.

Jadi yang kurang bukan hanya penandanya. Dua hal harus dikerjakan: **menghapus elemen ruang pegawai dari ruang administrasi**, dan **menguatkan penandanya**.

Lonceng tidak sekadar dihapus tanpa pengganti. Bila nanti ada notifikasi yang memang administratif (misalnya permintaan yang menunggu tindakan HC), lonceng ruang administrasi menampilkan itu dan hanya itu. Sampai notifikasi administratif ada, ruang administrasi tidak punya lonceng sama sekali.

### 9.2 Penanda konteks yang tidak bisa dilewatkan

1. **Pita konteks yang selalu terlihat** di ruang administrasi, melekat di atas header, tidak ikut menggulung, berbunyi: **"Mode Administrasi HCIS — <nama peran yang sedang dipakai>"**. Di ruang pegawai tidak ada pita; ketiadaannya adalah penandanya.
2. **Warna header berbeda** antara kedua ruang, cukup kontras untuk dikenali dari sudut mata, dan tetap memenuhi kontras WCAG AA.
3. **Judul tab browser diawali `[Admin]`** di ruang administrasi, supaya tab yang berjejer pun terbaca.
4. **Penanda yang sama hadir di mobile.** Pita tidak boleh dikorbankan di layar sempit; justru di sanalah sidebar tidak terlihat dan konteks paling mudah hilang.

Nama peran di pita penting: "Mode Administrasi HCIS — Admin Modul" berbeda dari "— Human Capital", dan itu menjawab pertanyaan kedua yang akan segera muncul, yaitu *admin yang mana*.

**Namanya belum ada datanya.** `AuthSession` di frontend hanya membawa `principal` dan `authorization.organizationPermissions`; tidak ada nama peran, dan `AdminShell` hari ini menuliskan `"Administrator HCIS"` secara hardcoded. HCIS juga tidak punya konsep "peran yang sedang dipakai" — permission adalah gabungan datar dan tidak ada yang dipilih. Maka pita ini menuntut satu perubahan API: **`/auth/me` dan login lokal mengembalikan nama peran organisasi yang efektif**, dan pita menampilkan semuanya bila lebih dari satu ("Admin Modul, Human Capital"). Tidak ada pemilih peran dan tidak ada peralihan peran — itu akan menambah konsep baru demi sebuah label.

Bila daftar peran kosong sementara akun jelas punya kewenangan administrasi (kasus break-glass, yang bukan `EMPLOYEE`), pita berbunyi "Mode Administrasi HCIS — Break-glass". Itu justru keadaan yang paling perlu terlihat.

### 9.3 Perpindahan harus disengaja

- Pemindah ruang tetap ada (orang yang sama memang boleh punya dua-duanya) tetapi perpindahan **selalu mendarat di akar ruang tujuan** (`/app` atau `/admin`), tidak pernah mempertahankan halaman yang sedang dibuka. Mendarat di tempat yang sama dengan tampilan berbeda persis adalah sumber kebingungan yang dikeluhkan.
- Bila ada formulir yang belum tersimpan, perpindahan **meminta konfirmasi** lebih dulu.
- Perpindahan tidak membuat sesi baru dan tidak meminta login ulang. Ini perpindahan tampilan, bukan perpindahan identitas — justru itu intinya.

Catatan teknis yang menentukan bentuk implementasinya: seluruh item sidebar dan kedua segmen pemindah ruang adalah `<a href>` biasa, sehingga perpindahan ruang dan deep link adalah pemuatan dokumen penuh, bukan navigasi router. Akibatnya konfirmasi formulir belum tersimpan **tidak bisa** berupa blocker router dan harus memakai `beforeunload`, dan toast §9.4 membutuhkan penanda yang bertahan melewati pemuatan (`sessionStorage`), bukan state di memori. Keduanya masuk §5 baris 16.

### 9.4 Deep link

| Keadaan | Perilaku |
|---|---|
| Membuka URL `/admin/...` sementara tab berada di ruang pegawai | konteks berpindah ke administrasi, halaman yang diminta dibuka, pita konteks muncul, dan satu toast "Mode Administrasi aktif" ditampilkan sekali. Tanpa layar antara — gesekan tambahan di setiap tautan akan dimatikan orang, sedangkan pita tetap terlihat selamanya |
| Membuka URL `/admin/...` tanpa kewenangan untuk halaman itu | tidak ada halaman administrasi yang terbuka sebagian. Dialihkan ke ruang pegawai dengan satu pesan yang menyebut halaman mana yang ditolak. Hari ini `requireAdminPath` melempar `notFound()`; perubahannya ada di §5 baris 17 |
| Membuka URL `/admin/...` oleh akun tanpa kewenangan administrasi apa pun | sama seperti di atas; menu administrasi memang tidak pernah muncul untuknya |
| Membuka URL ruang pegawai oleh akun break-glass tanpa data pegawai | dialihkan ke `/admin` dengan pesan bahwa akun ini tidak punya ruang pegawai. Hari ini `requirePrincipal(…, "EMPLOYEE")` memberi 404 |

**"Ditolak" dan "sudah tidak ada" harus dibedakan.** Setelah §8.4 dan tabel ini sama-sama berlaku, penjaga route harus memisahkan tiga keadaan, karena perlakuannya berbeda dan menyamakannya akan membingungkan: halaman **ada tetapi tidak diizinkan** → dialihkan ke ruang pegawai dengan pesan; halaman **sudah dipindahkan** → dialihkan atau halaman penunjuk berbatas waktu (§8.4 nomor 1–2); halaman **memang tidak pernah ada** → 404 biasa. Perbedaan ini ditetapkan di satu tempat pada router, bukan diputuskan per halaman.

### 9.5 Sesi yang sedang berjalan saat kewenangannya berubah

Admin Platform dapat mencabut peran seseorang saat orang itu sedang membuka ruang administrasi. Yang terjadi:

1. Penjaga route dievaluasi ulang pada navigasi berikutnya dan pada pemuatan ulang konteks otorisasi; halaman yang tidak lagi diizinkan **tidak dibuka**.
2. Bila akun kehilangan seluruh kewenangan administrasi, konteks jatuh ke ruang pegawai dengan satu pesan yang jelas — bukan layar kosong dan bukan menu yang masih tampil tetapi setiap kliknya 403.
3. Bila akun itu juga tidak punya data pegawai aktif (kasus break-glass), sesi diakhiri.
4. Tidak ada menu administrasi yang bertahan **melewati navigasi berikutnya** setelah kewenangannya hilang.

Butir 4 sengaja dibatasi pada "melewati navigasi berikutnya", karena rumusan sebelumnya — "tidak ada menu yang bertahan di layar" — bertentangan dengan paragraf di bawah ini dan dengan cara `AdminShell` bekerja: ia menyelesaikan sesi sekali pada `useEffect` dan tidak pernah memuatnya ulang. Menuntut menu hilang seketika berarti menambahkan polling atau pengawas perubahan izin, dan itu biaya yang tidak sebanding dengan masalahnya.

Pencabutan memang tidak memutus sesi yang sedang berjalan di tengah pekerjaan; perubahan terasa pada navigasi berikutnya. Itu pilihan sadar: pemutusan seketika di tengah pengisian formulir menghilangkan pekerjaan orang, sedangkan API tetap menolak setiap tindakan yang sudah tidak diizinkan, jadi tidak ada kewenangan nyata yang bocor dalam jeda itu. Yang menolong di sini sudah ada: `requireAdminPath` memanggil `/api/auth/me` segar pada setiap `beforeLoad` tanpa cache, sehingga pencabutan terlihat pada navigasi berikutnya **dan** pada pemuatan ulang halaman.

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
| ~~`TBD`~~ **terverifikasi 2026-10-27** | Realm `sq-staff` mengiklankan `urn:ietf:params:oauth:grant-type:token-exchange` pada discovery document-nya, jadi dukungan platform bukan penghalang. Yang tersisa murni konfigurasi per-client (K-4), dan itu tetap gate F4 |
| `DRAFT` | Daftar pemegang peran tetap ada di HCIS sebagai tampilan baca saja karena HC diperkirakan membutuhkannya untuk mengalirkan pekerjaan. Bila ternyata tidak dipakai, halaman itu ikut dihapus dan HC membacanya di SQ Hub |
| `DRAFT` | Nama permission baru `access.read` dan `organization.role_seat_links.manage` dipilih di sini; keduanya belum pernah dipakai di katalog |
| `DRAFT` | Ruang administrasi tidak punya lonceng sampai ada notifikasi yang memang administratif. Bila ternyata HC membutuhkannya lebih cepat, lonceng administratif dibuat lebih dulu dan lonceng pribadi tetap tidak kembali |
| `DRAFT` | Masa hidup halaman penunjuk deep link (§8.4) ditetapkan satu siklus rilis |
| `TBD` | Apakah aplikasi SQ Core lain (Aset SQ, SPMB, Karir SQ) memakai kanal berbentuk sama. Rancangan §2 sengaja tidak memuat apa pun yang khas HCIS selain katalog perannya |
