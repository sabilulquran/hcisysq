-- TRIP-001 Package 1: business travel requests, APR-001 approval snapshot, history.
-- Spec: docs/domain/business-travel.md §10.
--
-- No column holds money: advances, costs and reimbursement are post-MVP (AGENTS.md §5).
-- The assignment letter (surat tugas) is a row in the DOC-001 register, document_kind
-- 'ASSIGNMENT', number code 'ST', so it shares the counter lock and the never-recycle rule.
--
-- Down:
--   DROP TABLE IF EXISTS business_trip_events;
--   DROP TABLE IF EXISTS business_trip_approval_steps;
--   DROP TABLE IF EXISTS business_trip_requests;
--   -- Only when no ASSIGNMENT row exists (otherwise keep the wider check):
--   ALTER TABLE hr_issued_documents DROP CONSTRAINT hr_issued_documents_document_kind_check;
--   ALTER TABLE hr_issued_documents ADD CONSTRAINT hr_issued_documents_document_kind_check
--     CHECK (document_kind IN ('CERTIFICATE', 'DISCIPLINARY'));

ALTER TABLE hr_issued_documents DROP CONSTRAINT IF EXISTS hr_issued_documents_document_kind_check;
ALTER TABLE hr_issued_documents ADD CONSTRAINT hr_issued_documents_document_kind_check
  CHECK (document_kind IN ('CERTIFICATE', 'DISCIPLINARY', 'ASSIGNMENT'));

CREATE TABLE IF NOT EXISTS business_trip_requests (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  destination text NOT NULL CHECK (char_length(destination) BETWEEN 3 AND 200),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 10 AND 1000),
  start_on date NOT NULL,
  end_on date NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'ISSUED', 'COMPLETED')),
  idempotency_key uuid NOT NULL,
  -- APR-001: the resolved chain and the rollout context that explains it.
  approval_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  issued_document_id uuid NULL UNIQUE REFERENCES hr_issued_documents(id),
  cancelled_by_account_id uuid NULL REFERENCES accounts(id),
  cancel_reason text NULL,
  completion_report text NULL CHECK (completion_report IS NULL OR char_length(completion_report) BETWEEN 10 AND 2000),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  final_decided_at timestamptz NULL,
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, idempotency_key),
  CHECK (end_on >= start_on),
  -- D-03: at most 30 calendar days, inclusive.
  CHECK (end_on - start_on <= 29),
  CHECK ((status IN ('ISSUED', 'COMPLETED')) = (issued_document_id IS NOT NULL) OR status = 'CANCELLED')
);

CREATE INDEX IF NOT EXISTS business_trip_requests_employee_idx
  ON business_trip_requests (employee_id, start_on DESC);
CREATE INDEX IF NOT EXISTS business_trip_requests_status_idx
  ON business_trip_requests (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS business_trip_requests_range_idx
  ON business_trip_requests (start_on, end_on)
  WHERE status IN ('APPROVED', 'ISSUED', 'COMPLETED');

CREATE TABLE IF NOT EXISTS business_trip_approval_steps (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES business_trip_requests(id),
  step_order integer NOT NULL CHECK (step_order >= 1),
  approver_employee_id uuid NOT NULL REFERENCES employees(id),
  sources text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('waiting', 'pending', 'approved', 'rejected', 'cancelled')),
  acted_by_account_id uuid NULL REFERENCES accounts(id),
  acted_at timestamptz NULL,
  decision_note text NULL,
  UNIQUE (request_id, step_order)
);

-- APR-001-G: one active step per request, so two decisions cannot both advance it.
CREATE UNIQUE INDEX IF NOT EXISTS business_trip_approval_steps_one_pending_idx
  ON business_trip_approval_steps (request_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS business_trip_approval_steps_inbox_idx
  ON business_trip_approval_steps (approver_employee_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS business_trip_events (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES business_trip_requests(id),
  event_type text NOT NULL,
  actor_account_id uuid NULL REFERENCES accounts(id),
  note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_trip_events_request_idx
  ON business_trip_events (request_id, occurred_at ASC);
