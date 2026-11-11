# Roles and Permissions

> AUTH-011 supersedes principal-only administrative eligibility in this document.
> See [HCIS authorization modernization](hcis-authorization-modernization.md) for
> domain/platform boundaries, granular permissions and transitional legacy compatibility.

**Status:** DISCOVERY for legacy role inventory  
**Target model:** see `access-model.md` (ACCEPTED)

Dokumen ini menyimpan baseline dari implementasi sebelumnya dan aturan permission umum. **Nama role legacy di bawah bukan role target yang wajib dipertahankan.** Model akses target HCIS YSQ ditetapkan di `docs/domain/access-model.md`.

## Prinsip target

- Jenis akun berbeda dari role.
- Employee aktif mendapat base employee self-service tanpa perlu assignment role `pegawai` manual.
- Role tambahan bersifat additive.
- Role menentukan capability; scope menentukan area/data tempat capability itu berlaku.
- Role bukan pengganti policy berbasis resource.
- Akses diberikan secara least privilege.
- Organ Yayasan (`FOUNDATION_BOARD`) default-nya read only untuk statistik dan report yang diizinkan. Pengecualiannya hanya keputusan pada langkah approval yang tersimpan atas nama akunnya, dan hanya bila akun itu memegang `leave.governance.approve` (ORG-013).
- Super Admin adalah kewenangan teknis sistem, bukan representasi jabatan organisasi.
- Status akun aktif adalah precondition terpisah dari role.
- Akses data lintas unit harus eksplisit.
- Data payroll, pinjaman, performance, dan dokumen memiliki permission lebih granular.

## Contoh role tambahan target untuk employee

Nama final dapat disesuaikan saat implementasi, tetapi konsepnya:

| Role tambahan | Tujuan |
|---|---|
| Unit Manager | Team view, approval, dan dashboard unit sesuai scope |
| HC | Administrasi Human Capital sesuai permission |
| Finance | Reimbursement/payroll/keuangan sesuai permission |
| Management | Management dashboard/report sesuai mandat |
| Special Approver | Capability approval tertentu bila tidak berasal dari struktur normal |
| Panel Organ Yayasan (`foundation_board_viewer`, ORG-010 ACCEPTED) | Hanya `board.read` scope organization: membaca `/board` dan governance summary untuk Pengurus bergaji yang tercatat sebagai Employee. Tanpa mutasi. Hanya Super Admin yang memberikan. |
| Penyetuju cuti governance (`governance_leave_approver`, sudah ada sejak migrasi 0023; ORG-013 ACCEPTED) | Hanya `leave.governance.approve`: memutuskan langkah cuti yang tersimpan atas nama akun Organ Yayasan, misalnya Sekretaris untuk cuti Direktur. Tidak membawa `board.read`, data pribadi, atau payroll. Diberikan ke akun `FOUNDATION_BOARD` lewat allowlist AUTH-014 dengan alasan (nomor SK) dan tanggal berakhir. |

Jangan membuat role kombinasi seperti `pegawai-kepala-unit-finance`. Satu employee dapat memiliki lebih dari satu assignment.

## Role legacy yang terobservasi

Bagian ini hanya discovery evidence.

| Role legacy | Tujuan awal | Catatan discovery |
|---|---|---|
| `super_admin` | Konfigurasi dan administrasi sistem | Konsep target dipisahkan sebagai account type/kewenangan teknis. |
| `admin` | Administrasi operasional terbatas | Scope final harus dipetakan per modul. |
| `pegawai` | Self-service pegawai | Target: base access otomatis untuk employee aktif. |
| `kepala_unit` | Pengelolaan/approval unit | Target: additive role + unit scope. |
| `yayasan` | Akses pengurus yayasan | Target: `FOUNDATION_BOARD`, aggregate-first dan read only. |
| `ketua_yayasan` | Kewenangan sesuai mandat ketua | Tidak otomatis menjadi Super Admin. |
| `sekretaris_yayasan` | Kewenangan sesuai mandat sekretaris | Target permission TBD jika detail khusus dibutuhkan. |
| `bendahara_yayasan` | Kewenangan sesuai mandat bendahara | Detail finansial tetap membutuhkan permission granular. |
| `pengurus_yayasan` | Kewenangan pengurus | Target default adalah board/report read only. |

## Matriks kemampuan target ringkas

Legenda: `O` own, `U` unit, `A` organization sesuai permission, `RO` read only, `-` tidak otomatis.

