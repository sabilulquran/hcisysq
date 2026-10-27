-- NOTIF-002 Package 1: organization announcements.
-- Spec: docs/domain/announcements-and-reminders.md §6.
--
-- An announcement is its own object, not a bulk notification: NOTIF-004 rows only point at
-- it (N-01). The recipient list is frozen at publication (N-03), so reach and read counts
-- stay stable when the organization changes afterwards. Archival and the display window are
-- derived from dates on read, never from a scheduled job.
--
-- Down:
--   DROP TABLE IF EXISTS announcement_audit_events;
--   DROP TABLE IF EXISTS announcement_recipients;
--   DROP TABLE IF EXISTS announcement_audiences;
--   DROP TABLE IF EXISTS announcements;

CREATE TABLE IF NOT EXISTS announcements (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  -- N-09: plain text with paragraphs. Never HTML, never a script.
  body text NOT NULL,
  level text NOT NULL DEFAULT 'NORMAL' CHECK (level IN ('NORMAL', 'PENTING')),
  status text NOT NULL CHECK (status IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED', 'SUPERSEDED')),
  -- N-07: when a SCHEDULED announcement becomes visible. Evaluated on read.
  publish_at timestamptz NULL,
  -- N-08: optional end of the display window; afterwards it reads as archived.
  display_until date NULL,
  published_at timestamptz NULL,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  published_by_account_id uuid NULL REFERENCES accounts(id),
  -- N-06: a correction is a new announcement that supersedes this one.
  supersedes_id uuid NULL REFERENCES announcements(id),
  archived_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'SCHEDULED' OR publish_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS announcements_status_idx ON announcements (status, published_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS announcements_supersedes_idx
  ON announcements (supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS announcement_audiences (
  id uuid PRIMARY KEY,
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  -- N-02: Package 1 targets everyone or named organizational units.
  audience_kind text NOT NULL CHECK (audience_kind IN ('ALL_EMPLOYEES', 'UNIT')),
  organizational_unit_id uuid NULL REFERENCES organizational_units(id),
  CHECK ((audience_kind = 'UNIT') = (organizational_unit_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS announcement_audiences_announcement_idx
  ON announcement_audiences (announcement_id);

CREATE TABLE IF NOT EXISTS announcement_recipients (
  id uuid PRIMARY KEY,
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id),
  read_at timestamptz NULL,
  -- N-05: only a PENTING announcement asks for this.
  acknowledged_at timestamptz NULL,
  -- NOTIF-002-B: re-publishing cannot duplicate a recipient.
  UNIQUE (announcement_id, employee_id)
);

CREATE INDEX IF NOT EXISTS announcement_recipients_employee_idx
  ON announcement_recipients (employee_id, announcement_id);

CREATE TABLE IF NOT EXISTS announcement_audit_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  announcement_id uuid NULL REFERENCES announcements(id) ON DELETE CASCADE,
  actor_account_id uuid NULL REFERENCES accounts(id),
  reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS announcement_audit_events_occurred_idx
  ON announcement_audit_events (occurred_at DESC);
