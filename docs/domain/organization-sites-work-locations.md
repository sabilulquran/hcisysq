# ORG-005 — Lokasi kerja (site / cabang)

**Status:** DRAFT — default diambil tanpa keputusan tertulis berdasarkan aturan owner 2026-10-27 ("ambil default paling masuk akal, tandai DRAFT, jalan terus"). Setiap keputusan bertanda **D-5-x** dapat diubah owner.
**Related:** ORG-004 (struktur), ORG-007 (legal entity), ATT-003 (lokasi absensi/geofence), ATT-011 (jadwal), EMP-005 (penempatan), ORG-008 (designer)

## 1. Tujuan

Satu yayasan bekerja di beberapa tempat: kantor yayasan dan beberapa sekolah. HCIS sudah menyimpan tempat-tempat ini, tetapi hanya untuk absensi (`attendance_work_locations`: nama, titik, radius geofence), dan tidak terhubung dengan struktur organisasi. Akibatnya:

- tidak bisa dijawab "unit ini bekerja di lokasi mana";
- jadwal dan geofence dipilih satu per satu, padahal satu sekolah biasanya satu lokasi;
- mesin absensi memakai label teks bebas (`worksite_label`) yang tidak terhubung ke apa pun.

ORG-005 menjadikan **Lokasi kerja** satu daftar milik organisasi, lalu menghubungkannya ke unit struktur dan mesin absensi.

Ini bukan multi-tenancy, dan lokasi bukan legal entity (ORG-007): satu entity bisa punya banyak lokasi.

## 2. Keputusan (DRAFT)

| ID | Keputusan | Alasan |
|---|---|---|
| D-5-1 | Daftar lokasi kanonis adalah tabel yang sudah ada, `attendance_work_locations`, dan di layar disebut **Lokasi kerja**. Tidak dibuat tabel kedua. | Dua daftar tempat akan cepat berbeda isi. Absensi tetap memakai baris yang sama, jadi tidak ada migrasi data. |
| D-5-2 | Unit struktur (ORG-004 node) mendapat kolom nullable `work_location_id`. Kolom ini ikut versi change set, sama seperti `legacy_unit_id`. | Pindah lokasi adalah perubahan struktur yang perlu tanggal berlaku, riwayat, dan pemeriksa kedua. |
| D-5-3 | **Lokasi pegawai** = lokasi unit tempat ia menjadi anggota utama. Bila unit itu tidak punya lokasi, dipakai lokasi unit induk terdekat yang punya. Tidak ada lokasi yang ditebak dari nama unit. | Satu sekolah satu lokasi adalah kasus umum. Unit di bawahnya mewarisi tanpa diisi ulang. |
| D-5-4 | Mesin ADMS mendapat kolom nullable `work_location_id`. `worksite_label` tetap disimpan sebagai catatan lama. | Menghubungkan mesin ke lokasi tanpa menghapus data yang sudah ada. |
| D-5-5 | Mengelola daftar lokasi tetap memakai izin `attendance.schedule.manage` (ATT-003). Menautkan unit ke lokasi adalah penyusunan struktur, jadi memakai `organization.manage`. | Tidak ada izin baru. Pembagian ini sama dengan yang berlaku hari ini. |
| D-5-6 | Koordinat dan radius tetap wajib di v1. | Mesin absensi dan geofence membutuhkannya. Lokasi tanpa titik ditunda (TBD). |
| D-5-7 | Lokasi yang masih ditautkan ke unit di struktur yang berlaku, atau ke mesin aktif, tidak bisa dinonaktifkan. Respons 409 menyebut pemakainya. | Sama dengan aturan "nonaktif ditolak selama masih dipakai" di ORG-008-4b. |
| D-5-8 | **Absen HP dicek terhadap lokasi shift; bila shift tidak menyebut lokasi aktif, terhadap lokasi pegawai (D-5-3)** pada struktur yang berlaku di tanggal kerja. Lokasi shift yang aktif selalu menang. Lokasi nonaktif tidak pernah dipakai (lokasi shift yang dinonaktifkan jatuh ke lokasi unit). Aturan ini berlaku juga pada hari tanpa shift (libur/tanpa jadwal), karena yang dicek adalah tempat, bukan jam; tetapi **tidak** pada hari berstatus "Jadwal bermasalah", yang tetap masuk antrean tinjau. | Satu sekolah satu lokasi: HC cukup menautkan unit sekolah sekali di Struktur, tidak perlu mengisi lokasi di setiap shift. Shift tetap bisa menimpa untuk kasus khusus (mis. shift jaga di gedung lain). |

Di luar v1 (TBD): beberapa lokasi untuk satu unit, penugasan sementara ke lokasi lain, pemesanan ruang, lokasi per legal entity (ORG-007), dan `employment_placements.work_location_key` (kolomnya tetap dicadangkan, tidak diisi).

## 3. Actor dan izin

