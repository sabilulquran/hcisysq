-- Administrasi kepegawaian Paket 2, langkah P2-1.
-- Spec: docs/domain/employment-administration-package2.md (EMP-007, EMP-008,
-- EMP-009, EMP-003).
--
-- Pendidikan, keahlian, keluarga, dan alamat berhenti menjadi satu kolom yang
-- ditimpa dan menjadi catatan tersendiri dengan tanggalnya. Semua additive;
-- `employees.education` dibiarkan apa adanya sampai HC selesai memindahkan
-- riwayat (spec §5.5).
--
-- Down (sah selama tabel masih kosong):
--   DROP TABLE IF EXISTS employee_data_change_requests, employee_addresses,
--     employee_family_members, employee_skills, employee_education,
--     employee_profile_audit_events;
--
-- btree_gist sudah aktif sejak migrasi 0021; dipakai di sini untuk menjaga
-- "satu yang berlaku pada satu waktu" di tingkat basis data, bukan di kode.

-- EMP-007 -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_education (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  level text NOT NULL CHECK (level IN (
    'SD', 'SMP', 'SMA_SEDERAJAT', 'D1', 'D2', 'D3', 'D4_S1', 'S2', 'S3', 'PONDOK', 'LAINNYA'
  )),
  institution_name text NOT NULL CHECK (length(trim(institution_name)) > 0),
  major text NULL,
  started_year integer NULL CHECK (started_year BETWEEN 1900 AND 2200),
  completed_year integer NULL CHECK (completed_year BETWEEN 1900 AND 2200),
  completion_status text NOT NULL CHECK (completion_status IN ('SELESAI', 'BELUM_SELESAI', 'TIDAK_SELESAI')),
  degree_title text NULL,
  certificate_number text NULL,
  archive_reference text NULL,
  notes text NULL,
  verification_status text NOT NULL DEFAULT 'DILAPORKAN'
    CHECK (verification_status IN ('DILAPORKAN', 'DIVERIFIKASI')),
  verified_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  verified_at timestamptz NULL,
  voided_at timestamptz NULL,
  voided_reason text NULL,
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_education_year_order_check
    CHECK (started_year IS NULL OR completed_year IS NULL OR completed_year >= started_year),
  -- Namanya bukan employee_education_completed_year_check: PostgreSQL sudah
  -- memakai nama itu untuk CHECK rentang pada kolom completed_year.
  CONSTRAINT employee_education_completion_year_required_check
    CHECK (completion_status <> 'SELESAI' OR completed_year IS NOT NULL),
  CONSTRAINT employee_education_verified_pair_check
    CHECK ((verification_status = 'DIVERIFIKASI') = (verified_at IS NOT NULL)),
  CONSTRAINT employee_education_voided_pair_check
    CHECK ((voided_at IS NULL) = (voided_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS employee_education_employee_idx
  ON employee_education (employee_id, level) WHERE voided_at IS NULL;

-- EMP-008 -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_skills (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('KEAHLIAN', 'SERTIFIKAT')),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  category text NOT NULL CHECK (category IN (
    'PENGAJARAN', 'KEAGAMAAN', 'ADMINISTRASI', 'TEKNOLOGI', 'BAHASA', 'KESEHATAN_KESELAMATAN', 'LAINNYA'
  )),
  proficiency text NULL CHECK (proficiency IN ('DASAR', 'MENENGAH', 'MAHIR')),
  issuer text NULL,
  certificate_number text NULL,
  issued_on date NULL,
  expires_on date NULL,
  archive_reference text NULL,
  notes text NULL,
  verification_status text NOT NULL DEFAULT 'DILAPORKAN'
    CHECK (verification_status IN ('DILAPORKAN', 'DIVERIFIKASI')),
  verified_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  verified_at timestamptz NULL,
  voided_at timestamptz NULL,
  voided_reason text NULL,
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Sertifikat selalu menyebut penerbit dan tanggal terbitnya; keahlian tidak.
  CONSTRAINT employee_skills_certificate_fields_check
    CHECK (kind <> 'SERTIFIKAT' OR (issuer IS NOT NULL AND issued_on IS NOT NULL)),
  CONSTRAINT employee_skills_expiry_order_check
    CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  CONSTRAINT employee_skills_verified_pair_check
    CHECK ((verification_status = 'DIVERIFIKASI') = (verified_at IS NOT NULL)),
  CONSTRAINT employee_skills_voided_pair_check
    CHECK ((voided_at IS NULL) = (voided_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS employee_skills_employee_idx
  ON employee_skills (employee_id, kind) WHERE voided_at IS NULL;
-- Daftar "sertifikat akan berakhir" membaca kolom ini lintas pegawai.
CREATE INDEX IF NOT EXISTS employee_skills_expiry_idx
  ON employee_skills (expires_on) WHERE voided_at IS NULL AND expires_on IS NOT NULL;

-- EMP-009 -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_family_members (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  relation text NOT NULL CHECK (relation IN ('PASANGAN', 'ANAK', 'ORANG_TUA', 'SAUDARA', 'LAINNYA')),
  full_name text NOT NULL CHECK (length(trim(full_name)) > 0),
  birth_date date NULL,
  gender text NULL CHECK (gender IN ('L', 'P')),
  is_dependent boolean NOT NULL DEFAULT false,
  dependent_order integer NULL CHECK (dependent_order BETWEEN 1 AND 20),
  -- Spec §8: nomor identitas anggota keluarga belum dikumpulkan sampai ada
  -- kebijakan enkripsi kolom. Kolomnya ada agar keputusan owner tidak
  -- memerlukan migrasi lagi; aplikasi tidak menulisnya.
  identity_number text NULL,
  is_emergency_contact boolean NOT NULL DEFAULT false,
  emergency_phone text NULL,
  emergency_priority integer NULL CHECK (emergency_priority BETWEEN 1 AND 9),
  valid_from date NOT NULL,
  valid_to date NULL,
  notes text NULL,
  voided_at timestamptz NULL,
  voided_reason text NULL,
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_family_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT employee_family_dependent_birth_check
    CHECK (NOT is_dependent OR birth_date IS NOT NULL),
  CONSTRAINT employee_family_dependent_order_check
    CHECK (dependent_order IS NULL OR is_dependent),
  CONSTRAINT employee_family_emergency_check
    CHECK (NOT is_emergency_contact OR (emergency_phone IS NOT NULL AND emergency_priority IS NOT NULL)),
  CONSTRAINT employee_family_voided_pair_check
    CHECK ((voided_at IS NULL) = (voided_reason IS NULL)),
  -- Satu pasangan yang berlaku pada satu waktu (keputusan DRAFT spec §13).
  CONSTRAINT employee_family_single_spouse_excl
    EXCLUDE USING gist (
      employee_id WITH =,
      daterange(valid_from, COALESCE(valid_to + 1, 'infinity'::date), '[)') WITH &&
    ) WHERE (relation = 'PASANGAN' AND voided_at IS NULL),
  -- Urutan kontak darurat tidak boleh tabrakan pada periode yang sama.
  CONSTRAINT employee_family_emergency_priority_excl
    EXCLUDE USING gist (
      employee_id WITH =,
      emergency_priority WITH =,
      daterange(valid_from, COALESCE(valid_to + 1, 'infinity'::date), '[)') WITH &&
    ) WHERE (is_emergency_contact AND voided_at IS NULL)
);

CREATE INDEX IF NOT EXISTS employee_family_employee_idx
  ON employee_family_members (employee_id, relation) WHERE voided_at IS NULL;

-- EMP-003 alamat -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_addresses (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('DOMISILI', 'KTP')),
  address_line text NOT NULL CHECK (length(trim(address_line)) > 0),
  village text NULL,
  district text NULL,
  city text NOT NULL CHECK (length(trim(city)) > 0),
  province text NULL,
  postal_code text NULL CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{5}$'),
  valid_from date NOT NULL,
  valid_to date NULL,
  source text NOT NULL DEFAULT 'HC' CHECK (source IN ('IMPOR', 'HC', 'USULAN_PEGAWAI')),
  notes text NULL,
  voided_at timestamptz NULL,
  voided_reason text NULL,
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_addresses_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT employee_addresses_voided_pair_check
    CHECK ((voided_at IS NULL) = (voided_reason IS NULL)),
  -- Satu alamat per jenis yang berlaku pada satu waktu: pindah rumah menutup
  -- yang lama dan membuka yang baru.
  CONSTRAINT employee_addresses_single_current_excl
    EXCLUDE USING gist (
      employee_id WITH =,
      kind WITH =,
      daterange(valid_from, COALESCE(valid_to + 1, 'infinity'::date), '[)') WITH &&
    ) WHERE (voided_at IS NULL)
);

CREATE INDEX IF NOT EXISTS employee_addresses_employee_idx
  ON employee_addresses (employee_id, kind, valid_from DESC) WHERE voided_at IS NULL;

-- EMP-003 usulan perubahan ---------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_data_change_requests (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  submitted_by_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  target text NOT NULL CHECK (target IN ('ALAMAT', 'KONTAK', 'KELUARGA', 'PENDIDIKAN', 'KEAHLIAN')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'DIAJUKAN'
    CHECK (state IN ('DIAJUKAN', 'DITERIMA', 'DITOLAK', 'DIBATALKAN')),
  decided_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  decided_at timestamptz NULL,
  decision_note text NULL,
  applied_record_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_data_change_decided_pair_check
    CHECK ((state IN ('DIAJUKAN')) = (decided_at IS NULL)),
  -- Menolak wajib beralasan; menerima tidak harus.
  CONSTRAINT employee_data_change_reject_reason_check
    CHECK (state <> 'DITOLAK' OR (decision_note IS NOT NULL AND length(trim(decision_note)) >= 5))
);

CREATE INDEX IF NOT EXISTS employee_data_change_pending_idx
  ON employee_data_change_requests (created_at) WHERE state = 'DIAJUKAN';
CREATE INDEX IF NOT EXISTS employee_data_change_employee_idx
  ON employee_data_change_requests (employee_id, created_at DESC);

-- Audit ----------------------------------------------------------------------
-- Payload hanya memuat id, kode, tanggal, dan nama field yang berubah; tidak
-- pernah nama anggota keluarga, alamat, nomor telepon, atau nomor identitas
-- (spec §6).
CREATE TABLE IF NOT EXISTS employee_profile_audit_events (
  id uuid PRIMARY KEY,
  actor_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NULL,
  employee_id uuid NULL REFERENCES employees(id) ON DELETE RESTRICT,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_profile_audit_time_idx
  ON employee_profile_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS employee_profile_audit_employee_idx
  ON employee_profile_audit_events (employee_id, occurred_at DESC) WHERE employee_id IS NOT NULL;
