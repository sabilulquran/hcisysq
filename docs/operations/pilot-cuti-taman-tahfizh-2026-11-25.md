# Pilot Cuti Tahunan Taman Tahfizh — kesiapan terukur dan yang masih diperlukan

**Spec ID:** OPS-PILOT-TT-001
**Status:** ACTIVE — mencatat keputusan owner 2026-11-25 dan pengukuran yang menyertainya.
**Tanggal:** 2026-11-25
**Sumber angka production:** pembacaan baca-saja `ssh mi8vps-root` pada 2026-11-25 terhadap
`sqcore_hcis`, bagan terbit `Kursi Staf Kasir untuk peran kasbon` (berlaku 2026-11-10), dan nama
kunci pada `final.env`. Tidak ada satu pun nilai `final.env`, alamat email, NIP, atau nomor
telepon yang disalin ke dokumen ini.
**Rilis yang berjalan saat diukur:** `hcis-f6edebd4-20261125`.
**Rilis yang berjalan sejak 2026-11-25 12:17 WIB:** `hcis-27f10ccd-20261125` — membawa perubahan §6 (panel Mode persetujuan per unit dan dialog Tolak di halaman) ke production, tanpa satu migrasi pun dan tanpa mengubah satu pun angka di §4. Bukti `docs/development/production-release-verification-2026-11-25-27f10ccd.md`.

---

## 1. Apa yang owner putuskan pada 2026-11-25

Tiga keputusan yang sebelumnya menunggu di OPS-OPEN-001 §9 kini diambil:

| # OPS-OPEN-001 | Keputusan | Isinya |
| --- | --- | --- |
| D1 | Membuka bertahap lewat pilot satu unit | **Ya** |
| D2 | Unit pilot | **Taman Tahfizh**, modul **Cuti Tahunan** |
| D3b | Pengaturan rollout untuk node unit pilot | **Disiapkan**, agar data atasan cukup dipelihara di bagan |

Dan empat sasaran yang harus dibuktikan pilot:

1. undangan Akun SQ benar-benar berfungsi;
2. pengajuan masuk ke penyetuju yang benar;
3. keputusan **Setujui** dan **Tolak** berjalan dari layar;
4. pemohon menerima pemberitahuan hasilnya.

**Aktivasi massal menunggu hasil pilot.** Dokumen ini memisahkan dua daftar yang sering
tercampur: §5 — yang diperlukan untuk menjalankan pilot, dan §9 — sisa pekerjaan sebelum akses
dibuka untuk seluruh pegawai.

## 2. Cara membaca dokumen ini

Tiap baris di §4 adalah hasil pembacaan, bukan perkiraan. Yang tidak diukur ditulis "belum
diukur", bukan dikosongkan. Rekomendasi diberi label **Rekomendasi**; keputusan yang bukan milik
penulis diberi pemiliknya.

## 3. Bagan sebagai sumber penyetuju — terbaca dan lengkap

Node unit: **Taman Tahfizh Sabilul Qur'an**, di bawah Bidang Pendidikan, dengan dua anak node
**Guru** dan **Tata Usaha**. Kesembilan pegawai duduk di tiga node itu.

| Ikatan pada node unit | Kursi sasaran | Pejabat | Kebijakan kekosongan |
| --- | --- | --- | --- |
| `LEADER` | Kepala (node Taman Tahfizh) | **Pipit Fithriyah** | `CLIMB_TO_PARENT` |
| `UNIT_APPROVER` | Kepala (node Bidang Pendidikan) | **Muchsalmina** | `CLIMB_TO_PARENT` |

Kedua anak node **tidak punya ikatan sendiri**, jadi orangnya mendaki ke node unit. Inilah yang
membuat **satu baris pengaturan pada node unit cukup** untuk kesembilan orang — perilaku yang
sudah ada di production sejak `hcis-f6edebd4-20261125`.

