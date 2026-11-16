# Product Vision

**Status:** DRAFT

## Ringkasan

HCIS YSQ adalah sistem informasi human capital terpadu untuk membantu pegawai, atasan, pengelola unit, Human Capital, Finance, dan pengurus yayasan menjalankan proses kepegawaian secara konsisten, dapat diaudit, aman, dan mudah digunakan dari perangkat desktop maupun mobile.

HCIS adalah aplikasi kepegawaian di dalam SQ Suite, ekosistem aplikasi Yayasan Sabilul Qur'an. Istilah dan daftar aplikasi SQ Suite ada di [STRUKTUR-001](https://github.com/sabilulquran/SQ-Hub/blob/main/docs/product/struktur-sq-suite.md) (repository `SQ-Hub`, ADR-0014). HCIS tampil dengan tiga wajah: Kelola untuk Human Capital dan petugas berwenang serta Layanan mandiri untuk semua pegawai (keduanya di Portal Pegawai), dan Laporan untuk organ yayasan di Portal Organ.

## Masalah yang diselesaikan

- Data pegawai dan struktur organisasi tersebar atau tidak konsisten.
- Pengajuan dan approval sulit dilacak.
- Dokumen, payroll, pinjaman, dan reimbursement membutuhkan kontrol akses yang ketat.
- Proses manual menyulitkan audit, rekonsiliasi, dan pelaporan.
- Sistem harus tetap dapat berpindah dari managed environment ke VPS atau environment lain tanpa menulis ulang aturan bisnis.

## Outcome utama

1. Pegawai dapat menyelesaikan self-service tanpa bergantung pada admin untuk langkah rutin.
2. Approver melihat tugas, konteks, SLA, dan riwayat keputusan secara jelas.
3. Human Capital memiliki sumber data dan audit trail yang dapat dipercaya.
4. Finance dapat memproses data finansial dengan validasi dan rekonsiliasi.
5. Pengurus memperoleh laporan yang sesuai kewenangan tanpa membuka data detail yang tidak diperlukan.
6. Tim teknis dapat mengubah deployment environment melalui konfigurasi dan adapter.

## Kelompok pengguna

- Pegawai.
- Atasan langsung dan approver berjenjang.
- Kepala unit/pengelola unit.
- Human Capital.
- Finance.
- Organ yayasan (Pembina, Pengurus, Pengawas) sesuai mandat, lewat Portal Organ.
- Administrator sistem.

Kandidat rekrutmen bukan pengguna HCIS. Rekrutmen diurus aplikasi Karir SQ dengan Portal Pelamar (keputusan Product Owner 2026-10-16); HCIS hanya memegang sisi kepegawaian dari serah terimanya (REC-001 di `docs/product/hcis-capability-map.md`).

## Prinsip pengalaman pengguna

- Mobile-first untuk aktivitas pegawai seperti absensi, pengajuan, dan approval cepat.
- Desktop-efficient untuk tabel, administrasi, import, rekonsiliasi, dan laporan.
- Status, next action, dan alasan kegagalan selalu terlihat.
- Tidak mengandalkan warna saja untuk menyampaikan status.
- Form panjang disusun bertahap dan menyimpan progres bila sesuai risiko.
- Data sensitif hanya ditampilkan secukupnya sesuai kewenangan.

## Non-goals awal

- Menjadi ERP keuangan penuh.
- Menjadi platform komunikasi umum pengganti aplikasi chat.
- Membuat microservices sejak awal.
- Mendukung banyak database relasional secara paralel.
- Menyalin semua perilaku lama tanpa validasi.

## Indikator keberhasilan

Target numerik ditetapkan setelah discovery, tetapi harus mencakup:

- keberhasilan penyelesaian self-service;
- waktu penyelesaian approval;
- error rate dan failed jobs;
- konsistensi saldo/nominal pada rekonsiliasi;
- kelengkapan audit trail;
- adopsi pengguna aktif;
- waktu recovery dan keberhasilan restore backup;
- jumlah insiden akses data yang tidak semestinya.