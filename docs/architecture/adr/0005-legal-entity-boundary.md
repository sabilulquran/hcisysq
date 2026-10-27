# ADR-0005: Legal Entity sebagai Boundary di Atas ORG-004, Bukan Tenant (ORG-007)

- **Status:** PROPOSED
- **Date:** 2026-10-27
- **Related:** ORG-004, ORG-005, ORG-006, ORG-010, ORG-011, EMP-005, EMP-006, PAY-003, AUTH-010, AUTH-011; ADR-0001, ADR-0003, ADR-0004
- **Evidence:** `docs/domain/multi-company-organization.md`, `docs/domain/multi-entity-readiness.md`, `docs/domain/access-model.md`, `apps/api/migrations/`

## Context

Roadmap bagian E menyatakan HCIS dapat melayani beberapa company atau legal entity dalam satu instalasi tanpa menjadi SaaS multi-tenant. Yayasan Sabilul Qur'an memiliki beberapa satuan pendidikan dan kemungkinan badan hukum terpisah.

Keadaan sekarang: tidak ada satu pun dari 91 tabel aplikasi yang membawa legal entity. Single-entity bersifat implisit, bukan dideklarasikan. Akibatnya scope `organization` hari ini berarti "seluruh isi database", dan makna itu akan menjadi kebocoran otorisasi pada hari entity kedua dibuat.

Dua tekanan berlawanan:

- menunda seluruhnya berarti setiap fitur baru (payroll PAY-003, klasifikasi ORG-011, administrasi EMP-005/006) menambah utang yang harus dibongkar nanti;
- mengerjakan seluruhnya sekarang berarti membongkar otorisasi untuk kebutuhan yang belum nyata.

## Decision

1. Legal entity adalah **boundary di atas** struktur ORG-004, bukan pengganti ORG-004 dan bukan tenant SaaS. Deployment, kode, identity platform, dan database tetap satu.
2. **Person tidak diduplikasi.** `accounts` dan `employees` tidak pernah mendapat `legal_entity_id`. Relasi ke entity selalu melalui `employments`, yang menjadi satu-satunya sumber kebenaran entity untuk data turunan.
3. Scope `organization` berarti **satu legal entity**, bukan seluruh instalasi. Akses lintas entity hanya lewat scope `group` yang diberikan eksplisit, tanpa peningkatan otomatis.
4. **Fail closed.** Konteks entity yang tidak terselesaikan berarti akses ditolak.
5. Payroll, cuti, kehadiran, kalender, kebijakan, dan katalog ORG-011 terpisah per entity. Tidak ada run payroll gabungan dan tidak ada penggabungan saldo cuti.
6. Perpindahan antar entity adalah tutup-dan-buka employment dengan person yang dipertahankan, bukan penggantian `company_id`.
7. **Pengerjaan bertahap E1..E6** (`multi-entity-readiness.md` §5). E1 dan E2 aman dan dapat dikerjakan lebih dulu karena tidak mengubah perilaku selama hanya ada satu entity. E3 (otorisasi) adalah paket terpisah yang wajib melewati security review dan regression otorisasi penuh.
8. **Aktivasi multi-entity ditunda** sampai entity kedua benar-benar dibutuhkan. UX tetap single-company selama hanya satu entity aktif.

## Consequences

Positif:

- Fitur yang sedang dibangun sekarang dapat menurunkan entity dari employment tanpa redesign, karena arah sudah ditetapkan.
- Risiko terbesar (otorisasi) diisolasi menjadi satu paket dengan gate review sendiri, bukan tersebar.
- Operator tidak melihat kompleksitas multi-entity selama YSQ masih satu entity.

Negatif atau biaya:

- `legal_entity_id` akan muncul di puluhan tabel dan di hampir setiap query data bisnis.
- Penyempitan makna scope `organization` adalah perubahan semantik pada otorisasi yang sudah berjalan; tanpa regression menyeluruh ini berbahaya.
- Pegawai dengan dua employment menerima dua slip gaji dan punya dua konteks di UI; ini membebani operator dan pegawai.
- PPh21 lintas entity untuk satu orang tidak diselesaikan sistem pada v1 dan menjadi kewajiban manual Keuangan. Ini risiko kepatuhan yang harus tercatat di runbook.

## Alternatives considered

| Alternatif | Alasan ditolak |
|---|---|
| SaaS multi-tenant penuh (database per tenant) | jauh melebihi kebutuhan; menambah biaya operasi Mi8VPS dan tidak ada tenant komersial |
| Duplikasi employee per entity | memecah identity satu manusia, merusak riwayat karier dan akses self-service |
| Entity sebagai node ORG-004 biasa | entity membawa boundary otorisasi dan payroll; node tidak, dan pencampuran keduanya membuat authority bocor |
| Tunda seluruhnya sampai entity kedua ada | setiap fitur yang dibangun sekarang menambah utang yang harus dibongkar di bawah tekanan waktu |
| Kerjakan seluruh E1..E6 sekarang | membongkar otorisasi produksi untuk kebutuhan yang belum nyata |

## Compliance

- ADR ini `PROPOSED`. Tidak ada migration ORG-007 yang boleh dibuat sebelum statusnya `ACCEPTED`.
- E3 tidak boleh di-merge tanpa security review dan regression otorisasi penuh.
- Tidak boleh ada `legal_entity_id` pada `accounts` maupun `employees`.
- Tidak boleh ada jalur kode yang memberi akses lintas entity tanpa scope `group` yang eksplisit.
- Setiap laporan dan ekspor wajib menyatakan entity-nya.
- Default DRAFT pada `multi-entity-readiness.md` §4 berlaku sampai owner memutuskan lain.