Pembacaan kebijakan kekosongan di atas adalah syarat yang diminta OPS-OPEN-001 §7.1a butir 2
sebelum baris rollout ditulis, dan dengan ini terpenuhi: keduanya `CLIMB_TO_PARENT`. Sejak
ORG-004 D-R5 (sudah di production) kursi yang pejabatnya ada tetapi akunnya belum aktif **tidak
lagi dilewati diam-diam**; keadaan itu menolak dengan `409 APPROVER_ACCOUNT_NOT_READY`.

**Rantai pilot, di bawah mode `STRUCTURE`:** pemohon → **Pipit Fithriyah** (kepala unit) →
**Muchsalmina** (penyetuju unit). Dua orang berbeda, dua langkah, sehingga kegagalan routing
terbaca sebagai satu sebab. Bila **Pipit** yang mengajukan, langkah dirinya sendiri dibuang
(ORG-002) dan pengajuannya pergi langsung ke Muchsalmina.

## 4. Kesiapan yang terukur, 2026-11-25

### 4.1 Sembilan pegawai unit pilot

| Node | Pegawai | Email | Akun | Kelompok hak cuti | Mulai kerja |
| --- | --- | --- | --- | --- | --- |
| Taman Tahfizh | **Pipit Fithriyah** (kepala unit) | ada | `invited` | **kosong** | 2017-07-01 |
| Tata Usaha | **Rosaliana** | ada | `invited` | **kosong** | 2021-07-01 |
| Guru | Azzahra Nurfauziyyah Hanum | ada | `invited` | **kosong** | 2025-04-10 |
| Guru | Ida Parida | ada | `invited` | **kosong** | 2020-07-01 |
| Guru | Laeli Nurhayati | ada | `invited` | **kosong** | 2021-10-01 |
| Guru | Mega Silviyati | ada | `invited` | **kosong** | 2026-07-01 |
| Guru | Neneng Sri Sumiati | ada | `invited` | **kosong** | 2019-07-01 |
| Guru | Nurul Bulqis | ada | `invited` | **kosong** | 2023-01-09 |
| Guru | Siska Malika N. | **kosong** | **tidak ada akun** | **kosong** | 2024-07-01 |

Penyetuju unit **Muchsalmina** (di Bidang Pendidikan): email ada, akun `invited`, kelompok hak
cuti kosong, NIP ada.

Dua catatan data:

- **Siska Malika N. punya dua baris pegawai** — satu `resigned` dan satu `active`, dengan NIP
  berbeda dan keduanya tanpa email. Mana yang benar adalah keputusan data milik HC (OPS-OPEN-001
  D12). Selama belum diputuskan, ia tidak dapat diundang.
- Delapan dari sembilan punya email dan akun `invited`, jadi delapan **dapat diundang hari ini**.

### 4.2 Keadaan sistem yang menyentuh pilot

| Yang diperiksa | Hasil 2026-11-25 |
| --- | --- |
| Undangan aktivasi yang pernah dikirim, sepanjang umur sistem | **nol** (`account_activation_invitations` kosong) |
| Pengajuan cuti yang pernah dibuat | **nol** |
| Baris pengaturan rollout | **nol** — seluruh yayasan `LEGACY` |
| Kalender kerja | terisi: `Asia/Jakarta`, hari kerja Senin–Jumat |
| Periode kritis cuti yang aktif | **nol**, jadi tidak ada tanggal yang terhalang |
| Mode penerima WhatsApp | `allowlist`, adapter `kirim`; daftarnya berisi **3 entri**, dan **tidak satu pun** milik ketiga peran pilot |
| Jalur Akun SQ | kunci `SQ_HUB_APPLICATION_ACCESS_URL`, `SQ_HUB_MACHINE_CLIENT_ID`, `SQ_HUB_MACHINE_CLIENT_SECRET`, dan `OIDC_ISSUER` **ada**, jadi "Kirim aktivasi" tidak akan dijawab `ACTIVATION_INVITE_UNAVAILABLE` |
| Izin tambahan untuk penyetuju | **tidak ada**. Menu **Persetujuan** dan route `GET /leave/approvals` terbuka bagi setiap sesi pegawai; yang dibutuhkan hanya akun `active` |

