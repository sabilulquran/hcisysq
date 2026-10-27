# ADR-0006: Tiga Lapis Administrator SQ Core (AUTH-014)

- **Status:** ACCEPTED
- **Date:** 2026-10-27
- **Decider:** Owner Yayasan Sabilul Qur'an
- **Related:** AUTH-010, AUTH-011, AUTH-012, AUTH-013, ORG-008, ORG-010, EMP-005, DOC-002, `HUB-IMPL-003`; ADR-0005
- **Evidence:** `docs/domain/hcis-authorization-modernization.md`, `docs/domain/access-model.md`, `docs/domain/sq-core-administrator-layers.md`, `apps/api/src/modules/auth/role-assignment.ts`, `apps/api/src/modules/auth/permissions.ts`, inspeksi production read-only 2026-10-27

## Context

Hari ini SQ Core punya **empat** lapis administrator, dan ketiganya di luar Keycloak saling tidak mengenal satu sama lain:

| # | Lapis | Tempat | Pemegang | Kewenangan |
|---|---|---|---|---|
| 1 | Admin realm master Keycloak | konsol Keycloak `login.sabilulquran.or.id` | `admin@sabilulquran.or.id` | segalanya atas identitas |
| 2 | Platform Administrator SQ Hub | tabel `platform_administrators` | akun pegawai owner | akses aplikasi, daftar aplikasi, audit |
| 3 | Super Admin HCIS | akun terpisah `admin@hcis.sabilulquran.or.id`, `principal_type = 'SUPER_ADMIN'` | akun non-pegawai | **satu-satunya** yang boleh memberi/mencabut peran HCIS |
| 4 | Administrator HCIS | role `human_capital_admin` | akun pegawai | operasional HC + sebagian konfigurasi modul |

Keadaan yang sudah diverifikasi langsung di production (read-only, 2026-10-27):

- SQ Hub sudah memiliki `/admin/access` dan `/admin/audit`: memberi dan mencabut akses aplikasi, mengelola daftar aplikasi, melihat audit.
- Empat akun mesin SQ Hub di Keycloak (`service-account-sq-hub-directory`, `-identity-management`, `-organization-directory`, `-staff-lifecycle`) hanya memegang `query-users` dan `view-users`. **Tidak ada `manage-users`.** Jadi SQ Hub hari ini tidak bisa membuat akun, menonaktifkan akun, atau mereset kata sandi; semuanya masih lewat konsol Keycloak.
- Di HCIS, `assertRoleGrantor` (`apps/api/src/modules/auth/role-assignment.ts`) menolak setiap aktor yang `principalType !== "SUPER_ADMIN"` dengan `403 ROLE_GRANT_SUPER_ADMIN_ONLY`, dan tidak ada aktor yang boleh memberi peran kepada dirinya sendiri (keputusan owner 2026-10-16, AUTH-011).

Masalah nyata yang memicu keputusan ini bukan teoretis:

1. Owner harus **keluar-masuk dengan akun berbeda** hanya untuk memberi satu peran kepada satu pegawai. Pekerjaan satu menit menjadi pekerjaan tiga sesi login.
2. Owner sempat **tidak bisa masuk sama sekali** karena akun SUPER_ADMIN belum pernah ditautkan ke Akun SQ. Lapis yang dibuat demi keamanan justru menjadi penyebab kehilangan akses.
3. Batas antara lapis 2, 3, dan 4 tidak mengikuti satu prinsip apa pun. `human_capital_admin` memegang campuran: data pegawai (pekerjaan HC), konfigurasi cuti dan jadwal (isi modul), dan dulu juga `access.roles.assign` (identitas) sampai migration 0057 mencabutnya. Tidak ada jawaban yang bisa dihafal untuk "siapa yang boleh apa".

Tekanan berlawanan: menyederhanakan lapis otorisasi adalah perubahan paling berbahaya yang bisa dilakukan pada sistem yang sedang dipakai. Transisi auth yang salah mengunci semua orang keluar, dan tidak ada jalan masuk cadangan selain konsol Keycloak.

## Decision

### D-1. Tiga lapis, dengan satu garis pemisah yang bisa dihafal

Garisnya: **orang dan akses** versus **isi dan jalannya modul**.

