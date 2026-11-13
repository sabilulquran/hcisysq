-- REIMB-001 / HELP-001: help content for reimbursement.
-- Spec: docs/domain/help-center.md §8.2, docs/domain/reimbursement.md.
--
-- 1. Adds the help topic REIMBURSEMENT (kept in step with HELP_TOPICS in modules/help/domain.ts and
--    the web topic list).
-- 2. Adds four initial articles as DRAFT with origin SEED (D-03): nothing unreviewed reaches
--    employees until HC publishes it. Revision 1 without an actor and one audit event each, as 0130.
-- 3. Corrects the two TRIPS seed articles that said trip costs cannot be claimed in HCIS, with the
--    0137 rules: an untouched draft seed is corrected in place, a seed HC published without saving is
--    edited (version + 1, revision, audit), anything HC edited or archived is left alone.
-- Re-running is harmless: inserts skip existing rows and corrections match the old text only.
--
-- Down (removes the four seed articles; HC puts the TRIPS wording back on the admin screen):
--   remove help_audit_events, help_article_revisions and help_articles rows of topic REIMBURSEMENT,
--   then restore the 0130 topic CHECK without 'REIMBURSEMENT'.

ALTER TABLE help_articles DROP CONSTRAINT IF EXISTS help_articles_topic_check;
ALTER TABLE help_articles ADD CONSTRAINT help_articles_topic_check CHECK (topic IN (
  'GENERAL', 'ATTENDANCE', 'OVERTIME', 'LEAVE', 'PAYSLIP', 'TRIPS', 'CALENDAR',
  'TRAINING', 'LOANS', 'REIMBURSEMENT', 'ASSETS', 'DOCUMENTS', 'PERFORMANCE', 'APPROVALS'
));

