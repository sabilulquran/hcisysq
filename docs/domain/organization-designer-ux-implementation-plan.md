# ORG-008 — Rencana Implementasi Designer Struktur Organisasi

**Status:** DISETUJUI OWNER 2026-10-23 — eksekusi berjalan. **ORG-008-1 selesai** (frontend saja). Paket berikutnya menurut urutan di bawah: ORG-008-8, yang menunggu keputusan owner B (pemegang izin Terbitkan).
**Specification:** ORG-008 (`organization-designer-ux-spec.md`, ACCEPTED, O-1..O-10)
**Gap analysis:** `organization-designer-ux-gap-analysis.md`
**Batas semantik:** ORG-004 (`dynamic-organization-structure.md`, `organization-designer-visual-ranking.md`)
**Baseline kode:** `main` `2b87b86`; rilis production `hcis-2b87b865-20261023` (dikonfirmasi dari `readlink -f /srv/hcis/current` via `ssh mi8vps`, read-only)
**Disusun:** 2026-10-23

---

## 0. Ringkasan keputusan rencana

1. Urutan yang direkomendasikan **berbeda dari §9 spec**: penjaga keselamatan `publish` dipindah maju, dipecah menjadi potongan tanpa migration (**ORG-008-3a**) yang dapat dirilis segera setelah ORG-008-1.
   Urutan: **1 → 8 → 3a → 3b → 2 → 4 → 6 → 5 → 7**.
2. **ORG-008-8 sebagaimana tertulis di spec tidak menghasilkan manfaat operator penuh.** Tidak ada satu pun role yang memiliki `approvals.policy.manage`; hanya kompatibilitas legacy Super Admin yang memilikinya (bukti di §5.1). Tanpa keputusan owner tentang pemegang izin **Terbitkan**, HC Admin tetap harus memanggil Super Admin untuk menerbitkan.
3. Risiko kehilangan terbitan (gap D-2) **terbukti dari kode**, bukan dugaan (§3). Ini risiko data, bukan risiko UX, dan karena itu didahulukan.
4. Target performa §4.8 spec **tidak akan tercapai tanpa dua perbaikan teknis** yang saat ini belum ada di paket mana pun (§4). Keduanya adalah perubahan internal tanpa efek pada semantik resolver dan diusulkan menumpang di ORG-008-3b dan ORG-008-2.
5. Verifikasi butir TBD jumlah baris jabatan read-only di production **gagal diselesaikan di sesi ini**: `psql` tersedia di Mi8VPS tetapi `DATABASE_URL` hanya terbaca oleh root dan pembacaannya ditolak. Query read-only yang persis dibutuhkan ada di §5.4; membutuhkan persetujuan owner.

---

## 1. Isi, ketergantungan, dan urutan paket

### 1.1 Urutan yang direkomendasikan

```text
ORG-008-1   Bahasa, banner, gating                    frontend saja          SELESAI
ORG-008-8   Izin penyusunan (O-1)                     API (konstanta permission) — butuh keputusan owner pendamping
ORG-008-3a  Penjaga publish dasar usang               API, TANPA migration      ← dipindah maju dari §9 spec
ORG-008-3b  Siklus perubahan (daftar/reopen/discard/rebase/If-Match)  API + migration
ORG-008-2   Pegawai, Kesiapan, Cek persetujuan        API read-only (6 endpoint)
ORG-008-4   Perintah gabungan dan koreksi             API + migration (jurnal)
ORG-008-6   Tautan ATT-011 (legacy_unit_id)           API + migration
ORG-008-5   Pengaturan lanjutan + bagan                frontend saja
ORG-008-7   Usulan awal dari data lama (O-3)          API (menulis draft biasa)
```

Perbedaan dari urutan §9 spec (`1 → 8 → 2 → 3 → 4 → (6 ∥ 5) → 7`): ORG-008-3 dipecah dan bagian penjaganya dimajukan ke depan ORG-008-2. Alasannya di §3. ORG-008-6 dinaikkan di atas ORG-008-5 karena ORG-008-6 adalah prasyarat notifikasi ATT-011-6b, sedangkan ORG-008-5 murni kenyamanan.

### 1.2 Isi dan ketergantungan