| Lapis | Berkedudukan di | Mengurus | Tidak boleh |
|---|---|---|---|
| **Admin Platform** | SQ Hub | siapa punya Akun SQ, aktif/nonaktif, reset kata sandi, siapa boleh membuka aplikasi apa, **semua pemberian peran di modul mana pun**, menunjuk Admin Modul | — |
| **Admin Modul** (satu per aplikasi) | aplikasi masing-masing | pengaturan modul, data acuan, periode, hal teknis operasional. Di HCIS: shift dan jadwal, jenis cuti, komponen gaji, periode payroll, template dokumen, perangkat absensi | **tidak memberi peran**, **tidak menyentuh akun orang** |
| **Peran kerja dalam modul** | aplikasi masing-masing | pekerjaan sehari-hari (HC, Keuangan, Manajer Unit, Kepala HC) | memberi peran |

Admin Modul yang tidak memberi peran dan tidak menyentuh akun adalah koreksi eksplisit owner terhadap rancangan awal, dan merupakan satu-satunya hal yang membuat garis ini tetap tajam: begitu Admin Modul boleh memberi satu peran saja, lapis 2 dan 3 lama kembali.

### D-2. Konsol Keycloak turun status menjadi kunci cadangan

Konsol Keycloak bukan lagi alat kerja harian; dipakai hanya bila SQ Hub sendiri rusak. Supaya itu mungkin, akun mesin SQ Hub mendapat tambahan **`manage-users`**.

Yang **tetap hanya di konsol Keycloak** dan tidak pernah diberikan ke akun mesin mana pun:

- `impersonation`
- `manage-clients`
- `manage-realm`
- `manage-identity-providers`
- `realm-admin`

Alasan daftar itu: masing-masing memungkinkan pemegangnya menjadi orang lain, mengubah siapa yang boleh menandatangani token, atau memasang penyedia identitas baru. Tak satu pun dibutuhkan untuk pekerjaan harian Admin Platform, dan semuanya memutus rantai audit.

### D-3. Akun SUPER_ADMIN terpisah berhenti menjadi keharusan

Kewenangan memberi peran tidak lagi melekat pada `principal_type = 'SUPER_ADMIN'`. Owner dan Admin Platform lain bekerja dengan **akun pegawai biasa** mereka, sehingga tidak perlu berganti akun.

Pengaman utamanya tetap dua yang sudah berjalan dan tidak dilonggarkan:

- **tidak ada aktor yang boleh memberi peran kepada dirinya sendiri**, pada jalur apa pun, termasuk jalur SQ Hub;
- **setiap pemberian dan pencabutan peran menghasilkan audit event** yang menyebut manusia pelakunya, bukan akun mesin.

Akun SUPER_ADMIN tidak dihapus. Ia turun menjadi **break-glass yang nonaktif secara default** (`accounts.status = 'inactive'`), dihidupkan hanya lewat prosedur tercatat ketika jalur SQ Hub tidak tersedia. Menghapusnya sekarang berarti membuang satu-satunya jalan masuk ketika jalur baru gagal — justru kesalahan yang sudah pernah terjadi, dibalik arahnya.

### D-4. HCIS menerima pemberian peran, tidak menyelenggarakannya

HCIS tidak menyimpan siapa Admin Platform. Pemberian peran masuk melalui satu kanal mesin terotentikasi dari SQ Hub (`/internal/v1/role-administration/*`), mengikuti pola `staff-identity` dan `organization-directory` yang sudah ada: token mesin Keycloak, client allowlist, scope wajib.

HCIS **tidak memercayai kanal itu secara buta**. Setiap permintaan membawa subject Keycloak manusia yang bertindak; HCIS menyelesaikannya menjadi akun lokal dan menerapkan seluruh invarian domainnya sendiri — allowlist role, allowlist permission, validasi scope dan tanggal, mandat wajib untuk role istimewa, dan larangan memberi peran kepada diri sendiri — terhadap manusia itu, bukan terhadap akun mesin. Subject yang tidak bisa diselesaikan berarti **ditolak**, bukan diterima.

Rinciannya, termasuk apa yang masuk kewenangan Admin Modul HCIS dan jalur migrasinya, ada di **AUTH-014** (`docs/domain/sq-core-administrator-layers.md`).

### D-5. `access.roles.assign` dan kerabatnya tidak pernah diberikan lewat HCIS

Permission `access.roles.assign`, `access.roles.delegate`, dan `access.governance.manage` dikeluarkan dari daftar permission yang boleh dibawa role HCIS mana pun yang dapat diberikan melalui kanal SQ Hub. Keanggotaan Admin Platform hanya ada di SQ Hub.

