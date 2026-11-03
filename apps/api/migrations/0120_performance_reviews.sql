-- PERF-001 Package 1: performance review cycles, one review per employee per cycle, history.
-- Spec: docs/domain/performance-review.md §12.
--
-- No column holds a percentage or money: the tunjangan kinerja link to PAY-003 is a later package
-- (spec §11). Indicator scores live on the review row only, never in the event history.
--
-- Down:
--   DROP TABLE IF EXISTS performance_events;
--   DROP TABLE IF EXISTS performance_reviews;
--   DROP TABLE IF EXISTS performance_cycles;

CREATE TABLE IF NOT EXISTS performance_cycles (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 120),
  kind text NOT NULL CHECK (kind IN ('MONTHLY', 'ANNUAL')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  self_due_on date NOT NULL,
  review_due_on date NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'OPEN', 'CLOSED', 'CANCELLED')),
  -- D-05/D-06: indicators, weights and predicate boundaries; frozen once the cycle is OPEN.
  rubric jsonb NOT NULL,
  created_by_account_id uuid NULL REFERENCES accounts(id),
  opened_at timestamptz NULL,
  closed_at timestamptz NULL,
  cancel_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (self_due_on >= period_start),
  CHECK (review_due_on >= self_due_on)
);

-- D-02: one cycle per kind and period unless it was cancelled.
CREATE UNIQUE INDEX IF NOT EXISTS performance_cycles_period_idx
  ON performance_cycles (kind, period_start) WHERE status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS performance_cycles_list_idx
  ON performance_cycles (period_start DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS performance_reviews (
  id uuid PRIMARY KEY,
  cycle_id uuid NOT NULL REFERENCES performance_cycles(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  status text NOT NULL CHECK (status IN (
    'SELF_ASSESSMENT', 'MANAGER_REVIEW', 'HC_VALIDATION', 'FINALIZED', 'UNRATED', 'REMOVED'
  )),
  -- D-01: the rater resolved from the structure (or assigned by HC) and how.
  rater_employee_id uuid NULL REFERENCES employees(id),
  rater_source text NULL CHECK (rater_source IN ('DIRECT_MANAGER', 'GOVERNANCE_APPROVER', 'HC_ASSIGNED')),
  rater_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  self_scores jsonb NULL,
  self_note text NULL CHECK (self_note IS NULL OR char_length(self_note) <= 2000),
  self_submitted_at timestamptz NULL,
  rater_scores jsonb NULL,
  strengths text NULL CHECK (strengths IS NULL OR char_length(strengths) <= 2000),
  improvements text NULL CHECK (improvements IS NULL OR char_length(improvements) <= 2000),
  rater_note text NULL CHECK (rater_note IS NULL OR char_length(rater_note) <= 2000),
  rated_by_account_id uuid NULL REFERENCES accounts(id),
  rated_at timestamptz NULL,
  final_score numeric(3, 2) NULL CHECK (final_score IS NULL OR final_score BETWEEN 1 AND 4),
  predicate_code text NULL,
  predicate_label text NULL,
  -- D-16: compared with the employee's previous final review of the same kind, kept as legacy did.
  trend text NULL CHECK (trend IN ('FIRST', 'IMPROVING', 'STABLE', 'DECLINING')),
  finalized_by_account_id uuid NULL REFERENCES accounts(id),
  finalized_at timestamptz NULL,
  acknowledged_at timestamptz NULL,
  acknowledgement_comment text NULL
    CHECK (acknowledgement_comment IS NULL OR char_length(acknowledgement_comment) <= 1000),
  removed_reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, employee_id),
  CHECK (rater_employee_id IS DISTINCT FROM employee_id),
  -- A result exists exactly while it awaits validation or is final.
  CHECK ((status IN ('HC_VALIDATION', 'FINALIZED')) = (final_score IS NOT NULL AND predicate_code IS NOT NULL)
         OR status = 'REMOVED'),
  CHECK (status <> 'FINALIZED' OR (finalized_at IS NOT NULL AND trend IS NOT NULL)),
  CHECK (acknowledged_at IS NULL OR status = 'FINALIZED')
);

CREATE INDEX IF NOT EXISTS performance_reviews_cycle_idx
  ON performance_reviews (cycle_id, status);
CREATE INDEX IF NOT EXISTS performance_reviews_employee_idx
  ON performance_reviews (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS performance_reviews_rater_idx
  ON performance_reviews (rater_employee_id, status) WHERE rater_employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS performance_events (
  id uuid PRIMARY KEY,
  cycle_id uuid NOT NULL REFERENCES performance_cycles(id),
  review_id uuid NULL REFERENCES performance_reviews(id),
  event_type text NOT NULL,
  actor_account_id uuid NULL REFERENCES accounts(id),
  note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS performance_events_review_idx
  ON performance_events (review_id, occurred_at ASC) WHERE review_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS performance_events_cycle_idx
  ON performance_events (cycle_id, occurred_at ASC);
