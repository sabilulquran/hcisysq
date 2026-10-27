# AUTH-014 — Tiga lapis administrator: sisi HCIS

**Status:** ACCEPTED product decision (owner, 2026-10-27); implementasi belum dimulai.
**Related:** ADR-0006 (keputusan), AUTH-010, AUTH-011, AUTH-012, AUTH-013, ORG-008, ORG-010, EMP-005, DOC-002, `HUB-IMPL-003`.
**Supersedes:** aturan "hanya Super Admin yang memberi peran" di AUTH-011 (keputusan owner 2026-10-16), sejauh menyangkut *siapa* yang boleh memberi. Larangan self-grant, allowlist role/permission, kewajiban mandat, dan atomisitas audit **tidak** diubah.

Dokumen ini hanya mengatur HCIS. Perubahan di SQ Hub dan Keycloak ditulis sebagai kebutuhan di §7; repository SQ Hub tidak ada di checkout ini dan tidak disentuh.

---

## 1. Ringkasan

| Pertanyaan | Jawaban setelah AUTH-014 |
|---|---|
| Siapa yang memberi peran HCIS? | Admin Platform, dari SQ Hub, lewat kanal mesin ke HCIS |
| Apakah HCIS tahu siapa Admin Platform? | Tidak. HCIS hanya mengenali kanal, lalu memeriksa manusia pelakunya |
| Apakah masih perlu akun SUPER_ADMIN terpisah? | Tidak untuk pekerjaan harian. Tetap ada sebagai break-glass nonaktif |
| Siapa Admin Modul HCIS? | Role baru `hcis_module_admin`, scope organisasi, diberikan oleh Admin Platform |
| Apakah Admin Modul boleh memberi peran? | Tidak. Tidak pada peran apa pun, pada scope apa pun |
| Apakah Admin Modul boleh menyentuh akun orang? | Tidak. Tidak membuat, menonaktifkan, mengundang, atau mereset |

---

## 2. Kanal pemberian peran dari Admin Platform

### 2.1 Bentuk kanal

Dua endpoint internal baru, mengikuti pola yang sudah ada di
`apps/api/src/modules/employees/staff-identity-routes.ts` dan
`apps/api/src/modules/organization-directory/routes.ts`:

```
POST   /internal/v1/role-administration/accounts/:accountId/role-assignments
DELETE /internal/v1/role-administration/role-assignments/:assignmentId
GET    /internal/v1/role-administration/catalog
```

`GET /catalog` mengembalikan role HCIS yang dapat diberikan beserta permission, kewajiban scope, dan kewajiban mandat, supaya layar SQ Hub tidak perlu menyalin daftar peran HCIS ke dalam kodenya. Daftar itu tetap milik HCIS.

### 2.2 Otentikasi mesin

Sama persis dengan pola yang sudah berjalan: bearer token mesin Keycloak, diverifikasi dengan `createOrganizationDirectoryMachineTokenVerifier`.

| Parameter | Nilai |
|---|---|
| Issuer | `HCIS_ROLE_ADMIN_TOKEN_ISSUER` |
| Audience | `HCIS_ROLE_ADMIN_TOKEN_AUDIENCE` |
| Client allowlist | `HCIS_ROLE_ADMIN_ALLOWED_CLIENTS` (direncanakan: `sq-hub-identity-management` saja) |
| Scope wajib | `role-administration.manage` |
| Saklar | `HCIS_ROLE_ADMIN_ENABLED` (`"1"` untuk hidup; selain itu `503 ROLE_ADMIN_CHANNEL_DISABLED`) |

Saklar itu bagian dari rencana bertahap: endpoint boleh dirilis mati, lalu dihidupkan sebagai langkah operasi terpisah tanpa rilis kode baru.

### 2.3 Isi permintaan

```jsonc
{
  "actor": {
    "issuer": "https://login.sabilulquran.or.id/realms/sq-staff",
    "subject": "<sub Keycloak manusia yang menekan tombol di SQ Hub>"
  },
  "requestId": "<uuid dari SQ Hub, dicatat di kedua sisi>",
  "roleId": "<uuid role HCIS>",
  "scopeType": "organization",
  "organizationalUnitId": null,
  "reason": "<mandat, wajib untuk role istimewa>",
  "startsOn": null,
  "endsOn": null
}
```

Selain `actor` dan `requestId`, bentuknya identik dengan `RoleAssignmentInput` yang sudah ada, sehingga satu implementasi domain melayani kedua jalur.

### 2.4 Apa yang HCIS periksa sendiri

