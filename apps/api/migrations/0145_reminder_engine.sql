-- NOTIF-003 Package 1: scheduled reminder engine. Spec: docs/domain/reminders.md §7.
--
-- No permission key and no role change. Idempotency lives in the constraints (D-03):
-- one run per rule per Jakarta day, one occurrence per rule/occurrence/recipient, one WhatsApp
-- delivery per occurrence with a fixed idempotency key. In-app content stays in
-- in_app_notifications (NOTIF-004); message_text holds only the WhatsApp text, which carries no
-- other employee's name, no amount and no document content (D-07).
--
-- in_app_notifications.href may now also point into the admin shell (/admin/...), because HC
-- reminders link to admin worklists. The destination re-checks authorization as before (NOTIF-004).
--
-- Down (safe at any time; in-app notifications already written stay where they are):
--   UPDATE in_app_notifications SET href = NULL WHERE href LIKE '/admin/%';
--   ALTER TABLE in_app_notifications DROP CONSTRAINT in_app_notifications_href_check;
--   ALTER TABLE in_app_notifications ADD CONSTRAINT in_app_notifications_href_check
--     CHECK (href IS NULL OR (href LIKE '/app/%' AND char_length(href) <= 500));
--   DROP TABLE IF EXISTS reminder_audit_events;
--   DROP TABLE IF EXISTS reminder_preferences;
--   DROP TABLE IF EXISTS reminder_deliveries;
--   DROP TABLE IF EXISTS reminder_occurrences;
--   DROP TABLE IF EXISTS reminder_rule_runs;

CREATE TABLE IF NOT EXISTS reminder_rule_runs (
  rule_key text NOT NULL CHECK (rule_key ~ '^[a-z_]+\.[a-z_]+$'),
  run_date date NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NULL,
  generated integer NOT NULL DEFAULT 0 CHECK (generated >= 0),
  -- The error's class name only, never a message that could quote row values.
  error_code text NULL CHECK (error_code IS NULL OR char_length(error_code) <= 100),
  PRIMARY KEY (rule_key, run_date)
);

CREATE TABLE IF NOT EXISTS reminder_occurrences (
  id uuid PRIMARY KEY,
  rule_key text NOT NULL,
  occurrence_key text NOT NULL CHECK (char_length(occurrence_key) BETWEEN 1 AND 200),
  recipient_account_id uuid NOT NULL REFERENCES accounts(id),
  recipient_employee_id uuid NULL REFERENCES employees(id),
  title text NOT NULL,
  href text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_key, occurrence_key, recipient_account_id)
);

CREATE INDEX IF NOT EXISTS reminder_occurrences_recipient_idx
  ON reminder_occurrences (recipient_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reminder_deliveries (
  id uuid PRIMARY KEY,
  occurrence_id uuid NOT NULL UNIQUE REFERENCES reminder_occurrences(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  message_text text NOT NULL CHECK (char_length(message_text) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'HANDED_OVER', 'DRY_RUN', 'SKIPPED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  -- D-12: 21:00 WIB on the day the reminder was made.
  expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  kirim_message_id text NULL,
  error_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reminder_deliveries_due_idx
  ON reminder_deliveries (next_attempt_at) WHERE status = 'QUEUED';

CREATE TABLE IF NOT EXISTS reminder_preferences (
  account_id uuid NOT NULL REFERENCES accounts(id),
  rule_key text NOT NULL,
  whatsapp_enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, rule_key)
);

CREATE TABLE IF NOT EXISTS reminder_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  account_id uuid NULL REFERENCES accounts(id),
  rule_key text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reminder_audit_events_occurred_idx ON reminder_audit_events (occurred_at DESC);

ALTER TABLE in_app_notifications DROP CONSTRAINT IF EXISTS in_app_notifications_href_check;
ALTER TABLE in_app_notifications ADD CONSTRAINT in_app_notifications_href_check
  CHECK (href IS NULL OR ((href LIKE '/app/%' OR href LIKE '/admin/%') AND char_length(href) <= 500));