### 4.3 Kelompok hak cuti se-yayasan

| Nilai | Pegawai aktif |
| --- | --- |
| **kosong** | **91** |
| `education` | 4 |
| `non_education` | **2** |

Enam yang terisi adalah sisa pengujian, bukan hasil klasifikasi yang sistematis.

## 5. Yang masih diperlukan untuk menjalankan pilot

Berurutan; nomor 1 mendahului yang lain dan **bukan** pekerjaan repository.

### 5.1 Penghambat 1 — kelompok hak cuti belum diisi (keputusan HC)

**Cuti Tahunan individual hanya berlaku untuk `non_education`** (`docs/domain/leave-policy-ysq.md`,
"System validation": *employee belongs to the non-education entitlement group*; dijalankan oleh
`assertAnnualLeaveEntitlementGroup`). Pegawai yang kelompoknya kosong dijawab
**`409 UNSUPPORTED_ENTITLEMENT_GROUP`** — **sebelum** rantai penyetuju disentuh sama sekali.

Hari ini kelompok itu kosong untuk **kesembilan** pegawai unit pilot. Artinya, tanpa langkah ini,
pilot berhenti pada pengajuan pertama dan **tidak satu pun dari empat sasaran owner terbukti**,
termasuk sasaran yang sebenarnya tidak bersalah seperti routing.

Spesifikasi melarang HCIS menebaknya: *"HCIS must keep education/non-education classification
explicit; it must not infer the classification solely from unit or job-title strings."* Jadi ini
keputusan orang, bukan migrasi.

Jalannya ada di layar: **Admin → Konfigurasi Cuti**, per pegawai, izin
`leave.configuration.manage`, teraudit sebagai `leave.entitlement_group.changed`.

**Rekomendasi penulis, `DRAFT`, menunggu penegasan HC:**

| Pegawai | Usul kelompok | Dasarnya |
| --- | --- | --- |
| **Rosaliana** (Tata Usaha) | `non_education` | Tenaga administrasi, bukan pengajar |
| Tujuh Guru | `education` | Pengajar; haknya adalah Cuti Akhir Semester, bukan Cuti Tahunan individual |
| **Pipit Fithriyah** (Kepala Taman Tahfizh) | **keputusan HC** | Kepala unit pendidikan; tidak ada aturan tertulis yang menentukannya |
| **Muchsalmina** | tidak menghalangi pilot | Kelompok hanya dibutuhkan untuk **mengajukan**, bukan untuk **menyetujui** |

### 5.2 Penghambat 2 — akibat dari 5.1: siapa pegawai pilotnya

Taman Tahfizh adalah unit sekolah: **tujuh dari sembilan orangnya pengajar**, dan pengajar memang
tidak berhak atas Cuti Tahunan individual. Setelah klasifikasi, yang benar-benar dapat
mengajukan Cuti Tahunan di unit ini **paling banyak dua orang** — Rosaliana, dan Pipit bila HC
menetapkannya `non_education`.

**Rekomendasi penulis: pegawai pilotnya Rosaliana.** Ia satu-satunya orang di node **Tata Usaha**,
sehingga pengajuannya sekaligus membuktikan pendakian dari anak node yang tidak punya ikatan
sendiri — persis perilaku yang baris rollout tunggal andalkan — dan rantainya melewati **dua**
orang yang berbeda.

### 5.3 Penghambat 3 — tiga akun belum aktif (HC)

Akun menjadi `active` pada **masuk pertama** memakai Akun SQ, bukan karena HC menandainya. Jadi
tiga orang harus benar-benar masuk sebelum pengajuan pertama, **penyetuju lebih dulu**:

1. **Muchsalmina** (penyetuju unit),
2. **Pipit Fithriyah** (kepala unit),
3. **Rosaliana** (pegawai pilot).

Selama penyetuju belum aktif, pengajuan berhenti di `409 APPROVER_ACCOUNT_NOT_READY` — kode yang
sama pada `LEGACY` maupun `STRUCTURE` sejak ORG-004 D-R5.