Token mesin yang sah **hanya** membuktikan "permintaan ini datang dari SQ Hub". Ia tidak membuktikan apa pun tentang kewenangan. Karena itu HCIS menjalankan seluruh pemeriksaannya sendiri, berurutan, sebelum apa pun ditulis:

1. **Kanal hidup** — jika tidak, `503 ROLE_ADMIN_CHANNEL_DISABLED`.
2. **Token mesin sah, client ada di allowlist, scope ada** — jika tidak, `401`/`403` seperti pola yang sudah ada.
3. **Resolusi aktor.** `actor.issuer` + `actor.subject` dicocokkan ke `accounts.identity_issuer` + `accounts.identity_subject`. Tidak nol baris, tidak lebih dari satu baris, akun berstatus `active`, dan bila `principal_type = 'EMPLOYEE'` maka employee-nya juga `active`. Gagal pada salah satunya: `403 ROLE_ADMIN_ACTOR_UNRESOLVED`, tanpa menulis apa pun. **Tidak ada pencocokan lewat email atau nama.**
4. **Larangan self-grant.** `resolvedActor.id === accountId` ditolak `403 ROLE_DELEGATION_FORBIDDEN`. Ini berlaku pada pemberian maupun pencabutan, dan dievaluasi terhadap manusia hasil langkah 3 — bukan terhadap akun mesin, yang tidak pernah menjadi `accountId` karena bukan akun HCIS.
5. **Invarian domain yang sudah ada, tanpa pelonggaran:** target wajib `principal_type = 'EMPLOYEE'`; role wajib ada di `HCIS_ROLES`; seluruh permission role wajib ada di `HCIS_PERMISSIONS`; `assertAssignmentScope` dan `assertAssignmentDates`; mandat dan scope organisasi wajib untuk `human_capital_admin`, `human_capital_lead`, `foundation_board_viewer`, dan `hcis_module_admin`; pencabutan token aktivasi untuk role di luar bundle operasional HC.
6. **Larangan permission identitas (ADR-0006 D-5).** `access.roles.assign`, `access.roles.delegate`, dan `access.governance.manage` tidak boleh dibawa role mana pun yang diberikan lewat kanal ini. Role yang membawanya ditolak `403 ROLE_IDENTITY_PERMISSION_FORBIDDEN`, meskipun role itu ada di `HCIS_ROLES`. Pemeriksaan ini dilakukan terhadap permission role yang tersimpan di database, bukan terhadap daftar yang dikirim pemanggil.

Kegagalan pada langkah mana pun berarti **tidak ada assignment dan tidak ada audit event perubahan**; yang tercatat hanya log penolakan. Ini mengikuti perilaku `assertRoleGrantor` yang berjalan sekarang.

### 2.5 Audit

`role.assignment.created` dan `role.assignment.removed` tetap dipakai, atomik bersama mutasinya, dengan tiga field tambahan:

| Field | Jalur SQ Hub | Jalur break-glass |
|---|---|---|
| `actorSource` | `"sq_hub"` | `"hcis_break_glass"` |
| `actorAccountId` | akun lokal hasil resolusi | akun SUPER_ADMIN |
| `hubRequestId` | `requestId` dari SQ Hub | `null` |

`actorSource = "hcis_break_glass"` adalah penanda yang dimaksud ADR-0006 R-1 butir 6: pemakaian break-glass tidak boleh tenggelam di antara pemberian normal, dan harus bisa difilter di layar audit.

---

## 3. Nasib `principal_type = 'SUPER_ADMIN'`

Tidak ada kolom yang dihapus, tidak ada akun yang dihapus, tidak ada `principal_type` yang diubah. Yang berubah adalah artinya.

| Hal | Sekarang | Setelah AUTH-014 |
|---|---|---|
| `principalType === "SUPER_ADMIN"` di `assertRoleGrantor` | satu-satunya jalan memberi peran | salah satu dari dua jalan, dan yang kedua |
| Akun `admin@hcis.sabilulquran.or.id` | aktif, dipakai harian | `status = 'inactive'`, dihidupkan hanya untuk break-glass |
| `hasLegacySuperAdminCompatibility` | jalur permission SUPER_ADMIN ke seluruh `ADMIN_PERMISSIONS` | tidak diubah oleh AUTH-014; pencabutannya tetap milik AUTH-011 dan dilakukan setelah fase F6 |
| Form pemberian peran di `/admin/access` HCIS | tampil untuk SUPER_ADMIN | tetap tampil untuk SUPER_ADMIN; pengguna lain melihat daftar read-only dengan tautan "Kelola di SQ Hub" |

`assertRoleGrantor` menjadi:

