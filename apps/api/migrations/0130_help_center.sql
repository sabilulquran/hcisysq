-- HELP-001 Package 1: help center (FAQ, guides, HC contacts).
-- Spec: docs/domain/help-center.md §8.
--
-- Additive only: four new tables and the initial content. The initial content is loaded as
-- DRAFT with origin SEED (D-03), so nothing unreviewed reaches employees until HC publishes it.
-- Articles are never hard-deleted (D-02); audit rows keep article/contact ids without a foreign
-- key so the history survives a deleted contact.
--
-- Down:
--   DROP TABLE IF EXISTS help_audit_events;
--   DROP TABLE IF EXISTS help_article_revisions;
--   DROP TABLE IF EXISTS help_contacts;
--   DROP TABLE IF EXISTS help_articles;

CREATE TABLE IF NOT EXISTS help_articles (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('FAQ', 'GUIDE')),
  -- D-01: fixed topic list, kept in step with HELP_TOPICS in modules/help/domain.ts.
  topic text NOT NULL CHECK (topic IN (
    'GENERAL', 'ATTENDANCE', 'OVERTIME', 'LEAVE', 'PAYSLIP', 'TRIPS', 'CALENDAR',
    'TRAINING', 'LOANS', 'ASSETS', 'DOCUMENTS', 'PERFORMANCE', 'APPROVALS'
  )),
  title text NOT NULL CHECK (char_length(title) BETWEEN 5 AND 200),
  -- D-05: plain text with paragraphs. Never HTML, never a script.
  body text NOT NULL CHECK (char_length(body) BETWEEN 20 AND 8000),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  sort_order integer NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 9999),
  -- D-04: optimistic concurrency; equals the latest revision's version.
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  origin text NOT NULL DEFAULT 'HC' CHECK (origin IN ('SEED', 'HC')),
  created_by_account_id uuid NULL REFERENCES accounts(id),
  updated_by_account_id uuid NULL REFERENCES accounts(id),
  published_at timestamptz NULL,
  archived_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (origin = 'SEED' OR created_by_account_id IS NOT NULL),
  CHECK (status <> 'ARCHIVED' OR archived_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS help_articles_reader_idx
  ON help_articles (status, topic, sort_order, title);

CREATE TABLE IF NOT EXISTS help_article_revisions (
  id uuid PRIMARY KEY,
  article_id uuid NOT NULL REFERENCES help_articles(id),
  version integer NOT NULL CHECK (version >= 1),
  kind text NOT NULL,
  topic text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL,
  change_note text NULL CHECK (change_note IS NULL OR char_length(change_note) <= 300),
  -- Null only for the initial content loaded by this migration.
  actor_account_id uuid NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, version)
);

