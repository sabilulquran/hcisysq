-- LOAN-002 / APR-002: registri kursi persetujuan (approval seat registry) dan ambang Pembina.
-- Spec: docs/domain/employee-loans.md §16 (keputusan pemilik 2026-11-18), docs/domain/organ-account-approver.md.
--
-- Latar: keputusan pemilik 18 Nov 2026 menetapkan rantai kasbon tetap — approver unit, Kepala
-- Keuangan, Direktur, Ketua Yayasan, Bendahara Yayasan, dan Pembina di atas ambang tertentu.
-- Lima nama terakhir adalah *kursi*, bukan orang, dan resolver APR-001 tidak boleh membaca teks
-- jabatan (AUTH-010-K, docs/domain/access-model.md §342). Jadi kursi dipetakan ke stable key
-- jabatan ORG-004 oleh Human Capital, persis seperti aturan lembur ATT-011 D-10 (migrasi 0146).
--
-- 1. organization_approval_seats: pemetaan bertanggal dari kunci kursi ke stable key jabatan.
--    Tambah dan akhiri saja — tidak pernah dihapus dan targetnya tidak pernah diubah, sehingga
--    keputusan lama tetap dapat dijelaskan. Tidak ada teks jabatan yang dibaca: `seat_label` hanya
--    menyimpan apa yang dilihat HC saat memilih, untuk tampilan, dan tidak pernah dibaca resolver.
--    Tidak ada id orang atau pegawai di sini.
-- 2. employee_loan_approval_policy_versions: ambang nominal yang menambahkan kursi Pembina sebagai
--    langkah teratas. Disimpan sebagai konfigurasi bertanggal, bukan konstanta TypeScript, supaya
--    mengubahnya bukan rilis. Satu baris DRAFT Rp5.000.000 di-seed di sini (pemilik belum
--    menetapkan angkanya).
-- 3. Tidak ada seed kursi. Repo tidak memegang stable key jabatan produksi mana pun, dan sistem
--    tidak boleh menebaknya. HC memetakan kursi di Pengaturan > Kursi persetujuan. Sampai itu
--    dilakukan, rantai kasbon STRUCTURE gagal tertutup dengan kode yang menyebut kursinya
--    (LOAN_APPROVAL_SEAT_UNMAPPED); perilaku LEGACY tidak berubah sama sekali.
--
-- Aditif. Tidak ada tabel, baris, atau alur yang ada yang ditulis ulang.
--
-- Rollback (build lama mengabaikan tabel baru; rantai kursi lalu tidak dapat di-resolve):
--   DROP TRIGGER IF EXISTS organization_approval_seats_append_only ON organization_approval_seats;
--   DROP FUNCTION IF EXISTS organization_approval_seats_guard();
--   DROP TABLE IF EXISTS organization_approval_seats;
--   DROP TABLE IF EXISTS employee_loan_approval_policy_versions;
-- Recovery: kedua tabel adalah konfigurasi; riwayatnya juga ada di access_audit_events
-- (organization.approval_seat.mapped/ended, loans.approval_policy.updated).
--
-- Idempotent: menjalankan ulang tidak mengubah apa pun lagi.

CREATE TABLE IF NOT EXISTS organization_approval_seats (
  id uuid PRIMARY KEY,
  -- Himpunan tertutup. Menambah kursi baru adalah migrasi, bukan data.
  seat_key text NOT NULL CHECK (seat_key IN (
    'KEPALA_KEUANGAN', 'DIREKTUR', 'KETUA_YAYASAN', 'BENDAHARA_YAYASAN', 'PEMBINA'
  )),
  -- Stable key jabatan ORG-004 (organization_positions.stable_key).
  position_key uuid NOT NULL,
  -- Apa yang dilihat HC saat memilih (nama jabatan dan unitnya). Tampilan saja; resolver tidak
  -- pernah membacanya, sehingga tidak ada pencocokan teks jabatan di jalur persetujuan.
  seat_label text NOT NULL CHECK (char_length(btrim(seat_label)) BETWEEN 1 AND 300),
  effective_from date NOT NULL,
  -- Hari terakhir pemetaan berlaku (inklusif, seperti struktur). effective_from - 1 = tidak pernah berlaku.
  effective_to date NULL,
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  ended_at timestamptz NULL,
  end_reason text NULL,
  CONSTRAINT organization_approval_seats_period CHECK (effective_to IS NULL OR effective_to >= effective_from - 1),
  CONSTRAINT organization_approval_seats_end_recorded CHECK ((effective_to IS NULL) = (ended_at IS NULL))
);

-- Satu pemetaan terbuka per kursi; pemetaan yang sudah diakhiri boleh disusul yang baru.
CREATE UNIQUE INDEX IF NOT EXISTS organization_approval_seats_open_seat_idx
  ON organization_approval_seats (seat_key) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS organization_approval_seats_period_idx
  ON organization_approval_seats (seat_key, effective_from, effective_to);

-- Tambah dan akhiri saja: tidak ada hapus, dan hanya kolom pengakhiran yang boleh berubah, sekali.
CREATE OR REPLACE FUNCTION organization_approval_seats_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_approval_seats are never deleted; end the mapping instead';
  END IF;
  IF OLD.effective_to IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.seat_key <> OLD.seat_key OR NEW.position_key <> OLD.position_key
     OR NEW.seat_label <> OLD.seat_label OR NEW.effective_from <> OLD.effective_from
     OR NEW.created_at <> OLD.created_at
     OR NEW.created_by_account_id IS DISTINCT FROM OLD.created_by_account_id THEN
    RAISE EXCEPTION 'organization_approval_seats may only be ended once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_approval_seats_append_only ON organization_approval_seats;
CREATE TRIGGER organization_approval_seats_append_only
  BEFORE UPDATE OR DELETE ON organization_approval_seats
  FOR EACH ROW EXECUTE FUNCTION organization_approval_seats_guard();

-- Ambang Pembina. Pokok yang **melebihi** ambang menambahkan kursi Pembina sebagai langkah
-- teratas; pokok yang sama dengan ambang tidak. Rupiah bulat dalam bigint, seperti migrasi 0122.
CREATE TABLE IF NOT EXISTS employee_loan_approval_policy_versions (
  id uuid PRIMARY KEY,
  effective_from date NOT NULL,
  pembina_threshold_amount bigint NOT NULL
    CHECK (pembina_threshold_amount > 0 AND pembina_threshold_amount <= 1000000000),
  reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 1000),
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_loan_approval_policy_versions_effective_idx
  ON employee_loan_approval_policy_versions (effective_from DESC, created_at DESC);

-- DRAFT: pemilik menetapkan "ada misalnya plafon tertentu pembina juga masuk approval teratas"
-- tanpa menyebut angkanya. Rp5.000.000 dipakai sampai pemilik menetapkan yang lain; mengubahnya
-- adalah satu baris baru di tabel ini, bukan rilis.
INSERT INTO employee_loan_approval_policy_versions (id, effective_from, pembina_threshold_amount, reason)
VALUES (
  '20000000-0000-4000-8000-000000000001',
  DATE '2026-11-18',
  5000000,
  'DRAFT LOAN-002: ambang Pembina belum ditetapkan pemilik; default Rp5.000.000.'
)
ON CONFLICT (id) DO NOTHING;