```ts
// AUTH-014: dua jalur grantor. Jalur Hub membawa aktor yang sudah diselesaikan;
// jalur break-glass tetap SUPER_ADMIN. Tidak ada jalur ketiga, dan tidak ada
// permission HCIS yang memberi kewenangan ini (ADR-0006 D-5).
export function assertRoleGrantor(actor: AuthPrincipal, channel: GrantChannel): void
```

`GrantChannel` bernilai `"sq_hub"` atau `"break_glass"`. Nilai `"sq_hub"` hanya dapat dibentuk oleh route internal setelah §2.4 langkah 1–3 lulus; tidak ada cara membentuknya dari sesi pengguna. Pemeriksaan diulang di `createRoleAssignment`/`removeRoleAssignment` untuk pemanggil non-HTTP, seperti sekarang.

### Prosedur break-glass

1. Operator mencatat alasan di runbook Mi8VPS sebelum bertindak.
2. Akun break-glass diaktifkan (`accounts.status = 'active'`) lewat perintah CLI tercatat.
3. Pekerjaan dikerjakan; setiap aksi menghasilkan audit `actorSource = "hcis_break_glass"`.
4. Akun dikembalikan ke `inactive` segera setelah selesai.
5. Kredensial break-glass dirotasi setelah setiap pemakaian.

Akun break-glass **wajib sudah tertaut ke Akun SQ dan sudah pernah diuji login** sebelum fase F4 (§6). Ini pelajaran langsung dari kejadian yang memicu AUTH-014: lapis cadangan yang belum pernah diuji bukan lapis cadangan.

---

## 4. Admin Modul HCIS

### 4.1 Role baru

`hcis_module_admin` — "Admin Modul HCIS". Scope organisasi wajib, mandat wajib, diberikan hanya oleh Admin Platform lewat kanal §2.

### 4.2 Yang masuk kewenangannya

Permission berikut adalah pengaturan modul, data acuan, periode, dan hal teknis operasional. Semuanya sudah ada di katalog; tidak ada permission baru yang diciptakan.

| Kelompok | Permission |
|---|---|
| Jadwal dan kebijakan kehadiran | `attendance.schedule.manage`, `attendance.policy.manage`, `attendance.shift_swap.manage`, `attendance.calculation.run` |
| Perangkat absensi (non-destruktif) | `attendance.devices.read`, `attendance.devices.configure`, `attendance.devices.operate`, `attendance.devices.export` |
| Konfigurasi cuti | `leave.configuration.manage` |
| Konfigurasi payroll | `payroll.policies.manage`, `payroll.periods.manage` |
| Dokumen | `documents.manage` |

### 4.3 Yang tegas di luar kewenangannya

| Permission | Alasan |
|---|---|
| `access.roles.assign`, `access.roles.delegate`, `access.governance.manage` | memberi peran dan mengurus akun adalah lapis Admin Platform (ADR-0006 D-1, D-5) |
| `access.manage`, `access.accounts.temporary_reactivate` | menyentuh akun orang |
| `employees.manage`, `employees.read.all` | data pribadi pegawai adalah pekerjaan HC, bukan konfigurasi modul |
| `approvals.policy.manage` | mengubah siapa yang menyetujui apa; milik `human_capital_lead` (ORG-008-8) |
| `organization.manage` | struktur organisasi, bukan pengaturan modul |
| `leave.validate`, `leave.approve`, `leave.hc.approve` | keputusan kerja, bukan konfigurasi |
| `payslips.import`, `payslips.publish`, `payroll.calculate`, `payroll.submit`, `payroll.approve`, `payroll.payments.confirm` | menjalankan payroll, bukan mengaturnya |
| `attendance.devices.destructive`, `.biometrics`, `.firmware` | tetap terpisah dan diberikan eksplisit (AUTH-011) |
| `board.read` | hanya `foundation_board_viewer` (ORG-010) |

Catatan batas yang sengaja dipilih: `payroll.profiles.manage` dan `payroll.inputs.manage` **tidak** masuk Admin Modul. Keduanya menyentuh angka seorang pegawai, bukan bentuk perhitungannya, jadi tempatnya di peran kerja Keuangan. `payroll.policies.manage` masuk karena ia mendefinisikan komponen gaji, yang memang "data acuan".

### 4.4 Akibat pada `human_capital_admin`

Bundle `human_capital_admin` hari ini memuat campuran pekerjaan HC dan konfigurasi modul. Setelah AUTH-014 bundle itu menjadi **peran kerja HC saja**: permission di §4.2 dicabut darinya.

Pencabutan itu adalah migration tersendiri di fase F6, **setelah** `hcis_module_admin` dibuat, diberikan, dan terbukti bekerja. Sampai F6, kedua role tumpang tindih; ini disengaja, karena tumpang tindih sementara tidak memutus siapa pun sedangkan pencabutan dini memutus.

