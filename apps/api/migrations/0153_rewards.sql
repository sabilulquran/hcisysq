-- REWARD-001 Package 1: monthly employee awards from the Al-Qur'an tilawah scoreboard.
-- Spec: docs/domain/rewards.md §8.
--
-- Additive only: new tables; no existing table or row changes. Scores are copied from the
-- monthly snapshot as evidence (R-13) and never recomputed here. HCIS stores no tilawah record.
--
-- Down (only before the first published round; afterwards export the award register first):
--   DROP TABLE IF EXISTS reward_audit_events;
--   DROP TABLE IF EXISTS reward_outbox;
--   DROP TABLE IF EXISTS reward_awards;
--   DROP TABLE IF EXISTS reward_candidates;
--   DROP TABLE IF EXISTS reward_snapshot_rows;
--   DROP TABLE IF EXISTS reward_rounds;
--   DROP TABLE IF EXISTS reward_snapshot_imports;
--   DROP TABLE IF EXISTS reward_fetch_attempts;
--   DROP TABLE IF EXISTS reward_programs;
--   DELETE FROM schema_migrations WHERE name = '0153_rewards.sql';

CREATE TABLE IF NOT EXISTS reward_programs (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  source text NOT NULL CHECK (char_length(source) BETWEEN 3 AND 120),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO reward_programs (id, code, name, source, active)
VALUES ('6f2d0c1e-7b1a-4c55-9a0e-2f4b9d3c1a01', 'TILAWAH', 'Penghargaan Tilawah', 'al-quran.monthly-scoreboard', true)
ON CONFLICT (code) DO NOTHING;

-- §4.1: the automatic fetch for one month, retried hourly for 3 days, then left to "Susun ulang".
CREATE TABLE IF NOT EXISTS reward_fetch_attempts (
  program_id uuid NOT NULL REFERENCES reward_programs(id),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  first_failure_at timestamptz NULL,
  last_attempt_at timestamptz NULL,
  -- Short code only (TOKEN_FAILED, HTTP_ERROR, UNREACHABLE, INVALID_RESPONSE, NOT_FINAL).
  last_outcome text NULL CHECK (last_outcome IS NULL OR char_length(last_outcome) <= 40),
  exhausted_at timestamptz NULL,
  PRIMARY KEY (program_id, month)
);

-- R-14 DRAFT: the manual CSV fallback. The file itself is not kept; its hash and row count are.
CREATE TABLE IF NOT EXISTS reward_snapshot_imports (
  id uuid PRIMARY KEY,
  program_id uuid NOT NULL REFERENCES reward_programs(id),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 20000),
  note text NOT NULL CHECK (char_length(note) BETWEEN 5 AND 500),
  imported_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reward_rounds (
  id uuid PRIMARY KEY,
  program_id uuid NOT NULL REFERENCES reward_programs(id),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status text NOT NULL CHECK (status IN ('PENDING_DECISION', 'PUBLISHED', 'CANCELLED')),
  -- QURAN_API: §11.3 of QURAN-001. MANUAL_IMPORT: the R-14 DRAFT fallback, always labelled.
  source_kind text NOT NULL CHECK (source_kind IN ('QURAN_API', 'MANUAL_IMPORT')),
  import_id uuid NULL REFERENCES reward_snapshot_imports(id),
  snapshot_version text NOT NULL CHECK (char_length(snapshot_version) BETWEEN 1 AND 200),
  snapshot_finalized_at timestamptz NULL,
  directory_version text NULL CHECK (directory_version IS NULL OR char_length(directory_version) <= 200),
  directory_as_of timestamptz NULL,
  directory_stale boolean NOT NULL DEFAULT false,
  fetched_at timestamptz NOT NULL,
  -- NULL: created by the scheduler (the system actor).
  created_by_account_id uuid NULL REFERENCES accounts(id),
  cancel_reason text NULL CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 5 AND 500),
  cancelled_by_account_id uuid NULL REFERENCES accounts(id),
  cancelled_at timestamptz NULL,
  published_by_account_id uuid NULL REFERENCES accounts(id),
  published_at timestamptz NULL,
  announcement_id uuid NULL REFERENCES announcements(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_kind = 'MANUAL_IMPORT') = (import_id IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL AND published_by_account_id IS NOT NULL))
);

-- §4.1 precondition: one live round per program and month; a cancelled one can be rebuilt.
CREATE UNIQUE INDEX IF NOT EXISTS reward_rounds_one_live_idx
  ON reward_rounds (program_id, month) WHERE status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS reward_rounds_month_idx ON reward_rounds (month DESC, created_at DESC);

-- R-13: the snapshot as received, so "Ambil peringkat berikutnya" reads the same snapshot (R-08)
-- without asking the source again. Ranks and numbers only; no name, NIP or tilawah record.
CREATE TABLE IF NOT EXISTS reward_snapshot_rows (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES reward_rounds(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('FOUNDATION', 'UNIT')),
  -- '' for the foundation scope, hcis:org-node:<stable_key> for a unit.
  unit_ref text NOT NULL DEFAULT '' CHECK ((scope = 'FOUNDATION') = (unit_ref = '')),
  person_ref text NOT NULL CHECK (person_ref ~ '^hcis:employee:[0-9a-f-]{36}$'),
  employee_id uuid NULL REFERENCES employees(id),
  rank integer NOT NULL CHECK (rank >= 1),
  pages numeric(7,1) NOT NULL CHECK (pages >= 0),
  active_days integer NOT NULL CHECK (active_days BETWEEN 0 AND 31),
  khatam integer NOT NULL CHECK (khatam BETWEEN 0 AND 1000),
  labels text[] NOT NULL DEFAULT '{}' CHECK (labels <@ ARRAY['AUTO', 'SELF_REPORTED']::text[]),
  UNIQUE (round_id, scope, unit_ref, person_ref)
);

