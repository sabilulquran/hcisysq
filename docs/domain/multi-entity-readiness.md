# Multi-Entity Readiness Assessment (ORG-007)

**Status:** DRAFT / DISCOVERY  
**Specification:** ORG-007 (lanjutan discovery)  
**Proposed:** 2026-10-27  
**ADR:** ADR-0005 (PROPOSED)  
**Related:** ORG-004, ORG-005, ORG-006, ORG-010, ORG-011, EMP-005, EMP-006, ATT-*, LEAVE-*, PAY-003, AUTH-010, AUTH-011  
**Evidence:** `docs/domain/multi-company-organization.md`, `docs/domain/access-model.md`, `apps/api/migrations/`, `docs/product/roadmap.md` bagian E

`multi-company-organization.md` menjawab "bisakah". Dokumen ini menjawab "apa yang harus berubah", berdasarkan skema yang benar-benar ada hari ini, dan menutup daftar keputusan terbuka ORG-007 dengan default DRAFT supaya pekerjaan tidak berhenti.

Dokumen ini **bukan** izin implementasi. Lihat ADR-0005 §Compliance.

## 1. Keadaan sekarang

HCIS hari ini single-entity, tetapi **bukan tanpa jejak ORG-007**. Dua kolom sudah terpasang sebagai tempat duduk:

| Kolom terpasang | Lokasi | Semantik sekarang |
|---|---|---|
| `employments.legal_entity_key uuid NULL` | `apps/api/migrations/0056_employment_history_foundation.sql:63` | "Reserved for ORG-007; NULL is the implicit YSQ default" |
| `payroll_periods.legal_entity_key uuid NULL` | `apps/api/migrations/0069_payroll_foundation.sql:177` | sama |

Keduanya tanpa foreign key (tabel `legal_entities` belum ada) dan sudah ikut dalam constraint anti-tumpang-tindih: `employments_no_overlap` memakai `COALESCE(legal_entity_key, <uuid nol>)`, begitu juga constraint periode payroll. Artinya aturan "satu employment aktif per employee" **sudah per entity secara teknis** — tidak ada pekerjaan di sana.

Konsekuensi penamaan: ORG-007 memakai **`legal_entity_key`**, bukan `legal_entity_id`, supaya tidak ada dua nama untuk satu konsep (AGENTS.md §3). Foreign key ke `legal_entities` ditambahkan di E1 ketika tabelnya lahir.

Di luar dua kolom itu, 106 tabel aplikasi lainnya (hitungan nama unik `CREATE TABLE` pada `apps/api/migrations/`, 2026-10-27) tidak membawa entity sama sekali. Pembagiannya:

| Kelompok | Contoh | Perlakuan bila ORG-007 aktif |
|---|---|---|
| **A. Entity-owned** (data bisnis milik satu entity) | `employments`, `employment_terms`, `employment_placements`, `organization_change_sets` dan seluruh turunannya, `attendance_daily_records`, `attendance_schedule_versions`, `leave_requests`, `payslips`, `payroll_periods` | wajib punya entity context dan filter otorisasi |
| **B. Person/identity** (satu manusia, lintas entity) | `accounts`, `employees`, `auth_sessions`, `auth_recovery_codes`, `account_activation_tokens` | **tidak** diberi `legal_entity_key`; relasi ke entity lewat employment |
| **C. Platform/global** (katalog sistem) | `roles`, `permissions`, `role_permissions`, `attendance_adms_job_codes` | tetap global |
| **D. Scoped assignment** (global secara bentuk, tetapi berdampak per entity) | `account_role_assignments`, `organization_rollout_settings`, `employment_rollout_settings`, `leave_calendar_settings` | wajib diberi dimensi entity, kalau tidak otorisasi bocor lintas entity |

Kelompok D adalah risiko terbesar dan paling mudah terlewat.

### 1.1 Konvensi NULL sekarang adalah fail-open