---

## 5. Perubahan teknis di HCIS

| # | Perubahan | Berkas |
|---|---|---|
| 1 | Role `hcis_module_admin` + pemetaan permission §4.2 | migration baru (aditif) |
| 2 | Kolom audit `actor_source`, `actor_account_id`, `hub_request_id` | migration baru (aditif, nullable) |
| 3 | `MODULE_ADMIN_ROLE_KEY`, `MODULE_ADMIN_PERMISSIONS`, `IDENTITY_PERMISSIONS` (daftar larangan D-5) | `apps/api/src/modules/auth/permissions.ts` |
| 4 | `assertRoleGrantor(actor, channel)`, larangan permission identitas, mandat untuk role baru | `apps/api/src/modules/auth/role-assignment.ts` |
| 5 | Resolusi aktor dari issuer+subject | `apps/api/src/modules/auth/oidc-identity-mapping.ts` |
| 6 | Route internal §2.1 | `apps/api/src/modules/auth/role-administration-routes.ts` (baru) |
| 7 | Env + validasi | `apps/api/src/config/env.ts` |
| 8 | Kontrak endpoint internal | `docs/api/openapi.yaml` |
| 9 | `/admin/access`: notis read-only + tautan "Kelola di SQ Hub", filter `actorSource` di layar audit | `apps/web` |
| 10 | Pencabutan permission §4.2 dari `human_capital_admin` | migration terpisah, fase F6 |

Migration 1, 2, dan 10 menyentuh otorisasi, jadi setiap PR-nya wajib melewati satu putaran review independen sebelum merge.

---

## 6. Rencana bertahap

Prinsipnya: **aditif lebih dulu, pencabutan paling akhir; setiap fase punya jalan mundur yang tidak bergantung pada fase berikutnya; tidak ada satu pun fase yang mencabut jalan masuk sebelum penggantinya terbukti bekerja.**

| Fase | Isi | Risiko akses | Jalan mundur |
|---|---|---|---|
| **F0** | ADR-0006 + AUTH-014 (dokumentasi; PR ini) | nihil | revert commit |
| **F1** | Akun break-glass ditautkan ke Akun SQ dan **diuji login**, lalu dikembalikan ke `inactive`. Prosedur break-glass masuk runbook Mi8VPS | nihil (menambah jalan masuk) | — |
| **F2** | Migration aditif: role `hcis_module_admin`, kolom audit baru. Belum ada yang memegang role itu | nihil (tidak ada perilaku berubah) | `DROP ROLE`/`DROP COLUMN`; tidak ada pemegang |
| **F3** | Kode: `assertRoleGrantor(actor, channel)` dengan jalur `break_glass` berperilaku **persis seperti sekarang**, jalur `sq_hub` sudah ada tetapi route-nya belum terdaftar. Larangan permission identitas aktif | nihil | revert kode; database tidak berubah |
| **F4** | Route internal didaftarkan dengan `HCIS_ROLE_ADMIN_ENABLED` **mati**. Prasyarat: F1 lulus | nihil (`503`) | saklar tetap mati |
| **F5** | Saklar dihidupkan. SQ Hub memberikan satu peran uji ke satu akun uji, lalu mencabutnya. Diverifikasi: assignment benar, audit `actorSource = "sq_hub"` ada, self-grant ditolak, permission identitas ditolak | rendah; jalur lama masih utuh | matikan saklar; jalur SUPER_ADMIN tidak tersentuh |
| **F6** | Setelah F5 stabil (minimal dua minggu pemakaian nyata): berikan `hcis_module_admin` kepada pemegang yang dituju, **amati**, lalu migration pencabutan permission §4.2 dari `human_capital_admin` | sedang — ini satu-satunya fase yang mencabut sesuatu | migration pembalik mengembalikan permission ke bundle; pemegang tidak kehilangan apa pun yang tidak bisa dikembalikan dalam satu migration |
| **F7** | Akun SUPER_ADMIN dikembalikan ke `inactive` sebagai keadaan normal. Hanya setelah F5 dan F6 lulus | rendah | aktifkan kembali lewat prosedur break-glass |

Pencabutan `hasLegacySuperAdminCompatibility` **bukan** bagian AUTH-014; syaratnya sudah ditetapkan AUTH-011 dan dikerjakan setelah F7.

### Yang tidak boleh terjadi di fase mana pun