Tanpa aturan ini, keputusan D-3 membuka **penutupan eskalasi**: seorang Admin Platform dilarang memberi peran kepada dirinya sendiri, tetapi bisa memberi `access.roles.assign` kepada akun kedua, masuk sebagai akun kedua, dan memberi apa pun kepada akun pertamanya. Larangan self-grant hanya bermakna bila kewenangan memberi peran itu sendiri tidak dapat dibagikan dari dalam.

## Consequences

### Positif

- Satu akun untuk satu orang. Owner tidak lagi berganti akun untuk memberi satu peran, dan tidak ada akun yang bisa "hilang" karena tidak pernah ditautkan ke Akun SQ.
- Satu tempat untuk pertanyaan "siapa punya akses apa": SQ Hub, dengan audit yang sudah ada di `/admin/audit`.
- Jawaban "siapa boleh apa" bisa dihafal: orang dan akses di Hub, isi modul di modulnya.
- Konsol Keycloak berhenti menjadi alat kerja harian, sehingga jumlah orang yang perlu memegang kredensial realm master mengecil menjadi satu.

### Negatif dan biaya

- **SQ Hub menjadi titik tunggal kegagalan dan sasaran serangan paling bernilai di seluruh SQ Core.** Ini konsekuensi paling berat dari ADR ini dan dirinci di bagian Risiko.
- Rantai kepercayaan memanjang: HCIS kini memercayai pernyataan SQ Hub tentang siapa yang bertindak. Setiap mata rantai baru (token mesin, client allowlist, resolusi subject) adalah tempat baru untuk salah.
- Pemecahan `human_capital_admin` menjadi peran kerja dan Admin Modul menyentuh bundle yang sedang dipakai di production. Dikerjakan dengan urutan yang salah, ini mencabut kemampuan orang yang sedang bekerja.
- Audit menjadi terbelah dua sumber selama masa transisi: pemberian lewat Hub dan pemberian break-glass lewat HCIS. Keduanya harus bisa dibaca sebagai satu riwayat.

### Risiko yang kami lihat sendiri, dengan pengamannya

Bagian ini bukan pengulangan keputusan. Ini yang menurut kami bisa rusak.

**R-1. SQ Hub menjadi titik tunggal kegagalan.** Setelah D-1, satu aplikasi memegang: identitas (lewat `manage-users`), akses aplikasi, dan pemberian peran di setiap modul. Satu kerentanan di SQ Hub — satu IDOR di `/admin/access`, satu kebocoran secret akun mesin — bernilai sama dengan admin realm. Sebelum D-2 bahkan kompromi penuh SQ Hub tidak bisa mereset kata sandi siapa pun; setelahnya, bisa.

Pengaman yang kami wajibkan:

1. **Akun mesin terpisah per kewenangan.** `manage-users` hanya pada satu akun mesin (`sq-hub-identity-management`), tidak pada keempatnya. Kanal pemberian peran memakai scope sendiri (`role-administration.manage`) pada akun mesin lain. Satu secret bocor tidak membuka keduanya.
2. **Rotasi secret akun mesin terjadwal**, dan rotasi wajib setiap kali ada orang yang pernah memegangnya berhenti.
3. **Larangan self-grant diterapkan di HCIS, bukan hanya di SQ Hub.** Modul tidak boleh bergantung pada pemeriksaan yang dilakukan di seberang kanal. Penyerang yang menguasai SQ Hub tetap tidak bisa menaikkan satu akun pegawai menjadi administrator HCIS dari akun itu sendiri.
4. **Allowlist role dan permission di sisi HCIS tetap berlaku penuh** terhadap permintaan dari Hub. Hub tidak bisa meminta permission yang tidak dikenal HCIS, dan tidak bisa meminta `access.roles.*` (D-5).
5. **Audit dua sisi.** Pemberian peran tercatat di SQ Hub dan di HCIS secara terpisah, dengan `requestId` yang sama. Riwayat yang hanya muncul di satu sisi adalah tanda bahaya yang bisa diperiksa.
6. **Peringatan keluar-jalur.** Setiap pemberian peran HCIS yang tidak membawa `requestId` dari Hub (yakni jalur break-glass) menghasilkan audit event dengan penanda khusus, supaya pemakaian break-glass tidak tenggelam di antara pemberian normal.
7. **Tidak ada impersonation.** Dipertahankan di D-2 justru karena ini: tanpa `impersonation`, kompromi SQ Hub tidak memberi penyerang kemampuan menjadi pegawai tertentu tanpa jejak.

