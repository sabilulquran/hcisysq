# ORG-008 — Gap Analysis: Designer Struktur Organisasi Hari Ini vs Kebutuhan HC

**Status:** DISCOVERY EVIDENCE — repository inventory 2026-10-16  
**Specification:** ORG-008  
**Baseline commit:** `be2a4b6` (`main`, 2026-10-16)  
**Related:** ORG-004 (`dynamic-organization-structure.md`), ORG-004 visual ranking, ORG-002, ORG-001/AUTH-010, APR-001, ATT-011 (PR #103: D-5, D-10, D-11), EMP-006 (PR #102), `organization-designer-ux-spec.md` (usulan)

Dokumen ini mencatat apa yang **benar-benar** harus dilakukan Human Capital (HC) hari ini di halaman **Struktur Organisasi** (`/admin/organization`) untuk lima tugas utama, dan di mana operator tersandung. Inventory dibuat dari kode, bukan dari dokumen saja:

- web: `apps/web/src/pages/AdminOrganizationPage.tsx`, `apps/web/src/components/organization/OrganizationChart.tsx`, `apps/web/src/lib/organizationDesigner.ts`, `apps/web/src/lib/organizationTree.ts`;
- API: `apps/api/src/modules/organization/{admin-routes,draft-service,repository,resolver,rollout}.ts`;
- permission: `apps/api/src/modules/auth/permissions.ts`, migration `0045_hcis_human_capital_admin.sql`;
- terkait: `AdminEmployeeDetailPage.tsx` (atasan langsung ORG-002), `AdminLeaveConfigurationPage.tsx` (Unit Approver ORG-002), `AdminAccessPage.tsx` (scope role).

**Batas bukti.** Aplikasi **tidak dapat dijalankan** di mesin review ini (tidak ada PostgreSQL, Docker, maupun `node_modules`), sehingga walkthrough dilakukan dengan membaca alur kode langkah demi langkah. Setiap temuan di bawah adalah perilaku yang terbaca dari kode di commit baseline; temuan bertanda *(UAT)* wajib dikonfirmasi di UAT sintetis paket ORG-008-1 sebelum perbaikannya dianggap selesai. Production Mi8VPS tidak diperiksa; tidak ada data pegawai nyata yang dibaca.

Legenda dampak: **K** = kritis (hasil salah, data hilang, atau operator buntu), **T** = tinggi (banyak langkah/kerja manual atau tidak bisa memverifikasi), **S** = sedang (bahasa/UX), **R** = rendah.

## 1. Gambaran layar hari ini

Satu halaman, judul **"Organization Designer"**:

```text
[Lihat struktur pada tanggal: ____ ] [Saat ini]           [Jadwalkan perubahan]
--------------------------------------------------------------------------------
(bila draft dibuka)  Dipilih: <kotak>   9 tombol aksi: Tambah di bawah, Tambah sejajar,
                     Tambah posisi, Edit / pindah, Anggota, Rank visual, Kewenangan, ...
--------------------------------------------------------------------------------
                    Bagan pohon horizontal (kartu kelompok 22rem berisi posisi)
--------------------------------------------------------------------------------
[Validasi] [Preview dampak] [Publikasikan]   (hanya saat draft terbuka)
Hasil validasi · 6 angka dampak · "Preview rantai approval" (hanya saat draft terbuka)
```

Konsep yang harus dipahami operator sebelum bisa bekerja: *draft/change set*, *kelompok (node)*, *posisi*, *pejabat utama*, *pelaksana tugas (acting)*, *anggota (membership)*, *leader kelompok*, *unit approver*, *atasan struktural (supervisory parent)*, *governance approver*, *oversight parent*, *vacancy policy* (3 pilihan, ditanya dua kali), *rank visual*, *validasi*, *dampak*, *publikasi*. Tidak satu pun layar menjelaskan bahwa production masih memakai data atasan lama (`LEGACY`).

Atasan langsung dan Unit Approver yang **benar-benar** dipakai approval cuti hari ini diatur di dua layar lain: detail pegawai (`direct_manager_employee_id`) dan Konfigurasi Cuti (Unit Approver). HC jadi punya tiga tempat yang semuanya terlihat seperti "atasan".

## 2. Gap per tugas HC

### 2.1 Membangun atau mengubah struktur YSQ (unit, jabatan, pimpinan)

| # | Yang ada | Yang harus dilakukan HC hari ini | Target | Dampak |
|---|---|---|---|---|
| S-1 | Struktur dibangun dari kosong. Tidak ada impor dari unit hasil impor pegawai (`organizational_units`) maupun dari data atasan/Unit Approver ORG-002 yang sudah dipakai production. | Mengetik ulang seluruh unit, jabatan, pejabat, dan anggota yang sebenarnya sudah ada di HCIS. | Usulan awal (DRAFT) dari data yang sudah ada, ditinjau HC sebelum diterbitkan (keputusan O-3). | T |
| S-2 | "Kepala unit" = 5 aksi terpisah: tambah kelompok → tambah posisi → tetapkan pejabat → Kewenangan "Leader kelompok" → Kewenangan "Unit approver". Leader tidak bisa dipilih saat membuat posisi. | 5 dialog, 3 di antaranya memilih dari dropdown seluruh posisi. Lupa langkah 4/5 tidak terlihat sampai approval gagal. | Satu wizard **Tambah unit** (nama, induk, kepala unit, pejabat, "kepala unit menyetujui cuti unit ini"). | T |
| S-3 | Tidak ada tombol nonaktifkan/hapus kelompok atau posisi, padahal `PATCH` mendukung `active`. Item yang salah dibuat di draft yang sama juga tidak bisa dihapus. | Salah ketik/ salah tempat hanya bisa diganti nama/dipindah; item salah ikut terbit. | **Nonaktifkan** (item terbit) dan **Hapus** (item yang baru dibuat di perubahan ini). | T |
| S-4 | Dropdown induk/atasan/target berupa daftar datar seluruh kelompok/posisi tanpa jalur. Judul seperti "Wakil Kepala" atau "Kepala Unit" di beberapa sekolah tidak bisa dibedakan. | Menebak posisi yang benar dari judul. | Pilihan bertingkat dengan jalur ("SDIT › Kurikulum › Wakil Kepala") dan pencarian. | T |
| S-5 | Kartu bagan menampilkan enum mentah `nodeType` ("UNIT", "FOUNDATION"); bagan pohon horizontal kartu 22rem tanpa cari/zoom/"ciutkan semua"/fokus unit. | Struktur YSQ dengan banyak sekolah dan bidang menjadi sangat lebar; mencari satu jabatan = scroll. | Cari jabatan/pegawai, fokus satu unit, ciutkan semua; label jenis dalam bahasa Indonesia. | S |
| S-6 | Rank visual diatur di form kelompok **dan** dialog terpisah; banner biru "Rank visual diturunkan…" pada kartu. | — | Tetap ada, dipindah ke "Tampilan" agar tidak bersaing dengan aksi utama. | R |

### 2.2 Menempatkan pegawai ke unit dan jabatan

| # | Yang ada | Yang harus dilakukan HC hari ini | Target | Dampak |
|---|---|---|---|---|
| P-1 | Dialog **Anggota**: daftar centang **seluruh** pegawai (termasuk `inactive`/`resigned`, `GET /designer/employees` tanpa filter/paging), tanpa pencarian, maks 500 per kelompok; simpan = ganti seluruh anggota kelompok. | Mencentang satu per satu dari ratusan nama; bisa mencentang pegawai keluar. | Cari + filter "unit lama"; hanya pegawai aktif; **Tambahkan/Pindahkan**, bukan ganti seluruh daftar. | T |
| P-2 | Pegawai yang sama bisa dicentang di dua kelompok. Konflik baru muncul saat **Validasi** sebagai `PRIMARY_MEMBERSHIP_OVERLAP — Effective periods overlap.` tanpa nama pegawai. | Mencari sendiri pegawai mana yang ganda. | Saat menambahkan: "Ahmad sudah di SDIT · Kurikulum. Pindahkan ke sini?" | K |
| P-3 | Tidak ada daftar **pegawai yang belum ditempatkan**. Impact hanya menghitung pegawai yang sudah menjadi anggota (`draft-service.ts previewImpact`), sehingga pegawai yang tidak ditempatkan sama sekali **tidak terlihat** sebagai masalah. | Di bawah `STRUCTURE` pegawai ini gagal mengajukan cuti/lembur (fail-closed) tanpa HC tahu sebelumnya. | Kartu "N pegawai aktif belum punya unit" dengan aksi Tempatkan. | K |
| P-4 | Pejabat dipilih dari dropdown seluruh pegawai (termasuk nonaktif) tanpa pencarian; pejabat nonaktif baru ditolak saat Validasi (`INACTIVE_INCUMBENT`). | Scroll dropdown ratusan nama. | Pencarian pegawai aktif. | T |
| P-5 | Jabatan yang pejabatnya punya penanda `is_primary_structural` (data production hasil migrasi 0020–0023) ditolak `409 PRIMARY_STRUCTURAL_EDIT_REQUIRES_REVIEW`; jabatan yang dipegang akun Dewan (`holder_source = ACCOUNT`) ditolak `409 ACCOUNT_HELD_POSITION_EDIT_REQUIRES_REVIEW`. Tombol tetap tampil. | Bila data production memuat penanda ini, HC **tidak bisa mengganti pejabat** jabatan tersebut sama sekali. Pesan berbahasa Inggris. | Jabatan read-only ditandai sejak awal dengan alasan dan jalur penyelesaian; alur "jabatan utama" untuk pegawai yang memegang dua jabatan. Jumlah baris terdampak di production = **TBD** (cek read-only). | K |
| P-6 | Penempatan jangka panjang pegawai juga direncanakan di EMP-006 (PR #102, riwayat penugasan ke posisi ORG-004). | — | Satu tempat kerja untuk menempatkan pegawai (keputusan O-4). | T |

### 2.3 Mengatur atasan langsung dan Plt (pelaksana tugas)

| # | Yang ada | Yang harus dilakukan HC hari ini | Target | Dampak |
|---|---|---|---|---|
| M-1 | **Tidak ada layar yang menampilkan "atasan langsung" per pegawai.** Resolver menurunkannya dari tiga sumber berurutan: pengecualian per pegawai → atasan jabatan pegawai (`parentPositionKey` atau binding `SUPERVISORY_PARENT`) → leader kelompok anggota, **naik ke kelompok induk** bila kelompoknya tidak punya leader (`resolver.ts findNodeBinding`). | Untuk tahu atasan Ahmad: buka draft, pilih Ahmad di "Preview rantai approval", baca hasilnya — satu pegawai satu kali. Tidak bisa melihat ratusan pegawai sekaligus. | Tab **Pegawai**: setiap pegawai aktif dengan unit, jabatan, **atasan langsung**, dan alasan singkat ("karena Kepala SDIT memimpin SDIT"). | K |
| M-2 | Atasan sebuah jabatan bisa diatur di dua tempat: form posisi "Posisi atasan struktural" **dan** Kewenangan "Atasan struktural"; binding diam-diam mengalahkan field form. | Dua isian yang terlihat sama, hasilnya berbeda. | Satu isian **Melapor ke**. Binding tetap di backend, tidak terlihat sebagai konsep terpisah. | T |
| M-3 | Pewarisan leader dari kelompok induk tidak terlihat di bagan. | Tim tanpa leader diam-diam melapor ke pimpinan unit di atasnya. | Kartu tim menampilkan "Atasan anggota: Kepala SDIT (dari unit induk)". | T |
| M-4 | Pengecualian atasan per pegawai (`POST /reporting-overrides`) ada di API, **tidak ada UI**. | Kasus nyata "guru ini melapor langsung ke kepala sekolah" tidak bisa dicatat lewat layar. | Aksi **Atur atasan khusus** (atasan, mulai, sampai, alasan wajib). | T |
| M-5 | Pemimpin yang juga dicentang sebagai anggota kelompoknya sendiri dan jabatannya tidak melapor ke siapa pun menghasilkan `AUTHORITY_SELF_RESOLUTION` (bahasa Inggris). | Tidak dipahami. | Peringatan saat menempatkan: "Kepala SDIT tidak perlu menjadi anggota SDIT; atasannya diambil dari jabatan Kepala SDIT." | S |
| M-6 | Plt: satu per jabatan; mulai+sampai wajib; **alasan diisi tetap** `"Explicit acting mandate"` oleh server (bukan alasan HC), padahal ORG-004 mewajibkan alasan dan audit. "Hapus acting" dan "Tandai vacant" langsung tersimpan tanpa konfirmasi atau penjelasan dampak. | Tidak ada catatan mengapa Plt ditunjuk; satu klik salah menghapus Plt. | Wizard **Tunjuk Plt** dengan alasan wajib; konfirmasi dengan dampak ("Mulai 1 Nov, cuti tim Sosial disetujui oleh Direktur"). | T |
| M-7 | Tidak ada daftar Plt yang sedang/akan berakhir dan jabatan kosong. | Plt kedaluwarsa diam-diam; approval naik ke atas atau diblokir. | Tab **Plt & jabatan kosong** dengan "berakhir ≤ 14 hari". | T |
| M-8 | Pertanyaan "kalau jabatan kosong?" ditanya di posisi **dan** di setiap binding, dengan istilah teknis (`CLIMB_TO_PARENT`…) di balik label. | Dua jawaban berbeda untuk konsep yang sama. | Satu pertanyaan per jabatan dengan contoh nama orang. | S |

### 2.4 Kewenangan khusus (Direktur, Sekretaris, Ketua)

| # | Yang ada | Yang harus dilakukan HC hari ini | Target | Dampak |
|---|---|---|---|---|
| W-1 | Dialog **Kewenangan** hanya bisa *menambah*. Tidak ada daftar kewenangan yang sudah ada, tidak ada ubah/akhiri/hapus (tidak ada endpoint). Menambah leader kedua untuk kelompok yang sama → `AUTHORITY_BINDING_OVERLAP` → draft **tidak pernah bisa valid**. | Satu salah klik = buang draft dan mulai lagi (lihat D-3). | Daftar kewenangan per unit/jabatan dengan **Ganti** dan **Hapus** di dalam perubahan yang belum terbit. | K |
| W-2 | Istilah: "Governance approver", "Oversight di atas approver", "Leader kelompok", "Unit approver". | Harus memahami model ORG-004. | Kalimat: "Bila **[Direktur]** mengajukan cuti, yang menyetujui adalah **[Sekretaris Yayasan]**"; "Setelah disetujui, **[Ketua Yayasan]** diberi tahu". | T |
| W-3 | Jabatan Dewan (Ketua/Sekretaris) dipegang akun Dewan (`holder_source = ACCOUNT`) dan read-only (P-5); resolver menolak akun sebagai approver (fail-closed). | Aturan Direktur → Sekretaris tidak dapat berjalan di `STRUCTURE` sampai keputusan pemetaan akun disetujui. | Ditampilkan jujur: "Belum bisa dipakai untuk persetujuan — menunggu keputusan pemetaan akun Dewan". | T |

### 2.5 Melihat dampak dan menerbitkan

| # | Yang ada | Yang harus dilakukan HC hari ini | Target | Dampak |
|---|---|---|---|---|
| D-1 | Draft hanya dapat dibuka lewat `?draftId=` di URL. **Tidak ada daftar draft.** Mengubah "Lihat struktur pada tanggal" saat draft terbuka langsung menutup draft (`setDraftId(null)`). | Pindah menu atau mengganti tanggal = draft "hilang"; HC membuat draft baru dari awal. *(UAT)* | Kartu "Lanjutkan perubahan: Restruktur 2027 (12 perubahan, terakhir oleh Siti)". | K |
| D-2 | Tidak ada **Buang draft**. Beberapa draft untuk tanggal yang sama boleh ada. Saat terbit tidak dicek apakah struktur dasar draft masih yang terbaru. Karena setiap terbitan adalah snapshot lengkap dan yang dipilih adalah `effective_on DESC, published_at DESC`, **terbitan belakangan menimpa seluruh terbitan sebelumnya**. Contoh: draft 2027 dibuat dari struktur Oktober; HC lalu menerbitkan koreksi berlaku besok; pada 1 Jan 2027 koreksi itu **hilang** karena snapshot 2027 tidak memuatnya. | Perubahan bisa hilang diam-diam. | Satu perubahan terbuka; terbit ditolak bila dasar sudah berubah, dengan tawaran "perbarui dari struktur terbaru". | K |
| D-3 | Setelah Validasi sukses, draft menjadi `VALIDATED` dan **tidak bisa diedit lagi**; tidak ada "kembali ubah". | Ingin memperbaiki satu salah ketik setelah validasi = buat draft baru dari struktur terbit, semua pekerjaan draft hilang. | **Ubah lagi** mengembalikan ke "sedang disusun" (validasi diulang). | K |
| D-4 | Tiga tombol terpisah (Validasi → Preview dampak → Publikasikan); Preview dampak bisa ditekan tanpa validasi; publish memakai `window.confirm`. Hasil tampil di bawah bagan (harus scroll). | Urutan tidak jelas. | Satu tombol **Periksa & lihat dampak** → layar ringkasan → **Terbitkan**. | S |
| D-5 | Hasil validasi = kode + pesan Inggris (`PRIMARY_INCUMBENCY_OVERLAP — Effective periods overlap.`) tanpa nama item dan tanpa tautan ke item. | Mencari sendiri item yang salah. | Pesan bahasa Indonesia dengan nama, tombol "Buka". | T |
| D-6 | Dampak = 6 angka saja (Atasan langsung berubah, Unit approver berubah, …). API mengembalikan ID pegawai/posisi; layar tidak menampilkan siapa. | Tidak tahu siapa yang terdampak. | Daftar "Ahmad: atasan Yusuf → Hasan" dengan filter unit. | T |
| D-7 | Halaman tidak menyebut mode rollout. `GET /admin/organization/rollout` ada, tidak dipakai UI. Catatan sukses "Struktur dipublikasikan" tidak menyebut bahwa approval tetap memakai data lama. | Operator mengira terbit = approval langsung berubah (atau sebaliknya). | Banner tetap: "Persetujuan cuti saat ini memakai **data atasan lama**. Struktur ini belum dipakai untuk persetujuan." | T |
| D-8 | Setiap perubahan kecil menulis ulang seluruh snapshot draft (`replaceDraftSnapshot`) lalu memuat ulang seluruh bagan; dampak menjalankan resolver per pegawai secara berurutan (4 resolusi per pegawai). | Potensi lambat di Mi8VPS untuk struktur penuh YSQ. **TBD** — ukur di UAT sintetis dengan ±500 pegawai. | Target waktu: aksi edit < 1 dtk, periksa dampak < 10 dtk (DRAFT). | S |

### 2.6 Memeriksa siapa menyetujui siapa

| # | Yang ada | Yang harus dilakukan HC hari ini | Target | Dampak |
|---|---|---|---|---|
| C-1 | "Preview rantai approval" hanya muncul saat draft terbuka. | Untuk mengecek struktur yang sudah terbit harus membuat draft dulu. | **Cek persetujuan** pada struktur yang berlaku, terjadwal, atau perubahan terbuka. | T |
| C-2 | Workflow terkunci `LEAVE` + capability `leave.approve`; `oversight` selalu `null` dan `warnings` selalu kosong dari API, padahal UI menyediakan tempatnya. Lembur (ATT-011 D-5) belum bisa dicek. | Tidak bisa memastikan "Ketua diberi tahu" atau atasan lembur. | Pilih jenis: Cuti tahunan, Cuti tanpa upah, Lembur; tampil langkah, alasan, dan siapa diberi tahu. | T |
| C-3 | Gagal resolve → `409` dengan pesan Inggris resolver ("Structural leader is not configured."). | Tidak tahu apa yang harus diperbaiki. | "Atasan Ahmad belum bisa ditentukan: unit SDIT · Kurikulum belum punya pemimpin. [Atur pemimpin]". | T |
| C-4 | Tidak ada perbandingan massal "data atasan lama vs struktur". Bukti `SHADOW` hanya terkumpul ketika ada pengajuan cuti nyata dan disimpan di konteks request, tanpa layar. | Kesiapan aktivasi tidak bisa diukur sebelum pilot; HC harus menunggu pengajuan. | Laporan **Bandingkan dengan data lama** untuk semua pegawai di satu unit, read-only, tanpa mengubah mode rollout. | K |
| C-5 | Tidak ada daftar kesiapan (pegawai tanpa unit, tanpa atasan, atasan tanpa akun aktif/`leave.approve`, jabatan kosong tanpa Plt, Plt berakhir). | Kesiapan pilot dinilai manual. | Tab **Kesiapan** sebagai halaman pertama. | T |

### 2.7 Kebutuhan baru dari ATT-011 (PR #103)

| # | Kebutuhan ATT-011 | Yang ada | Gap | Dampak |
|---|---|---|---|---|
| X-1 | Atasan langsung untuk **setiap** pegawai (approver lembur D-5, fail-closed `422 OVERTIME_APPROVER_UNRESOLVED`). | M-1, P-3, C-4. | Tanpa daftar pegawai + kesiapan, HC tidak tahu siapa yang akan gagal mengajukan lembur. | K |
| X-2 | Jabatan **Direktur** sebagai target aturan "lembur tidak berlaku" (D-10), berbasis position stable key, bukan orang. | Posisi punya `stableKey`, tetapi tidak ada tempat melihat "aturan yang memakai jabatan ini"; bila jabatan Direktur dihapus/diganti di restrukturisasi, aturan bisa menunjuk jabatan nonaktif tanpa peringatan. | Panel jabatan menampilkan aturan yang terkait; restrukturisasi memperingatkan bila jabatan bertanda aturan dinonaktifkan. | T |
| X-3 | Notifikasi HC per **unit pegawai atau unit induknya** (D-11). | Scope role HC menunjuk `organizational_units` (hasil impor, **datar, tanpa induk**); struktur ORG-004 bertingkat tetapi **tidak terhubung** ke `organizational_units` (`integrationCode` hanya teks bebas). | "Unit induk" tidak bisa dihitung dengan pasti; penerima notifikasi bisa salah sasaran. | K |
| X-4 | Plt diperhitungkan untuk approver lembur dan aturan Direktur. | Resolver sudah menghormati Plt. | Tampilan Plt (M-6, M-7) dibutuhkan agar HC bisa memastikan. | T |
| X-5 | Capability approver lembur. | Preview memakai `leave.approve`. | Capability approver lembur = **TBD** (ditetapkan ATT-011-6b); preview harus mengikuti. | S |

### 2.8 Izin, state, dan mobile

| # | Yang ada | Gap | Dampak |
|---|---|---|---|
| U-1 | Role `human_capital_admin` memiliki `organization.manage` tetapi **tidak** `approvals.policy.manage` (`permissions.ts`, migration `0045`). Tetapkan pejabat, Plt, Kewenangan, pengecualian atasan, dan **Terbitkan** membutuhkan `approvals.policy.manage`. Semua tombol tetap tampil. | HC Admin bisa menyusun unit dan anggota lalu tiba-tiba `403` di tengah pekerjaan; hanya akun dengan kompatibilitas Super Admin yang bisa menyelesaikan. Pemisahan ini mungkin disengaja, tetapi tidak terlihat di layar (keputusan O-1). | K |
| U-2 | Empty state berbahasa Inggris ("Start organization structure"); gagal memuat daftar pegawai disembunyikan menjadi daftar kosong ("Daftar pegawai aktif belum tersedia"). | Operator tidak tahu bahwa masalahnya error, bukan data kosong. | S |
| U-3 | Mobile: bagan horizontal dengan kartu 22rem, bar aksi 9 tombol membungkus; dialog sudah berupa bottom sheet. | Mengedit di HP tidak praktis; melihat struktur di HP pun sulit. | S |
| U-4 | Error API generik: "Permintaan Organization Designer tidak dapat diproses." | Tidak ada arahan perbaikan. | S |
| U-5 | Nama "Unknown employee" / "Unknown governance account" tampil bila data tidak ditemukan. | Bahasa Inggris dan membingungkan. | R |

## 3. Hitungan langkah — contoh nyata (data sintetis)

**Mendaftarkan SDIT: Kepala SDIT + tim Kurikulum (Wakil Kepala + 30 guru), approval cuti normal.**

- Hari ini: Jadwalkan perubahan (nama, tanggal) → pilih induk → Tambah di bawah (SDIT) → Tambah posisi (Kepala SDIT, kebijakan kosong) → Tetapkan pejabat (dropdown ratusan nama) → Kewenangan: Leader kelompok → Kewenangan: Unit approver → pilih SDIT → Tambah di bawah (Kurikulum) → Tambah posisi (Wakil Kepala, atasan = Kepala SDIT dari dropdown datar) → Tetapkan pejabat → Kewenangan: Leader kelompok → Anggota: centang 30 dari ratusan nama tanpa pencarian → Validasi → Preview dampak → Publikasikan. **≈ 14 dialog + 30 centang**, tanpa melihat atasan siapa pun.
- Target: Perubahan → **Tambah unit** "SDIT" (kepala unit Kepala SDIT, pejabat dicari, "menyetujui cuti unit ini" ✓) → **Tambah unit** "Kurikulum" di bawah SDIT (pimpinan Wakil Kepala) → **Tempatkan pegawai**: filter unit lama "SDIT", pilih 30, Kurikulum → **Periksa & lihat dampak** (daftar 31 pegawai dengan atasan masing-masing) → **Terbitkan**. **≈ 5 langkah**.

**Kepala Divisi Sosial kosong, Yusuf ditunjuk Plt 1 Sep–31 Des.**

- Hari ini: buat draft → pilih jabatan → Pelaksana tugas → pilih Yusuf, dua tanggal → (tanpa alasan) → Validasi → Publikasikan; untuk mengecek hasil harus pilih satu staf di preview.
- Target: **Plt & jabatan kosong** → Kepala Divisi Sosial → **Tunjuk Plt** → Yusuf, tanggal, alasan → layar dampak "5 staf Sosial: atasan Direktur → Yusuf (1 Sep–31 Des)" → Terbitkan.

**"Siapa yang menyetujui lembur Ahmad?"** (ATT-011)

- Hari ini: tidak bisa (preview hanya cuti, hanya dalam draft).
- Target: **Cek persetujuan** → Ahmad → Lembur → tanggal → "Diajukan Ahmad → disetujui **Yusuf** (atasan langsung, Wakil Kepala Kurikulum) → HC SDIT diberi tahu".

## 4. Yang sudah benar dan wajib dipertahankan

- Snapshot struktur lengkap per tanggal berlaku; terbitan tidak pernah ditimpa (`organization_change_sets`, ORG-004).
- Draft → validasi → terbit; tidak ada perubahan langsung pada struktur yang berlaku.
- Resolver fail-closed: tidak ada fallback ke orang sembarang; self-approval, siklus, dan batas penelusuran ditolak.
- Plt eksplisit dan bertanggal; jabatan kosong tetap terlihat.
- Rank visual tidak berdampak pada kewenangan; dampak "visual saja" sudah dideteksi.
- Approval snapshot disimpan saat submit; restrukturisasi tidak menulis ulang request yang sudah diajukan.
- Rollout `LEGACY → SHADOW → STRUCTURE` terpisah dari terbit struktur; tanpa baris rollout = `LEGACY`.
- Setiap mutasi privileged diaudit dalam transaksi yang sama.
- Jabatan yang dipegang akun Dewan tidak memberi role/permission dan tidak dipakai sebagai approver tanpa keputusan terpisah.

Perbaikan UX di `organization-designer-ux-spec.md` tidak boleh melemahkan butir-butir ini.
