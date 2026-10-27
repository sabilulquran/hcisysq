# Pengumuman dan Pengingat

**Status:** ACCEPTED (Paket 1: pengumuman) — spesifikasi ini mengizinkan implementasi NOTIF-002. NOTIF-003 (pengingat terjadwal) tetap DISCOVERY di dokumen ini dan tidak boleh diimplementasikan sebelum §8 diputuskan. Keputusan bisnis yang belum tertulis ditandai `DRAFT`.
**Spesifikasi:** NOTIF-002 (pengumuman), NOTIF-003 (pengingat)
**Tanggal:** 2026-10-27
**Terkait:** NOTIF-001, NOTIF-004, ORG-004, ORG-005, AUTH-011
**Roadmap:** `docs/product/roadmap.md` §G, `docs/product/hcis-capability-map.md` §6

## 1. Tujuan

Hari ini pengumuman YSQ beredar lewat grup pesan. Akibatnya tidak ada arsip, tidak ada kepastian siapa sudah membaca, dan pegawai baru tidak pernah melihat pengumuman lama.

NOTIF-002 memberi:

- satu tempat resmi pengumuman organisasi yang dapat dibaca ulang;
- sasaran yang jelas (seluruh pegawai, satu unit, atau satu lokasi kerja);
- tanda baca per pegawai untuk pengumuman yang menuntut konfirmasi;
- pemberitahuan masuk ke pusat notifikasi NOTIF-004 yang sudah berjalan.

## 2. Batas

Termasuk:

- menyusun, menerbitkan, menjadwalkan terbit, mengarsipkan pengumuman;
- sasaran berbasis unit organisasi dan lokasi kerja;
- pengumuman penting yang meminta konfirmasi baca;
- ringkasan jangkauan dan bacaan untuk Human Capital.

**Tidak** termasuk:

| Di luar lingkup | Alasan |
| --- | --- |
| Email, WhatsApp, browser push | NOTIF-001 adapter eksternal, keputusan terpisah |
| Lampiran berkas | belum ada object storage yang disepakati; Paket 1 hanya teks |
| Komentar atau balasan pegawai | pengumuman adalah komunikasi satu arah; diskusi tetap di kanal lain |
| Pengingat terjadwal | NOTIF-003, §8 |
| Pengumuman ke luar organisasi | HCIS hanya untuk pegawai |

## 3. Keputusan

| # | Keputusan | Status |
| --- | --- | --- |
| N-01 | Pengumuman adalah **objek tersendiri**, bukan sekadar notifikasi massal. Notifikasi NOTIF-004 hanya penunjuk ke pengumuman. | ACCEPTED |
| N-02 | Sasaran: `ALL_EMPLOYEES`, `UNITS` (satu atau beberapa unit ORG-004, termasuk turunannya), `SITES` (lokasi kerja ORG-005). | ACCEPTED |
| N-03 | Daftar penerima **dibekukan saat terbit** (snapshot), supaya jangkauan dan angka bacaan tidak berubah ketika organisasi berubah. | ACCEPTED |
| N-04 | Pegawai yang masuk setelah pengumuman terbit **tidak** menerima notifikasinya, tetapi tetap dapat membaca arsipnya. | DRAFT |
| N-05 | Dua tingkat: `NORMAL` (cukup dibaca) dan `PENTING` (meminta konfirmasi baca dan tampil menonjol sampai dikonfirmasi). | DRAFT |
| N-06 | Pengumuman yang sudah terbit **tidak dapat diedit**; yang ada adalah **ralat** — versi baru yang menggantikan dan menautkan ke versi lama. | ACCEPTED |
| N-07 | Pengumuman dapat **dijadwalkan** terbit pada tanggal/jam tertentu. Penerbitannya dikerjakan saat pertama kali dibaca setelah waktunya lewat, bukan oleh job wajib. | DRAFT |
| N-08 | Pengumuman punya **masa tampil** opsional; setelahnya pindah ke arsip, tidak dihapus. | DRAFT |
| N-09 | Isi pengumuman adalah teks biasa dengan paragraf; tanpa HTML, tanpa skrip. | ACCEPTED |
| N-10 | Pengumuman **tidak boleh** memuat data pribadi pegawai lain, nominal gaji, atau nomor identitas. Aturan ini ditulis di layar penyusun, dan tidak ditegakkan otomatis. | DRAFT |