Kami **tidak** mengusulkan membatalkan sentralisasi ini. Keadaan sekarang, dengan empat lapis yang saling tidak mengenal, bukan lebih aman — hanya lebih sulit diaudit. Tetapi pemusatan ini membuat pengerasan SQ Hub (rate limit pada `/admin/access`, review keamanan sendiri, log yang tidak bisa dihapus dari dalam aplikasi) berpindah dari "baik untuk dimiliki" menjadi prasyarat, dan itu pekerjaan yang belum dijadwalkan.

**R-2. Kehilangan akses saat transisi.** Urutan yang salah mengunci semua orang keluar. Pengaman: urutan di AUTH-014 §6 bersifat **aditif lebih dulu, pencabutan paling akhir**, setiap langkah punya jalan mundur yang tidak bergantung pada langkah berikutnya, dan akun break-glass dihidupkan serta diuji **sebelum** `assertRoleGrantor` disentuh.

**R-3. `manage-users` lebih luas daripada yang dibutuhkan.** Di Keycloak, `manage-users` mencakup membuat, mengubah, menonaktifkan, dan menghapus pengguna, serta mengelola credential. Owner hanya meminta tiga kemampuan: membuat akun, menonaktifkan akun, reset kata sandi. Tidak ada role Keycloak bawaan yang lebih sempit. Pengaman: penghapusan pengguna dilarang di tingkat aplikasi SQ Hub (nonaktifkan, jangan hapus), dan pelanggarannya terlihat karena jumlah pengguna realm dipantau. Ini pengaman aplikasi, bukan pengaman platform, dan harus dicatat sebagai keterbatasan yang diterima.

**R-4. Resolusi subject menjadi permukaan serangan baru.** HCIS memetakan subject Keycloak dari Hub ke akun lokal. Pemetaan yang keliru berarti audit menuding orang yang salah, atau larangan self-grant terlewat. Pengaman: pemetaan hanya lewat `accounts.identity_issuer` + `identity_subject` yang sudah ada (bukan email, bukan nama), gagal-tertutup bila tidak unik, dan aktor yang terselesaikan wajib berstatus aktif.

**R-5. `human_capital_admin` kehilangan kemampuan di tengah jalan.** Pengaman: role Admin Modul dibuat dan diberikan **sebelum** permission apa pun dicabut dari `human_capital_admin`, dengan jeda pengamatan di antaranya, dan pencabutan adalah migration tersendiri yang bisa dibalik.

## Alternatives considered

| Alternatif | Alasan ditolak |
|---|---|
| Biarkan empat lapis, perbaiki hanya penautan akun SUPER_ADMIN ke Akun SQ | menyelesaikan gejala (tidak bisa login) tanpa menyelesaikan sebabnya (berganti akun untuk satu pemberian peran), dan mempertahankan batas yang tidak mengikuti prinsip apa pun |
| Jadikan `human_capital_admin` boleh memberi peran | membalik keputusan owner 2026-10-16 dan mengembalikan eskalasi: administrator modul bisa menaikkan dirinya lewat akun kedua. Inilah yang D-5 cegah |
| Pemberian peran tetap di HCIS, SQ Hub hanya mengurus akses aplikasi | owner tetap mengelola peran di enam tempat berbeda saat aplikasi SQ Core lengkap, dan tidak ada satu pun tempat yang bisa menjawab "siapa punya akses apa" |
| Berikan `realm-admin` ke akun mesin SQ Hub supaya Hub dapat melakukan segalanya | kompromi SQ Hub menjadi setara kompromi realm, termasuk impersonation dan penggantian penyedia identitas. Daftar larangan di D-2 adalah batas yang membuat kerusakan maksimal tetap terbatas |
| Hapus akun SUPER_ADMIN sekarang juga | membuang satu-satunya jalan masuk bila jalur Hub gagal; risiko persis yang sudah pernah terjadi |
| Admin Modul boleh memberi peran kerja di modulnya sendiri | terdengar wajar, tetapi "peran kerja" di HCIS mencakup `leave.validate` dan `payslips.publish`; Admin Modul akan menjadi lapis ketiga yang memberi akses, dan garis "orang dan akses versus isi modul" hilang. Koreksi eksplisit owner |