| Capability | Employee base | Employee + role | Foundation Board | Super Admin |
|---|---:|---:|---:|---:|
| Lihat profil sendiri | O | O | - | kebijakan khusus |
| Ajukan request sendiri | O | O | - | - |
| Lihat/kerjakan approval | - | sesuai assignment/scope | - | troubleshooting/reassign terkontrol |
| Kelola employee master | - | HC sesuai permission | RO bila diberi detail | A teknis/administratif sesuai policy |
| Lihat statistik/report | own/terbatas | U/A sesuai permission | RO | sesuai permission |
| Panel Organ Yayasan `/board` (ORG-010 ACCEPTED) | - | RO bila role Panel Organ Yayasan efektif | RO | - |
| Export report | sesuai modul | sesuai permission | RO/export sesuai permission | sesuai permission |
| Kelola role/permission | - | - (termasuk Human Capital dan Human Capital Administrator) | - | A |
| Konfigurasi sistem | - | - | - | A |

Keputusan owner 2026-10-16 (AUTH-011): hanya Super Admin yang dapat memberikan atau mencabut role
(`POST /admin/access/accounts/:accountId/role-assignments`, `DELETE /admin/access/role-assignments/:assignmentId`).
Role Human Capital dan Human Capital Administrator, atau pemegang permission apa pun termasuk
`access.roles.assign` dan `access.roles.delegate`, tidak boleh mendelegasikan role atau permission kepada akun lain.
Percobaan tersebut mendapat 403 sebelum validasi input dan tidak menulis assignment maupun audit event.
Migration 0057 menghapus `access.roles.assign` dari role `human_capital_admin`; halaman admin akses hanya
menampilkan kontrol tambah/cabut role untuk principal Super Admin menurut authorization context dari backend.
Lihat [AUTH-011](hcis-authorization-modernization.md#delegation-and-account-management).

## Permission naming

Gunakan pola:

```text
<resource>.<action>[.<scope>]
```

Contoh:

```text
employees.read.own
employees.read.unit
employees.read.all
leave.submit
leave.approve
reimbursements.approve
reports.read.organization
reports.export.organization
payroll.import
payslips.read.own
roles.manage
approvals.reassign
activity_logs.read
```

## Permission payroll (PAY-003 v1)

Daftar final yang diimplementasikan migration `0069_payroll_foundation.sql`. Seluruhnya berscope organisasi.

| Permission | Pemegang | Catatan |
|---|---|---|
| `payroll.policies.manage` | Kepala Human Capital | kebijakan berversi (skala gaji, tunjangan, statutori) |
| `payroll.profiles.manage` | Kepala Human Capital | tidak boleh atas profil miliknya sendiri |
| `payroll.periods.manage` | Kepala Human Capital | |
| `payroll.inputs.manage` | Kepala Human Capital | tidak boleh atas input miliknya sendiri |
| `payroll.calculate` | Kepala Human Capital | |
| `payroll.submit` | Kepala Human Capital | pengaju tidak dapat menjadi pengesah |
| `payroll.approve` | Direktur | |
| `payroll.reopen.approve` | Direktur | `payroll.reopen` adalah resource, `approve` adalah action |
| `payroll.loans.manage` | Keuangan | terpisah dari konfirmasi bayar; kasbon terkunci di `CALCULATED` |
| `payroll.payments.confirm` | Kepala Keuangan | |
| `payroll.reports.read.organization` | Kepala Keuangan, Direktur | laporan rekap, tanpa nomor rekening |
| `payroll.transfers.read.organization` | Kepala Keuangan | daftar transfer berisi rekening; setiap baca dan ekspor dicatat |

Role baru: `finance_officer` (Keuangan), `finance_lead` (Kepala Keuangan), `director` (Direktur).

### Penangguhan cuti (LEAVE-008)

Tidak ada permission baru (`docs/domain/leave-postponement.md` §6). Mengusulkan tanggal lain memakai kepemilikan tahap persetujuan yang sama dengan setujui/tolak (termasuk `leave.governance.approve` untuk akun pengurus ORG-013); menerima dan menolak usulan adalah kepemilikan pengajuan oleh pegawai.

### Masa kritis cuti (LEAVE-009)

Tidak ada permission baru (`docs/domain/leave-critical-periods.md` §6, D-07 DRAFT).

| Tindakan | Permission | Pemegang hari ini |
|---|---|---|
| Kelola masa kritis (`/admin/leave/critical-periods`) | `leave.configuration.manage` | HC Admin (`human_capital_admin`) |
| Putus tinjauan masa kritis (`/leave/hc/critical-reviews`) | `leave.validate` + `leave.hc.approve` (organisasi) | HC yang juga memegang mandat persetujuan HC (`special_approver`), sama seperti Cuti Tanpa Gaji |

### Pinjaman pegawai (LOAN-001)

Migration `0123_employee_loan_permissions.sql`, berscope organisasi (`docs/domain/employee-loans.md` §6, D-13 DRAFT).

| Permission | Pemegang | Catatan |
|---|---|---|
| `loans.read` | Keuangan (`finance_officer`), HC Admin (`human_capital_admin`) | register, jadwal, pembayaran, riwayat |
| `loans.manage` | Keuangan (`finance_officer`) | cair, catat/koreksi pembayaran, batal sebelum cair; tidak atas pinjaman miliknya sendiri |

`payroll.loans.manage` (register kasbon PAY-003) dan `loans.*` tidak saling membuka. Super Admin tidak memperoleh `loans.*` lewat kompatibilitas legacy.

### Pusat Bantuan (HELP-001)

Migration `0131_help_center_permissions.sql`, berscope organisasi (`docs/domain/help-center.md` §6, D-08 DRAFT).

| Permission | Pemegang | Catatan |
|---|---|---|
| `help.manage` | HC Admin (`human_capital_admin`) | membuat, mengedit, menerbitkan, mengarsipkan, memulihkan artikel; mengelola kontak HC; membaca revisi dan riwayat |

Membaca Pusat Bantuan tidak membutuhkan permission: setiap sesi `EMPLOYEE` membaca artikel terbit dan kontak aktif (D-07). Super Admin tidak memperoleh `help.manage` lewat kompatibilitas legacy.

### Kartu Pegawai (EMP-012)

Migration `0133_employee_card_permissions.sql`, berscope organisasi (`docs/domain/employee-id-card.md` §6).

| Permission | Pemegang | Catatan |
|---|---|---|
| `employee_cards.manage` | HC Admin (`human_capital_admin`) | mengunggah pas foto, menerbitkan, menerbitkan ulang, mencabut, mencetak kartu; mengatur penanda tangan dan masa berlaku; membaca riwayat |

Melihat kartu sendiri dan melaporkannya hilang tidak membutuhkan permission (sesi `EMPLOYEE` yang terhubung ke pegawai). Halaman cek keaslian `/public/employee-cards/*` tanpa sesi dan dibatasi lajunya. Super Admin tidak memperoleh `employee_cards.manage` lewat kompatibilitas legacy.

### Arsip Dokumen Pegawai (EMP-011)

Migration `0143_employee_document_permissions.sql`, berscope organisasi (`docs/domain/employee-documents.md` §6, D-08–D-10).

| Permission | Pemegang | Catatan |
|---|---|---|
| `employee_documents.read` | HC Admin (`human_capital_admin`) | membaca arsip dokumen seorang pegawai, mengunduh berkas, membaca daftar kerja akan berakhir dan menunggu verifikasi; setiap pembacaan diaudit |
| `employee_documents.manage` | HC Admin (`human_capital_admin`) | mengunggah, memverifikasi, menolak, mengganti, menghapus isi berkas, dan mengubah metadata |

Melihat, mengunduh, mengusulkan, dan menarik dokumen sendiri tidak membutuhkan permission (sesi `EMPLOYEE` yang terhubung ke pegawai). Tidak ada role bercakupan unit yang membawanya, sehingga atasan tidak membaca dokumen bawahan; `employees.read.all` juga tidak membukanya. Super Admin tidak memperolehnya lewat kompatibilitas legacy. Berkas Perjanjian Kerja/SK (EMP-010) memakai `employment.read`/`employment.manage`, dan mengganti berkas dokumen terkunci butuh juga `employment.correct`.

### Kepanitiaan (ORG-012)

Migration `0135_committee_permissions.sql`, berscope organisasi (`docs/domain/committees.md` §6, D-18 DRAFT).

| Permission | Pemegang | Catatan |
|---|---|---|
| `committees.read` | HC Admin (`human_capital_admin`) | daftar, detail, riwayat, rekap keikutsertaan |
| `committees.manage` | HC Admin (`human_capital_admin`) | mencatat, mengelola anggota, menetapkan (SK), menyelesaikan, membatalkan; pencarian pegawai |

Kepanitiaan Saya tidak membutuhkan permission: aksesnya keanggotaan. Kepanitiaan tidak memberi kewenangan approval apa pun. Super Admin tidak memperoleh `committees.*` lewat kompatibilitas legacy.

Pengurus Yayasan (`foundation_board_viewer`) **tidak** memegang permission payroll apa pun; ORG-003-F dan ORG-010-F melarangnya, dan membukanya membutuhkan ADR tersendiri. Super Admin tidak memperoleh permission payroll lewat kompatibilitas legacy.

## Scope

Baseline:

```text
own
unit
organization
```

Custom scope hanya ditambahkan bila kebutuhan nyata tidak dapat direpresentasikan oleh scope baseline.

## Account state

Target account state didefinisikan di `access-model.md`:

```text
invited
active
suspended
inactive
```

Akun non-active tidak boleh mengakses route terlindungi kecuali flow pemulihan yang secara eksplisit diizinkan.

## Test minimum

Setiap capability harus memiliki test untuk:

- unauthenticated;
- wrong account type;
- wrong role/permission;
- inactive/suspended account;
- allowed own resource;
- forbidden other resource;
- unit boundary;
- board read-only mutation denial;
- direct URL/API authorization bypass attempt;
- audit event untuk aksi sensitif.
