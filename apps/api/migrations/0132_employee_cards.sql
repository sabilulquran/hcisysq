-- EMP-012 Package 1: employee ID cards.
-- Spec: docs/domain/employee-id-card.md §8.
--
-- Adds tables and a sequence only; no existing data changes.
--
-- Photos and the signature image use the encrypted-in-database pattern of training certificates
-- (TRAIN-001 D-10): AES-GCM with AUTH_ENCRYPTION_KEY, base64 ciphertext/iv/auth_tag columns.
--
-- Card data is frozen at issue (D-13) so the printed card, the digital card and the public check
-- page always agree. The public check page reads a card by its random verify_code (D-07).
--
-- Down:
--   DROP TABLE IF EXISTS employee_card_audit_events, employee_cards, employee_card_photos,
--     employee_card_settings;
--   DROP SEQUENCE IF EXISTS employee_card_number_seq;
--   DELETE FROM schema_migrations WHERE name = '0132_employee_cards.sql';

CREATE TABLE IF NOT EXISTS employee_card_photos (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  uploaded_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  replaced_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_card_photos_one_current_idx
  ON employee_card_photos (employee_id) WHERE replaced_at IS NULL;

CREATE INDEX IF NOT EXISTS employee_card_photos_employee_idx
  ON employee_card_photos (employee_id, created_at DESC);

CREATE SEQUENCE IF NOT EXISTS employee_card_number_seq START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE IF NOT EXISTS employee_cards (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  card_number text NOT NULL UNIQUE CHECK (card_number ~ '^KP-[0-9]{4}-[0-9]{4,}$'),
  edition integer NOT NULL CHECK (edition >= 1),
  verify_code text NOT NULL UNIQUE CHECK (verify_code ~ '^[0-9A-HJKMNP-TV-Z]{10}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REPLACED', 'REPORTED_LOST', 'REVOKED')),
  issue_reason text NOT NULL CHECK (issue_reason IN ('NEW', 'LOST', 'DAMAGED', 'DATA_CHANGED', 'EXPIRED')),
  issued_at timestamptz NOT NULL,
  valid_until date NOT NULL,
  photo_id uuid NOT NULL REFERENCES employee_card_photos(id),
  full_name text NOT NULL CHECK (char_length(full_name) BETWEEN 1 AND 200),
  employee_number text NOT NULL CHECK (char_length(employee_number) BETWEEN 1 AND 60),
  position_title text NULL CHECK (position_title IS NULL OR char_length(position_title) BETWEEN 1 AND 200),
  unit_name text NULL CHECK (unit_name IS NULL OR char_length(unit_name) BETWEEN 1 AND 200),
  signer_name text NOT NULL CHECK (char_length(signer_name) BETWEEN 1 AND 120),
  signer_title text NOT NULL CHECK (char_length(signer_title) BETWEEN 1 AND 120),
  issued_by_account_id uuid NOT NULL REFERENCES accounts(id),
  print_count integer NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  last_printed_at timestamptz NULL,
  ended_at timestamptz NULL,
  end_reason text NULL CHECK (end_reason IS NULL OR char_length(end_reason) BETWEEN 1 AND 300),
  ended_by_account_id uuid NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_cards_edition_unique UNIQUE (employee_id, edition),
  CONSTRAINT employee_cards_ended_check CHECK (
    (status = 'ACTIVE' AND ended_at IS NULL)
    OR (status <> 'ACTIVE' AND ended_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_cards_one_active_idx
  ON employee_cards (employee_id) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS employee_cards_employee_idx
  ON employee_cards (employee_id, edition DESC);

CREATE TABLE IF NOT EXISTS employee_card_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  signer_title text NOT NULL DEFAULT 'Ketua Yayasan' CHECK (char_length(signer_title) BETWEEN 1 AND 120),
  signer_name text NULL CHECK (signer_name IS NULL OR char_length(signer_name) BETWEEN 1 AND 120),
  validity_months integer NOT NULL DEFAULT 24 CHECK (validity_months BETWEEN 12 AND 60),
  signature_content_type text NULL CHECK (signature_content_type IS NULL OR signature_content_type = 'image/png'),
  signature_byte_size integer NULL CHECK (signature_byte_size IS NULL OR (signature_byte_size > 0 AND signature_byte_size <= 524288)),
  signature_ciphertext text NULL,
  signature_iv text NULL,
  signature_auth_tag text NULL,
  updated_by_account_id uuid NULL REFERENCES accounts(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_card_settings_signature_check CHECK (
    (signature_ciphertext IS NULL AND signature_iv IS NULL AND signature_auth_tag IS NULL
      AND signature_content_type IS NULL AND signature_byte_size IS NULL)
    OR (signature_ciphertext IS NOT NULL AND signature_iv IS NOT NULL AND signature_auth_tag IS NOT NULL
      AND signature_content_type IS NOT NULL AND signature_byte_size IS NOT NULL)
  )
);

INSERT INTO employee_card_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS employee_card_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN (
    'employee_card.photo.uploaded',
    'employee_card.issued',
    'employee_card.replaced',
    'employee_card.reported_lost',
    'employee_card.revoked',
    'employee_card.printed',
    'employee_card.settings.updated',
    'employee_card.signature.uploaded'
  )),
  employee_id uuid NULL REFERENCES employees(id),
  card_id uuid NULL,
  actor_account_id uuid NULL REFERENCES accounts(id),
  reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS employee_card_audit_events_occurred_idx
  ON employee_card_audit_events (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS employee_card_audit_events_employee_idx
  ON employee_card_audit_events (employee_id, occurred_at DESC);
