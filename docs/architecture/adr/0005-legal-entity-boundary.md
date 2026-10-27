# ADR-0005: Legal Entity sebagai Boundary di Atas ORG-004, Bukan Tenant (ORG-007)

- **Status:** PROPOSED
- **Date:** 2026-10-27
- **Related:** ORG-004, ORG-005, ORG-006, ORG-010, ORG-011, EMP-005, EMP-006, PAY-003, AUTH-010, AUTH-011; ADR-0001, ADR-0003, ADR-0004
- **Evidence:** `docs/domain/multi-company-organization.md`, `docs/domain/multi-entity-readiness.md`, `docs/domain/access-model.md`, `apps/api/migrations/`

## Context

Roadmap bagian E menyatakan HCIS dapat melayani beberapa company atau legal entity dalam satu instalasi tanpa menjadi SaaS multi-tenant. Yayasan Sabilul Qur'an memiliki beberapa satuan pendidikan dan kemungkinan badan hukum terpisah.

Keadaan sekarang: ORG-007 sudah mempunyai dua tempat duduk di skema — `employments.legal_entity_key` dan `payroll_periods.legal_entity_key`, keduanya `uuid NULL` tanpa foreign key, dengan konvensi "NULL berarti YSQ". Keduanya sudah ikut dalam constraint anti-tumpang-tindih, sehingga aturan satu employment aktif per employee secara teknis sudah per entity. Di luar itu, 106 tabel aplikasi lainnya tidak membawa entity sama sekali.

Dua akibatnya:

1. scope `organization` hari ini berarti "seluruh isi database", dan makna itu menjadi kebocoran otorisasi pada hari entity kedua dibuat;
2. konvensi `NULL = YSQ` adalah **fail-open**: baris tanpa entity terlihat oleh semua orang. Menambahkan filter entity di atas konvensi itu tidak menghasilkan keamanan apa pun.

Dua tekanan berlawanan:

- menunda seluruhnya berarti setiap fitur baru (payroll PAY-003, klasifikasi ORG-011, administrasi EMP-005/006) menambah utang yang harus dibongkar nanti;
- mengerjakan seluruhnya sekarang berarti membongkar otorisasi untuk kebutuhan yang belum nyata.

## Decision

1. Legal entity adalah **boundary di atas** struktur ORG-004, bukan pengganti ORG-004 dan bukan tenant SaaS. Deployment, kode, identity platform, dan database tetap satu.
2. **Person tidak diduplikasi.** `accounts` dan `employees` tidak pernah mendapat kolom entity. Relasi ke entity selalu melalui `employments`, yang menjadi satu-satunya sumber kebenaran entity untuk data turunan.
3. **Nama kolom adalah `legal_entity_key`**, mengikuti kolom yang sudah terpasang, bukan `legal_entity_id` baru. Foreign key ke `legal_entities` ditambahkan saat tabel itu lahir.
4. **Konvensi `NULL = YSQ` dihapus di E2**, sebelum otorisasi disentuh: konversi NULL menjadi entity default, kolom menjadi NOT NULL. Tanpa langkah ini aturan fail-closed di bawah tidak pernah berlaku.
5. Scope `organization` berarti **satu legal entity**, bukan seluruh instalasi. Akses lintas entity hanya lewat scope `group` yang diberikan eksplisit, tanpa peningkatan otomatis.
6. **Fail closed.** Konteks entity yang tidak terselesaikan berarti akses ditolak.
7. Payroll, cuti, kehadiran, kalender, kebijakan, dan katalog ORG-011 terpisah per entity. Tidak ada run payroll gabungan dan tidak ada penggabungan saldo cuti.
8. Perpindahan antar entity adalah tutup-dan-buka employment dengan person yang dipertahankan, bukan penggantian `company_id`.
9. **Pengerjaan bertahap E1..E6** (`multi-entity-readiness.md` §5). E1 dan E2 aman dan dapat dikerjakan lebih dulu karena tidak mengubah perilaku selama hanya ada satu entity. E3 (otorisasi) adalah paket terpisah yang wajib melewati security review dan regression otorisasi penuh.
10. **Aktivasi multi-entity ditunda** sampai entity kedua benar-benar dibutuhkan. UX tetap single-company selama hanya satu entity aktif.
11. **Pengecualian lintas entity bersifat tertutup dan bernama.** Hanya dua yang diizinkan tanpa scope `group`: self-service ber-scope `own` (termasuk `payslips.read.own`, karena principal membaca datanya sendiri) dan pemetaan device ADMS lintas entity, karena itu konfigurasi perangkat dan bukan data bisnis. Pengecualian baru hanya lewat perubahan ADR ini.

## Consequences

Positif:

- Fitur yang sedang dibangun sekarang dapat menurunkan entity dari employment tanpa redesign, karena arah sudah ditetapkan.
- Risiko terbesar (otorisasi) diisolasi menjadi satu paket dengan gate review sendiri, bukan tersebar.
- Operator tidak melihat kompleksitas multi-entity selama YSQ masih satu entity.

Negatif atau biaya:

- `legal_entity_key` akan muncul di puluhan tabel dan di hampir setiap query data bisnis.
- Penyempitan makna scope `organization` adalah perubahan semantik pada otorisasi yang sudah berjalan; tanpa regression menyeluruh ini berbahaya. Scope `group` juga belum ada di `access-model.md`, sehingga E3 harus menambahkannya di sana dan mendaftar ulang setiap permission ber-scope `organization` (`reports.read.organization`, seluruh `payroll.*`, `board.read` ORG-010) beserta perilaku barunya.
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
- Tidak boleh ada kolom entity pada `accounts` maupun `employees`.
- Nama kolom entity di seluruh skema adalah `legal_entity_key`.
- E2 tidak selesai sebelum konvensi `NULL = YSQ` hilang dan kolom menjadi NOT NULL.
- Tidak boleh ada jalur kode yang memberi akses lintas entity tanpa scope `group` yang eksplisit.
- Setiap laporan dan ekspor wajib menyatakan entity-nya.
- Default DRAFT pada `multi-entity-readiness.md` §4 berlaku sampai owner memutuskan lain.