## 4. Objek dan status

```text
Announcement
  DRAFT -> SCHEDULED -> PUBLISHED -> ARCHIVED
  DRAFT -> PUBLISHED
  PUBLISHED -> SUPERSEDED   (oleh ralat, N-06)
```

Saat `PUBLISHED`:

1. daftar penerima dihitung dari struktur yang berlaku dan disimpan sebagai snapshot (N-03);
2. satu notifikasi NOTIF-004 dikirim per penerima, dengan `event_key` stabil sehingga pengiriman ulang idempoten;
3. pengumuman menjadi dapat dibaca di `/app/announcements`.

`ARCHIVED` dan kedaluwarsa masa tampil **diturunkan dari tanggal**, bukan dari job terjadwal, dengan pola yang sama seperti DOC-002.

## 5. Permission

| Permission | Arti |
| --- | --- |
| `announcements.read` | Melihat daftar dan statistik pengumuman seluruh organisasi |
| `announcements.manage` | Menyusun, menerbitkan, meralat, mengarsipkan |

Keduanya masuk bundel `human_capital_admin`. Super Admin tidak menerimanya lewat kompatibilitas legacy. Pegawai membaca pengumuman miliknya melalui endpoint self, bukan permission.

Pengumuman bersasaran unit **tidak** memberi hak baca lintas unit: pegawai hanya melihat pengumuman yang menyasar dirinya, ditambah yang menyasar seluruh pegawai.

## 6. Penyimpanan

```text
announcements                 isi, tingkat, status, jadwal, masa tampil, ralat
announcement_audiences        aturan sasaran per pengumuman
announcement_recipients       snapshot penerima + waktu baca/konfirmasi
announcement_audit_events     jejak transisi
```

`announcement_recipients` unik pada `(announcement_id, employee_id)`.

## 7. Acceptance criteria

- NOTIF-002-A: pegawai hanya melihat pengumuman yang menyasar dirinya atau seluruh pegawai.
- NOTIF-002-B: menerbitkan dua kali (retry) tidak menggandakan notifikasi maupun baris penerima.
- NOTIF-002-C: memindahkan pegawai ke unit lain setelah terbit tidak mengubah daftar penerima maupun angka bacaan.
- NOTIF-002-D: pengumuman `PENTING` meminta konfirmasi; konfirmasi tercatat dengan waktu dan tidak dapat dilakukan untuk orang lain.
- NOTIF-002-E: pengumuman yang sudah terbit tidak dapat diedit; ralat membuat versi baru dan menandai yang lama `SUPERSEDED`.
- NOTIF-002-F: pengumuman terjadwal tidak terlihat sebelum waktunya, tanpa bergantung pada job.
- NOTIF-002-G: isi dirender sebagai teks, bukan HTML.
- NOTIF-002-H: pengumuman yang melewati masa tampil pindah ke arsip tanpa job terjadwal.

## 8. NOTIF-003 — pengingat (DISCOVERY)

Pengingat berbeda dari pengumuman: sumbernya adalah keadaan data, bukan karangan manusia. Contoh yang nyata di YSQ: kontrak akan berakhir, surat peringatan akan habis masa berlakunya, permintaan surat menggantung, cuti belum diputuskan.

Yang harus diputuskan sebelum implementasi:

1. **Penjalan.** Mi8VPS tidak memakai systemd/cron per-layanan. Pilihan: worker `sq-core-worker.sh` yang sudah ada, atau penjadwal di dalam proses API. Keduanya butuh keputusan operasional, bukan hanya kode.
2. **Idempotensi.** Satu pengingat per objek per jendela waktu, tahan terhadap proses yang dijalankan dua kali.
3. **Daftar aturan pengingat** dan ambang harinya (H-30, H-7, H-1?).
4. **Penerima**: pegawai ybs, atasan, atau Human Capital.
5. **Kanal**: in-app saja, atau menunggu NOTIF-001.

Sampai kelimanya dijawab, NOTIF-003 tetap `discovery` di katalog layanan dan tidak boleh diiklankan sebagai tersedia.
