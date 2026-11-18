-- TRIP-002 revisi menurut SK Yayasan Sabilul Qur'an Nomor 01.111/YSQ/VII/2026
-- ("Pengaturan Standar Biaya Uang Saku Perjalanan Dinas", ditetapkan di Cirebon 10 Juli 2026).
-- Spec: docs/domain/trip-advance-per-diem.md §9 (D-01, D-02, D-04, D-20, D-21).
--
-- Migration 0160 membangun tarif uang harian di atas asumsi DRAFT: empat zona dan tarif per zona
-- saja. SK-nya kini ada dan berbeda. Yang berubah di sini:
--
--   1. Dimensi tarif menjadi (golongan, wilayah, tanggal berlaku). Golongan: PIMPINAN,
--      KEPALA_UNIT, STAF (Lampiran 1). Wilayah: DALAM_DAERAH (Wilayah III Cirebon),
--      LUAR_DAERAH, dan LUAR_NEGERI yang dipertahankan sebagai kode tanpa tarif.
--   2. Enam tarif Lampiran 1 disemai sebagai versi pertama, berlaku 2026-07-10, dengan nomor SK
--      pada kolom provenans `decree_reference`.
--   3. Pemetaan klasifikasi jabatan ORG-011 ke golongan (`trip_per_diem_golongan_map`). Golongan
--      tidak pernah ditebak dari teks jabatan (AUTH-010-K, ADR-0004); HC memetakannya eksplisit.
--   4. Diktum Keempat (uang saku tidak dibayar dua kali): deklarasi pegawai / penanda Keuangan
--      pada uang muka, dan alasan tertulis bila uang harian ditahan atau dikurangi.
--
-- Katalog ORG-011 tidak disentuh: ADR-0004 melarang kolom nominal atau band pada
-- `job_classifications`, jadi pemetaan golongan ini milik TRIP-002, bukan milik katalog.
-- Tidak ada tabel `payroll_*` yang dibaca atau ditulis.
--
-- Prasyarat data: `trip_per_diem_rates` dirancang mulai kosong (D-02) dan rilis
-- `hcis-...-20261117` memang tidak menulis satu baris pun ke tabel ini. Baris tarif lama tidak
-- dapat dipetakan ke golongan mana pun tanpa menebak, jadi migrasi ini berhenti dengan pesan
-- jelas bila ternyata ada isinya. Uang muka yang sudah berjalan tidak berhenti: zona DRAFT-nya
-- dipetakan deterministik ke wilayah SK.
--
-- Down (hanya sebelum ada tarif atau pemetaan baru di production; sesudahnya ekspor dulu):
--   DROP TABLE IF EXISTS trip_per_diem_golongan_map;
--   DELETE FROM trip_per_diem_rates WHERE decree_reference IS NOT NULL;
--   ALTER TABLE trip_per_diem_rates DROP CONSTRAINT IF EXISTS trip_per_diem_rates_author_check;
--   ALTER TABLE trip_per_diem_rates ALTER COLUMN created_by_account_id SET NOT NULL;
--   ALTER TABLE trip_per_diem_rates DROP COLUMN IF EXISTS decree_reference;
--   ALTER TABLE trip_per_diem_rates DROP COLUMN IF EXISTS golongan;
--   ALTER TABLE trip_per_diem_rates RENAME COLUMN wilayah TO zone;
--   ALTER TABLE trip_advances DROP CONSTRAINT IF EXISTS trip_advances_per_diem_golongan_check;
--   ALTER TABLE trip_advances DROP CONSTRAINT IF EXISTS trip_advances_organizer_per_diem_check;
--   ALTER TABLE trip_advances DROP CONSTRAINT IF EXISTS trip_advances_waive_reason_check;
--   ALTER TABLE trip_advances DROP COLUMN IF EXISTS per_diem_golongan,
--     DROP COLUMN IF EXISTS organizer_per_diem_declared, DROP COLUMN IF EXISTS per_diem_waive_reason;
--   ALTER TABLE trip_advances RENAME COLUMN wilayah TO zone;
--   -- lalu kembalikan CHECK zona lama pada kedua tabel.
--   DELETE FROM schema_migrations WHERE name = '0168_trip_per_diem_decree.sql';

-- Tarif lama tidak dapat dipetakan ke golongan: berhenti, jangan menebak.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM trip_per_diem_rates WHERE decree_reference IS NULL) THEN
    RAISE EXCEPTION 'trip_per_diem_rates berisi tarif zona DRAFT yang tidak punya golongan. Ekspor baris itu, kosongkan tabel, lalu jalankan migrasi ini (SK 01.111/YSQ/VII/2026).'
      USING ERRCODE = '23514';
  END IF;
EXCEPTION
  WHEN undefined_column THEN
    IF EXISTS (SELECT 1 FROM trip_per_diem_rates) THEN
      RAISE EXCEPTION 'trip_per_diem_rates berisi tarif zona DRAFT yang tidak punya golongan. Ekspor baris itu, kosongkan tabel, lalu jalankan migrasi ini (SK 01.111/YSQ/VII/2026).'
        USING ERRCODE = '23514';
    END IF;
