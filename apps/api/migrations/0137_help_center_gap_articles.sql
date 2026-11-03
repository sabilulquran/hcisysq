-- HELP-001: bring seven initial help articles in line with CAL-001 K-16, DOC-001 D-20 and
-- LEAVE-010, which closed the gaps those articles described (WhatsApp option shown while inactive,
-- no print button for an issued letter, no leave cancellation, no approver notification for leave).
-- Spec: docs/domain/help-center.md §8.1.
--
-- HC's own edits always win. An article changes only while its body is still exactly the initial
-- text from 0130:
--   * an untouched DRAFT seed (version 1, never published) is corrected in place as initial content:
--     article and revision 1 get the new text and stay version 1, so it still counts as a draft HC
--     has to review (D-03), and audit records help.article.seed_corrected;
--   * a seed HC published without editing is edited like any other save (D-04): version + 1, a full
--     revision with a change note, and help.article.edited without an actor;
--   * anything HC edited or archived is left alone; HC updates it on the admin screen.
-- Re-running is harmless: once the body has changed, nothing matches.
--
-- Down: none needed for safety. To restore the 0130 wording of an untouched draft, run the same
-- statement with old and new swapped; a published one is edited back on the admin screen.

WITH changes(id, old_body, new_body, change_note) AS (VALUES
  ('99431555-85a0-56fd-9546-d9d6bbc390e7',
   $help$Saat ini undangan, perubahan, pembatalan, dan pengingat rapat sampai lewat Notifikasi di HCIS. Pengingat dikirim 30 menit sebelum rapat dimulai kepada penyelenggara dan peserta yang tidak berhalangan.

Pengiriman lewat WhatsApp dari HCIS belum aktif, walaupun pilihannya sudah tampil di formulir rapat. Jadi, pastikan Anda rutin membuka Notifikasi.$help$,
   $help$Belum. Saat ini undangan, perubahan, pembatalan, dan pengingat rapat sampai lewat Notifikasi di HCIS. Pengingat dikirim 30 menit sebelum rapat dimulai kepada penyelenggara dan peserta yang tidak berhalangan.

Selama pengiriman WhatsApp dari HCIS belum aktif, formulir rapat tidak menampilkan pilihan WhatsApp dan menuliskan bahwa pemberitahuan WhatsApp belum aktif. Pilihan Kirim juga lewat WhatsApp baru muncul setelah layanan itu dinyalakan. Jadi, pastikan Anda rutin membuka Notifikasi.$help$,
   $help$Formulir rapat kini menyembunyikan pilihan WhatsApp selama belum aktif (CAL-001 K-16).$help$),
  ('ed9cc0bb-554b-5ea9-8368-7706e32b7984',
   $help$Surat yang sudah terbit tercatat di bagian Surat yang sudah terbit beserta nomor, tanggal terbit, dan penandatangannya. Saat ini halaman Dokumen belum menyediakan tombol cetak atau unduh untuk surat tersebut.

Untuk mendapatkan salinan cetaknya, hubungi Human Capital (HC) melalui kontak di halaman Bantuan dan sebutkan nomor suratnya.$help$,
   $help$Buka Semua Layanan, bagian Layanan Pegawai, lalu pilih Dokumen. Pada bagian Surat yang sudah terbit, tekan Lihat & cetak pada surat yang Anda perlukan. Surat tampil lengkap dengan nomor, tanggal terbit, dan penandatangannya.

Tekan Cetak / Simpan PDF. Pilih printer untuk mencetak, atau pilih Simpan sebagai PDF untuk menyimpan berkas di perangkat Anda. Surat yang sudah dibatalkan tidak dapat dicetak. Bila ada isi surat yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan dan sebutkan nomor suratnya.$help$,
   $help$Pegawai kini dapat mencetak atau menyimpan PDF surat keterangan miliknya (DOC-001 D-20).$help$),
  ('35baba2c-65ce-5758-8849-8f6989a58638',
   $help$Layanan Dokumen dipakai untuk meminta surat keterangan dan melihat dokumen kepegawaian yang sudah terbit untuk Anda, termasuk surat peringatan bila ada.

1. Buka Semua Layanan, bagian Layanan Pegawai, lalu pilih Dokumen.
2. Pada Minta surat keterangan, pilih Jenis surat dan tulis keperluannya, misalnya pengajuan beasiswa anak.
3. Tekan Kirim permintaan.
4. Pantau di Permintaan saya. Statusnya: Menunggu keputusan, Disetujui, menunggu terbit, Sudah terbit, Ditolak, atau Dibatalkan.
5. Selama masih Menunggu keputusan, Anda dapat menekan Batalkan.
6. Surat yang sudah terbit tampil di Surat yang sudah terbit, lengkap dengan nomor surat, tanggal, dan penandatangan.

Permintaan diputuskan oleh HC. Nomor surat baru diberikan saat surat terbit, dan Anda menerima notifikasi saat permintaan diputuskan dan saat surat terbit. Bila permintaan ditolak, catatan HC tampil di bawahnya.

Surat keterangan penghasilan belum tersedia. Bila ada yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   $help$Layanan Dokumen dipakai untuk meminta surat keterangan dan melihat dokumen kepegawaian yang sudah terbit untuk Anda, termasuk surat peringatan bila ada.

1. Buka Semua Layanan, bagian Layanan Pegawai, lalu pilih Dokumen.
2. Pada Minta surat keterangan, pilih Jenis surat dan tulis keperluannya, misalnya pengajuan beasiswa anak.
3. Tekan Kirim permintaan.
4. Pantau di Permintaan saya. Statusnya: Menunggu keputusan, Disetujui, menunggu terbit, Sudah terbit, Ditolak, atau Dibatalkan.
5. Selama masih Menunggu keputusan, Anda dapat menekan Batalkan.
6. Surat yang sudah terbit tampil di Surat yang sudah terbit, lengkap dengan nomor surat, tanggal, dan penandatangan. Tekan Lihat & cetak, lalu Cetak / Simpan PDF untuk mencetak atau menyimpannya.

Permintaan diputuskan oleh HC. Nomor surat baru diberikan saat surat terbit, dan Anda menerima notifikasi saat permintaan diputuskan dan saat surat terbit. Bila permintaan ditolak, catatan HC tampil di bawahnya.

Surat keterangan penghasilan belum tersedia. Bila ada yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   $help$Menambahkan langkah cetak dan simpan PDF surat terbit (DOC-001 D-20).$help$),
  ('928a0c74-0b29-5415-baf3-a60f52b3b086',
   $help$Saat ini halaman Cuti & Izin belum menyediakan tombol pembatalan untuk pengajuan yang sudah dikirim.

Bila rencana Anda berubah, segera beri tahu atasan Anda dan hubungi Human Capital (HC) melalui kontak di halaman Bantuan agar pengajuan tersebut ditindaklanjuti. Periksa kembali tanggal sebelum menekan Kirim pengajuan untuk menghindari salah tanggal.$help$,
   $help$Bisa, selama pengajuan Cuti Tahunan atau keperluan terencana masih Dalam persetujuan, termasuk saat menunggu pemeriksaan HC. Buka menu Cuti & Izin, cari pengajuan di riwayat, tekan Batalkan pengajuan, isi alasan bila perlu, lalu tekan Ya, batalkan. Penyetuju yang sedang menunggu akan diberi tahu, dan jatah cutinya kembali tersedia.

Cuti yang sudah disetujui tidak dapat Anda batalkan sendiri. Begitu pula laporan sakit atau kondisi khusus. Untuk keduanya, beri tahu atasan Anda dan hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   $help$Pegawai kini dapat membatalkan cuti yang masih menunggu persetujuan (LEAVE-010).$help$),
  ('54750e5f-aacd-5103-acc2-5986ba954135',
   $help$Menu Cuti & Izin dipakai untuk mengajukan cuti, melaporkan kondisi khusus seperti sakit, dan melihat hak cuti tahunan Anda.

1. Buka menu Cuti & Izin.
2. Pada pertanyaan Apa yang Anda butuhkan, pilih salah satu: Cuti Tahunan, Sakit atau kondisi khusus, atau Keperluan terencana (pernikahan, menikahkan atau khitan anak, Haji wajib, dan Cuti Tanpa Gaji).
3. Isi tanggal mulai dan selesai, serta keterangan bila perlu.
4. Lampirkan dokumen pendukung bila diminta (PDF, JPG, atau PNG, maksimal 2 MB).
5. Tekan Lanjutkan atau Periksa pengajuan, lalu baca ringkasannya, misalnya jumlah hari kerja, sisa hak, dan alur persetujuan.
6. Tekan Kirim pengajuan atau Kirim laporan.
7. Pantau statusnya di riwayat pada halaman yang sama.

Siapa yang memproses: Cuti Tahunan disetujui atasan langsung lalu approver unit, kemudian HC diberi tahu. Laporan kondisi khusus diberitahukan kepada atasan, lalu HC memeriksa administrasinya. Keperluan terencana disetujui atasan dan dokumennya diperiksa HC; Cuti Tanpa Gaji juga memerlukan persetujuan HC.

Bila HC meminta dokumen tambahan, status berubah menjadi Perlu dilengkapi dan tombol Kirim dokumen muncul. Bila ada yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   $help$Menu Cuti & Izin dipakai untuk mengajukan cuti, melaporkan kondisi khusus seperti sakit, dan melihat hak cuti tahunan Anda.

1. Buka menu Cuti & Izin.
2. Pada pertanyaan Apa yang Anda butuhkan, pilih salah satu: Cuti Tahunan, Sakit atau kondisi khusus, atau Keperluan terencana (pernikahan, menikahkan atau khitan anak, Haji wajib, dan Cuti Tanpa Gaji).
3. Isi tanggal mulai dan selesai, serta keterangan bila perlu.
4. Lampirkan dokumen pendukung bila diminta (PDF, JPG, atau PNG, maksimal 2 MB).
5. Tekan Lanjutkan atau Periksa pengajuan, lalu baca ringkasannya, misalnya jumlah hari kerja, sisa hak, dan alur persetujuan.
6. Tekan Kirim pengajuan atau Kirim laporan.
7. Pantau statusnya di riwayat pada halaman yang sama. Selama Cuti Tahunan atau keperluan terencana masih Dalam persetujuan, Anda dapat menekan Batalkan pengajuan.

Siapa yang memproses: Cuti Tahunan disetujui atasan langsung lalu approver unit, kemudian HC diberi tahu. Laporan kondisi khusus diberitahukan kepada atasan, lalu HC memeriksa administrasinya. Keperluan terencana disetujui atasan dan dokumennya diperiksa HC; Cuti Tanpa Gaji juga memerlukan persetujuan HC.

Bila HC meminta dokumen tambahan, status berubah menjadi Perlu dilengkapi dan tombol Kirim dokumen muncul. Bila ada yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   $help$Menambahkan pembatalan cuti yang masih menunggu persetujuan (LEAVE-010).$help$),
  ('fad4a383-21b6-58e4-9059-35126b44d2dc',
   $help$Untuk perjalanan dinas, pinjaman, lembur, dan penilaian kinerja, Anda menerima notifikasi di HCIS saat tiba giliran Anda.

Untuk pengajuan cuti, saat ini belum ada notifikasi khusus. Periksa menu Persetujuan secara rutin, atau lihat kotak Perlu tindakan di Beranda yang menampilkan jumlah persetujuan yang menunggu.$help$,
   $help$Ya. Untuk cuti, perjalanan dinas, pinjaman, lembur, dan penilaian kinerja, Anda menerima notifikasi di HCIS saat tiba giliran Anda. Untuk cuti, Anda juga diberi tahu bila pemohon membatalkan pengajuan yang sedang menunggu keputusan Anda.

Notifikasi hanya penunjuk. Keputusan tetap diambil di menu Persetujuan, dan kotak Perlu tindakan di Beranda menampilkan jumlah persetujuan yang menunggu.$help$,
   $help$Penyetuju cuti kini menerima notifikasi di HCIS (LEAVE-010).$help$),
  ('039578d1-10b3-5d5e-8414-2ab0ffd0ed1f',
   $help$Notifikasi berisi pemberitahuan yang ditujukan khusus untuk akun Anda, misalnya pengajuan lembur yang sudah diputuskan, tukar shift, perjalanan dinas, pinjaman, surat yang terbit, penilaian kinerja, undangan rapat, dan slip gaji yang baru terbit. Buka dengan menekan ikon lonceng di bagian atas.

Tekan Tandai semua dibaca untuk membersihkan tanda belum dibaca. Membaca notifikasi tidak menyetujui apa pun. Saat ini notifikasi hanya tampil di dalam HCIS, belum dikirim lewat email atau WhatsApp.$help$,
   $help$Notifikasi berisi pemberitahuan yang ditujukan khusus untuk akun Anda, misalnya pengajuan cuti yang menunggu persetujuan Anda, pengajuan lembur yang sudah diputuskan, tukar shift, perjalanan dinas, pinjaman, surat yang terbit, penilaian kinerja, undangan rapat, dan slip gaji yang baru terbit. Buka dengan menekan ikon lonceng di bagian atas.

Tekan Tandai semua dibaca untuk membersihkan tanda belum dibaca. Membaca notifikasi tidak menyetujui apa pun. Saat ini notifikasi hanya tampil di dalam HCIS, belum dikirim lewat email atau WhatsApp.$help$,
   $help$Menyebut notifikasi pengajuan cuti untuk penyetuju (LEAVE-010).$help$)
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
                            'version', 1, 'origin', 'SEED', 'migration', '0137')
    FROM draft
  RETURNING id
)
INSERT INTO help_audit_events (id, event_type, article_id, reason, metadata)
SELECT gen_random_uuid(), 'help.article.edited', live.id, live.change_note,
       jsonb_build_object('kind', live.kind, 'topic', live.topic, 'title', live.title,
                          'version', live.version, 'status', live.status, 'origin', 'SEED',
                          'migration', '0137')
  FROM live;