CREATE TABLE IF NOT EXISTS help_contacts (
  id uuid PRIMARY KEY,
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 100),
  channel text NOT NULL CHECK (channel IN ('WHATSAPP', 'PHONE', 'EMAIL', 'OFFICE')),
  value text NOT NULL CHECK (char_length(value) BETWEEN 2 AND 200),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 200),
  sort_order integer NOT NULL DEFAULT 100 CHECK (sort_order BETWEEN 0 AND 9999),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS help_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  article_id uuid NULL,
  contact_id uuid NULL,
  actor_account_id uuid NULL REFERENCES accounts(id),
  reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS help_audit_events_occurred_idx
  ON help_audit_events (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS help_audit_events_article_idx
  ON help_audit_events (article_id) WHERE article_id IS NOT NULL;

-- D-03: initial content, generated from docs/domain/help-center-seed.json. Each article gets
-- revision 1 without an actor and one audit event, exactly as if HC had drafted it.
INSERT INTO help_articles (id, kind, topic, title, body, status, sort_order, version, origin)
SELECT seed.id::uuid, seed.kind, seed.topic, seed.title, seed.body, 'DRAFT', seed.sort_order, 1, 'SEED'
FROM (VALUES
  ('f580ae78-6030-526a-b8f2-f97d3c189adb', 'GUIDE', 'GENERAL', $help$Panduan singkat: Memulai HCIS$help$,
   $help$HCIS adalah layanan kepegawaian Yayasan Sabilul Qur'an. Di sini Anda dapat melihat kehadiran, mengajukan cuti dan lembur, membaca slip gaji, serta memakai layanan pegawai lainnya. HCIS dibuka lewat browser di HP atau komputer.

1. Buka alamat HCIS (hcis.sabilulquran.or.id) di browser HP atau komputer.
2. Tekan tombol Masuk dengan Akun SQ, lalu masuk memakai Akun SQ Anda. Akun yang sama juga dipakai untuk SQ Hub dan Aset SQ. Bila Anda masih dalam keadaan masuk di Akun SQ, HCIS biasanya langsung terbuka.
3. Anda akan tiba di Beranda. Di sini tampil kehadiran hari ini, Akses cepat, kotak Perlu tindakan, dan ringkasan cuti tahunan.
4. Pakai menu di sisi kiri (komputer) atau di bagian bawah layar (HP: Beranda, Hadir, Cuti, Approval, dan Lainnya). Layanan lain ada di Semua Layanan.
5. Tekan ikon lonceng di bagian atas untuk membuka Notifikasi.
6. Untuk keluar, tekan nama atau inisial Anda di kanan atas, lalu pilih Keluar.

Setiap layanan hanya menampilkan data milik Anda sendiri. Keputusan seperti persetujuan cuti tetap dibuat oleh atasan atau HC sesuai alurnya, bukan oleh layar.

Bila muncul pesan bahwa akun Anda belum memiliki akses ke HCIS atau sedang tidak aktif, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('ab52adc0-ce88-5417-988c-6abf9f079228', 'FAQ', 'GENERAL', $help$Bagaimana cara masuk ke HCIS?$help$,
   $help$Buka HCIS di browser, lalu tekan Masuk dengan Akun SQ. Anda masuk memakai Akun SQ, yaitu akun yang sama untuk SQ Hub, HCIS, dan Aset SQ. HCIS tidak memakai kata sandi tersendiri.

Setelah berhasil, Anda langsung diarahkan ke Beranda. Bila gagal, coba sekali lagi. Bila tetap gagal, catat pesan yang muncul di layar lalu hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   20),
  ('f5d877f7-bea8-57e1-b35c-b53c873aafa4', 'FAQ', 'GENERAL', $help$Saya lupa kata sandi Akun SQ. Apa yang harus saya lakukan?$help$,
   $help$Kata sandi Akun SQ tidak disimpan dan tidak dapat diatur ulang dari HCIS. Hubungi Human Capital (HC) melalui kontak di halaman Bantuan agar permintaan Anda diteruskan ke pengelola Akun SQ.

Pengaturan profil, keamanan, dan sesi Akun SQ dibuka dari menu akun HCIS (tekan nama Anda di kanan atas, lalu pilih Akun SQ). Jangan pernah memberitahukan kata sandi Anda kepada siapa pun, termasuk petugas HC.$help$,
   30),
  ('9344158e-cfba-5146-b8b6-876fa51e5b16', 'FAQ', 'GENERAL', $help$Muncul pesan bahwa akun saya belum memiliki akses ke HCIS. Kenapa?$help$,
   $help$Pesan itu berarti Anda berhasil masuk dengan Akun SQ, tetapi akun tersebut belum diberi akses ke HCIS. Akses HCIS diberikan per akun oleh pengelola.

Bila pesannya berbunyi akun HCIS Anda sedang tidak aktif, status akun Anda perlu diperiksa. Untuk kedua keadaan ini, hubungi Human Capital (HC) melalui kontak di halaman Bantuan. Bila pesannya meminta mencoba lagi beberapa saat, tunggu sebentar lalu muat ulang halaman.$help$,
   40),
  ('7a249b41-4b69-5dd9-a118-f897a928c5b9', 'FAQ', 'GENERAL', $help$Apakah HCIS punya aplikasi yang harus diunduh dari Play Store?$help$,
   $help$Tidak. HCIS dibuka langsung lewat browser di HP atau komputer, tanpa memasang aplikasi.

Untuk Clock In/Out dari HP, browser akan meminta izin Lokasi dan Kamera. Izinkan keduanya untuk situs HCIS. Bila izin pernah ditolak, buka pengaturan situs di sebelah alamat HCIS lalu ubah menjadi diizinkan.$help$,
   50),
  ('039578d1-10b3-5d5e-8414-2ab0ffd0ed1f', 'FAQ', 'GENERAL', $help$Apa isi halaman Notifikasi?$help$,
   $help$Notifikasi berisi pemberitahuan yang ditujukan khusus untuk akun Anda, misalnya pengajuan lembur yang sudah diputuskan, tukar shift, perjalanan dinas, pinjaman, surat yang terbit, penilaian kinerja, undangan rapat, dan slip gaji yang baru terbit. Buka dengan menekan ikon lonceng di bagian atas.

Tekan Tandai semua dibaca untuk membersihkan tanda belum dibaca. Membaca notifikasi tidak menyetujui apa pun. Saat ini notifikasi hanya tampil di dalam HCIS, belum dikirim lewat email atau WhatsApp.$help$,
   60),
  ('c2e9bb87-25d5-5edc-9bf3-5b96d1f4f8c5', 'FAQ', 'GENERAL', $help$Di mana saya membaca pengumuman resmi yayasan?$help$,
   $help$Buka Semua Layanan, lalu pilih Pengumuman di bagian Informasi. Di sana tampil pengumuman yang sedang berlaku untuk Anda, dan pengumuman lama tetap dapat dibaca di arsip.

Pengumuman bertanda penting meminta Anda menekan Saya sudah membaca. Tanda ini dicatat sebagai bukti bahwa Anda sudah membacanya. Pengumuman yang sudah terbit tidak diedit; bila ada perbaikan, akan terbit ralat dan versi lama ditandai sudah diralat.$help$,
   70),
  ('ebd5d44b-ea4f-5daa-ac89-155c523e27bd', 'FAQ', 'GENERAL', $help$Bagaimana cara mengubah alamat atau nomor telepon saya di HCIS?$help$,
   $help$Buka menu Data Saya, lalu tekan Ajukan perubahan alamat atau Ajukan perubahan kontak. Isi data baru, lalu tekan Kirim usulan. Pada usulan kontak, kotak yang dibiarkan kosong tidak diubah; untuk menghapus email atau telepon, centang pilihan di bawahnya.

Usulan Anda diputuskan oleh HC. Statusnya tampil di daftar Usulan perubahan data saya: Menunggu keputusan, Diterima, Ditolak (beserta alasannya), atau Dibatalkan. Selama masih menunggu, Anda dapat menekan Batalkan usulan.$help$,
   80),
  ('6ca42c90-6ba7-55e3-936b-6d7943cc4ba7', 'FAQ', 'GENERAL', $help$Data lain saya di HCIS salah, misalnya nama, jabatan, atau unit. Bagaimana memperbaikinya?$help$,
   $help$Saat ini yang dapat Anda usulkan sendiri lewat Data Saya hanya alamat dan kontak. Data keluarga, pendidikan, keahlian, serta data kepegawaian seperti nama, jabatan, dan unit dicatat oleh HC.

Bila ada yang keliru, hubungi Human Capital (HC) melalui kontak di halaman Bantuan dan sebutkan data mana yang perlu diperbaiki beserta bukti pendukungnya.$help$,
   90),
  ('a8dbc441-2de2-50f5-b214-251ebdf67dfb', 'GUIDE', 'ATTENDANCE', $help$Panduan singkat: Kehadiran dan Clock In/Out$help$,
   $help$Menu Kehadiran menampilkan status hari ini, jadwal, jam masuk dan keluar yang tercatat, Jadwal saya untuk minggu ini dan minggu depan, Klarifikasi saya, serta Riwayat 30 hari. Catatan dari mesin fingerprint dan dari presensi HP digabung di sini.

Cara presensi lewat HP:

1. Buka menu Clock In/Out, atau tekan Buka Clock In / Out di halaman Kehadiran.
2. Periksa kotak Persiapan presensi. Server harus berstatus siap.
3. Tekan 1. Baca GPS dan izinkan akses lokasi.
4. Tekan 2. Buka kamera, izinkan akses kamera, lalu tekan 3. Ambil foto. Periksa pratinjau fotonya.
5. Tekan Clock in saat datang, atau Clock out saat pulang.
6. Tunggu pesan bahwa presensi tersimpan, beserta keterangan lokasinya, misalnya di dalam area atau di luar area dan perlu ditinjau.

Lokasi hanya dibaca saat Anda menekan Baca GPS; tidak ada pelacakan di latar belakang. Foto adalah bukti presensi, bukan pengenalan wajah, dan disimpan terenkripsi.

Presensi di luar area tetap tersimpan, tetapi ditandai perlu ditinjau HC. Bila pengiriman belum terkonfirmasi karena sinyal putus, tekan Coba ulang pengiriman yang sama; presensi tidak akan tercatat dua kali. Bila jam masuk atau pulang tidak tercatat, ajukan klarifikasi dari Riwayat 30 hari.$help$,
   10),
  ('4c7fa90b-0f67-56c3-ae00-a03fef434ecf', 'FAQ', 'ATTENDANCE', $help$Saya lupa absen masuk atau pulang. Bagaimana memperbaikinya?$help$,
   $help$Buka menu Kehadiran, lalu cari tanggalnya di Riwayat 30 hari. Tombol Ajukan klarifikasi muncul untuk tanggal berstatus Belum lengkap, Terlambat, atau Tidak hadir, paling lama 7 hari ke belakang.

Pilih Koreksi waktu, pilih alasan (misalnya Jam keluar belum tercatat), isi usulan jam, tulis penjelasan, lalu tekan Kirim klarifikasi. HC yang memutuskan. Statusnya tampil di Klarifikasi saya: Menunggu, Disetujui, atau Ditolak. Selama masih Menunggu, Anda dapat membatalkannya. HC juga dapat mengirim notifikasi yang meminta Anda mengajukan klarifikasi.$help$,
   20),
  ('615fde19-917a-53c7-94a7-f5635b274a55', 'FAQ', 'ATTENDANCE', $help$Apa beda Justifikasi dan Koreksi waktu pada klarifikasi kehadiran?$help$,
   $help$Justifikasi dipakai bila jam yang tercatat sudah benar, tetapi ada alasan yang perlu diterima, misalnya terlambat karena tugas. Jam aktual tidak diubah; bila disetujui, keterlambatan ditandai beralasan.

Koreksi waktu dipakai bila jam yang tercatat salah atau kosong. Anda mengusulkan jam masuk dan atau jam keluar yang benar. Catatan asli dari mesin atau HP tetap disimpan apa adanya; usulan Anda berlaku setelah disetujui HC.$help$,
   30),
  ('88620efe-5c47-54d8-8043-3d4c57d82f08', 'FAQ', 'ATTENDANCE', $help$Kenapa presensi HP saya ditandai di luar area atau perlu ditinjau?$help$,
   $help$Ada tiga kemungkinan: posisi Anda di luar radius lokasi kerja, akurasi GPS kurang baik, atau lokasi kerja belum terhubung ke jadwal Anda. Presensi tetap tersimpan, hanya ditandai agar ditinjau HC.

Bila Anda memang bertugas di luar lokasi, ajukan klarifikasi untuk tanggal itu dengan alasan Di luar geofence dan jelaskan tugasnya. Untuk akurasi yang lebih baik, aktifkan layanan lokasi HP dan tekan Baca GPS lagi di tempat terbuka.$help$,
   40),
  ('5d0abedd-9ace-5d61-84ee-755ce119fa25', 'FAQ', 'ATTENDANCE', $help$Tombol Clock in atau Clock out tidak bisa ditekan. Kenapa?$help$,
   $help$Tombol baru aktif setelah server siap, GPS terbaca, dan foto sudah diambil. Periksa kotak Persiapan presensi untuk melihat mana yang belum siap.

Bila izin lokasi atau kamera ditolak, buka pengaturan situs di sebelah alamat HCIS lalu izinkan Lokasi dan Kamera. Bila kamera sedang dipakai aplikasi lain, tutup aplikasi tersebut. Bila server tertulis belum siap, berarti presensi HP sedang tidak dapat dipakai; hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   50),
  ('8dd950c8-bac2-5667-bf11-8d39f49a79de', 'FAQ', 'ATTENDANCE', $help$Bagaimana cara tukar shift dengan rekan kerja?$help$,
   $help$Buka menu Tukar Shift. Pilih Tanggal kerja, pilih Rekan satu unit yang shiftnya berbeda pada tanggal itu, tambahkan catatan bila perlu, lalu tekan Ajukan tukar shift. Tukar shift hanya untuk rekan satu unit pada tanggal yang sama dan harus diajukan sebelum shift dimulai.

Rekan Anda menyetujui atau menolak lebih dulu, lalu HC memberi keputusan akhir. Statusnya: Menunggu rekan, Menunggu Human Capital, Disetujui, Ditolak rekan, Ditolak Human Capital, atau Dibatalkan. Selama masih menunggu, Anda dapat menekan Batalkan pengajuan.$help$,
   60),
  ('32d82331-1941-5670-8381-9ce722073147', 'FAQ', 'ATTENDANCE', $help$Jadwal kerja saya salah atau tertulis Jadwal perlu diperiksa. Siapa yang mengubahnya?$help$,
   $help$Jadwal dan shift ditetapkan oleh HC. Anda dapat melihatnya di menu Kehadiran pada bagian Jadwal saya, tetapi tidak dapat mengubahnya sendiri. Tulisan Jadwal diganti berarti HC sudah mengganti jadwal pada tanggal itu.

Bila jadwal Anda keliru atau tertulis Jadwal perlu diperiksa, hubungi Human Capital (HC) melalui kontak di halaman Bantuan. Untuk bertukar shift dengan rekan, pakai menu Tukar Shift.$help$,
   70),
  ('512002e3-b37a-522a-84b1-91e08f4ba5e6', 'GUIDE', 'OVERTIME', $help$Panduan singkat: Lembur$help$,
   $help$Lembur di HCIS dicatat hanya dari pengajuan yang disetujui. Pulang lebih lambat dari jadwal tidak otomatis menjadi lembur. Lembur dapat dimulai dari Anda (pengajuan lembur) atau dari atasan (perintah lembur).

Cara mengajukan lembur:

1. Buka menu Kehadiran, lalu cari kotak Ajukan lembur. Anda juga dapat membukanya dari Semua Layanan, bagian Waktu & Kehadiran, lalu Lembur.
2. Isi tanggal lembur dan lamanya dalam menit.
3. Tulis catatan singkat tentang pekerjaan yang dilakukan. Catatan boleh dikosongkan, tetapi sangat membantu atasan.
4. Tekan Kirim pengajuan.
5. Pantau statusnya di daftar Pengajuan terakhir: Menunggu, Disetujui, Ditolak, atau Dibatalkan.

Pengajuan Anda diputuskan oleh atasan langsung. Atasan dapat menyetujui sesuai pengajuan atau dengan menit yang lebih sedikit, dan wajib menulis catatan bila menolak. HC hanya menerima pemberitahuan, bukan pemberi persetujuan. Menit yang disetujui tampil sebagai Lembur disetujui di halaman Kehadiran dan di kolom Lembur pada Riwayat 30 hari.

Lembur dapat diajukan sebelum hari lembur dan paling lambat 7 hari sesudahnya. Bila muncul pesan bahwa atasan Anda belum tercatat, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('051f9f0d-4af0-5aa9-8942-ec1c6a1601b2', 'FAQ', 'OVERTIME', $help$Saya pulang lebih lambat dari jadwal. Apakah otomatis dihitung lembur?$help$,
   $help$Tidak. Jam pulang yang lebih lambat hanya tercatat sebagai fakta kehadiran. Lembur baru diakui setelah ada pengajuan lembur yang disetujui atasan, atau perintah lembur dari atasan yang Anda setujui.

Jadi, bila Anda bekerja melebihi jadwal atas permintaan atau kebutuhan pekerjaan, ajukan lembur dari menu Kehadiran pada kotak Ajukan lembur.$help$,
   20),
  ('b763357b-b4be-5b1c-9acb-c121fafc3f22', 'FAQ', 'OVERTIME', $help$Sampai kapan saya boleh mengajukan lembur?$help$,
   $help$Pengajuan lembur boleh dibuat sebelum tanggal lembur sebagai rencana, dan paling lambat 7 hari setelah tanggal lembur. Lewat dari itu, pengajuan akan ditolak sistem.

Batas ini juga berlaku untuk perintah lembur dari atasan. Pengajuan yang sudah masuk tepat waktu tetap dapat diputuskan atasan meskipun keputusannya diberikan setelah 7 hari.$help$,
   30),
  ('dda05908-cea2-5017-9c4f-cff80813a59c', 'FAQ', 'OVERTIME', $help$Atasan meminta saya lembur lewat HCIS. Apa yang harus saya lakukan?$help$,
   $help$Perintah lembur tampil di menu Kehadiran, pada daftar Pengajuan terakhir, dengan judul Perintah lembur dari atasan. Periksa tanggal, lama, dan keterangannya, lalu tekan Setuju atau Tolak.

Lembur baru berlaku setelah Anda menekan Setuju. Persetujuan di HCIS diperlakukan sebagai persetujuan tertulis. Bila Anda menolak, atasan Anda akan diberi tahu.$help$,
   40),
  ('c365c32f-d7ce-597a-8a55-6e603681075b', 'FAQ', 'OVERTIME', $help$Bisakah saya membatalkan pengajuan lembur?$help$,
   $help$Bisa, selama statusnya masih Menunggu. Buka menu Kehadiran, cari pengajuan di daftar Pengajuan terakhir, lalu tekan Batalkan.

Lembur yang sudah disetujui tidak dapat Anda batalkan sendiri. Bila ada kesalahan setelah disetujui, bicarakan dengan atasan Anda atau hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   50),
  ('f3fbf168-75d4-5b8a-9b7c-1f380e8c5cc6', 'FAQ', 'OVERTIME', $help$Apakah HCIS menampilkan uang lembur saya?$help$,
   $help$Tidak. HCIS hanya mencatat menit lembur yang disetujui. HCIS tidak menghitung atau menampilkan nilai uang lembur kepada pegawai.

Pembayaran lembur mengikuti ketentuan yayasan. Bila ada pertanyaan tentang pembayarannya, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   60),
  ('54750e5f-aacd-5103-acc2-5986ba954135', 'GUIDE', 'LEAVE', $help$Panduan singkat: Cuti & Izin$help$,
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
   10),
  ('33b7ee82-a5df-5249-9d20-722b12b83e74', 'FAQ', 'LEAVE', $help$Berapa hak cuti tahunan saya?$help$,
   $help$Untuk tenaga non-pendidikan, hak cuti tahunan adalah 12 hari kerja per tahun, dengan pemakaian paling banyak 3 hari kerja per periode tiga bulan (Januari–Maret, April–Juni, Juli–September, Oktober–Desember). Hak mulai dapat dipakai setelah 12 bulan bekerja; periode sebelum itu tidak berlaku mundur, dan sisa periode saat ini tidak otomatis dibawa ke periode berikutnya.

Untuk tenaga pendidikan, hak tahunan dipenuhi lewat Cuti Akhir Semester dan Akhir Tahun Pelajaran sesuai kalender akademik yayasan, bukan lewat pengajuan Cuti Tahunan perorangan. Kelompok Anda tampil di kotak Hak Cuti Tahunan.$help$,
   20),
  ('56ac994c-79bf-5106-9bcd-8cc91d775b17', 'FAQ', 'LEAVE', $help$Berapa hari sebelumnya saya harus mengajukan cuti?$help$,
   $help$Cuti Tahunan dan keperluan terencana (pernikahan, menikahkan anak, khitan anak, Haji wajib) diajukan paling lambat 7 hari sebelumnya (H-7). Cuti Tanpa Gaji sampai 3 hari kalender juga H-7; lebih dari 3 hari kalender H-30. Cuti melahirkan diajukan H-30 dengan dokumen pendukung.

Kondisi mendesak seperti sakit, keguguran, atau keluarga meninggal dunia dapat dilaporkan segera, dan dokumennya boleh dilengkapi kemudian.$help$,
   30),
  ('baf19f01-fd64-5fce-8e08-75105cd5ad59', 'FAQ', 'LEAVE', $help$Saya sakit mendadak. Bagaimana cara melapor?$help$,
   $help$Buka menu Cuti & Izin, pilih Sakit atau kondisi khusus, lalu pilih Sakit. Isi tanggal mulai dan selesai, ceritakan singkat bila perlu, lalu tekan Lanjutkan dan Kirim laporan. Bila kondisinya mendesak, surat dokter boleh diunggah setelahnya.

Atasan Anda diberi tahu dan HC memeriksa administrasinya. Bila HC meminta dokumen, status berubah menjadi Perlu dilengkapi; unggah dokumennya lewat tombol Kirim dokumen pada riwayat.$help$,
   40),
  ('9f3705a1-185d-5674-9246-7e8ff01251cb', 'FAQ', 'LEAVE', $help$Keperluan terencana apa saja yang bisa diajukan, dan berapa lama?$help$,
   $help$Pada pilihan Keperluan terencana tersedia: pernikahan pegawai (paling lama 3 hari kerja), menikahkan anak (2 hari kerja), khitan anak (2 hari kerja), ibadah Haji wajib dengan dokumen resmi (hanya satu kali selama bekerja), dan Cuti Tanpa Gaji.

Cuti Tanpa Gaji dicatat sebagai tidak bergaji, tetapi halaman ini tidak menghitung potongan gaji apa pun. Sebelum dikirim, ringkasan menampilkan hari kerja terdampak, durasi kalender, dan batas minimal pengajuan.$help$,
   50),
  ('928a0c74-0b29-5415-baf3-a60f52b3b086', 'FAQ', 'LEAVE', $help$Bisakah saya membatalkan cuti yang sudah diajukan?$help$,
   $help$Saat ini halaman Cuti & Izin belum menyediakan tombol pembatalan untuk pengajuan yang sudah dikirim.

Bila rencana Anda berubah, segera beri tahu atasan Anda dan hubungi Human Capital (HC) melalui kontak di halaman Bantuan agar pengajuan tersebut ditindaklanjuti. Periksa kembali tanggal sebelum menekan Kirim pengajuan untuk menghindari salah tanggal.$help$,
   60),
  ('ee412a1e-16cc-5796-9cc5-19d9fba8ff9c', 'FAQ', 'LEAVE', $help$Apa itu halaman Tindak lanjut ketidakhadiran?$help$,
   $help$Halaman ini hanya muncul bila ada tanggal ketidakhadiran yang administrasi cutinya belum lengkap. Tautannya tampil di kotak Perlu tindakan pada Beranda.

Bila HC mengusulkan memakai Cuti Tahunan untuk tanggal tersebut, Anda dapat memilih Gunakan Cuti Tahunan atau Jangan gunakan. Bila Anda menolak, kasusnya kembali ke HC untuk diselesaikan dengan cara lain, misalnya dispensasi. Bila tertulis Sedang ditangani HC, Anda tidak perlu melakukan apa pun.$help$,
   70),
  ('9c20f169-7053-53aa-905d-0709036358ea', 'GUIDE', 'PAYSLIP', $help$Panduan singkat: Slip Gaji$help$,
   $help$Menu Slip Gaji menampilkan slip gaji Anda yang sudah diterbitkan oleh HC. Isi slip disiapkan dan diterbitkan HC; HCIS menampilkannya apa adanya dan tidak menghitung ulang angka di dalamnya.

1. Buka menu Slip Gaji.
2. Pilih Tahun.
3. Tekan kolom Pilih periode slip, lalu pilih bulan yang diinginkan. Anda juga dapat mengetik nama bulan atau tahun untuk menyaring.
4. Tekan Tampilkan. Slip berisi identitas pegawai, ringkasan gaji, kolom penghasilan dan potongan, serta penandatangan.
5. Bila perlu menyimpan atau mencetak, tekan Cetak / Simpan PDF.

Slip gaji bersifat rahasia dan pribadi. Hanya Anda yang dapat membuka slip milik Anda dari akun ini. Jangan menyebarkan atau menunjukkan isinya kepada pihak yang tidak berwenang.

Slip yang masih disiapkan HC tidak ditampilkan. Saat slip baru terbit, Anda akan menerima notifikasi. Slip yang sudah terbit tidak dapat diubah dari HCIS; bila ada angka yang Anda ragukan, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('9aab4894-d17d-5671-ad7a-70d819102bb1', 'FAQ', 'PAYSLIP', $help$Kenapa slip gaji bulan ini belum muncul?$help$,
   $help$Slip gaji baru tampil setelah HC menerbitkannya. Slip yang masih disiapkan atau diperiksa tidak ditampilkan kepada pegawai. Bila belum ada slip sama sekali, halaman menampilkan tulisan Belum ada slip gaji yang dipublikasikan.

Anda akan menerima notifikasi saat slip baru terbit. Bila sudah lewat dari jadwal biasanya dan slip belum muncul, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   20),
  ('b0fef046-d684-51a1-9e18-6f790aab58bd', 'FAQ', 'PAYSLIP', $help$Angka di slip gaji saya sepertinya salah. Apa yang harus saya lakukan?$help$,
   $help$Isi slip gaji disiapkan dan diterbitkan oleh HC. HCIS menampilkannya apa adanya, tidak menghitung ulang, dan Anda tidak dapat mengubahnya. Slip yang sudah terbit juga terkunci di sistem.

Hubungi Human Capital (HC) melalui kontak di halaman Bantuan, sebutkan periode slip dan bagian yang Anda ragukan. Jangan mengirim tangkapan layar slip ke grup atau orang lain.$help$,
   30),
  ('8d711c57-07bb-5ba7-9e36-2a2f560de43a', 'FAQ', 'PAYSLIP', $help$Bagaimana cara menyimpan atau mencetak slip gaji?$help$,
   $help$Tampilkan slip periode yang diinginkan, lalu tekan Cetak / Simpan PDF. Jendela cetak browser akan terbuka dengan ukuran kertas A4.

Pilih printer untuk mencetak, atau pilih Simpan sebagai PDF untuk menyimpan berkas di perangkat Anda. Simpan berkas itu di tempat yang aman karena isinya rahasia.$help$,
   40),
  ('cc2f8665-27c8-5575-b136-848c203465d5', 'FAQ', 'PAYSLIP', $help$Bisakah saya melihat slip gaji bulan-bulan sebelumnya?$help$,
   $help$Bisa. Semua slip yang sudah diterbitkan untuk Anda tetap tersedia. Pilih Tahun, tekan kolom Pilih periode slip untuk melihat daftar periodenya, lalu tekan Tampilkan.

Jumlah slip yang tersedia tertulis di bawah kolom pilihan. Bila ada periode yang seharusnya ada tetapi tidak muncul, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   50),
  ('fe7895b7-8d4f-5c96-a088-a7c2e2f8c7be', 'FAQ', 'PAYSLIP', $help$Apakah orang lain bisa melihat slip gaji saya?$help$,
   $help$Tidak. Pegawai lain, termasuk atasan Anda, tidak dapat membuka slip gaji Anda. HCIS selalu menampilkan slip berdasarkan akun yang sedang masuk, dan setiap pembukaan slip dicatat sistem.

Hanya petugas yang berwenang yang mengelola penyiapan dan penerbitan slip. Jaga kerahasiaannya dengan tidak meminjamkan akun dan selalu menekan Keluar bila memakai perangkat bersama.$help$,
   60),
  ('77c1c9c3-7657-543b-9568-36c74fdacfb4', 'GUIDE', 'TRIPS', $help$Panduan singkat: Perjalanan Dinas$help$,
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
   10),
  ('6ce59b3f-bc89-5f01-8dd7-5bdd4bb646ac', 'FAQ', 'TRIPS', $help$Siapa yang menyetujui perjalanan dinas saya?$help$,
   $help$Saat ini perjalanan dinas disetujui oleh atasan langsung Anda, lalu oleh approver unit. Setelah semua menyetujui, HC menerbitkan surat tugas bernomor. HC tidak menjadi tahap persetujuan.

Sebelum mengirim, tekan Periksa penyetuju untuk melihat nama penyetujunya. Bila nama yang muncul tidak tepat, hubungi Human Capital (HC) melalui kontak di halaman Bantuan sebelum mengirim pengajuan.$help$,
   20),
  ('23161474-2772-5c62-a43d-72d00482794d', 'FAQ', 'TRIPS', $help$Apakah biaya perjalanan, uang harian, atau uang muka bisa diajukan di HCIS?$help$,
   $help$Belum. Layanan Perjalanan Dinas di HCIS saat ini hanya mengurus pengajuan, persetujuan, surat tugas, dan laporan selesai. HCIS tidak mencatat atau menghitung biaya, uang harian, akomodasi, tiket, maupun uang muka.

Untuk urusan biaya perjalanan, ikuti ketentuan yang berlaku di yayasan atau hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   30),
  ('516eceab-5cf8-574a-a982-eb570bf4361b', 'FAQ', 'TRIPS', $help$Bisakah saya mengubah tanggal atau tujuan perjalanan yang sudah diajukan?$help$,
   $help$Tidak bisa diubah. Bila tanggal atau tujuan berubah, batalkan pengajuan lama lalu ajukan yang baru. Tombol Batalkan tersedia selama status Menunggu persetujuan atau Disetujui, menunggu surat tugas, dan Anda wajib menulis alasan pembatalan.

Setelah surat tugas terbit, Anda tidak dapat membatalkannya sendiri. Hanya HC yang dapat membatalkan, dan surat tugasnya akan dicabut. Bila perlu, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   40),
  ('8b4bb541-7a3a-5773-9ed2-78372de2b93d', 'FAQ', 'TRIPS', $help$Berapa lama maksimal perjalanan dinas dan kapan paling cepat diajukan?$help$,
   $help$Saat ini satu pengajuan paling lama 30 hari kalender. Tanggal berangkat paling cepat hari ini; pengajuan mundur untuk perjalanan yang sudah berjalan tidak dapat dibuat di HCIS.

Perjalanan juga tidak boleh bertumpuk dengan perjalanan dinas lain milik Anda, atau dengan cuti yang sedang diproses atau sudah disetujui.$help$,
   50),
  ('b0e5cd19-bf98-5921-9bfe-f70ef2254772', 'FAQ', 'TRIPS', $help$Saya berangkat bersama rombongan. Apakah cukup satu pengajuan?$help$,
   $help$Tidak. Satu pengajuan hanya untuk satu pegawai, dan diajukan oleh pegawai itu sendiri. Setiap anggota rombongan mengajukan perjalanan dinasnya masing-masing.

Dengan begitu, setiap anggota mendapat persetujuan dan surat tugas sendiri.$help$,
   60),
  ('4ac41536-ebdd-5f14-af6c-ffc17e633f8f', 'GUIDE', 'CALENDAR', $help$Panduan singkat: Kalender & Rapat$help$,
   $help$Menu Kalender menampilkan rapat yayasan, cuti dan perjalanan dinas Anda, serta hari libur dalam satu kalender bulanan. Anda juga dapat mengundang rekan ke rapat, dan HCIS menolak undangan yang membuat jadwal peserta bentrok.

1. Buka menu Kalender. Tab Kalender menampilkan satu bulan; tab Rapat saya menampilkan rapat Akan datang dan Lewat.
2. Untuk membuat rapat, tekan Buat rapat atau tekan tanggal pada kalender.
3. Isi judul, waktu mulai dan selesai, lokasi, peserta (cari namanya), dan keterangan. Centang Rahasia bila rapat tidak boleh terlihat rinciannya oleh pegawai lain.
4. Tekan Kirim undangan. Peserta menerima notifikasi di HCIS.
5. Bila Anda diundang, buka rapatnya lalu jawab Hadir atau Berhalangan.

Undangan ditolak bila jadwal salah satu peserta bentrok dengan rapat lain, cuti yang sudah disetujui, atau perjalanan dinas yang sudah disetujui. Cuti atau perjalanan yang masih diproses hanya memunculkan peringatan. Pengingat dikirim di HCIS 30 menit sebelum rapat dimulai.

Rapat hanya dapat diubah atau dibatalkan oleh penyelenggaranya. Bila ada kendala, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('d50f09a9-814d-5a7d-bc6e-2623bf32562a', 'FAQ', 'CALENDAR', $help$Kenapa undangan rapat saya ditolak karena bentrok?$help$,
   $help$HCIS menolak undangan bila pada jam itu ada peserta yang sudah terjadwal di rapat lain, sedang cuti yang sudah disetujui, atau sedang perjalanan dinas yang sudah disetujui. Pesan di layar menyebutkan siapa yang bentrok.

Pilih waktu lain atau keluarkan peserta tersebut. Tidak ada tombol untuk memaksa. Cuti atau perjalanan yang masih diproses tidak menolak undangan, tetapi memunculkan peringatan.$help$,
   20),
  ('7db91fa6-38f8-5310-b589-88d70714c060', 'FAQ', 'CALENDAR', $help$Bagaimana cara menjawab undangan rapat?$help$,
   $help$Buka menu Kalender, pilih rapatnya (atau buka dari notifikasi), lalu tekan Hadir atau Berhalangan. Saat memilih Berhalangan, Anda boleh menulis alasan.

Jawaban Berhalangan membebaskan waktu Anda sehingga dapat dipakai untuk rapat lain, dan penyelenggara diberi tahu. Anda dapat mengubah jawaban kembali menjadi Hadir selama waktunya belum terpakai rapat lain.$help$,
   30),
  ('1bef4e82-4bc2-5f45-89aa-6f7c42f3f534', 'FAQ', 'CALENDAR', $help$Apakah semua pegawai bisa melihat rapat saya?$help$,
   $help$Rapat tampil di kalender semua pegawai, tetapi pegawai yang bukan peserta hanya melihat judul, jam, lokasi, dan nama penyelenggara. Daftar peserta dan keterangan hanya terlihat oleh peserta.

Bila penyelenggara mencentang Rahasia, pegawai yang bukan peserta hanya melihat tulisan Sibuk tanpa judul, lokasi, dan penyelenggara.$help$,
   40),
  ('2ccf9890-72b6-5275-a203-d56825a8827a', 'FAQ', 'CALENDAR', $help$Bagaimana cara mengubah atau membatalkan rapat?$help$,
   $help$Hanya penyelenggara yang dapat mengubah atau membatalkan rapat. Perubahan hanya bisa dilakukan sebelum rapat dimulai. Bila waktunya diubah, jawaban semua peserta kembali menjadi Belum menjawab dan mereka diberi tahu.

Untuk membatalkan, buka rapatnya lalu tekan Batalkan rapat dan tulis alasan (5 sampai 500 karakter). Semua peserta akan diberi tahu.$help$,
   50),
  ('99431555-85a0-56fd-9546-d9d6bbc390e7', 'FAQ', 'CALENDAR', $help$Apakah undangan dan pengingat rapat dikirim lewat WhatsApp?$help$,
   $help$Saat ini undangan, perubahan, pembatalan, dan pengingat rapat sampai lewat Notifikasi di HCIS. Pengingat dikirim 30 menit sebelum rapat dimulai kepada penyelenggara dan peserta yang tidak berhalangan.

Pengiriman lewat WhatsApp dari HCIS belum aktif, walaupun pilihannya sudah tampil di formulir rapat. Jadi, pastikan Anda rutin membuka Notifikasi.$help$,
   60),
  ('587aa6b5-492f-5cab-a882-47d6702fc40d', 'FAQ', 'CALENDAR', $help$Apakah saya bisa memesan ruang rapat lewat HCIS?$help$,
   $help$Belum. HCIS tidak menyediakan pemesanan ruang rapat. Lokasi rapat diisi sebagai teks biasa, misalnya nama ruangan atau tautan rapat daring.

Pastikan ketersediaan ruangan dengan pengelola ruangan di unit Anda sebelum mengirim undangan.$help$,
   70),
  ('76a0b76a-6cc5-5734-b175-c891358bc9b8', 'GUIDE', 'TRAINING', $help$Panduan singkat: Pelatihan$help$,
   $help$Layanan Pelatihan menampilkan program pelatihan yang Anda ikuti, riwayat pelatihan, sertifikat, dan jumlah jam pelatihan Anda. Pelatihan dari pihak luar dapat Anda catat sendiri lalu diverifikasi HC.

1. Buka Semua Layanan, bagian Kinerja & Pengembangan, lalu pilih Pelatihan.
2. Lihat ringkasan Jam pelatihan tahun ini, jam internal dan eksternal, serta jam sebagai narasumber.
3. Pada Program yang saya ikuti, pilih satu program untuk melihat jadwal sesi dan kehadiran Anda.
4. Pada Riwayat pelatihan, lihat catatan pelatihan Anda dan buka Sertifikat bila tersedia.
5. Untuk pelatihan dari pihak luar, isi formulir Catat pelatihan dari pihak luar: nama pelatihan, penyelenggara, kategori, tanggal mulai dan selesai, jumlah jam, sertifikat (PDF, JPG, atau PNG, maksimal 2 MB), dan ringkasan materi bila ada.
6. Tekan Kirim untuk diverifikasi.

Pelatihan dari pihak luar berstatus Menunggu verifikasi sampai HC memutuskan, lalu menjadi Terverifikasi atau Ditolak. Selama masih menunggu, Anda dapat menekan Tarik.

Peserta program internal didaftarkan oleh HC, dan kehadiran setiap sesi juga dicatat HC. Bila ada data yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('43db413e-91a9-59ff-96b2-a3a19337100f', 'FAQ', 'TRAINING', $help$Bagaimana cara mendaftar program pelatihan internal?$help$,
   $help$Saat ini pegawai tidak mendaftar sendiri. Peserta program pelatihan internal ditambahkan oleh HC.

Setelah Anda didaftarkan, program itu muncul di bagian Program yang saya ikuti beserta jadwal sesinya, dan Anda menerima notifikasi. Bila Anda ingin ikut suatu program, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   20),
  ('e717560d-cf8f-57c5-ac95-bc8dc0ec685c', 'FAQ', 'TRAINING', $help$Kehadiran saya di sesi pelatihan belum tercatat atau salah. Apa yang harus saya lakukan?$help$,
   $help$Kehadiran sesi pelatihan dicatat oleh HC dengan pilihan Hadir, Tidak hadir, atau Izin. Sebelum dicatat, sesi tertulis Kehadiran belum dicatat.

Bila catatannya keliru, segera hubungi Human Capital (HC) melalui kontak di halaman Bantuan. Koreksi masih bisa dilakukan selama program belum ditutup. Setelah program ditutup, catatannya terkunci. Kehadiran sesi pelatihan tidak sama dengan presensi kerja.$help$,
   30),
  ('96d8a642-b421-5a37-acae-6204b34e9aea', 'FAQ', 'TRAINING', $help$Kapan saya dinyatakan menyelesaikan program pelatihan?$help$,
   $help$Saat ini peserta dinyatakan menyelesaikan program bila jam sesi yang dihadiri minimal 80 persen dari total jam sesi program. HC dapat mengatur batas lain untuk program tertentu. Izin tidak dihitung sebagai hadir.

Peserta yang hadir sebagian (minimal satu sesi) tetap tercatat di riwayat dengan keterangan Belum memenuhi kehadiran. Jam pelatihan internal dihitung dari lama sesi yang Anda hadiri.$help$,
   40),
  ('8dad1c87-207c-505b-8b8c-4f51063d32d3', 'FAQ', 'TRAINING', $help$Pelatihan eksternal yang saya catat ditolak. Apa yang harus saya lakukan?$help$,
   $help$Baca alasan penolakan dari HC pada riwayat atau notifikasi. Catatan yang ditolak tidak dapat diubah; perbaiki datanya lalu catat ulang sebagai catatan baru.

Pastikan tanggal selesai tidak di masa depan, jumlah jam antara 0,5 dan 200 jam, dan sertifikat yang diunggah terbaca jelas.$help$,
   50),
  ('b6d22960-4548-590c-9eb0-71188ff5ed8e', 'FAQ', 'TRAINING', $help$Apakah jam pelatihan memengaruhi presensi, gaji, atau nilai kinerja saya?$help$,
   $help$Tidak. Pelatihan tidak mengubah catatan presensi kerja maupun gaji, dan jam pelatihan bukan bagian dari nilai penilaian kinerja.

Rekap jam pelatihan tampil sebagai catatan pengembangan diri Anda, tanpa target jam tertentu.$help$,
   60),
  ('f33ff16e-4f9e-5316-95bf-faa0525918ea', 'GUIDE', 'LOANS', $help$Panduan singkat: Pinjaman$help$,
   $help$Layanan Pinjaman dipakai untuk mengajukan pinjaman tanpa bunga, lalu memantau persetujuan, jadwal cicilan, pembayaran, dan sisa pinjaman.

1. Buka Semua Layanan, bagian Keuangan Saya, lalu pilih Pinjaman.
2. Isi Pokok pinjaman (hanya angka dan titik ribuan, tanpa koma), pilih Lama cicilan (3, 6, atau 12 bulan), dan tulis Keperluan.
3. Tekan Lihat cicilan dan penyetuju untuk melihat perkiraan cicilan dan siapa yang akan menyetujui.
4. Tekan Kirim pengajuan.
5. Pantau di daftar Pinjaman saya. Pilih pinjaman untuk melihat persetujuan, jadwal cicilan, pembayaran, dan riwayatnya.

Alur status: Menunggu persetujuan, lalu Disetujui, menunggu pencairan, lalu Berjalan setelah dicairkan, dan Lunas setelah semua terbayar. Pengajuan juga dapat Ditolak atau Dibatalkan.

Pinjaman disetujui oleh atasan langsung lalu approver unit. Setelah itu Keuangan mencairkan dana dan menetapkan jadwal cicilan. Cicilan tidak dipotong otomatis dari gaji; Keuangan mencatat setiap pembayaran di HCIS.

Bila ada yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('aafb4ba5-7d97-5372-8181-7f86e929f3ac', 'FAQ', 'LOANS', $help$Apakah pinjaman dikenai bunga?$help$,
   $help$Tidak. Pinjaman di HCIS tanpa bunga, sehingga total cicilan sama dengan pokok pinjaman.

Saat ini cicilan dihitung dari pokok dibagi lama cicilan, dibulatkan ke bawah ke ribuan rupiah, dan cicilan terakhir menanggung sisanya. Contoh: pinjaman Rp1.000.000 selama 3 bulan dicicil Rp333.000, Rp333.000, dan Rp334.000.$help$,
   20),
  ('0d5e9dcc-20ec-5f6e-90ed-3a08b00d0cac', 'FAQ', 'LOANS', $help$Berapa batas pinjaman, dan bolehkah saya punya dua pinjaman sekaligus?$help$,
   $help$Saat ini pokok pinjaman antara Rp100.000 dan Rp10.000.000, dengan lama cicilan 3, 6, atau 12 bulan. Tidak ada syarat masa kerja; cukup pegawai aktif dengan akun aktif.

Setiap pegawai hanya boleh punya satu pinjaman terbuka, yaitu yang masih menunggu persetujuan, menunggu pencairan, atau sedang berjalan. Pinjaman baru dapat diajukan setelah pinjaman sebelumnya lunas, ditolak, atau dibatalkan.$help$,
   30),
  ('0fa35200-e56a-5308-aa19-fd22bc0f2d8a', 'FAQ', 'LOANS', $help$Apakah cicilan pinjaman otomatis dipotong dari gaji?$help$,
   $help$Tidak. HCIS tidak memotong gaji secara otomatis. Pembayaran cicilan dicatat oleh Keuangan, baik tunai, transfer, maupun potong gaji yang dicatat manual setelah potongan itu tampil di slip gaji resmi.

Anda dapat memeriksa setiap pembayaran dan sisa pinjaman di detail pinjaman pada halaman Pinjaman. Cicilan yang bulannya sudah lewat dan belum lunas akan ditandai lewat bulan.$help$,
   40),
  ('55aa2bf2-bb16-5597-bc1c-a25dda1ea0af', 'FAQ', 'LOANS', $help$Bisakah saya membatalkan pengajuan pinjaman?$help$,
   $help$Bisa, selama dana belum dicairkan, yaitu saat status Menunggu persetujuan atau Disetujui, menunggu pencairan. Buka detail pinjaman, tekan Batalkan pengajuan, lalu tulis alasannya.

Setelah dana dicairkan, pinjaman tidak dapat dibatalkan dan hanya selesai dengan pelunasan.$help$,
   50),
  ('73d4e787-7417-5cb7-9d68-b204e2d988a8', 'FAQ', 'LOANS', $help$Kapan cicilan pertama dimulai, dan bolehkah saya melunasi lebih cepat?$help$,
   $help$Bulan cicilan yang pasti ditetapkan Keuangan saat pencairan. Saat ini cicilan pertama paling cepat bulan setelah pencairan dan paling lambat tiga bulan sesudahnya. Jadwal yang sudah ditetapkan tidak dapat diubah.

Pembayaran sebagian dan pelunasan lebih cepat diperbolehkan. Hubungi Keuangan untuk melakukan pembayaran; setelah dicatat, sisa pinjaman berkurang dan status menjadi Lunas bila sudah terbayar seluruhnya.$help$,
   60),
  ('9e304d01-937e-5ff4-a114-5475e426ca51', 'GUIDE', 'ASSETS', $help$Panduan singkat: Asset Saya$help$,
   $help$Asset Saya menampilkan aset organisasi yang sedang menjadi tanggung jawab Anda, misalnya laptop atau peralatan kerja, menurut catatan Aset SQ. Halaman ini hanya untuk melihat; HCIS tidak mengubah data aset.

1. Buka Semua Layanan, bagian Layanan Pegawai, lalu pilih Asset Saya.
2. Lihat ringkasannya: berapa aset yang sedang Anda pegang, berapa yang menunggu konfirmasi Anda, dan berapa yang lewat tanggal kembali.
3. Periksa daftar aset beserta tanggal Harus kembali bila ada.
4. Untuk menerima, menolak, atau mengembalikan aset, tekan Buka Aset SQ dan lanjutkan di sana.

Aset yang ditandai Menunggu konfirmasi Anda sudah diserahkan kepada Anda tetapi belum Anda konfirmasi di Aset SQ. Aset yang ditandai Lewat tanggal kembali seharusnya sudah dikembalikan.

Bila daftar aset belum dapat ditampilkan, buka Aset SQ langsung. Bila ada aset yang tidak sesuai dengan yang Anda pegang, hubungi pengelola aset melalui Aset SQ, atau hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('a1d46dda-0a3c-593d-8758-f6906b2f2e67', 'FAQ', 'ASSETS', $help$Kenapa saya tidak bisa menerima atau mengembalikan aset di HCIS?$help$,
   $help$Karena data dan serah terima aset dikelola di Aset SQ, bukan di HCIS. Asset Saya di HCIS hanya menampilkan daftar aset yang sedang Anda pegang.

Tekan Buka Aset SQ untuk menerima, menolak, atau mengembalikan aset. Anda masuk ke Aset SQ dengan Akun SQ yang sama.$help$,
   20),
  ('bbb49561-5886-5056-bab0-9594c40b90b3', 'FAQ', 'ASSETS', $help$Muncul pesan Daftar aset belum dapat ditampilkan di HCIS. Apa artinya?$help$,
   $help$Artinya HCIS belum dapat mengambil data dari Aset SQ, entah karena sambungannya belum diaktifkan atau Aset SQ sedang tidak dapat dihubungi.

Anda tetap dapat melihat aset Anda langsung di Aset SQ lewat tombol Buka Aset SQ. Bila sambungan sedang terganggu, coba lagi beberapa saat kemudian.$help$,
   30),
  ('06380afb-d171-5be8-8709-a6b7fa896cc0', 'FAQ', 'ASSETS', $help$Apa arti tanda Menunggu konfirmasi Anda dan Lewat tanggal kembali?$help$,
   $help$Menunggu konfirmasi Anda berarti aset sudah diserahkan kepada Anda, tetapi Anda belum menerimanya di Aset SQ. Aset ini tetap dihitung sebagai aset yang Anda pegang.

Lewat tanggal kembali berarti aset masih Anda pegang padahal tanggal Harus kembali sudah lewat. Segera kembalikan aset tersebut atau bicarakan dengan pengelola aset.$help$,
   40),
  ('73a593c5-2eef-5a6f-a780-60c2c445c315', 'FAQ', 'ASSETS', $help$Ada aset yang tidak saya pegang tetapi tercantum atas nama saya. Apa yang harus saya lakukan?$help$,
   $help$HCIS hanya menampilkan data dari Aset SQ dan tidak dapat mengubahnya. Bila aset baru diserahkan dan belum Anda terima, Anda dapat menolaknya di Aset SQ.

Untuk kesalahan lain, hubungi pengelola aset melalui Aset SQ, atau hubungi Human Capital (HC) melalui kontak di halaman Bantuan. Bila muncul tulisan Sebagian aset tidak ditampilkan, buka Aset SQ untuk melihat daftar lengkapnya.$help$,
   50),
  ('35baba2c-65ce-5758-8849-8f6989a58638', 'GUIDE', 'DOCUMENTS', $help$Panduan singkat: Dokumen Kepegawaian$help$,
   $help$Layanan Dokumen dipakai untuk meminta surat keterangan dan melihat dokumen kepegawaian yang sudah terbit untuk Anda, termasuk surat peringatan bila ada.

1. Buka Semua Layanan, bagian Layanan Pegawai, lalu pilih Dokumen.
2. Pada Minta surat keterangan, pilih Jenis surat dan tulis keperluannya, misalnya pengajuan beasiswa anak.
3. Tekan Kirim permintaan.
4. Pantau di Permintaan saya. Statusnya: Menunggu keputusan, Disetujui, menunggu terbit, Sudah terbit, Ditolak, atau Dibatalkan.
5. Selama masih Menunggu keputusan, Anda dapat menekan Batalkan.
6. Surat yang sudah terbit tampil di Surat yang sudah terbit, lengkap dengan nomor surat, tanggal, dan penandatangan.

Permintaan diputuskan oleh HC. Nomor surat baru diberikan saat surat terbit, dan Anda menerima notifikasi saat permintaan diputuskan dan saat surat terbit. Bila permintaan ditolak, catatan HC tampil di bawahnya.

Surat keterangan penghasilan belum tersedia. Bila ada yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('c1b642c9-b617-5666-9c77-454cacb52b80', 'FAQ', 'DOCUMENTS', $help$Surat apa saja yang bisa saya minta lewat HCIS?$help$,
   $help$Jenis surat yang dapat Anda minta tampil di pilihan Jenis surat. Untuk pegawai aktif, yang tersedia saat ini adalah Surat Keterangan Kerja. Surat keterangan penghasilan belum tersedia.

Surat keterangan pengalaman kerja (paklaring) diperuntukkan bagi pegawai yang hubungan kerjanya sudah berakhir dan diterbitkan langsung oleh HC, bukan diminta lewat halaman ini.$help$,
   20),
  ('ed9cc0bb-554b-5ea9-8368-7706e32b7984', 'FAQ', 'DOCUMENTS', $help$Bagaimana cara mendapatkan salinan surat yang sudah terbit?$help$,
   $help$Surat yang sudah terbit tercatat di bagian Surat yang sudah terbit beserta nomor, tanggal terbit, dan penandatangannya. Saat ini halaman Dokumen belum menyediakan tombol cetak atau unduh untuk surat tersebut.

Untuk mendapatkan salinan cetaknya, hubungi Human Capital (HC) melalui kontak di halaman Bantuan dan sebutkan nomor suratnya.$help$,
   30),
  ('fda9422f-8183-5951-966f-ce67f346f23b', 'FAQ', 'DOCUMENTS', $help$Berapa banyak permintaan surat yang boleh saya ajukan sekaligus?$help$,
   $help$Saat ini setiap pegawai boleh memiliki paling banyak 3 permintaan surat yang masih terbuka sekaligus.

Bila batas itu tercapai, tunggu sampai salah satu permintaan diputuskan, atau batalkan permintaan yang masih Menunggu keputusan dan tidak lagi Anda perlukan.$help$,
   40),
  ('e0f139e8-a9f2-5c95-84c4-8bfdc29795eb', 'FAQ', 'DOCUMENTS', $help$Saya menerima surat peringatan di HCIS. Apa arti tombol Saya telah membaca?$help$,
   $help$Surat peringatan hanya dapat dilihat oleh Anda dan petugas HC yang berwenang; atasan tidak otomatis melihatnya. Tombol Saya telah membaca adalah tanda terima bahwa Anda sudah melihat surat tersebut. Tanda ini bukan persetujuan dan tidak membatalkan surat.

Saat ini masa berlaku surat peringatan umumnya 6 bulan sejak tanggal berlaku. Bila ada pertanyaan tentang isinya, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   50),
  ('6e4e0f38-a568-5861-9d6c-19017dbff628', 'GUIDE', 'PERFORMANCE', $help$Panduan singkat: Penilaian Kinerja$help$,
   $help$Layanan Kinerja dipakai untuk mengisi penilaian diri dan melihat hasil penilaian kinerja Anda pada setiap siklus. Atasan Anda memberi nilai, lalu HC mengesahkan.

1. Buka Semua Layanan, bagian Kinerja & Pengembangan, lalu pilih Kinerja / KPI.
2. Pada tab Penilaian saya, pilih penilaian dari siklus yang sedang berjalan.
3. Bila statusnya Menunggu penilaian diri, pilih nilai 1 sampai 4 untuk setiap indikator, tulis capaian dan kendala bila perlu, lalu tekan Kirim penilaian diri.
4. Penilaian lalu berpindah ke status Menunggu penilai, kemudian Menunggu pengesahan HC.
5. Setelah status Final, nilai dan predikat Anda tampil. Tekan Tandai sudah dibaca dan tulis tanggapan bila ingin.

Skala nilai: 4 Sangat baik, 3 Baik, 2 Cukup, 1 Kurang. Penilaian diri menjadi bahan pertimbangan atasan dan tidak dihitung ke nilai akhir. Penilaian yang tidak dinilai sampai siklus ditutup berstatus Tidak dinilai.

Penilaian ini belum memengaruhi tunjangan kinerja. Bila penilai Anda tidak tepat atau ada yang tidak sesuai, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('028d4a3e-c166-5472-810d-ea4c9ace3ce6', 'FAQ', 'PERFORMANCE', $help$Apakah penilaian diri saya ikut menentukan nilai akhir?$help$,
   $help$Tidak. Saat ini nilai akhir hanya berasal dari nilai yang diberikan penilai, yaitu atasan langsung Anda. Penilaian diri menjadi bahan pertimbangan penilai sebelum memberi nilai.

Meski begitu, isilah penilaian diri dengan jujur dan lengkap, termasuk capaian dan kendala, agar atasan memahami pekerjaan Anda.$help$,
   20),
  ('bcfc56b3-e1f2-5b4c-ad7c-4bc653843e0b', 'FAQ', 'PERFORMANCE', $help$Bagaimana nilai akhir dan predikat dihitung?$help$,
   $help$Setiap indikator dinilai 1 sampai 4 dan punya bobot. Nilai akhir adalah rata-rata berbobot dari nilai penilai, antara 1,00 dan 4,00. Indikator bawaan saat ini: Hasil kerja 30 persen, Disiplin dan kehadiran 20, Akhlak dan adab 20, Kerja sama dan komunikasi 15, serta Inisiatif dan pengembangan diri 15.

Predikat bawaan: A Sangat baik untuk nilai 3,50 ke atas, B Baik mulai 2,50, C Cukup mulai 1,50, dan D Kurang di bawahnya. HC dapat menyesuaikan indikator, bobot, dan batas predikat untuk siklus tertentu sebelum siklus dibuka.$help$,
   30),
  ('597c0a38-de6a-5228-9146-2a55f06e5190', 'FAQ', 'PERFORMANCE', $help$Saya tidak setuju dengan hasil penilaian. Bisakah saya mengajukan banding?$help$,
   $help$Saat ini belum ada proses banding di HCIS. Anda dapat menyampaikan tanggapan saat menekan Tandai sudah dibaca, paling banyak 1000 karakter. Tanggapan dicatat, tetapi tidak mengubah nilai.

Penilaian yang sudah Final tidak dapat diubah. Bila ada keberatan, bicarakan dengan atasan Anda atau hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   40),
  ('988bf675-3162-541b-a7c9-879cf41cc54d', 'FAQ', 'PERFORMANCE', $help$Saya terlambat mengisi penilaian diri. Apakah masih bisa?$help$,
   $help$Masih bisa, selama penilai belum memberi nilai. Bila batas penilaian diri sudah lewat, penilai boleh langsung menilai tanpa menunggu penilaian diri Anda.

Jadi, segera isi penilaian diri begitu siklus dibuka. Anda akan menerima notifikasi saat penilaian kinerja dibuka.$help$,
   50),
  ('31e48dcb-784e-57e9-8a76-5b095b2e3f58', 'FAQ', 'PERFORMANCE', $help$Apakah hasil penilaian kinerja memengaruhi gaji atau tunjangan saya?$help$,
   $help$Saat ini tidak. Hasil penilaian kinerja di HCIS belum dipakai untuk menghitung tunjangan kinerja atau gaji, dan tidak menyimpan persentase maupun nominal uang.

Hasilnya dipakai sebagai catatan kinerja dan bahan pembinaan. Riwayat penilaian Anda dari siklus-siklus sebelumnya tetap dapat dilihat di tab Penilaian saya.$help$,
   60),
  ('d359de33-7809-58ba-91bb-3215f11561a2', 'GUIDE', 'APPROVALS', $help$Panduan singkat: Persetujuan untuk atasan dan approver$help$,
   $help$Bagian ini untuk atasan langsung dan approver unit yang memutuskan pengajuan anggota timnya. Pengajuan cuti, perjalanan dinas, dan pinjaman yang menunggu keputusan Anda dikumpulkan di menu Persetujuan.

1. Buka menu Persetujuan di kelompok Tugas (di HP: Approval). Jumlah yang menunggu juga tampil di kotak Perlu tindakan pada Beranda.
2. Periksa bagian Cuti, Perjalanan Dinas, dan Pinjaman. Hanya tahap yang sedang menjadi giliran Anda yang muncul.
3. Baca rinciannya, misalnya tanggal, jumlah hari kerja, dan peran Anda (Atasan langsung atau Approver unit).
4. Tekan Setujui atau Tolak. Alasan penolakan cuti boleh dikosongkan; untuk perjalanan dinas dan pinjaman, alasan wajib minimal 5 karakter.
5. Setelah Anda menyetujui, pengajuan berlanjut ke penyetuju berikutnya atau selesai.

Persetujuan lain ada di tempat masing-masing: lembur bawahan di menu Lembur Tim, penilaian kinerja anggota tim di tab Tim yang saya nilai pada halaman Kinerja, dan permintaan tukar shift dari rekan di menu Tukar Shift pada bagian Menunggu keputusan Anda.

Daftar penyetuju ditetapkan saat pegawai mengajukan. Bila Anda merasa tidak seharusnya menjadi penyetuju, atau tidak dapat memutuskan karena berhalangan, hubungi Human Capital (HC) melalui kontak di halaman Bantuan.$help$,
   10),
  ('3fc2e681-6a36-5ef5-a9ea-561f75619005', 'FAQ', 'APPROVALS', $help$Kenapa saya melihat menu Persetujuan padahal saya bukan atasan?$help$,
   $help$Menu Persetujuan dan Lembur Tim tampil untuk semua pegawai, tetapi isinya hanya muncul bila Anda tercatat sebagai penyetuju sebuah pengajuan.

Bila Anda bukan penyetuju, halaman itu akan tertulis Tidak ada approval yang menunggu. Anda tidak perlu melakukan apa pun.$help$,
   20),
  ('c91baf4f-6daa-5376-bdf2-9bca4f4c7601', 'FAQ', 'APPROVALS', $help$Bagaimana cara menyetujui lembur bawahan saya?$help$,
   $help$Buka menu Lembur Tim, tab Perlu persetujuan. Untuk setiap pengajuan, Anda dapat mengubah Menit disetujui (tidak boleh melebihi yang diajukan), lalu tekan Setujui. Untuk menolak, isi Catatan terlebih dahulu karena wajib, lalu tekan Tolak.

Untuk beberapa pengajuan sekaligus, centang pengajuannya lalu tekan Setujui sesuai pengajuan. Persetujuan di HCIS berlaku sebagai persetujuan tertulis, dan HC menerima pemberitahuan atas lembur yang disetujui.$help$,
   30),
  ('eda35411-61f6-5d48-8641-aae06991989e', 'FAQ', 'APPROVALS', $help$Bagaimana cara memerintahkan lembur kepada bawahan?$help$,
   $help$Buka menu Lembur Tim, lalu tekan Perintahkan lembur. Cari bawahan langsung dengan nama atau NIP (bisa lebih dari satu orang), isi Tanggal, Durasi (menit), dan Keterangan, lalu tekan Kirim.

Perintah lembur baru berlaku setelah pegawai menekan Setuju. Statusnya tampil di tab Perintah lembur: Menunggu persetujuan pegawai, Disetujui pegawai, Ditolak pegawai, atau Dibatalkan. Selama masih menunggu, Anda dapat menekan Batalkan perintah.$help$,
   40),
  ('27fe78d5-b15d-5a56-85ac-4780cba22249', 'FAQ', 'APPROVALS', $help$Struktur atau atasan berubah setelah pegawai mengajukan. Siapa yang menyetujui?$help$,
   $help$Daftar penyetuju ditetapkan dan disimpan saat pegawai mengajukan. Perubahan struktur organisasi sesudahnya tidak memindahkan pengajuan yang sudah berjalan; pengajuan tetap menunggu penyetuju yang tercatat.

Bila penyetuju yang tercatat sudah tidak dapat memutuskan, misalnya karena pindah tugas, hubungi Human Capital (HC) melalui kontak di halaman Bantuan. Pengajuan baru akan memakai struktur yang berlaku saat diajukan.$help$,
   50),
  ('fad4a383-21b6-58e4-9059-35126b44d2dc', 'FAQ', 'APPROVALS', $help$Apakah saya mendapat pemberitahuan saat ada pengajuan yang perlu saya setujui?$help$,
   $help$Untuk perjalanan dinas, pinjaman, lembur, dan penilaian kinerja, Anda menerima notifikasi di HCIS saat tiba giliran Anda.

Untuk pengajuan cuti, saat ini belum ada notifikasi khusus. Periksa menu Persetujuan secara rutin, atau lihat kotak Perlu tindakan di Beranda yang menampilkan jumlah persetujuan yang menunggu.$help$,
   60),
  ('f6a32ff3-75aa-5a10-924b-44d268ebe44b', 'FAQ', 'APPROVALS', $help$Bagaimana cara menilai kinerja anggota tim saya?$help$,
   $help$Buka halaman Kinerja, lalu pilih tab Tim yang saya nilai. Pilih penilaian anggota tim, baca penilaian dirinya, lalu pilih nilai 1 sampai 4 untuk setiap indikator dan tekan Kirim nilai.

Anda dapat menilai setelah pegawai mengirim penilaian diri, atau setelah batas penilaian diri lewat. Nilai Anda kemudian disahkan HC. Bila HC mengembalikannya, Anda akan diberi tahu beserta alasannya dan dapat menilai ulang.$help$,
   70)
) AS seed(id, kind, topic, title, body, sort_order)
ON CONFLICT (id) DO NOTHING;

INSERT INTO help_article_revisions (id, article_id, version, kind, topic, title, body, status)
SELECT gen_random_uuid(), article.id, 1, article.kind, article.topic, article.title, article.body, article.status
FROM help_articles article
WHERE article.origin = 'SEED'
  AND NOT EXISTS (SELECT 1 FROM help_article_revisions r WHERE r.article_id = article.id AND r.version = 1);

INSERT INTO help_audit_events (id, event_type, article_id, metadata)
SELECT gen_random_uuid(), 'help.article.created', article.id,
       jsonb_build_object('kind', article.kind, 'topic', article.topic, 'title', article.title,
                          'version', 1, 'origin', 'SEED')
FROM help_articles article
WHERE article.origin = 'SEED'
  AND NOT EXISTS (
    SELECT 1 FROM help_audit_events e WHERE e.article_id = article.id AND e.event_type = 'help.article.created'
  );