`legal_entity_key NULL = YSQ` berarti baris tanpa entity hari ini **terlihat oleh semua orang**. Itu kebalikan dari aturan fail-closed ADR-0005. Selama konvensi NULL masih hidup, fail-closed tidak pernah benar-benar berlaku.

E2 karena itu wajib memuat: buat entity default, konversi seluruh `legal_entity_key NULL` menjadi id entity default, jadikan kolom NOT NULL, lalu hapus konvensi NULL dari kode dan komentar. Tanpa langkah ini, E3 hanya menambah filter di atas data yang defaultnya terbuka.

## 2. Perangkat keras: perangkat kehadiran

`attendance_adms_devices` dan `attendance_adms_employee_mappings` adalah kasus khusus. Mesin absensi berada di satu lokasi fisik, tetapi satu mesin bisa saja dipakai pegawai dari dua entity bila satuan pendidikan berbagi gedung.

Keputusan DRAFT: **device dimiliki satu legal entity** (ikut site ORG-005), tetapi `attendance_adms_employee_mappings` boleh memetakan pegawai dari entity lain ke device itu, dengan syarat event hasilnya tetap jatuh ke entity employment pegawai, bukan entity device. Ini menjaga laporan kehadiran per entity tetap benar tanpa memaksa dua mesin di satu ruangan.

Ini adalah **pengecualian lintas entity bernama** (lihat §3.2): pemetaan device adalah konfigurasi perangkat, bukan akses data bisnis, jadi tidak memerlukan scope `group`. Pengecualian seperti ini harus terdaftar, bukan muncul diam-diam.

## 3. Dampak per domain

### 3.1 Model data

- Tabel baru `legal_entities`: `id`, `code`, `name`, `legal_form` (`FOUNDATION`, `BUSINESS_UNIT`, `OTHER`), `active`, `effective_from`/`effective_to`.
- `employments.legal_entity_key` dan `payroll_periods.legal_entity_key` mendapat foreign key ke `legal_entities`, lalu menjadi NOT NULL setelah konversi NULL (§1.1).
- Setiap tabel kelompok A lainnya mendapat `legal_entity_key` NOT NULL, diturunkan dari employment atau dari root struktur, bukan diketik ulang.
- `employments.legal_entity_key` adalah sumber kebenaran: domain turunan mewarisi dari employment, bukan menyimpan salinan yang dapat menyimpang. Di mana salinan diperlukan untuk performa, nilainya dikunci constraint ke employment.
- Satu `employees` dapat memiliki lebih dari satu `employments` di entity berbeda. Constraint `employments_no_overlap` **sudah** menyertakan `legal_entity_key`, jadi tidak perlu diubah; yang berubah hanya hilangnya COALESCE setelah kolom menjadi NOT NULL.
- ORG-004: setiap root `organization_nodes` dimiliki satu entity; change set juga milik satu entity, sehingga publish struktur entity A tidak menyentuh entity B. Keunikan publish per tanggal **tidak** dihidupkan kembali — ORG-004 sengaja mengizinkan beberapa revisi pada tanggal yang sama sejak `0020_organization_revisions_and_account_holders.sql`; yang ditambahkan hanya `legal_entity_key` pada indeks `organization_change_sets_effective_revision_idx` yang sudah ada.
- ORG-011: katalog klasifikasi dan golongan mendapat `legal_entity_key`; tidak otomatis dibagi.

### 3.2 Akses dan otorisasi

Ini perubahan paling berisiko dan harus dikerjakan sebagai paket tersendiri dengan security review.