- Tidak ada fase yang membuat `assertRoleGrantor` menolak SUPER_ADMIN sebelum F7, dan F7 pun tidak menolaknya — hanya menonaktifkan akunnya.
- Tidak ada fase yang mencabut permission dari role yang sedang dipakai sebelum penggantinya diberikan dan diamati.
- Tidak ada fase yang mengubah `principal_type`, `identity_issuer`, `identity_subject`, kredensial, atau sesi akun mana pun.
- F5 tidak dijalankan pada hari yang sama dengan rilis payroll atau penutupan periode kehadiran.

### Verifikasi tiap fase

Setiap fase yang menyentuh kode atau database menuntut: typecheck, lint, test API dan frontend, build; test positif/negatif untuk aktor yang tidak terselesaikan, self-grant, permission identitas, role di luar allowlist, scope dan tanggal tidak sah, target bukan `EMPLOYEE`, kanal mati, token tanpa scope, dan client di luar allowlist. Gate yang tidak dapat dijalankan dilaporkan apa adanya, tidak diklaim lulus (AGENTS.md §7).

---

## 7. Kebutuhan di SQ Hub dan Keycloak

Ditulis sebagai kebutuhan, bukan sebagai perubahan. Repository SQ Hub tidak disentuh dari sini.

### 7.1 Keycloak

| # | Kebutuhan | Catatan |
|---|---|---|
| K-1 | Tambahkan `manage-users` **hanya** pada `sq-hub-identity-management` | bukan pada keempat akun mesin; ADR-0006 R-1 butir 1 |
| K-2 | Buat client scope `role-administration.manage` dan berikan hanya pada akun mesin yang memanggil kanal §2 | audience harus menyebut HCIS |
| K-3 | Jangan pernah berikan `impersonation`, `manage-clients`, `manage-realm`, `manage-identity-providers`, `realm-admin` ke akun mesin mana pun | ADR-0006 D-2 |
| K-4 | Jadwalkan rotasi secret keempat akun mesin | ADR-0006 R-1 butir 2 |
| K-5 | Pastikan `sub` manusia yang masuk SQ Hub sama dengan `identity_subject` yang tersimpan di HCIS | prasyarat §2.4 langkah 3; perbedaan apa pun membuat seluruh kanal gagal-tertutup |

### 7.2 SQ Hub

| # | Kebutuhan | Catatan |
|---|---|---|
| H-1 | Layar pemberian peran per aplikasi di `/admin/access`, memakai `GET /internal/v1/role-administration/catalog` HCIS sebagai sumber daftar peran | jangan menyalin daftar peran HCIS ke kode Hub |
| H-2 | Kirim `actor.issuer`, `actor.subject`, dan `requestId` pada setiap panggilan | tanpa ini HCIS menolak |
| H-3 | Periksa keanggotaan `platform_administrators` sebelum memanggil HCIS | pemeriksaan di HCIS bersifat tambahan, bukan pengganti |
| H-4 | Larang penghapusan pengguna Keycloak di tingkat aplikasi; sediakan hanya buat, nonaktifkan, reset kata sandi | ADR-0006 R-3 |
| H-5 | Catat setiap pemberian peran di audit Hub dengan `requestId` yang sama | ADR-0006 R-1 butir 5 |
| H-6 | Rate limit dan review keamanan tersendiri untuk `/admin/access` | prasyarat yang muncul karena pemusatan ini; ADR-0006 R-1 |
| H-7 | Tampilkan peringatan bila HCIS menolak dengan `ROLE_ADMIN_ACTOR_UNRESOLVED` | menandakan K-5 belum beres, bukan kesalahan operator |
| H-8 | Tangani `503 ROLE_ADMIN_CHANNEL_DISABLED` sebagai keadaan normal selama F4 | jangan tampilkan sebagai kerusakan |

---

## 8. Asumsi yang belum diverifikasi

| Tanda | Asumsi |
|---|---|
| `DRAFT` | Admin Modul HCIS dipegang oleh satu orang pada awalnya; tidak ada batas teknis jumlah pemegang, dan batas kebijakan belum ditetapkan |
| `DRAFT` | Jeda pengamatan F5→F6 ditetapkan dua minggu sebagai angka yang masuk akal, bukan dari dokumen mana pun |
| `DRAFT` | `payroll.profiles.manage` dan `payroll.inputs.manage` ditempatkan di peran kerja Keuangan, bukan Admin Modul (§4.3). Bila PAY-003 memutuskan lain, §4.2 menyesuaikan |
| `TBD` | Apakah aplikasi SQ Core lain (Aset SQ, SPMB, Karir SQ) memakai kanal yang bentuknya sama. Rancangan §2 sengaja tidak memuat apa pun yang khas HCIS selain katalog perannya |