| Paket | Isi ringkas | Bergantung pada | Memblokir |
|---|---|---|---|
| **1** Bahasa, banner, gating | Kamus istilah §3 spec di seluruh `AdminOrganizationPage.tsx` dan `OrganizationChart.tsx`; banner mode dari `GET /admin/organization/rollout` yang sudah ada; peta kode→kalimat §7 spec; sembunyikan tombol yang pasti 403; pencarian pegawai di sisi klien + sembunyikan nonaktif; konfirmasi untuk **Kosongkan**/**Hapus Plt**; draft tidak lagi tertutup saat tanggal diganti (D-1 sebagian); empty/error state; UAT sintetis walkthrough §3 gap analysis | — | semua paket lain (bahasa dan peta pesan dipakai ulang) |
| **8** Izin penyusunan | Ubah permission 4 endpoint penyusunan dari `approvals.policy.manage` → `organization.manage`; `publish` dan `PATCH /rollout` tidak berubah; manifest AUTH-011 + OpenAPI; label "Siap diterbitkan — menunggu Kepala HC" | 1 (untuk label) | pekerjaan pengisian struktur nyata oleh HC |
| **3a** Penjaga publish | `409 ORGANIZATION_DRAFT_BASE_STALE` pada `publish`; penanda "dasar usang" pada respons `GET /designer` dan di layar | 1 | pengisian struktur nyata |
| **3b** Siklus perubahan | `GET /drafts`, `reopen`, `discard`, `rebase`, revisi `If-Match`, satu perubahan terbuka (O-7); layar Perubahan; **Periksa & lihat dampak** satu tombol; migration `DISCARDED` + kolom `revision` | 3a | 4 (rebase dipakai ulang oleh jurnal) |
| **2** Read model | `GET /people`, `/readiness`, `/explanation`, `POST /resolution-preview` tanpa draft, `GET /designer/employees` dengan paging, `GET /capabilities`, `GET /rollout` diperluas; tab Pegawai, Kesiapan, Plt (lihat saja), Cek persetujuan + laporan perbandingan | 1 | pemilihan unit pilot (O-11), SHADOW, ATT-011-6b |
| **4** Perintah gabungan | `POST /drafts/:id/commands` (7 tipe), hapus/akhiri binding di draft, hapus item belum terbit, nonaktif dengan cek pemakaian, jurnal "Yang berubah", alur jabatan utama | 3b, 2 (daftar dampak bernama), 8 | 5, 7 |
| **6** Tautan ATT-011 | Kolom `organization_nodes.legacy_unit_id`; layar tautan unit; panel "Staf HC unit ini"; `GET /admin/organization/positions/search` | 2, 4 | ATT-011-6b (notifikasi HC per unit) |
| **5** Pengaturan lanjutan | Penyetuju khusus/diberi tahu sebagai kalimat; rank visual pindah ke "Tampilan"; cari/fokus/ciutkan di bagan; daftar bertingkat mobile | 4 | — |
| **7** Usulan awal | `POST /drafts/from-legacy` dari `organizational_units`, Unit Approver ORG-002, `direct_manager_employee_id` | 2 (laporan perbandingan = bukti kualitas usulan), 4 | — |

### 1.3 Paket yang paling cepat memberi manfaat operator

Urut dari manfaat tercepat per satuan usaha:

1. **ORG-008-1** — manfaat langsung tanpa risiko: operator berhenti membaca `PRIMARY_MEMBERSHIP_OVERLAP` dan `nodeType = UNIT`, dan berhenti kehilangan draft karena mengganti tanggal (D-1). Tanpa API, tanpa migration, dapat dirilis sendiri.
2. **ORG-008-2** — manfaat terbesar secara absolut: menjawab empat dari lima pertanyaan HC di §1 spec ("siapa atasan setiap pegawai", "siapa belum punya unit", "siapa menyetujui siapa") dan merupakan satu-satunya sumber data untuk memilih unit pilot O-11. Read-only, nol risiko data.
3. **ORG-008-4** — menurunkan "mendaftarkan SDIT" dari ≈14 dialog + 30 centang menjadi ≈5 langkah (§3 gap analysis). Manfaat besar tetapi usaha terbesar dan menyentuh otorisasi.

ORG-008-3a/3b tidak terasa sebagai "fitur" bagi operator, tetapi mencegah kerja berjam-jam hilang; karena itu tetap didahulukan meski bukan manfaat yang terlihat.

---

## 2. Paket frontend murni vs paket yang menyentuh API, dan batas semantik

### 2.1 Pembagian

| Paket | Frontend | API | Migration | Catatan |
|---|---|---|---|---|
| 1 | ya | tidak | tidak | hanya memakai endpoint yang ada |
| 8 | label saja | ya (konstanta permission) | tidak | murni otorisasi → review tambahan |
| 3a | ya (penanda) | ya (`publish`, `GET /designer`) | **tidak** | penolakan baru, bukan perubahan perilaku terbit |
| 3b | ya | ya | ya (`DISCARDED`, `revision`) | review tambahan: migration + publish |
| 2 | ya | ya (6 endpoint read-only) | tidak | tidak menulis apa pun |
| 4 | ya | ya (perintah, hapus/akhiri) | ya (jurnal) | review tambahan: authority/permission |
| 6 | ya | ya | ya (`legacy_unit_id`) | review tambahan: migration + notifikasi |
| 5 | ya | tidak | tidak | memakai ORG-008-4 |
| 7 | kecil | ya (1 endpoint) | tidak | hanya menulis draft |

### 2.2 Yang tidak boleh berubah (dibuktikan per PR)

ORG-008 adalah lapisan UX. Berkas berikut **tidak boleh berubah perilakunya** di paket mana pun; perubahan di dalamnya hanya boleh berupa penambahan yang tidak mengubah hasil:

| Batas | Lokasi | Cara membuktikan |
|---|---|---|
| Presedensi resolver (override → governance → leader/supervisory → acting → vacancy → eligibility → self/cycle) | `apps/api/src/modules/organization/resolver.ts` | `apps/api/test/organization-resolver.test.ts` lulus tanpa diubah |
| Pemilihan snapshot berlaku: `status='PUBLISHED' AND effective_on <= $1 ORDER BY effective_on DESC, published_at DESC` | `repository.ts` `loadEffectiveSnapshot` | query tidak disentuh di paket mana pun; ditegaskan ulang di review ORG-008-3 |
| Immutability snapshot terbit | `replaceDraftSnapshot` menolak non-`DRAFT` | test yang ada + test baru ORG-008-3b |
| Snapshot approval saat submit | modul Leave | `apps/api/test/leave-organization-integration.test.ts` lulus tanpa diubah |
| Rollout `LEGACY/SHADOW/STRUCTURE` | `organization_rollout_settings`, `PATCH /admin/organization/rollout` | **tidak ada paket ORG-008 yang menulis baris rollout**; test: setelah seluruh alur ORG-008, `SELECT count(*) FROM organization_rollout_settings` tidak berubah |
| Rank visual tidak memengaruhi kewenangan | `organization-impact.test.ts` | lulus tanpa diubah |

Tidak ada UI untuk mengubah mode rollout di ORG-008. Banner §4.1 spec hanya membaca.

### 2.3 Temuan: banner mode bisa berbohong di luar LEGACY

`GET /admin/organization/rollout` hari ini mengembalikan **satu baris terakhir apa pun** (`ORDER BY created_at DESC LIMIT 1`), tanpa menyaring `workflow_key`, `node_key`, maupun tanggal berlaku. Resolver sebaliknya memilih baris yang efektif per workflow dan per node (`resolveRolloutMode`). Selama production memiliki **nol baris** rollout, endpoint mengembalikan `LEGACY` dan banner benar. Begitu baris pertama ditulis, banner dapat menampilkan mode yang tidak dipakai resolver.

Konsekuensi untuk rencana: banner ORG-008-1 hanya boleh menyatakan "memakai data atasan lama" ketika tidak ada baris rollout; untuk keadaan lain ia harus menyatakan "mode tidak dapat dipastikan di layar ini" sampai `GET /rollout` diperluas di ORG-008-2. Tanpa aturan ini, acceptance **ORG-008-K** ("banner selalu menyatakan dengan benar") tidak dapat dipenuhi oleh ORG-008-1.

---

## 3. Penjaga keselamatan `publish` — ya, didahulukan

### 3.1 Masalahnya nyata, bukan dugaan

Terbukti dari tiga tempat di kode baseline:

- `repository.ts` `loadEffectiveSnapshot` memilih snapshot dengan `ORDER BY effective_on DESC, published_at DESC`;
- `repository.ts` `createDraft` menyalin **seluruh** isi dasar sekali pada saat draft dibuat, dan tidak pernah menyegarkannya;
- `admin-routes.ts` `publish` hanya memeriksa `status === 'VALIDATED'`.

Skenario kehilangan data:

```text
1 Okt   : terbit "Struktur Oktober"                         (berlaku 1 Okt)
15 Okt  : draft "Restruktur 2027" dibuat dari Struktur Oktober (berlaku 1 Jan 2027)
20 Okt  : terbit "Koreksi Oktober"                          (berlaku 24 Okt)
20 Okt  : "Restruktur 2027" diterbitkan — tetap berisi salinan 1 Okt
1 Jan 27: loadEffectiveSnapshot memilih Restruktur 2027 (effective_on tertinggi)
          → seluruh isi "Koreksi Oktober" hilang secara diam-diam
```

Tidak ada peringatan di mana pun dalam alur tersebut. Karena snapshot bersifat lengkap (bukan delta), "hilang" di sini berarti seluruh perubahan koreksi, bukan satu baris.

### 3.2 Mengapa didahulukan, dan bagaimana dipecah

Didahulukan, dengan satu nuansa: **bagian yang mendesak tidak membutuhkan migration**, sehingga tidak perlu menunggu paket ORG-008-3 yang utuh.

- **ORG-008-3a (tanpa migration, kecil).** Aturan penolakan dapat dihitung seluruhnya dari kolom yang sudah ada (`base_change_set_id`, `created_at`, `published_at`, `effective_on`, `status`).

  Aturan yang diusulkan (difinalkan dengan property test di paket ini):

  > `publish(draft)` ditolak `409 ORGANIZATION_DRAFT_BASE_STALE` bila ada change set `X` dengan
  > `X.status = 'PUBLISHED'`, `X.id <> draft.base_change_set_id`,
  > `X.published_at > draft.created_at`, dan `X.effective_on <= draft.effective_on`.

  `<=` (bukan `<`) karena pada `effective_on` yang sama, urutan kedua `published_at DESC` tetap memenangkan draft yang terbit belakangan, sehingga isi `X` tetap tertimpa.

  Arah sebaliknya — menerbitkan koreksi berlaku besok ketika sudah ada terbitan **terjadwal** 2027 dari dasar lama — tidak dapat dicegah oleh penjaga ini, karena yang usang adalah terbitan yang sudah ada. Penanganannya: `GET /admin/organization/designer` (dan nanti Kesiapan) menandai terbitan terjadwal yang usang, dan penyelesaiannya adalah menerbitkan perubahan pengganti. Keadaan ini harus ditampilkan, bukan didiamkan.

- **ORG-008-3b (dengan migration).** Daftar perubahan, **Lanjutkan**, **Kembali ubah**, **Buang**, **Perbarui dari struktur terbaru** (rebase), revisi `If-Match`, satu perubahan terbuka (O-7). Setelah O-7 berlaku, dasar usang menjadi jarang; penjaga tetap dipasang sebagai jaring pengaman.

### 3.3 Efek samping yang perlu keputusan

`previewImpact` membandingkan draft dengan `base_change_set_id`, bukan dengan struktur yang berlaku pada tanggal berlakunya draft. Ketika dasar sudah usang, angka dampak juga salah (menyembunyikan perubahan yang sebenarnya akan terjadi). Pilihan:

- (a) biarkan pembandingnya `base`, dan andalkan penjaga 3a untuk memaksa rebase lebih dulu — tidak ada perubahan perilaku, paling murah;
- (b) bandingkan terhadap snapshot yang berlaku pada `draft.effective_on` — lebih jujur, tetapi mengubah angka yang dilaporkan dan menyentuh `organization-impact.test.ts`.

**Rekomendasi: (a)** untuk ORG-008-3a, karena penjaga membuat kasus (b) tidak dapat terjadi lagi pada saat terbit. Bila owner menginginkan (b), itu perubahan perilaku yang dicatat tersendiri di PR.

---

## 4. Target performa dan cara mengukurnya

### 4.1 Target (DRAFT, §4.8 spec)

- aksi edit < 1 detik;
- **Periksa & lihat dampak** < 10 detik untuk 500 pegawai;
- diukur di Mi8VPS (ponsel ARM), bukan di laptop.

### 4.2 Mengapa target tidak akan tercapai apa adanya

**Aksi edit (D-8).** Setiap mutasi draft memanggil `replaceDraftSnapshot`, yang:

1. `DELETE` dari tujuh tabel untuk `change_set_id` tersebut;
2. `INSERT` ulang **setiap baris** snapshot, satu `query()` per baris (node, job profile, posisi, keanggotaan, incumbency, binding, override).

Untuk struktur YSQ penuh (±500 keanggotaan, puluhan node dan posisi), satu klik "ganti nama unit" berarti ratusan round trip ke PostgreSQL. Frontend kemudian memanggil `reload()` yang mengambil ulang seluruh bagan.

**Periksa dampak.** `previewImpact` menjalankan, per pegawai, empat resolusi (atasan langsung dan penyetuju unit × sebelum dan sesudah), berurutan. Setiap resolusi memanggil `eligibilityValidator.validate()` per kandidat (`resolver.ts:331`, `resolver.ts:525`), yang merupakan query DB satu baris. Untuk 500 pegawai: ≥2.000 resolusi dan ≥2.000 query kelayakan, serial.

### 4.3 Perbaikan yang diusulkan (tanpa menyentuh semantik resolver)

| Perbaikan | Paket | Risiko | Perkiraan efek |
|---|---|---|---|
| `replaceDraftSnapshot` memakai satu `INSERT ... SELECT * FROM unnest(...)` per tabel, bukan satu per baris | 3b | rendah; isi identik, hanya cara menulis | ratusan round trip → 7 |
| Validator kelayakan dengan cache per permintaan, disuntikkan lewat opsi `eligibilityValidator` yang sudah ada | 2 | rendah; titik injeksi sudah dirancang untuk ini, presedensi tidak berubah | ≥2.000 query → ≤1 query batch |
| Perintah menulis catatan primitif secara terarah, `replaceDraftSnapshot` hanya untuk `createDraft`/`rebase` | 4 | sedang; harus tetap atomik | menghapus penulisan ulang penuh dari jalur edit |
| Frontend tidak memuat ulang seluruh bagan setelah setiap mutasi (pakai hasil respons) | 4/5 | rendah | menghilangkan satu bolak-balik penuh per klik |

Dua perbaikan pertama saja sudah memindahkan beban dari ratusan round trip menjadi satuan; keduanya diusulkan menumpang di paket yang memang sudah menyentuh berkas tersebut agar tidak menjadi PR refactor tersendiri (AGENTS.md §9).

### 4.4 Cara mengukur

1. **Seed sintetis** (skrip test, bukan data nyata): ±500 pegawai, ±40 unit bertingkat 4 level, ±60 jabatan, pemimpin unit lengkap, 3 jabatan kosong, 2 Plt. Tidak ada nama atau NIP pegawai nyata.
2. **Laptop/CI** sebagai pagar regresi: ukur p50/p95 untuk (a) satu `PATCH /nodes/:id`, (b) `GET /drafts/:id/impact`, dan catat jumlah query (hitung lewat penghitung pada pool test). Jumlah query adalah metrik yang stabil lintas perangkat; jadikan itu nilai yang di-assert di test, bukan milidetik.
3. **Mi8VPS** sebagai angka yang mengikat: jalankan pada database sekali pakai yang terpisah dari production, dengan persetujuan owner, dan catat waktu nyata di PR. Production tidak disentuh.
4. **Pelaporan jujur.** Bila target meleset, PR mencatat angka sebenarnya sebagai batasan yang diketahui; tidak menyatakan quality gate lulus berdasarkan inspeksi statis (AGENTS.md §7).

Pengukuran dasar (sebelum perbaikan) diambil di ORG-008-2 agar ada pembanding.

---

## 5. Butir TBD yang harus diverifikasi

### 5.1 Siapa pemegang `approvals.policy.manage` — **temuan, bukan sekadar TBD**

Diperiksa di kode baseline:

- `permissions.ts` memasukkan `approvals.policy.manage` ke `ADMIN_PERMISSIONS`, yaitu daftar yang hanya dipakai oleh `hasLegacySuperAdminCompatibility`;
- migration `0045` memberi role `human_capital_admin` 13 permission, **tanpa** `approvals.policy.manage`;
- `0057` justru mencabut satu permission dari role itu; tidak ada migration yang memberikan `approvals.policy.manage` kepada role mana pun.

Artinya: **hari ini hanya principal Super Admin yang dapat menerbitkan struktur.** Konsekuensi untuk ORG-008-8: paket itu benar secara teknis (HC Admin akhirnya bisa menyusun pejabat/Plt/kewenangan), tetapi langkah **Terbitkan** tetap menunggu Super Admin, bukan Kepala HC.

Tiga pilihan, semuanya butuh keputusan owner:

| Pilihan | Konsekuensi |
|---|---|
| (i) Role baru, misalnya `human_capital_lead`, membawa `approvals.policy.manage` | Migration + AUTH-011 + review permission; "empat mata" O-1 terjaga. Paket tersendiri (**ORG-008-8b**), bukan bagian ORG-008-8 yang "tanpa migration". |
| (ii) Tambahkan `approvals.policy.manage` ke `human_capital_admin` | Membatalkan maksud O-1(b): penyusun dan penerbit menjadi orang yang sama. Tidak direkomendasikan. |
| (iii) Terima Super Admin sebagai penerbit untuk sementara | Nol kode; HC bergantung pada ketersediaan Super Admin tiap kali menerbitkan. |

**Rekomendasi: (i)**, dirilis bersama atau tepat setelah ORG-008-8.

### 5.2 Kelayakan jurnal perubahan untuk v1

Tabel jurnal itu sendiri murah (satu baris per perintah, aditif). Yang mahal adalah **batalkan per baris**, karena membatalkan perintah ke-3 dari 12 berarti menyusun ulang draft dari dasar lalu menerapkan ulang 11 perintah sisanya — yaitu mesin yang sama dengan `rebase`.

Rencana: ORG-008-3b membangun `rebase` lebih dulu; ORG-008-4 memakai ulangnya untuk "batalkan". Spike setengah hari di awal ORG-008-4 memutuskan: bila penerapan ulang tidak dapat dibuat deterministik untuk ketujuh tipe perintah, jatuh ke fallback yang sudah disediakan spec — "Yang berubah" dihitung dari diff draft vs dasar, tanpa batalkan per baris. Keputusan dicatat di PR ORG-008-4; tidak menunda paket.

### 5.3 Toleransi status `DISCARDED` pada rilis lama

Yang sudah dapat dipastikan dari kode:

- `loadEffectiveSnapshot` menyaring `status = 'PUBLISHED'`, jadi baris `DISCARDED` tidak pernah terpilih sebagai struktur berlaku;
- `listChangeSets` mengembalikan semua baris dan memetakan `status` ke union TypeScript tanpa validasi runtime, sehingga nilai asing tidak melempar; begitu pula tipe `OrganizationDraftStatus` di web yang hanya tipe, bukan skema;
- CHECK yang harus diperluas ada di `0019_dynamic_organization.sql` baris 9–10 (`status IN (...)`) **dan** CHECK konsistensi baris 21–23, yang harus mengizinkan `DISCARDED` dengan `published_at IS NULL`. Migration yang hanya mengubah CHECK pertama akan gagal.

Verifikasi yang tetap wajib di ORG-008-3b: jalankan binary rilis sebelumnya terhadap database yang sudah dimigrasi dan berisi satu baris `DISCARDED`, lalu pastikan `GET /admin/organization/designer` dan alur Leave tidak terganggu. Ini test rollback, bukan inspeksi statis.

### 5.4 Jumlah baris jabatan read-only di production — **belum terverifikasi**

Dicoba di sesi ini: `ssh mi8vps` berhasil, `psql` tersedia di `/usr/bin/psql`, rilis berjalan terkonfirmasi `hcis-2b87b865-20261023`. Namun `DATABASE_URL` berada di `/srv/hcis/shared/final.env` yang hanya terbaca root, dan pembacaannya ditolak oleh kebijakan sesi ini. Verifikasi **membutuhkan persetujuan owner**.

Query read-only yang dibutuhkan (tanpa data pribadi, hanya hitungan):

```sql
SELECT count(*) AS rollout_rows FROM organization_rollout_settings;
SELECT status, count(*) FROM organization_change_sets GROUP BY status;
SELECT count(*) AS primary_structural FROM organization_incumbencies WHERE is_primary_structural;
SELECT count(*) AS account_held FROM organization_positions WHERE holder_source = 'ACCOUNT';
SELECT count(*) AS active_employees FROM employees WHERE status = 'active';
```

Pengaruh hasilnya terhadap rencana:

- `account_held` > 0 → ORG-008-1 wajib menandai jabatan itu read-only sejak awal (bukan menunggu 409), dan aturan Direktur → Sekretaris tidak dapat berjalan sampai keputusan pemetaan akun Dewan (gap W-3);
- `primary_structural` > 0 → alur **jabatan utama** di ORG-008-4 menjadi wajib, bukan opsional;
- `rollout_rows` ≠ 0 → asumsi `LEGACY` pada §2.3 gugur dan banner harus diperluas lebih awal;
- `active_employees` menentukan apakah angka 500 di target performa realistis.

### 5.5 Capability approver lembur (X-5)

Ditetapkan ATT-011-6b. `resolution-preview` hari ini mengunci `requiredCapability: "leave.approve"` (`admin-routes.ts`). ORG-008-2 harus menjadikannya parameter per workflow, dengan default `leave.approve` dan pilihan Lembur ditandai "pratinjau — belum berlaku" sampai ATT-011-6b dirilis, persis seperti §4.6 spec.

---

## 6. Keputusan owner dan ketergantungan pada rollout ORG-004

### 6.1 Yang dibutuhkan dari owner

| # | Keputusan | Memblokir | Kapan dibutuhkan |
|---|---|---|---|
| A | Persetujuan rencana ini dan urutan paketnya | seluruh implementasi | sekarang |
| B | Pemegang izin **Terbitkan** (§5.1, pilihan i/ii/iii) | nilai operasional ORG-008-8 | sebelum ORG-008-8 di-merge |
| C | Persetujuan query read-only production (§5.4) | ORG-008-1 (penanda read-only) dan ORG-008-4 (jabatan utama) | sebelum ORG-008-1 selesai |
| D | **O-11 unit pilot** | uji banding dan aktivasi; **tidak** memblokir paket mana pun | setelah ORG-008-2 dirilis |
| E | Pemetaan akun Dewan sebagai approver | aturan Direktur → Sekretaris di `STRUCTURE` | di luar ORG-008 |
| F | Persetujuan rilis per paket (OPS-MI8-REL-001) | tiap rilis | per paket |

### 6.2 Pengaruh rollout yang masih `LEGACY` dengan nol baris

Keadaan ini sebenarnya **memudahkan** urutan pengerjaan:

- Tidak ada pengajuan cuti/lembur production yang memakai struktur, sehingga setiap paket ORG-008 dapat dirilis tanpa risiko mengubah keputusan approval yang berjalan. Ini alasan mengapa ORG-008-2 (read-only) aman dirilis kapan saja.
- Setiap layar ORG-008 harus terus menyatakan "persetujuan memakai data atasan lama" (acceptance ORG-008-K), termasuk setelah **Terbitkan** berhasil.
- Arah ketergantungannya satu arah: **ORG-008 tidak menunggu rollout; rollout menunggu ORG-008.** Urutan menuju aktivasi:

```text
ORG-008-1 + 8 + 3a/3b   → HC dapat menyusun dengan aman
ORG-008-4 (+ 7)         → HC mengisi struktur YSQ yang sebenarnya
ORG-008-2               → laporan "Bandingkan dengan data lama" per unit
                          → dasar owner memilih O-11 (unit pilot)
ORG-008-6               → notifikasi HC per unit tepat sasaran (prasyarat ATT-011-6b)
                          → baru kemudian SHADOW, lalu STRUCTURE (di luar ORG-008)
```

- Karena struktur YSQ yang sebenarnya belum diisi, risiko D-2 hari ini masih laten. Itu justru alasan untuk memasang penjaga **sebelum** pengisian dimulai, bukan sesudah — biaya memasangnya sekarang jauh lebih murah daripada memulihkan terbitan yang hilang nanti.

---

## 7. Test minimum dan risiko utama per paket

| Paket | Test minimum | Risiko utama | Mitigasi |
|---|---|---|---|
| **1** | Tidak ada enum/kode/UUID di layar utama (test render); setiap kode §7 spec punya kalimat (test peta, gagal bila ada kode tanpa kalimat); tombol tidak tampil tanpa permission; banner menampilkan LEGACY saat nol baris rollout; mengganti tanggal tidak menutup draft; konfirmasi muncul sebelum Kosongkan/Hapus Plt; smoke mobile; typecheck/lint/build | Banner menyatakan mode yang salah bila baris rollout muncul (§2.3) | Banner hanya memastikan LEGACY pada nol baris; selain itu menyatakan tidak pasti |
| **8** | HC Admin: susun pejabat/Plt/kewenangan → 2xx, publish → 403; pemegang `approvals.policy.manage`: publish → 2xx; tanpa `organization.manage` → 403 di semua; HC Operator → 403; grant ber-scope unit tidak memberi akses organisasi; `PATCH /rollout` tetap 403 untuk HC Admin; test cakupan rute AUTH-011 lulus | Pelonggaran izin lebih luas dari maksud O-1 | Manifest AUTH-011 sebagai sumber kebenaran + test per rute; review permission tambahan (AGENTS.md §8) |
| **3a** | Dua draft dari dasar sama → terbit kedua 409; draft 2027 lalu koreksi besok → draft 2027 tidak dapat terbit; draft dengan dasar terbaru tetap dapat terbit (tidak ada false positive); snapshot terbit tidak berubah; audit tercatat; property test aturan `<=` | Penjaga terlalu ketat sehingga memblokir terbit yang sah | Property test dua arah (harus ditolak / harus lolos) sebelum merge; aturan dicatat di OpenAPI |
| **3b** | Reopen menghapus status siap; buang tidak menghapus riwayat; `If-Match` tidak cocok → 409; rebase menerapkan ulang dan menampilkan konflik per baris; perubahan terbuka kedua → 409; migration clean dari nol; **rilis sebelumnya tetap jalan dengan baris `DISCARDED`**; jumlah query `replaceDraftSnapshot` turun (assert hitungan) | Migration CHECK ganda di `0019` terlewat → migration gagal di production | Migration menyentuh kedua CHECK; uji clean migrate + uji rilis lama; review migration tambahan |
| **2** | Pegawai tanpa unit ikut terhitung (perbaikan P-3); sumber `INHERITED_LEADER` benar; Plt dan naik-saat-kosong terjelaskan; `oversight` terisi; laporan perbandingan tidak menulis apa pun dan tidak mengubah rollout (assert `count(*)` rollout dan `updated_at` tidak berubah); 403 per endpoint + manifest AUTH-011; tidak ada NIK/alamat di respons; 500 pegawai sintetis dengan hitungan query dan waktu tercatat | Endpoint read model membocorkan data pribadi yang tidak dibutuhkan; dampak performa dari resolusi massal | Daftar field respons ditetapkan eksplisit (allowlist), bukan `SELECT *`; validator kelayakan dengan cache; paging 50 dan batas 1.000 per laporan |
| **4** | Perintah atomik (gagal di tengah = nol perubahan); audit per primitif + `organization.command.applied`; pindah anggota tanpa overlap; Plt tanpa alasan → 400 dan alasan HC benar-benar tersimpan (bukan "Explicit acting mandate"); hapus item terbit → 409; nonaktif saat dipakai → 409 dengan daftar; binding ganda tidak dapat dibuat; property test: resolver menghasilkan atasan yang sama dengan preview; permission per perintah | Satu perintah gabungan menulis sebagian lalu gagal; perintah membuat kombinasi binding yang tidak dapat divalidasi | Satu transaksi per perintah (pola `atomicOrganizationMutation` yang sudah ada); validasi kombinasi sebelum menulis; review authority/permission tambahan |
| **6** | Unit induk dihitung dari struktur bertingkat; scope unit HC cocok; tanpa tautan → fallback organisasi; aturan Direktur tetap menunjuk stable key setelah restrukturisasi; peringatan saat jabatan bertanda aturan dinonaktifkan; kolom ikut tersalin ke draft | Kolom baru tidak ikut disalin saat clone draft — `replaceDraftSnapshot` menyebut kolom satu per satu pada `INSERT INTO organization_nodes`, jadi kolom yang lupa ditambahkan akan hilang diam-diam pada edit pertama | Test eksplisit: buat draft dari terbitan yang punya `legacy_unit_id`, lakukan satu edit, pastikan nilainya bertahan |
| **5** | Aturan Direktur → Sekretaris, Ketua diberi tahu tersusun dari kalimat dan lolos Cek persetujuan (sintetis, akun Dewan tetap read-only); rank visual tidak mengubah dampak routing; cari/fokus/ciutkan; mobile | Pemindahan rank visual menimbulkan kesan ia memengaruhi kewenangan | Label "Tampilan" terpisah + `organization-impact.test.ts` tetap lulus tanpa diubah |
| **7** | Tidak ada inferensi dari teks jabatan (test negatif: judul "Kepala …" tidak menghasilkan binding); hasil Cek persetujuan draft = data lama untuk semua pegawai yang data lamanya lengkap; tidak menyentuh rollout; semua hasil bertanda "usulan — tinjau"; audit | Usulan otomatis diterbitkan tanpa ditinjau | Hasil selalu berstatus Sedang disusun; penerbitan tetap memerlukan pemeriksa kedua (O-1) |

Seluruh paket juga wajib: typecheck, lint, test, build benar-benar dijalankan; dokumentasi diperbarui dalam PR yang sama; OpenAPI dan client tetap sinkron; tidak ada data pegawai nyata di test maupun tangkapan layar (AGENTS.md §3, §7, §8).

---

## 8. Yang belum diputuskan di rencana ini

- Pemegang izin **Terbitkan** (§5.1) — menunggu owner.
- Jumlah baris jabatan read-only di production (§5.4) — menunggu persetujuan query read-only.
- Pembanding `previewImpact` tetap `base` atau pindah ke snapshot berlaku (§3.3) — rekomendasi tetap `base`.
- Batalkan per baris di jurnal perubahan (§5.2) — diputuskan oleh spike di awal ORG-008-4.
- O-11 unit pilot — menunggu owner, tidak memblokir paket mana pun.