CREATE INDEX IF NOT EXISTS reward_snapshot_rows_rank_idx ON reward_snapshot_rows (round_id, scope, unit_ref, rank);

CREATE TABLE IF NOT EXISTS reward_candidates (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES reward_rounds(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('FOUNDATION', 'UNIT')),
  unit_ref text NOT NULL DEFAULT '' CHECK ((category = 'FOUNDATION') = (unit_ref = '')),
  unit_name text NULL CHECK (unit_name IS NULL OR char_length(unit_name) <= 200),
  -- FOUNDATION: seat 1..3 (the rank it was chosen for). UNIT: seat 1.
  seat integer NOT NULL CHECK (seat BETWEEN 1 AND 3),
  rank integer NOT NULL CHECK (rank >= 1),
  pages numeric(7,1) NOT NULL CHECK (pages >= 0),
  active_days integer NOT NULL CHECK (active_days BETWEEN 0 AND 31),
  khatam integer NOT NULL CHECK (khatam BETWEEN 0 AND 1000),
  labels text[] NOT NULL DEFAULT '{}' CHECK (labels <@ ARRAY['AUTO', 'SELF_REPORTED']::text[]),
  person_ref text NOT NULL CHECK (person_ref ~ '^hcis:employee:[0-9a-f-]{36}$'),
  employee_id uuid NULL REFERENCES employees(id),
  status text NOT NULL CHECK (status IN ('CANDIDATE', 'AWARDED', 'DECLINED', 'UNRESOLVED')),
  unresolved_reason text NULL CHECK (unresolved_reason IS NULL OR unresolved_reason IN ('UNKNOWN_PERSON', 'INACTIVE_EMPLOYEE')),
  decline_reason text NULL CHECK (decline_reason IS NULL OR char_length(decline_reason) BETWEEN 5 AND 500),
  decided_by_account_id uuid NULL REFERENCES accounts(id),
  decided_at timestamptz NULL,
  -- R-08: a replacement names the candidate whose seat it fills; one replacement step per candidate.
  replaces_candidate_id uuid NULL UNIQUE REFERENCES reward_candidates(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- R-15 DRAFT: one candidacy per person per round.
  UNIQUE (round_id, person_ref),
  CHECK ((status = 'UNRESOLVED') = (unresolved_reason IS NOT NULL)),
  CHECK ((status = 'DECLINED') = (decline_reason IS NOT NULL)),
  CHECK (status NOT IN ('AWARDED', 'DECLINED') OR (decided_by_account_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status = 'UNRESOLVED' OR employee_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS reward_candidates_round_idx ON reward_candidates (round_id, category, unit_ref, seat, rank);

CREATE TABLE IF NOT EXISTS reward_awards (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES reward_rounds(id),
  candidate_id uuid NOT NULL UNIQUE REFERENCES reward_candidates(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  category text NOT NULL CHECK (category IN ('FOUNDATION', 'UNIT')),
  -- The certificate's wording, frozen at publication ("Terbaik Tilawah Yayasan — Peringkat 1").
  category_label text NOT NULL CHECK (char_length(category_label) BETWEEN 5 AND 250),
  recipient_name text NOT NULL CHECK (char_length(recipient_name) BETWEEN 1 AND 200),
  -- §4.3: at least 128 random bits, Crockford base32 (26 characters).
  verification_code text NOT NULL UNIQUE CHECK (verification_code ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  revoke_reason text NULL CHECK (revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 5 AND 500),
  revoked_by_account_id uuid NULL REFERENCES accounts(id),
  revoked_at timestamptz NULL,
  -- Written by the CERTIFICATE effect of the outbox; NULL until then.
  certificate_pdf bytea NULL CHECK (certificate_pdf IS NULL OR octet_length(certificate_pdf) BETWEEN 100 AND 200000),
  certificate_generated_at timestamptz NULL,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)),
  CHECK ((certificate_pdf IS NULL) = (certificate_generated_at IS NULL))
);

CREATE INDEX IF NOT EXISTS reward_awards_employee_idx ON reward_awards (employee_id, month DESC);
CREATE INDEX IF NOT EXISTS reward_awards_month_idx ON reward_awards (month DESC, category, id) WHERE status = 'ACTIVE';

-- §4.3: side effects of publication, retried; a failure never undoes the publication.
CREATE TABLE IF NOT EXISTS reward_outbox (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES reward_rounds(id),
  award_id uuid NULL REFERENCES reward_awards(id),
  effect text NOT NULL CHECK (effect IN ('NOTIFICATION', 'ANNOUNCEMENT', 'CERTIFICATE')),
  status text NOT NULL CHECK (status IN ('PENDING', 'DONE', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text NULL CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((effect = 'ANNOUNCEMENT') = (award_id IS NULL)),
  CHECK ((status = 'DONE') = (done_at IS NOT NULL)),
  UNIQUE (round_id, effect, award_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS reward_outbox_one_announcement_idx
  ON reward_outbox (round_id) WHERE effect = 'ANNOUNCEMENT';
CREATE INDEX IF NOT EXISTS reward_outbox_due_idx ON reward_outbox (next_attempt_at) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS reward_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type ~ '^reward\.[a-z_.]+$'),
  round_id uuid NULL REFERENCES reward_rounds(id),
  candidate_id uuid NULL REFERENCES reward_candidates(id),
  award_id uuid NULL REFERENCES reward_awards(id),
  import_id uuid NULL REFERENCES reward_snapshot_imports(id),
  actor_account_id uuid NULL REFERENCES accounts(id),
  reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 500),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS reward_audit_events_round_idx ON reward_audit_events (round_id, occurred_at);