| Actor | Boleh | Izin |
|---|---|---|
| HC Admin | Melihat dan mengelola daftar lokasi; menautkan unit ke lokasi di dalam change set | `attendance.schedule.manage`, `organization.manage` |
| Kepala HC | Menerbitkan change set yang memuat tautan lokasi | `approvals.policy.manage` (ORG-008-8/10) |
| Pegawai | Tidak ada perubahan di v1 | — |

## 4. Alur

**4.1 Menautkan unit ke lokasi**
- **Precondition:** ada change set yang sedang disusun.
- **Input:** unit dan lokasi aktif.
- **Transisi:** `organization_nodes.work_location_id` pada draft diisi atau dikosongkan.
- **Audit dan jurnal:** `organization.node.updated` (field `workLocationId`) dan baris jurnal `MANUAL_EDIT`.
- **Kegagalan:** lokasi tidak ada atau nonaktif → 400 `INVALID_WORK_LOCATION`. Draft tidak bisa diubah → 409 seperti biasa.
- **Pemeriksaan:** unit aktif yang memakai lokasi yang dinonaktifkan sesudahnya ditolak saat Periksa dengan isu `WORK_LOCATION_INACTIVE`. Unit nonaktif tidak mewariskan lokasi. Pemilih lokasi hanya tampil bagi pemegang `attendance.schedule.manage` (D-5-5); yang lain hanya melihat lokasi saat ini.

**4.2 Membaca lokasi pegawai**
- Read model ORG-008-2 menambah `workLocation` pada setiap baris pegawai: `{ id, name, inheritedFromNodeKey | null }`, atau `null` bila tidak ada sampai ke akar.
- Kesiapan menambah hitungan informatif "unit tanpa lokasi". Ini **bukan** syarat terbit.

**4.3 Menautkan mesin ke lokasi** (paket kedua)
- Di layar mesin ADMS ada pilihan lokasi.
- Audit `attendance.adms.device.location_updated`.

**4.3a Absen HP memakai lokasi unit** (ORG-005-3, D-5-8)
- **Actor:** pegawai yang absen dari HP (`POST /attendance/mobile/clock`).
- **Urutan:** (1) lokasi versi shift hari itu, bila aktif; (2) bila kosong atau nonaktif, dan hari itu tidak berstatus "Jadwal bermasalah", lokasi unit utama pegawai pada struktur terbit yang berlaku di tanggal kerja, diwarisi dari unit induk terdekat (resolver read model ORG-005-1 yang sama, tidak ada resolver kedua); (3) bila tetap tidak ada, `unassigned_location` dan masuk antrean tinjau seperti sebelumnya.
- **Jejak:** respons mengembalikan `workLocationId` dan `workLocationSource` (`shift`/`unit`/`null`); `attendance_events.safe_metadata` menyimpan `workLocationSource`; `attendance_mobile_evidence.work_location_id` berisi lokasi yang benar-benar dipakai. Tidak ada migration.
- **Biaya:** satu pemuatan snapshot struktur per absen, hanya bila shift tidak menyebut lokasi.
- **Kesiapan di HP:** `GET /attendance/me/workforce` → `mobileReadiness.hasWorkLocation` ikut aturan yang sama dan menambah `workLocationSource`; layar HP menulis "terhubung (dari unit)". Struktur hanya dimuat bila absen HP aktif.
- **Kegagalan:** struktur belum terbit, pegawai tanpa keanggotaan utama, unit nonaktif, atau lokasi unit tanpa titik → dianggap tidak ada lokasi (langkah 3), tidak pernah menebak. Lokasi unit yang nonaktif biasanya tidak terjadi karena D-5-7 menolak menonaktifkan lokasi yang masih dipakai unit; resolver tetap mengabaikannya.
- **Layar Shift** menganggap shift dengan lokasi nonaktif sama dengan shift tanpa lokasi (dicoret, diberi tanda).
- **Di luar paket ini:** laporan dan filter lokasi pada Laporan (ATT-014) masih memakai lokasi shift saja. `DRAFT`.

**4.4 Menonaktifkan lokasi**
- Ditolak 409 `WORK_LOCATION_IN_USE` dengan daftar pemakainya, bila masih dipakai unit di struktur yang berlaku hari ini atau mesin aktif (D-5-7).

## 5. Paket