END;
$$;

-- ------------------------------------------------------------------ wilayah

-- D-01: katalog wilayah SK menggantikan empat zona DRAFT. Uang muka yang sudah diajukan
-- dipetakan: dalam kabupaten/kota -> Dalam Daerah; luar kabupaten/kota dan luar provinsi ->
-- Luar Daerah; luar negeri -> Luar Negeri (yang tidak punya tarif di SK).
DO $$
DECLARE
  doomed record;
BEGIN
  -- Drop by definition, not by guessed name: the zone CHECKs were created inline in 0160.
  FOR doomed IN
    SELECT conrelid::regclass AS table_name, conname
      FROM pg_constraint
     WHERE contype = 'c'
       AND conrelid IN ('trip_advances'::regclass, 'trip_per_diem_rates'::regclass)
       AND pg_get_constraintdef(oid) LIKE '%PROVINCIAL%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', doomed.table_name, doomed.conname);
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'trip_advances' AND column_name = 'zone'
  ) THEN
    ALTER TABLE trip_advances RENAME COLUMN zone TO wilayah;
    UPDATE trip_advances SET wilayah = CASE wilayah
      WHEN 'LOCAL' THEN 'DALAM_DAERAH'
      WHEN 'PROVINCIAL' THEN 'LUAR_DAERAH'
      WHEN 'NATIONAL' THEN 'LUAR_DAERAH'
      WHEN 'INTERNATIONAL' THEN 'LUAR_NEGERI'
      ELSE wilayah END;
    ALTER TABLE trip_advances ADD CONSTRAINT trip_advances_wilayah_check
      CHECK (wilayah IN ('DALAM_DAERAH', 'LUAR_DAERAH', 'LUAR_NEGERI'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'trip_per_diem_rates' AND column_name = 'zone'
  ) THEN
    DROP INDEX IF EXISTS trip_per_diem_rates_lookup_idx;
    ALTER TABLE trip_per_diem_rates RENAME COLUMN zone TO wilayah;
    ALTER TABLE trip_per_diem_rates ADD CONSTRAINT trip_per_diem_rates_wilayah_check
      CHECK (wilayah IN ('DALAM_DAERAH', 'LUAR_DAERAH', 'LUAR_NEGERI'));
  END IF;
END;
$$;

-- ------------------------------------------------------------------ tarif

-- D-02: tarif berversi per (golongan, wilayah). Tetap append-only; trigger 0160 tetap berlaku.
ALTER TABLE trip_per_diem_rates ADD COLUMN IF NOT EXISTS golongan text;
ALTER TABLE trip_per_diem_rates ADD COLUMN IF NOT EXISTS decree_reference text;
-- Aman tanpa backfill: pemeriksaan di atas sudah memastikan tidak ada baris tarif lama, dan
-- baris SK di bawah mengisi golongan sendiri. Tidak ada golongan yang ditebak untuk baris lama.
ALTER TABLE trip_per_diem_rates ALTER COLUMN golongan SET NOT NULL;
ALTER TABLE trip_per_diem_rates DROP CONSTRAINT IF EXISTS trip_per_diem_rates_golongan_check;
ALTER TABLE trip_per_diem_rates ADD CONSTRAINT trip_per_diem_rates_golongan_check
  CHECK (golongan IN ('PIMPINAN', 'KEPALA_UNIT', 'STAF'));
ALTER TABLE trip_per_diem_rates DROP CONSTRAINT IF EXISTS trip_per_diem_rates_decree_reference_check;
ALTER TABLE trip_per_diem_rates ADD CONSTRAINT trip_per_diem_rates_decree_reference_check
  CHECK (decree_reference IS NULL OR char_length(decree_reference) BETWEEN 1 AND 200);

-- Baris yang disemai migrasi ini berasal dari SK, bukan dari seorang petugas; justru nomor SK
-- itulah provenansnya. Baris yang dicatat lewat layar tetap wajib menyebut akun pencatat.
ALTER TABLE trip_per_diem_rates ALTER COLUMN created_by_account_id DROP NOT NULL;
ALTER TABLE trip_per_diem_rates DROP CONSTRAINT IF EXISTS trip_per_diem_rates_author_check;
ALTER TABLE trip_per_diem_rates ADD CONSTRAINT trip_per_diem_rates_author_check
  CHECK (created_by_account_id IS NOT NULL OR decree_reference IS NOT NULL);

CREATE INDEX IF NOT EXISTS trip_per_diem_rates_lookup_idx
  ON trip_per_diem_rates (golongan, wilayah, effective_from DESC, created_at DESC);

-- Lampiran 1 SK 01.111/YSQ/VII/2026: uang saku per hari per orang, berlaku sejak penetapan.
-- Luar Negeri sengaja tidak punya baris: SK tidak mengaturnya, jadi harus berperilaku
-- "tarif belum ditetapkan", bukan Rp0.
INSERT INTO trip_per_diem_rates (id, golongan, wilayah, effective_from, daily_amount, note, decree_reference, created_at)
SELECT gen_random_uuid(), seed.golongan, seed.wilayah, DATE '2026-07-10', seed.daily_amount,
       'Lampiran 1 SK 01.111/YSQ/VII/2026, ditetapkan di Cirebon 10 Juli 2026.',
       'SK Yayasan Sabilul Qur''an Nomor 01.111/YSQ/VII/2026', now()
  FROM (VALUES
    ('PIMPINAN', 'DALAM_DAERAH', 100000::bigint),
    ('PIMPINAN', 'LUAR_DAERAH', 180000::bigint),
    ('KEPALA_UNIT', 'DALAM_DAERAH', 80000::bigint),
    ('KEPALA_UNIT', 'LUAR_DAERAH', 160000::bigint),
    ('STAF', 'DALAM_DAERAH', 60000::bigint),
    ('STAF', 'LUAR_DAERAH', 140000::bigint)
  ) AS seed(golongan, wilayah, daily_amount)
 WHERE NOT EXISTS (
   SELECT 1 FROM trip_per_diem_rates existing
    WHERE existing.golongan = seed.golongan AND existing.wilayah = seed.wilayah
      AND existing.effective_from = DATE '2026-07-10'
 );

-- -------------------------------------------------------------- golongan map

-- D-20: golongan seseorang berasal dari klasifikasi jabatan ORG-011 yang dipetakan HC, tidak
-- pernah dari teks jabatan (docs/domain/dynamic-organization-structure.md, AUTH-010-K).
-- Tanpa FK ke job_classifications: kode di sana effective-dated (code + rentang), bukan kunci
-- tunggal. Kode klasifikasi bersifat permanen (ADR-0004), jadi teks kode adalah kunci yang sah.
CREATE TABLE IF NOT EXISTS trip_per_diem_golongan_map (
  job_classification_code text PRIMARY KEY CHECK (job_classification_code ~ '^[A-Z][A-Z0-9_]{0,47}$'),
  golongan text NOT NULL CHECK (golongan IN ('PIMPINAN', 'KEPALA_UNIT', 'STAF')),
  note text NULL CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  updated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Riwayat pemetaan golongan ikut jejak audit TRIP-002 yang sudah ada (tanpa nominal, D-17).
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
    'trip_advance.golongan.mapped', 'trip_advance.golongan.unmapped'
  ));