- Makna scope dipersempit sesuai `multi-company-organization.md`: `organization` = **satu** legal entity, bukan seluruh instalasi.
- `account_role_assignments` mendapat `legal_entity_key`. Role tanpa entity hanya sah untuk scope `own` dan untuk role platform (Super Admin).
- Scope baru `group` (lintas entity) hanya untuk role yang diberikan eksplisit; tidak ada peningkatan otomatis dari `organization`.
- Setiap query data kelompok A harus memfilter entity. Default aman: **fail closed** — konteks entity yang tidak terselesaikan berarti akses ditolak, bukan akses penuh. Prasyaratnya adalah penghapusan konvensi NULL di §1.1.
- Scope `group` **belum ada** di baseline `access-model.md` (`own`, `unit`, `organization`). E3 harus menambahkannya ke access-model dalam perubahan yang sama, bukan mengasumsikannya sudah ada.
- Penyempitan makna `organization` mengubah arti setiap permission ber-scope itu yang sudah berjalan, termasuk `reports.read.organization`, seluruh `payroll.*` (PAY-003 §2), dan `board.read` (ORG-010). E3 wajib membawa daftar lengkap permission ber-scope `organization` beserta perilaku barunya, dan regression untuk masing-masing.
- **Pengecualian lintas entity yang diizinkan tanpa scope `group`**, dan hanya ini: (a) `payslips.read.own` dan self-service ber-scope `own` lainnya, karena principal membaca datanya sendiri; (b) pemetaan device ADMS lintas entity (§2), karena itu konfigurasi perangkat, bukan data bisnis. Pengecualian baru hanya boleh ditambahkan lewat perubahan ADR-0005.
- Traversal authority ORG-004 tidak boleh melintasi entity. Atasan di entity A tidak menjadi approver bagi pegawai entity B kecuali ada binding lintas-entity eksplisit.
- Pegawai dengan dua employment aktif punya dua konteks; UI memerlukan pemilih entity, dan API memerlukan konteks employment yang eksplisit, bukan "employment pertama yang ditemukan".

### 3.3 Payroll

- Payroll period, komponen, kebijakan, dan payslip semuanya milik satu entity. Tidak ada run gabungan.
- Tabel kebijakan berversi PAY-003 menjadi per entity. Entity baru dimulai dari salinan eksplisit, bukan warisan diam-diam.
- Pegawai dengan dua employment menerima **dua slip**, satu per entity. Tidak ada penggabungan take-home pay.
- PPh21: penggabungan penghasilan lintas entity untuk satu orang adalah masalah perpajakan nyata, bukan masalah teknis. v1 ORG-007 **tidak** menggabungkan; penggabungan ditandai sebagai kewajiban manual Keuangan sampai ada keputusan owner dan proses owner payroll. Ini risiko yang harus ditulis di runbook, bukan disembunyikan.
- `payslips.read.own` tetap menampilkan seluruh slip milik person lintas entity, karena itu haknya sendiri.

### 3.4 Kehadiran dan cuti

- Kalender libur, pengaturan cuti, dan kebijakan jadwal menjadi per entity.
- Saldo cuti terikat employment, jadi otomatis terpisah per entity. Perpindahan antar entity **tidak** memindahkan saldo; sisa saldo diselesaikan di entity asal sesuai kebijakan.
- Hasil kehadiran harian mengikuti entity employment, bukan entity device (lihat §2).

### 3.5 Pelaporan

- Semua laporan default ke satu entity dan menyatakan entity-nya di judul serta di ekspor.
- Laporan group-level hanya berupa agregat dan hanya untuk scope `group`. Tidak ada daftar per orang lintas entity tanpa scope `group`.
- ORG-010 governance summary ke SQ Hub: kontrak harus membawa identifier entity. Sampai itu ada, ringkasan tetap satu entity dan tidak boleh dijumlahkan diam-diam.
- ORG-006 directory projection membawa identifier entity yang stabil, supaya SQ Hub tidak mencampur dua struktur.

### 3.6 Perpindahan antar entity

Mengikuti `multi-company-organization.md`: tutup employment lama, buka employment baru, pertahankan person. Tambahan dari dokumen ini:

- Perpindahan adalah employment action baru (EMP-006), bukan mutasi biasa, dengan referensi ke employment asal.
- Masa kerja (MKG) untuk skala gaji: default DRAFT **meneruskan masa kerja dari entity asal** bila perpindahan terjadi dalam satu grup yayasan, karena memutus MKG akan memotong gaji pegawai yang dipindahkan atas keputusan organisasi. Perlu konfirmasi owner.
- Riwayat karier menampilkan keduanya sebagai satu alur, meski datanya dimiliki dua entity.

## 4. Keputusan terbuka ORG-007, dengan default DRAFT

| Keputusan terbuka (ORG-007) | Default DRAFT | Alasan |
|---|---|---|
| Apakah "company" selalu badan hukum | tidak; `legal_form` boleh `BUSINESS_UNIT` | satuan pendidikan YSQ belum tentu badan hukum terpisah |
| Siapa yang boleh membuat entity | hanya Super Admin, dan hanya lewat operasi yang teraudit | pembuatan entity mengubah batas otorisasi |
| Apakah pegawai boleh aktif di dua entity bersamaan | ya | kasus nyata: guru mengajar di dua satuan pendidikan |
| Apakah entitlement cuti terpisah | ya, per employment | saldo sudah terikat employment |
| Apakah payroll selalu terpisah | ya | tidak ada run gabungan pada v1 |
| Apakah perlu pelaporan group-level | ya, tetapi hanya agregat dan hanya scope `group` | Pengurus butuh gambaran yayasan |
| Apakah ada authority lintas entity | tidak secara default; hanya binding eksplisit | mencegah kebocoran approval |
| Lifecycle account bila employment terakhir berakhir | account dinonaktifkan hanya bila tidak ada employment aktif di entity mana pun | mencegah pegawai kehilangan akses karena satu kontrak berakhir |
| Nama kolom entity | `legal_entity_key`, mengikuti kolom yang sudah terpasang | menghindari dua nama untuk satu konsep |
| Kapan konvensi `NULL = YSQ` dihapus | di E2, sebelum E3 | tanpa itu fail-closed tidak pernah berlaku |
| Apakah pengecualian lintas entity boleh bertambah | tidak, kecuali lewat perubahan ADR-0005 | mencegah pengecualian tumbuh diam-diam |

## 5. Urutan pengerjaan yang diusulkan

Setiap langkah berdiri sendiri dan dapat dirilis tanpa mengaktifkan multi-entity.

1. **E1 Fondasi (aman):** tabel `legal_entities`, satu entity default YSQ, foreign key untuk dua kolom `legal_entity_key` yang sudah terpasang. Tanpa perubahan perilaku dan tanpa UI.
2. **E2 Entity context (aman):** konversi `legal_entity_key NULL` menjadi entity default dan jadikan NOT NULL (§1.1), lalu tambahkan `legal_entity_key` pada tabel kelompok A lainnya, diturunkan dari employment, dengan constraint. Masih satu entity, jadi hasilnya tidak berubah.
3. **E3 Otorisasi (berisiko, wajib security review):** entity pada `account_role_assignments`, penyempitan makna scope `organization`, fail-closed, regression otorisasi penuh.
4. **E4 Domain scoping:** payroll, cuti, kehadiran, kalender, katalog ORG-011 menjadi per entity.
5. **E5 Pelaporan dan projection:** identifier entity pada ORG-006 dan ORG-010, laporan menyatakan entity.
6. **E6 Aktivasi:** pemilih entity dan admin entity dibuka hanya setelah entity kedua benar-benar dibutuhkan, dan hanya setelah E3 lolos regression.

UX tetap single-company selama hanya ada satu entity aktif. Tidak ada pemilih entity yang muncul tanpa entity kedua.

## 6. Yang tidak akan dikerjakan

- Multi-tenancy SaaS, provisioning tenant, billing.
- Database per entity.
- Penggabungan payroll antar entity secara otomatis.
- Pemberian akses lintas entity secara otomatis.
- Duplikasi person karena bekerja di dua entity.