| Paket | Isi | Migration | Test minimum |
|---|---|---|---|
| **ORG-005-1** (selesai) | Kolom `organization_nodes.work_location_id`; tautan di panel unit Struktur (jendela "Lokasi, unit lama & staf HC"); `workLocation` di read model (warisan dari induk); hitungan Kesiapan | Ya, aditif. Rollback: `DROP COLUMN`; struktur lain tidak tersentuh. | Tautan tersimpan per change set; warisan dari induk; lokasi nonaktif ditolak; audit dan jurnal; izin `organization.manage` |
| **ORG-005-2** (selesai) | `attendance_adms_devices.work_location_id`; pilihan lokasi di layar mesin; penolakan nonaktif lokasi yang masih dipakai (D-5-7) | Ya, aditif | Tautan mesin; 409 dengan daftar pemakai; audit |
| **ORG-005-3** (selesai, DRAFT D-5-8) | Absen HP memakai lokasi unit bila shift tanpa lokasi; layar Shift dan Lokasi kerja menunjukkan shift tanpa lokasi dan pemakai tiap lokasi | Tidak | Unit (warisan induk) dipakai saat shift kosong; shift selalu menang; lokasi nonaktif dan pegawai tanpa unit → `unassigned_location`; `usage` per lokasi di PostgreSQL |

**Catatan ORG-005-2 (dibangun):**
- `PATCH /admin/attendance/adms/devices/:deviceId/wdms-profile` menerima `workLocationId`. Lokasinya harus ada dan aktif; kalau tidak, ditolak 400 `INVALID_WORK_LOCATION` dan di-*rollback*. Perubahan ini masuk ke audit `wdms_device_profile_updated`. Profil mesin mengembalikan `workLocationId` dan `workLocationName`.
- `PATCH /admin/attendance/work-locations/:id` dengan `active: false` ditolak 409 `WORK_LOCATION_IN_USE` (beserta `details.uses`) bila lokasi itu masih dipakai unit di struktur yang berlaku hari ini, unit di struktur terbit yang berlaku nanti, atau mesin yang belum dipensiunkan. Pemeriksaan dan penonaktifan berjalan dalam satu transaksi dengan baris lokasi dikunci; menautkan mesin mengambil *share lock* pada baris yang sama.
- Migration `0090_adms_device_work_location.sql` diberi nomor 0090 supaya jauh dari rentang yang dipakai paket lain.
- Di layar mesin: "Lokasi kerja" kini dipilih dari daftar organisasi, sedangkan `worksite_label` lama tetap tersimpan sebagai "Catatan lokasi (lama)". Pemilihnya hanya tampil bagi pemegang `attendance.schedule.manage` dan `attendance.devices.configure`.

**Catatan ORG-005-3 (dibangun):**
- Absen HP mengikuti §4.3a. Lokasi shift tetap menang, jadi data shift yang sudah berlokasi tidak berubah hasilnya.
- `GET /admin/attendance/work-locations` menambah `usage` per lokasi: shift aktif yang memakainya (nama), jumlah unit di struktur hari ini yang menautkannya langsung (unit yang mewarisi tidak dihitung), dan jumlah mesin. Respons juga membawa `mobileAttendanceEnabled`. `GET /admin/attendance/schedules` membawa `mobileAttendanceEnabled`. Keduanya data master terbatas (ENG-LIST-001 §4: lokasi beberapa baris, shift ≤ 200), tidak dipaginasi.
- Layar **Shift**: bila absen HP aktif, banner "N shift aktif belum punya lokasi kerja" dengan tombol **Atur lokasi** (membuka edit shift pertama yang kosong) atau **Tambah lokasi kerja** bila belum ada lokasi sama sekali; setiap baris shift aktif tanpa lokasi diberi tanda "Belum ada lokasi — absen HP tidak dicek radius". Pemilih lokasi di Tambah shift kini kotak tersendiri "Lokasi kerja (untuk absen HP)" dengan teks bantuan; pilihan kosong bernama "Tanpa lokasi (pakai lokasi unit)". Pemilih di edit hanya menawarkan lokasi aktif (plus lokasi yang sedang dipakai).
- Layar **Lokasi kerja**: kolom "Dipakai oleh" (shift, unit, mesin), ajakan "Belum dipakai shift — tautkan ke shift", teks bantuan cara mengambil titik dan radius, dan *empty state* yang menyarankan menambah lokasi seperti gedung sekolah.
- Perubahan ini tidak membuat atau mengubah data production. Menambah lokasi (mis. Taman Tahfizh) dan menautkannya ke shift atau unit adalah pekerjaan HC.

**Kecukupan model untuk lokasi seperti Taman Tahfizh (diperiksa 2026-11-11):** tidak ada yang kurang. Setiap lokasi punya titik dan radius sendiri (10–5000 m), tidak ada batasan nama unik atau larangan lingkaran yang tumpang tindih, dan absen hanya dicek terhadap satu lokasi yang ditetapkan untuk pegawai itu, sehingga dua sekolah dalam satu kompleks cukup dibuat sebagai dua lokasi (radius masing-masing, boleh beririsan) tanpa ambiguitas. Yang memang di luar v1 (tetap TBD, §2): satu pegawai yang berpindah tempat dalam satu shift, beberapa lokasi untuk satu unit, dan bentuk area selain lingkaran.

## 6. Privasi

Lokasi kerja berisi nama tempat dan titik geofence, bukan alamat rumah pegawai. Read model hanya menambah nama lokasi.