Caranya: **Admin → Akses/Akun**, tombol **Kirim aktivasi** untuk tiap akun `invited`. HCIS
memanggil SQ Hub, Keycloak mengirim email berisi tautan kata sandi (berlaku 12 jam), dan
undangannya sendiri berlaku 14 hari. Batasnya: paling cepat 10 menit antar pengiriman untuk satu
akun, paling banyak 5 kali per 24 jam.

**Kata sandi diisi orangnya sendiri.** Tidak ada agent maupun HC yang mengetiknya.

### 5.4 Langkah operator — daftar izin WhatsApp (opsional, tidak menghalangi)

Pemberitahuan WhatsApp untuk ketiga peserta akan berstatus `not_allowlisted` selama NIP mereka
belum ada di `WHATSAPP_ALLOWLIST`. **Email aktivasi tidak terpengaruh** — ia datang dari Keycloak,
bukan dari jalur WhatsApp HCIS. Panduan peserta sudah menyuruh mereka menunggu email, bukan
WhatsApp.

Bila owner ingin pemberitahuan WhatsApp ikut terbukti (sasaran 1 dan 4 tetap terbukti tanpa itu),
operator menambahkan **tiga NIP peserta** ke `WHATSAPP_ALLOWLIST` pada
`/srv/hcis/shared/final.env` lalu memulai ulang layanan — kira-kira 30 detik gangguan. Dilakukan
bersamaan dengan pengiriman undangan, bukan sebelumnya, supaya keadaan env tidak menyimpang dari
yang tercatat.

### 5.5 Langkah HCM — satu baris pengaturan rollout

Setelah 5.1–5.3, satu baris memindahkan unit ini ke bagan. Sejak perubahan ini, baris itu ditulis
**dari layar**, bukan dari psql: **Admin → Struktur Organisasi → Mode persetujuan per unit →
Pindahkan unit**.

| Isian | Nilai |
| --- | --- |
| Unit | **Taman Tahfizh Sabilul Qur'an** (bukan leluhurnya; satu baris menjangkau seluruh sub-nodenya) |
| Jenis pengajuan | **Cuti Tahunan** (`leave.annual`) |
| Sumber atasan | **Struktur ini** (`STRUCTURE`) |
| Berlaku mulai | hari pertama pilot |
| Alasan | `Pilot Cuti Tahunan Taman Tahfizh` |

**Jalan mundurnya ada di baris yang sama:** tombol **Akhiri**, alasan wajib, paling awal berakhir
hari ini, teraudit sebagai `organization.rollout.ended`. Unit kembali ke data atasan lama, dan
rantai pada pengajuan yang sudah terkirim tidak disentuh.

**Pembacaan 2026-11-26.** Uji kering di production yang selalu di-ROLLBACK membuktikan baris
pada §5.5 cukup: dengan baris itu dan ketiga akun aktif, pengajuan Rosaliana membaca bagan terbit
dan rantainya **Pipit Fithriyah → Muchsalmina**; pegawai unit lain tetap LEGACY. Ditemukan juga
bahwa §5.1 di production menjawab **500**, bukan 409, untuk kelompok yang kosong; perbaikannya
menunggu rilis. Bukti lengkap: `docs/operations/pilot-tt-readiness-evidence-2026-11-26.md`.

### 5.6 Ringkasan §5