-- ------------------------------------------------------- uang muka: golongan

-- Golongan dan tarif yang dipakai disimpan pada uang muka saat penyelesaian, sehingga uang muka
-- yang sudah diselesaikan dapat dihitung ulang persis walau katalog atau pemetaan berubah.
ALTER TABLE trip_advances ADD COLUMN IF NOT EXISTS per_diem_golongan text;
ALTER TABLE trip_advances DROP CONSTRAINT IF EXISTS trip_advances_per_diem_golongan_check;
ALTER TABLE trip_advances ADD CONSTRAINT trip_advances_per_diem_golongan_check
  CHECK (per_diem_golongan IS NULL OR (
    per_diem_golongan IN ('PIMPINAN', 'KEPALA_UNIT', 'STAF') AND per_diem_rate_id IS NOT NULL));
ALTER TABLE trip_advances DROP CONSTRAINT IF EXISTS trip_advances_per_diem_golongan_present_check;
ALTER TABLE trip_advances ADD CONSTRAINT trip_advances_per_diem_golongan_present_check
  CHECK (per_diem_rate_id IS NULL OR per_diem_golongan IS NOT NULL);

-- D-21 (Diktum Keempat): uang saku tidak dibayar dua kali. Pegawai menyatakannya saat mengajukan
-- pertanggungjawaban, Keuangan dapat menandainya saat menyelesaikan; keduanya menutup uang harian.
ALTER TABLE trip_advances ADD COLUMN IF NOT EXISTS organizer_per_diem_declared boolean NOT NULL DEFAULT false;
ALTER TABLE trip_advances ADD COLUMN IF NOT EXISTS per_diem_waive_reason text;
ALTER TABLE trip_advances DROP CONSTRAINT IF EXISTS trip_advances_waive_reason_check;
ALTER TABLE trip_advances ADD CONSTRAINT trip_advances_waive_reason_check
  CHECK (per_diem_waive_reason IS NULL OR (
    settled_at IS NOT NULL AND char_length(per_diem_waive_reason) BETWEEN 10 AND 500));
ALTER TABLE trip_advances DROP CONSTRAINT IF EXISTS trip_advances_organizer_per_diem_check;
ALTER TABLE trip_advances ADD CONSTRAINT trip_advances_organizer_per_diem_check
  CHECK (NOT organizer_per_diem_declared OR per_diem_days IS NULL OR per_diem_days = 0);
