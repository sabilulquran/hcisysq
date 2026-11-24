-- TRIP-002 D-22: uang saku perjalanan dinas terkunci sampai dinyalakan, dan hanya boleh
-- dinyalakan bila pemeriksaan kesiapannya lulus.
-- Spec: docs/domain/trip-advance-per-diem.md §10. Keputusan owner 2026-11-24.
--
-- Mengapa tabel ini ada. Sebelum ini tidak ada keadaan "belum dinyalakan": begitu 0172 jalan,
-- jalur uang saku hidup dan menjawab 409 TRIP_PER_DIEM_GOLONGAN_UNMAPPED kepada setiap pegawai
-- selama pemetaan golongan masih kosong. Itu bukan terkunci, itu rusak. Karena itu pemeriksaan
-- katalognya dipindahkan dari gerbang rilis (yang menahan SELURUH rilis, termasuk perbaikan cuti
-- yang tidak ada hubungannya) ke syarat penyalaan fiturnya sendiri.
--
-- Tabel ini hanya ditambahi, tidak pernah diubah atau dihapus barisnya: keadaan yang berlaku
-- adalah baris terakhir, dan tidak adanya baris berarti INACTIVE. Jadi production yang baru
-- menerima migrasi ini mulai dalam keadaan terkunci tanpa perlu menulis satu baris pun, dan
-- setiap penyalaan maupun pematian meninggalkan jejak dengan alasannya.
--
-- Down:
--   DROP TABLE IF EXISTS trip_per_diem_activation;
--   ALTER TABLE trip_advance_events DROP CONSTRAINT IF EXISTS trip_advance_events_global_check;
--   ALTER TABLE trip_advance_events ADD CONSTRAINT trip_advance_events_global_check
--     CHECK (advance_id IS NOT NULL OR event_type IN (
--       'trip_advance.register.exported', 'trip_advance.rate.created',
--       'trip_advance.golongan.mapped', 'trip_advance.golongan.unmapped'));
--   -- (hapus dulu baris trip_advance.per_diem.* bila ada, atau CHECK itu tidak dapat dipasang)
--   DELETE FROM schema_migrations WHERE name = '0183_trip_per_diem_activation.sql';

CREATE TABLE IF NOT EXISTS trip_per_diem_activation (
  id uuid PRIMARY KEY,
  -- Urutan yang menentukan "baris terakhir". Sengaja BUKAN changed_at: now() adalah waktu
  -- transaksi, jadi dua keputusan dalam satu transaksi memiliki stempel yang sama persis dan
  -- urutannya akan jatuh ke id acak — keadaan yang berlaku lalu menjadi undian.
  recorded_seq bigint GENERATED ALWAYS AS IDENTITY,
  state text NOT NULL CHECK (state IN ('ACTIVE', 'INACTIVE')),
  reason text NULL CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  -- Bukti pemeriksaan pada saat penyalaan: jumlah temuan dan peringatan yang tersisa, bukan
  -- daftar orangnya (D-17: tanpa data pribadi di jejak).
  readiness jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_by_account_id uuid NOT NULL REFERENCES accounts(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_per_diem_activation_latest_idx
  ON trip_per_diem_activation (recorded_seq DESC);

-- Penyalaan dan pematian ikut jejak audit TRIP-002 yang sudah ada. Keduanya tidak melekat pada
-- satu uang muka, jadi daftar event yang boleh ber-advance_id NULL harus ikut diperluas; tanpa
-- ini INSERT-nya ditolak CHECK dan rutenya gagal 500.
ALTER TABLE trip_advance_events DROP CONSTRAINT IF EXISTS trip_advance_events_global_check;
ALTER TABLE trip_advance_events ADD CONSTRAINT trip_advance_events_global_check
  CHECK (advance_id IS NOT NULL OR event_type IN (
    'trip_advance.register.exported', 'trip_advance.rate.created',
    'trip_advance.golongan.mapped', 'trip_advance.golongan.unmapped',
    'trip_advance.per_diem.activated', 'trip_advance.per_diem.deactivated'
  ));