| # | Yang diperlukan | Pemilik | Menghalangi? |
| --- | --- | --- | --- |
| 1 | Isi kelompok hak cuti peserta | HC | **Ya, mutlak** |
| 2 | Tetapkan pegawai pilot (usul: Rosaliana) | HCM | **Ya** |
| 3 | Kirim aktivasi untuk Muchsalmina, Pipit, lalu pegawai pilot; ketiganya masuk sekali | HC, lalu orangnya | **Ya** |
| 4 | Tulis baris rollout Taman Tahfizh · Cuti Tahunan · `STRUCTURE` | HCM | **Ya** |
| 5 | Tambahkan tiga NIP ke daftar izin WhatsApp | Operator | Tidak |
| 7 | Isi hari libur dan cuti bersama sampai akhir pilot (production hanya mencatat 2026-08-25) | HC | Disarankan |
| ~~8~~ | ~~Rilis perbaikan 409 untuk kelompok hak cuti kosong (sebelumnya 500)~~ | Operator | **Selesai 2026-11-26 16:16 WIB** — `hcis-7fd89146-20261126`; bukti `docs/development/production-release-verification-2026-11-26-7fd89146.md` |
| ~~6~~ | ~~Rilis perubahan ini ke production~~ | Operator | **Selesai 2026-11-25 12:17 WIB** — `hcis-27f10ccd-20261125`, tanpa migrasi, verify lulus percobaan pertama; bukti `docs/development/production-release-verification-2026-11-25-27f10ccd.md`. Panel **Mode persetujuan per unit** dan dialog **Tolak** sudah ada di production |

## 6. Yang ditambahkan perubahan ini

| Perubahan | Mengapa pilot membutuhkannya |
| --- | --- |
| **Panel "Mode persetujuan per unit"** pada Admin → Struktur Organisasi, dengan tombol memindahkan unit dan **Akhiri** per baris | `PATCH /admin/organization/rollout` dan `POST .../rollout/:id/end` sebelumnya tidak dipanggil dari mana pun, sehingga menyalakan maupun mematikan saklar hanya bisa lewat psql — dan "jalan mundur" yang dijanjikan OPS-OPEN-001 §7.8 adalah route yang tidak ada pemanggilnya |
| `GET /admin/organization/rollout` kini membawa `id` dan `reason` tiap baris yang berlaku (ORG-004 D-R7) | Tanpa `id`, tidak ada klien yang dapat menyebut baris yang akan diakhiri |
| **Dialog "Tolak" pindah ke dalam halaman** pada layar Persetujuan, dengan alasan yang terbaca pemohon | Sasaran owner nomor 3. `window.prompt` tidak terbaca pembaca layar, dan Android Chrome menawarkan menekan dialog berikutnya — sesudah itu tombol **Tolak** diam saja. Ini juga menutup S1/S2 di OPS-EVID-001 §7 |

## 7. Yang sudah diperiksa dan **bukan** penghambat

- **Bagan.** Lengkap, ikatannya terbaca, kebijakan kekosongan dibaca dan dicatat (§3).
- **Kolom atasan lama.** Tidak dibaca rute berbasis bagan; kosongnya `direct_manager_employee_id`
  untuk kesembilan orang tidak berpengaruh di bawah `STRUCTURE`.
- **Tanggal mulai kerja.** Terisi untuk kesembilan orang, jadi `EMPLOYMENT_START_MISSING` tidak
  akan muncul.
- **Kalender kerja dan periode kritis.** Terisi dan kosong; tidak ada tanggal yang terhalang.
- **Izin penyetuju.** Tidak ada izin tambahan yang perlu diberikan.
- **Jalur Akun SQ.** Terkonfigurasi di production.
- **Rilis.** Jangkauan sub-node, jalur `end`, dan ORG-004 D-R5 sudah berjalan di production sejak
  `hcis-f6edebd4-20261125`; G12 OPS-OPEN-001 karena itu terpenuhi untuk ketiga perilaku yang
  dibutuhkan pilot.

## 8. Satu pertentangan dengan OPS-OPEN-001 yang harus diputuskan

OPS-OPEN-001 §7.6 butir 3 menuntut **minimal lima pengajuan cuti nyata dari lebih dari satu
orang**. Di Taman Tahfizh, Cuti Tahunan paling banyak dapat diajukan **dua** orang (§5.2), dan
itu pun bila Pipit ditetapkan `non_education`. Butir itu **tidak dapat dipenuhi** dengan Cuti
Tahunan di unit ini.

Tiga jalan, dan ini keputusan owner:

| Jalan | Akibatnya |
| --- | --- |
| **A. Turunkan ukuran keberhasilan** agar sesuai empat sasaran owner — misalnya "minimal dua pengajuan nyata selesai diputuskan, dari dua orang" | **Rekomendasi penulis.** Empat sasaran owner memang terbukti dengan satu sampai dua pemohon; angka lima berasal dari rencana yang cakupannya lebih luas |
| B. Tambah unit kedua yang tenaganya non-pendidikan, misalnya General Affair | Menambah akun yang harus diaktifkan dan menghilangkan sifat "satu unit, satu sebab" |
| C. Perluas cakupan pilot ke jenis cuti lain | Jenis lain punya `line_handling` dan jalur HC yang berbeda; kegagalan jadi lebih sulit dibaca |

## 9. Sisa pekerjaan sebelum akses dibuka untuk seluruh pegawai

Terpisah dari §5, dan **tidak** diperlukan untuk menjalankan pilot:

| Bidang | Yang tersisa | Pemilik |
| --- | --- | --- |
| Kelompok hak cuti | **91 pegawai aktif belum diklasifikasi**; pilot hanya menyentuh sebagian kecilnya | HC |
| Email | 23 pegawai aktif tanpa email sama sekali, jadi tidak dapat diundang | HC |
| Akun | 74 akun `invited` dan beberapa pegawai tanpa akun; aktivasi massal menunggu hasil pilot | HC |
| Penyetuju unit lain | Delapan dari sembilan unit berpegawai aktif penyetujunya belum berakun aktif | HC |
| Mode persetujuan unit lain | Tetap `LEGACY` dengan kolom atasan diisi, atau menyusul ke `STRUCTURE` (OPS-OPEN-001 D11) | Owner bersama HCM |
| Daftar izin WhatsApp | Keputusan jangkauan pesan untuk populasi penuh (D4) | Owner |
| Pemulihan kata sandi | Jalur atau fallback manual belum tertulis (D5) | Owner bersama HCM |
| Kepemilikan dan kanal peringatan | Pemilik insiden, stop, rollback, RPO/RTO belum bernama (D6) | Owner |
| Latihan restore penuh | Terakhir 2026-10-16 pada 55 migrasi; production kini 156 (D7) | Owner |
| Menu modul di luar cakupan | Menu pendek atau label jujur (D10, OPS-CLOSE-001 W11) | Owner |
| Pusat Bantuan | Topik untuk layanan yang dibuka belum terbit | HC |
| Kehadiran dari mesin | Perangkat ADMS diam sejak 17 November | Pemilik perangkat bersama operator |
| Katalog klasifikasi jabatan | Kosong, sehingga uang saku dinas tidak dapat dipakai siapa pun (D8) | Owner bersama HCM |
| Keputusan pembukaan | Satu salinan OPS-GOLIVE-001 yang terisi penuh (G13) | Owner |

## 10. Hubungan dengan dokumen lain

- `docs/operations/hcis-opening-criteria-and-pilot-plan-2026-11-23.md` (OPS-OPEN-001) — kriteria
  go/no-go dan rencana pilot. Dokumen ini mengisi §7.1 dengan pengukuran, menutup syarat §7.1a
  butir 2, dan mengajukan satu perubahan pada §7.6 (lihat §8).
- `docs/operations/panduan-pilot-cuti-taman-tahfizh.md` — panduan peserta.
- `docs/development/hcis-closure-list.md` (OPS-CLOSE-001) — posisi tiap butir, dengan bukti.
- `docs/development/hcis-opening-readiness-evidence-2026-11-24.md` (OPS-EVID-001) — S1 dan S2.
- `docs/domain/leave-policy-ysq.md` — aturan kelompok hak cuti yang §5.1 kutip.
- `docs/development/leave-003-r2-semester-quota-2026-11-25.md` (LEAVE-003 R2) — perpindahan batas
  pemakaian ke 6 hari kerja per semester, berlaku untuk cuti yang mulai 1 Januari 2027 (ditetapkan
  pemilik 25 November 2026). Tidak menambah prasyarat pilot: cuti yang mulai sebelum tanggal itu
  tetap memakai aturan 3 hari per triwulan.
- `docs/domain/dynamic-organization-structure.md` — perilaku saklar ORG-004.
