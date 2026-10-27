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

**4.4 Menonaktifkan lokasi**
- Ditolak 409 `WORK_LOCATION_IN_USE` dengan daftar pemakainya, bila masih dipakai unit di struktur yang berlaku hari ini atau mesin aktif (D-5-7).

## 5. Paket

| Paket | Isi | Migration | Test minimum |
|---|---|---|---|
| **ORG-005-1** (selesai) | Kolom `organization_nodes.work_location_id`; tautan di panel unit Struktur (jendela "Lokasi, unit lama & staf HC"); `workLocation` di read model (warisan dari induk); hitungan Kesiapan | Ya, aditif. Rollback: `DROP COLUMN`; struktur lain tidak tersentuh. | Tautan tersimpan per change set; warisan dari induk; lokasi nonaktif ditolak; audit dan jurnal; izin `organization.manage` |
| **ORG-005-2** | `attendance_adms_devices.work_location_id`; pilihan lokasi di layar mesin; penolakan nonaktif lokasi yang masih dipakai (D-5-7) | Ya, aditif | Tautan mesin; 409 dengan daftar pemakai; audit |
| ORG-005-3 (TBD) | Jadwal memakai lokasi unit sebagai bawaan | Tidak | Menunggu ATT-011 |

## 6. Privasi

Lokasi kerja berisi nama tempat dan titik geofence, bukan alamat rumah pegawai. Read model hanya menambah nama lokasi.