INSERT INTO help_articles (id, kind, topic, title, body, status, sort_order, version, origin)
SELECT seed.id::uuid, seed.kind, 'REIMBURSEMENT', seed.title, seed.body, 'DRAFT', seed.sort_order, 1, 'SEED'
FROM (VALUES
  ('5a0c9a52-3f4e-4a8e-9a41-2c1d0e7b6a01', 'GUIDE', $help$Panduan singkat: Reimbursement$help$,
   $help$Layanan Reimbursement dipakai untuk meminta penggantian biaya kerja yang sudah Anda bayar sendiri, misalnya transport, penginapan, konsumsi rapat, atau perlengkapan kerja.

1. Buka Semua Layanan, bagian Keuangan Saya, lalu pilih Reimbursement.
2. Tekan Buat klaim. Isi judul klaim, lalu tambahkan baris biaya: kategori, tanggal, uraian, dan nominal. Bila biaya ini dari perjalanan dinas, pilih perjalanannya.
3. Tekan Simpan draf. Klaim tersimpan sebagai draf dan belum dikirim.
4. Unggah bukti pembayaran (foto struk, nota, atau tiket) dalam bentuk PDF, JPG, atau PNG, paling besar 4 MB per berkas. Anda dapat memotret langsung dari HP.
5. Tekan Periksa penyetuju untuk melihat siapa yang akan menyetujui, lalu tekan Kirim klaim.
6. Pantau di daftar Klaim saya. Pilih satu klaim untuk melihat tahap persetujuan, hasil verifikasi Keuangan, pembayaran, dan riwayatnya.

Alur status: Draf, lalu Menunggu persetujuan, Disetujui, menunggu verifikasi Keuangan, Diverifikasi, menunggu pembayaran, dan akhirnya Dibayar. Klaim juga dapat berstatus Ditolak atau Dibatalkan. Persetujuan diberikan oleh atasan langsung lalu approver unit; setelah itu Keuangan memeriksa bukti dan membayar.

Bila ada yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('5a0c9a52-3f4e-4a8e-9a41-2c1d0e7b6a02', 'FAQ', $help$Biaya apa saja yang bisa diklaim, dan berapa batasnya?$help$,
   $help$Saat ini ada lima kategori, masing-masing dengan batas per baris biaya: Transportasi sampai Rp3.000.000, Akomodasi sampai Rp2.000.000, Konsumsi sampai Rp1.000.000, Operasional atau perlengkapan kerja sampai Rp2.000.000, dan Lainnya sampai Rp1.000.000. Batas ini tampil juga di formulir.

Satu klaim boleh berisi 1 sampai 10 baris biaya dengan total paling banyak Rp10.000.000. Setiap baris paling sedikit Rp1.000. Tanggal biaya tidak boleh setelah hari ini dan paling lama 90 hari sebelum klaim dikirim. Setiap klaim wajib disertai bukti pembayaran.$help$,
   20),
  ('5a0c9a52-3f4e-4a8e-9a41-2c1d0e7b6a03', 'FAQ', $help$Kapan dan bagaimana reimbursement dibayar?$help$,
   $help$Setelah atasan langsung dan approver unit menyetujui, Keuangan memeriksa bukti Anda. Keuangan dapat menyetujui seluruh nominal, atau menyetujui sebagian bila ada baris yang tidak sesuai bukti atau ketentuan; alasannya tertulis di detail klaim.

Setelah diverifikasi, Keuangan membayar secara tunai atau transfer, di luar slip gaji, lalu mencatatnya di HCIS. Anda menerima notifikasi saat klaim disetujui, diverifikasi, ditolak, dan dibayar. Nominal yang dibayarkan tampil di detail klaim Anda.$help$,
   30),
  ('5a0c9a52-3f4e-4a8e-9a41-2c1d0e7b6a04', 'FAQ', $help$Bisakah saya mengubah atau membatalkan klaim?$help$,
   $help$Selama masih Draf, Anda bebas mengubah judul, baris biaya, perjalanan dinas, dan bukti, atau membuang draf itu. Bukti di draf yang dibuang ikut dihapus.

Setelah dikirim, isi klaim tidak dapat diubah. Anda dapat membatalkannya dengan menulis alasan selama statusnya Menunggu persetujuan atau Disetujui, menunggu verifikasi Keuangan. Setelah Keuangan memverifikasi, pembatalan hanya dapat dilakukan Keuangan. Bila ada yang keliru, batalkan lalu buat klaim baru.$help$,
   40)
) AS seed(id, kind, title, body, sort_order)
ON CONFLICT (id) DO NOTHING;

INSERT INTO help_article_revisions (id, article_id, version, kind, topic, title, body, status)
SELECT gen_random_uuid(), article.id, 1, article.kind, article.topic, article.title, article.body, article.status
FROM help_articles article
WHERE article.origin = 'SEED' AND article.topic = 'REIMBURSEMENT'
  AND NOT EXISTS (SELECT 1 FROM help_article_revisions r WHERE r.article_id = article.id AND r.version = 1);

INSERT INTO help_audit_events (id, event_type, article_id, metadata)
SELECT gen_random_uuid(), 'help.article.created', article.id,
       jsonb_build_object('kind', article.kind, 'topic', article.topic, 'title', article.title,
                          'version', 1, 'origin', 'SEED', 'migration', '0150')
FROM help_articles article
WHERE article.origin = 'SEED' AND article.topic = 'REIMBURSEMENT'
  AND NOT EXISTS (
    SELECT 1 FROM help_audit_events e WHERE e.article_id = article.id AND e.event_type = 'help.article.created'
  );

WITH changes(id, old_body, new_body, change_note) AS (VALUES
  ('77c1c9c3-7657-543b-9568-36c74fdacfb4',
   $help$Layanan Perjalanan Dinas dipakai untuk mengajukan penugasan ke luar tempat kerja, misalnya rapat di yayasan mitra atau kunjungan sekolah, sampai surat tugas bernomor terbit.

1. Buka Semua Layanan, bagian Layanan Pegawai, lalu pilih Perjalanan Dinas.
2. Isi Tujuan, tanggal Berangkat dan Kembali, serta Keperluan.
3. Tekan Periksa penyetuju untuk melihat siapa yang akan menyetujui.
4. Tekan Kirim pengajuan.
5. Pantau di daftar Perjalanan saya. Pilih satu perjalanan untuk melihat tahap persetujuan, surat tugas, dan riwayatnya.
6. Setelah status menjadi Surat tugas terbit, buka detailnya lalu tekan Cetak bila perlu.
7. Setelah kembali, tekan Tandai selesai dan tulis laporan singkat hasil perjalanan.

Alur status: Menunggu persetujuan, lalu Disetujui, menunggu surat tugas, lalu Surat tugas terbit, dan akhirnya Selesai. Pengajuan juga dapat berstatus Ditolak atau Dibatalkan. Persetujuan diberikan oleh atasan langsung lalu approver unit, kemudian HC menerbitkan surat tugas bernomor.

Biaya perjalanan dan uang muka belum diurus di HCIS. Bila ada yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   $help$Layanan Perjalanan Dinas dipakai untuk mengajukan penugasan ke luar tempat kerja, misalnya rapat di yayasan mitra atau kunjungan sekolah, sampai surat tugas bernomor terbit.

1. Buka Semua Layanan, bagian Layanan Pegawai, lalu pilih Perjalanan Dinas.
2. Isi Tujuan, tanggal Berangkat dan Kembali, serta Keperluan.
3. Tekan Periksa penyetuju untuk melihat siapa yang akan menyetujui.
4. Tekan Kirim pengajuan.
5. Pantau di daftar Perjalanan saya. Pilih satu perjalanan untuk melihat tahap persetujuan, surat tugas, dan riwayatnya.
6. Setelah status menjadi Surat tugas terbit, buka detailnya lalu tekan Cetak bila perlu.
7. Setelah kembali, tekan Tandai selesai dan tulis laporan singkat hasil perjalanan.

Alur status: Menunggu persetujuan, lalu Disetujui, menunggu surat tugas, lalu Surat tugas terbit, dan akhirnya Selesai. Pengajuan juga dapat berstatus Ditolak atau Dibatalkan. Persetujuan diberikan oleh atasan langsung lalu approver unit, kemudian HC menerbitkan surat tugas bernomor.

Biaya perjalanan yang sudah Anda keluarkan diklaim lewat layanan Reimbursement, dan klaimnya dapat ditautkan ke perjalanan ini. Uang muka dan uang harian belum diurus di HCIS. Bila ada yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   $help$Biaya perjalanan kini diklaim lewat Reimbursement (REIMB-001).$help$),
  ('23161474-2772-5c62-a43d-72d00482794d',
   $help$Belum. Layanan Perjalanan Dinas di HCIS saat ini hanya mengurus pengajuan, persetujuan, surat tugas, dan laporan selesai. HCIS tidak mencatat atau menghitung biaya, uang harian, akomodasi, tiket, maupun uang muka.

Untuk urusan biaya perjalanan, ikuti ketentuan yang berlaku di yayasan atau hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   $help$Sebagian. Biaya yang sudah Anda keluarkan, misalnya tiket, transport, penginapan, atau konsumsi selama perjalanan, sekarang diklaim lewat layanan Reimbursement. Saat menyusun klaim, pilih perjalanan dinasnya di kolom Perjalanan dinas, lalu unggah bukti pembayarannya. Perjalanan yang dapat dipilih adalah perjalanan Anda yang sudah disetujui, surat tugasnya sudah terbit, atau sudah selesai.

Uang muka sebelum berangkat dan uang harian belum diurus di HCIS. Untuk keduanya, ikuti ketentuan yang berlaku di yayasan atau hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   $help$Biaya perjalanan kini diklaim lewat Reimbursement (REIMB-001); uang muka dan uang harian belum.$help$)
),
draft AS (
  UPDATE help_articles article
     SET body = changes.new_body, updated_at = now()
    FROM changes
   WHERE article.id = changes.id::uuid
     AND article.origin = 'SEED' AND article.status = 'DRAFT' AND article.version = 1
     AND article.published_at IS NULL AND article.body = changes.old_body
  RETURNING article.id, article.kind, article.topic, article.title, changes.change_note
),
draft_revision AS (
  UPDATE help_article_revisions revision
     SET body = changes.new_body
    FROM draft
    JOIN changes ON changes.id::uuid = draft.id
   WHERE revision.article_id = draft.id AND revision.version = 1
  RETURNING revision.article_id
),
live AS (
  UPDATE help_articles article
     SET body = changes.new_body, version = article.version + 1, updated_at = now()
    FROM changes
   WHERE article.id = changes.id::uuid
     AND article.origin = 'SEED' AND article.status = 'PUBLISHED' AND article.body = changes.old_body
     AND NOT EXISTS (SELECT 1 FROM help_article_revisions saved
                      WHERE saved.article_id = article.id AND saved.actor_account_id IS NOT NULL)
  RETURNING article.id, article.kind, article.topic, article.title, article.body, article.status,
            article.version, changes.change_note
),
live_revision AS (
  INSERT INTO help_article_revisions (id, article_id, version, kind, topic, title, body, status, change_note)
  SELECT gen_random_uuid(), live.id, live.version, live.kind, live.topic, live.title, live.body, live.status,
         live.change_note
    FROM live
  RETURNING article_id
),
draft_audit AS (
  INSERT INTO help_audit_events (id, event_type, article_id, reason, metadata)
  SELECT gen_random_uuid(), 'help.article.seed_corrected', draft.id, draft.change_note,
         jsonb_build_object('kind', draft.kind, 'topic', draft.topic, 'title', draft.title,
                            'version', 1, 'origin', 'SEED', 'migration', '0150')
    FROM draft
  RETURNING id
)
INSERT INTO help_audit_events (id, event_type, article_id, reason, metadata)
SELECT gen_random_uuid(), 'help.article.edited', live.id, live.change_note,
       jsonb_build_object('kind', live.kind, 'topic', live.topic, 'title', live.title,
                          'version', live.version, 'status', live.status, 'previousTitle', live.title,
                          'origin', 'SEED', 'migration', '0150')
  FROM live;
