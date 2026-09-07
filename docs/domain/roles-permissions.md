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
- Organ Yayasan (`FOUNDATION_BOARD`) default-nya read only untuk statistik dan report yang diizinkan.
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
| Export report | sesuai modul | sesuai permission | RO/export sesuai permission | sesuai permission |
| Kelola role/permission | - | - | - | A |
| Konfigurasi sistem | - | - | - | A |

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
