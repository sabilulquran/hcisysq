-- LEAVE-009: critical periods (masa kritis) that add a Human Capital review step to leave.
-- Spec: docs/domain/leave-critical-periods.md §7.
--
-- Additive only: two new tables, no change to existing leave tables or permissions.
-- Managing periods reuses leave.configuration.manage; deciding a review reuses
-- leave.validate + leave.hc.approve (D-07), so no grant is needed here.
--
-- Down (release rollback leaves these tables in place; older code never reads them):
--   -- First decide or record every review still pending; those requests would stay
--   -- in_review with no active step under older code.
--   DROP TABLE IF EXISTS leave_request_critical_reviews;
--   DROP TABLE IF EXISTS leave_critical_periods;

CREATE TABLE IF NOT EXISTS leave_critical_periods (
  id uuid PRIMARY KEY,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 500),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  -- NULL means the whole foundation (D-04).
  organizational_unit_id uuid NULL REFERENCES organizational_units(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  updated_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on),
  -- D-09: at most 120 calendar days, inclusive.
  CHECK (ends_on - starts_on <= 119)
);

CREATE INDEX IF NOT EXISTS leave_critical_periods_active_range_idx
  ON leave_critical_periods (starts_on, ends_on)
  WHERE is_active;
CREATE INDEX IF NOT EXISTS leave_critical_periods_list_idx
  ON leave_critical_periods (starts_on DESC, id);

-- One review per leave request; the matched periods are copied at submission (D-06), so
-- later edits to leave_critical_periods never change an in-flight request.
CREATE TABLE IF NOT EXISTS leave_request_critical_reviews (
  id uuid PRIMARY KEY,
  leave_request_id uuid NOT NULL UNIQUE REFERENCES leave_requests(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('waiting', 'pending', 'approved', 'rejected')),
  period_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(period_snapshot) = 'array' AND jsonb_array_length(period_snapshot) > 0
  ),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 1000),
  acted_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  acted_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('approved', 'rejected')) = (acted_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS leave_request_critical_reviews_queue_idx
  ON leave_request_critical_reviews (status, created_at ASC)
  WHERE status = 'pending';
