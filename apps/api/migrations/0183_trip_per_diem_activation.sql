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
-- Down (satu transaksi; `trip_advance_events` punya trigger `trip_advance_events_immutable`
-- yang menolak UPDATE dan DELETE, jadi baris jejaknya tidak dapat dihapus dengan cara biasa —
-- dan CHECK yang lama tidak dapat dipasang kembali selama baris itu masih ada):
--   BEGIN;
--   DROP TABLE IF EXISTS trip_per_diem_activation;
--   SET LOCAL session_replication_role = 'replica';   -- melewati trigger immutability
--   DELETE FROM trip_advance_events
--    WHERE advance_id IS NULL
--      AND event_type IN ('trip_advance.per_diem.activated', 'trip_advance.per_diem.deactivated');
--   SET LOCAL session_replication_role = 'origin';
--   ALTER TABLE trip_advance_events DROP CONSTRAINT IF EXISTS trip_advance_events_global_check;
--   ALTER TABLE trip_advance_events ADD CONSTRAINT trip_advance_events_global_check
--     CHECK (advance_id IS NOT NULL OR event_type IN (
--       'trip_advance.register.exported', 'trip_advance.rate.created',
--       'trip_advance.golongan.mapped', 'trip_advance.golongan.unmapped'));
--   DELETE FROM schema_migrations WHERE name = '0183_trip_per_diem_activation.sql';
--   COMMIT;
-- Jejak penyalaan/pematian memang hilang karena itu. Bila jejaknya ingin disimpan, ekspor dulu
-- kedua jenis event tersebut sebelum menjalankan Down ini.

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
-- Dibuang berdasarkan definisinya, bukan berdasarkan namanya: pembatas aslinya dibuat inline
-- tanpa nama pada 0160 dan baru diberi nama oleh 0172. Pada database mana pun yang 0172-nya
-- belum sempat menamainya, DROP ... IF EXISTS by name akan diam-diam tidak melakukan apa-apa,
-- CHECK dua-nilai yang lama bertahan, dan penyalaan pertama gagal 500. Pola ini mengikuti 0172.
DO $$
DECLARE
  doomed record;
BEGIN
  FOR doomed IN
    SELECT conname FROM pg_constraint
     WHERE contype = 'c' AND conrelid = 'trip_advance_events'::regclass
       AND pg_get_constraintdef(oid) LIKE '%trip_advance.register.exported%'
  LOOP
    EXECUTE format('ALTER TABLE trip_advance_events DROP CONSTRAINT %I', doomed.conname);
  END LOOP;
END;
$$;
ALTER TABLE trip_advance_events ADD CONSTRAINT trip_advance_events_global_check
  CHECK (advance_id IS NOT NULL OR event_type IN (
    'trip_advance.register.exported', 'trip_advance.rate.created',
    'trip_advance.golongan.mapped', 'trip_advance.golongan.unmapped',
    'trip_advance.per_diem.activated', 'trip_advance.per_diem.deactivated'
  ));
