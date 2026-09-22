# Multi-Company / Multi-Legal-Entity Organization

**Status:** PROPOSED / DISCOVERY  
**Specification:** ORG-007  
**Proposed:** 2026-09-22  
**Related:** ORG-001, ORG-004, ORG-005, ORG-006, EMP-005, EMP-006, AUTH-010

## Question

Bisakah satu HCIS menangani beberapa company/legal entity tanpa merusak struktur organisasi ORG-004 yang sudah ada?

Jawaban desain: bisa, dengan menjadikan company/legal entity sebagai boundary di atas struktur ORG-004, bukan mengganti ORG-004.

## Proposed model

```text
HCIS installation
  |
  +-- Enterprise Group (optional logical grouping)
       |
       +-- Legal Entity / Company A
       |    |
       |    +-- ORG-004 organization structure
       |    +-- ORG-005 sites / work locations
       |
       +-- Legal Entity / Company B
            |
            +-- ORG-004 organization structure
            +-- ORG-005 sites / work locations
```

Existing YSQ deployment dapat dimigrasikan sebagai satu default legal entity tanpa mengubah mental model pengguna yang sekarang.

## Why legal entity, not tenant

Target ini bukan SaaS commercial multi-tenancy.

Company/legal entity berbagi:

- deployment;
- identity platform;
- application code;
- database infrastructure.

Tetapi data bisnis sensitif harus selalu mempunyai legal-entity scope dan authorization yang eksplisit.

## Person, employee, and employment

Satu manusia tidak boleh diduplikasi hanya karena bekerja pada lebih dari satu entity.

Arah model:

```text
Person identity
  -> Employment A @ Legal Entity A
  -> Employment B @ Legal Entity B
```

Dengan demikian satu account dapat mempertahankan identity yang sama, sedangkan kontrak, position assignment, payroll, leave, attendance, dan authority mengikuti employment/legal entity yang tepat.

## Integration with ORG-004

ORG-004 tetap dipakai apa adanya secara konseptual, tetapi setiap root structure harus dimiliki satu legal entity.

```text
Legal Entity
  -> organization nodes
  -> positions
  -> incumbencies
  -> authority bindings
```

Traversal authority tidak boleh meloncat antar legal entity kecuali ada policy lintas-entity yang dibuat eksplisit kemudian.

## Integration with ORG-005

ORG-005 site/branch/work location selalu berada di bawah satu legal entity.

Satu entity dapat mempunyai banyak site.

```text
Company A
  -> Head Office
  -> School Site 1
  -> School Site 2
```

Site bukan company, dan company bukan site.

## Cross-company move

Perpindahan employee antar company sebaiknya tidak diperlakukan sebagai "mutasi biasa" yang mengganti company_id secara diam-diam.

Target semantics:

1. employment lama ditutup/effective-ended;
2. employment baru dibuat di legal entity tujuan;
3. person/account identity dapat dipertahankan;
4. career history menampilkan hubungan keduanya;
5. payroll/leave/attendance history lama tetap milik legal entity asal.

## Authorization

Existing scope `organization` tidak boleh otomatis berarti seluruh company dalam instalasi.

Arah:

- `own` = data principal sendiri;
- `unit` = unit pada satu legal entity;
- `organization` = satu legal entity;
- future `group` / multi-entity scope hanya untuk role yang secara eksplisit diberi akses lintas entity.

Human Capital entity A tidak boleh melihat payroll entity B hanya karena sama-sama menggunakan HCIS.

## Domain scoping

Bila ORG-007 diimplementasikan, minimal domain berikut harus mempunyai legal-entity context yang jelas:

- employment/contract;
- organization structure;
- site/work location;
- attendance and schedule;
- leave policy/balance;
- payroll/payslip;
- reimbursement/loan;
- HR documents;
- reporting/audit.

## SQ Hub integration

ORG-006 projection ke SQ Hub harus membawa stable legal-entity identifier bila ORG-007 diaktifkan, sehingga directory tidak mencampur struktur dua company secara ambigu.

## Migration strategy

ORG-007 tidak boleh memaksa redesign data current sebelum kebutuhan nyata disetujui.

Proposed compatibility path:

1. tambahkan legal entity model;
2. buat satu default entity untuk current YSQ;
3. backfill existing organization/site/employment references ke default entity;
4. pertahankan UX single-company bila hanya satu entity aktif;
5. expose company switcher/admin only setelah entity kedua benar-benar dibuat;
6. lakukan authorization regression sebelum multi-entity activation.

## Open decisions

Sebelum status berubah menjadi ACCEPTED/IMPLEMENTATION, tentukan:

- apakah "company" selalu badan hukum atau boleh unit usaha non-badan-hukum;
- siapa yang boleh membuat entity;
- apakah employee boleh aktif di dua entity bersamaan;
- apakah leave entitlement lintas entity terpisah;
- apakah payroll selalu terpisah;
- apakah group-level reporting diperlukan;
- apakah ada authority lintas entity;
- bagaimana identity/account lifecycle bila employment terakhir berakhir.

## Non-goals

- SaaS tenant provisioning;
- billing per tenant;
- database-per-company;
- otomatis menggabungkan payroll antar company;
- otomatis memberi akses lintas entity.
