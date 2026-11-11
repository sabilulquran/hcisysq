-- DOC-003 Package 1: organization-wide outgoing letter numbering register (buku nomor surat keluar).
-- Spec: docs/domain/outgoing-letter-register.md §7.
--
-- No permission key and no role change: the routes reuse documents.read / documents.manage
-- (D-11), so this migration opens no permission window (mi8vps-hcis-release.md §4.5).
--
-- Allocation (D-05): the API increments letter_number_counters with ON CONFLICT DO UPDATE and
-- inserts the letter_numbers row in the same transaction. The counter row lock makes a second
-- allocation for the same issuer, type and period wait, and a rollback hands the number back,
-- so the book has no gaps and no duplicates. The UNIQUE constraints below are the backstop.
-- Numbers are never deleted or reused: a number taken by mistake moves to VOIDED (D-08).
--
-- Down (only before any number has been taken in production; afterwards the book is a record):
--   DROP TABLE IF EXISTS letter_audit_events;
--   DROP TABLE IF EXISTS letter_numbers;
--   DROP TABLE IF EXISTS letter_number_counters;
--   DROP TABLE IF EXISTS letter_number_grants;
--   DROP TABLE IF EXISTS letter_issuers;
--   DROP TABLE IF EXISTS letter_types;

CREATE TABLE IF NOT EXISTS letter_types (
  -- D-15: the code is part of every number, so it never changes.
  code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9-]{0,9}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 120),
  -- D-04: YEARLY resets on 1 January, MONTHLY on the 1st (Asia/Jakarta).
  reset_period text NOT NULL DEFAULT 'YEARLY' CHECK (reset_period IN ('YEARLY', 'MONTHLY')),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- D-16 DRAFT starting catalog; HC changes it on screen.
INSERT INTO letter_types (code, label, sort_order) VALUES
  ('UND', 'Undangan', 1),
  ('PEM', 'Pemberitahuan', 2),
  ('PMH', 'Permohonan', 3),
  ('EDR', 'Edaran', 4),
  ('SK', 'Surat Keputusan', 5),
  ('KET', 'Keterangan', 6),
  ('REK', 'Rekomendasi', 7),
  ('LAIN', 'Lainnya', 99)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS letter_issuers (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 200),
  kind text NOT NULL CHECK (kind IN ('ORGANIZATION', 'UNIT', 'COMMITTEE', 'OTHER')),
  organizational_unit_id uuid NULL REFERENCES organizational_units(id),
  -- D-14: a committee issuer numbers letters only while its committee is ACTIVE.
  committee_id uuid NULL REFERENCES committees(id),
  active boolean NOT NULL DEFAULT true,
  created_by_account_id uuid NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'UNIT') = (organizational_unit_id IS NOT NULL)),
  CHECK ((kind = 'COMMITTEE') = (committee_id IS NOT NULL))
);

INSERT INTO letter_issuers (id, code, name, kind)
VALUES ('00000000-0000-4000-8000-0000000d0003', 'YSQ', 'Yayasan Sabilul Qur''an', 'ORGANIZATION')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS letter_number_grants (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  issuer_id uuid NOT NULL REFERENCES letter_issuers(id),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 500),
  granted_by_account_id uuid NOT NULL REFERENCES accounts(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  revoked_by_account_id uuid NULL REFERENCES accounts(id),
  revoke_reason text NULL CHECK (revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 5 AND 500),
  CHECK ((revoked_at IS NULL) = (revoked_by_account_id IS NULL))
);

-- One active grant per employee per issuer.
CREATE UNIQUE INDEX IF NOT EXISTS letter_number_grants_active_unique
  ON letter_number_grants (employee_id, issuer_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS letter_number_grants_issuer_idx
  ON letter_number_grants (issuer_id, granted_at DESC);

CREATE TABLE IF NOT EXISTS letter_number_counters (
  issuer_id uuid NOT NULL REFERENCES letter_issuers(id),
  type_code text NOT NULL REFERENCES letter_types(code),
  -- 'YYYY' for YEARLY types, 'YYYY-MM' for MONTHLY types.
  period_key text NOT NULL CHECK (period_key ~ '^\d{4}(-\d{2})?$'),
  last_sequence integer NOT NULL CHECK (last_sequence >= 0),
  PRIMARY KEY (issuer_id, type_code, period_key)
);

CREATE TABLE IF NOT EXISTS letter_numbers (
  id uuid PRIMARY KEY,
  issuer_id uuid NOT NULL REFERENCES letter_issuers(id),
  type_code text NOT NULL REFERENCES letter_types(code),
  period_key text NOT NULL CHECK (period_key ~ '^\d{4}(-\d{2})?$'),
  sequence integer NOT NULL CHECK (sequence >= 1),
  letter_number text NOT NULL UNIQUE,
  -- D-06: the Jakarta date the number was taken.
  letter_date date NOT NULL,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 300),
  recipient text NOT NULL CHECK (char_length(recipient) BETWEEN 2 AND 300),
  notes text NULL CHECK (notes IS NULL OR char_length(notes) <= 1000),
  status text NOT NULL DEFAULT 'ALLOCATED' CHECK (status IN ('ALLOCATED', 'VOIDED')),
  requested_by_employee_id uuid NOT NULL REFERENCES employees(id),
  requested_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  voided_at timestamptz NULL,
  voided_by_account_id uuid NULL REFERENCES accounts(id),
  void_reason text NULL CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 10 AND 500),
  UNIQUE (issuer_id, type_code, period_key, sequence),
  CHECK ((status = 'VOIDED') = (voided_at IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (voided_by_account_id IS NULL)),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS letter_numbers_date_idx ON letter_numbers (letter_date DESC, letter_number DESC);
CREATE INDEX IF NOT EXISTS letter_numbers_issuer_idx ON letter_numbers (issuer_id, letter_date DESC);
CREATE INDEX IF NOT EXISTS letter_numbers_requester_idx ON letter_numbers (requested_by_employee_id, letter_date DESC);

CREATE TABLE IF NOT EXISTS letter_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  letter_number_id uuid NULL REFERENCES letter_numbers(id),
  issuer_id uuid NULL REFERENCES letter_issuers(id),
  actor_account_id uuid NULL REFERENCES accounts(id),
  reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS letter_audit_events_occurred_idx ON letter_audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS letter_audit_events_letter_idx ON letter_audit_events (letter_number_id, occurred_at DESC);
