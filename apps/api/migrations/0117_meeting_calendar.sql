-- CAL-001 Package 1: meeting invitations that block the participants' time, responses,
-- history/audit, the first NOTIF-003 reminder rule and the WhatsApp delivery queue.
-- Spec: docs/domain/meeting-calendar.md §6.1 and §10.
--
-- No permission is added and no existing role, table or row is touched: access is ownership
-- (organizer or participant row), and every employee may invite (K-01).
--
-- Down (no other data is affected; the five tables are only read by CAL-001 code):
--   DROP TABLE IF EXISTS meeting_notification_deliveries;
--   DROP TABLE IF EXISTS meeting_reminders;
--   DROP TABLE IF EXISTS meeting_events;
--   DROP TABLE IF EXISTS meeting_participants;
--   DROP TABLE IF EXISTS meetings;
--   -- btree_gist stays: migrations 0021 and 0056 depend on it.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS meetings (
  id uuid PRIMARY KEY,
  organizer_employee_id uuid NOT NULL REFERENCES employees(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description text NULL CHECK (description IS NULL OR char_length(description) <= 3000),
  location text NULL CHECK (location IS NULL OR char_length(location) <= 255),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'CANCELLED')),
  -- K-05: shown to non-participants as "Sibuk" only.
  confidential boolean NOT NULL DEFAULT false,
  -- K-14: invitation, change and cancellation also go out over WhatsApp.
  notify_whatsapp boolean NOT NULL DEFAULT true,
  cancel_reason text NULL CHECK (cancel_reason IS NULL OR char_length(cancel_reason) BETWEEN 5 AND 500),
  cancelled_at timestamptz NULL,
  cancelled_by_account_id uuid NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  idempotency_key uuid NOT NULL,
  created_by_account_id uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organizer_employee_id, idempotency_key),
  CHECK (end_at > start_at),
  -- K-09 DRAFT: 15 minutes to 7 days.
  CHECK (end_at - start_at >= interval '15 minutes'),
  CHECK (end_at - start_at <= interval '7 days'),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);

-- The foundation-wide calendar (K-05) reads every active meeting in a date range.
CREATE INDEX IF NOT EXISTS meetings_active_range_idx
  ON meetings (start_at, end_at) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  role text NOT NULL CHECK (role IN ('ORGANIZER', 'ATTENDEE')),
  response text NOT NULL CHECK (response IN ('PENDING', 'ACCEPTED', 'DECLINED')),
  response_note text NULL CHECK (response_note IS NULL OR char_length(response_note) <= 500),
  responded_at timestamptz NULL,
  -- Copy of the meeting interval, [start_at, end_at), kept by the code in the same transaction.
  busy tstzrange NOT NULL,
  -- meeting ACTIVE and response <> DECLINED (§10); a cancelled meeting frees everybody.
  blocks_time boolean NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, employee_id),
  CHECK (role <> 'ORGANIZER' OR response = 'ACCEPTED'),
  CHECK (NOT blocks_time OR response <> 'DECLINED'),
  CHECK (NOT isempty(busy) AND lower_inc(busy) AND NOT upper_inc(busy)),
  -- §6.1 safety net behind the row locks: one person, one blocking meeting at a time.
  -- Touching intervals ([09:00,10:00) and [10:00,11:00)) do not overlap.
  CONSTRAINT meeting_participants_no_overlap
    EXCLUDE USING gist (employee_id WITH =, busy WITH &&) WHERE (blocks_time)
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_participants_one_organizer_idx
  ON meeting_participants (meeting_id) WHERE role = 'ORGANIZER';
CREATE INDEX IF NOT EXISTS meeting_participants_employee_idx
  ON meeting_participants (employee_id, meeting_id);

CREATE TABLE IF NOT EXISTS meeting_events (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  event_type text NOT NULL CHECK (event_type IN (
    'meeting.created',
    'meeting.updated',
    'meeting.participant.added',
    'meeting.participant.removed',
    'meeting.participant.responded',
    'meeting.cancelled'
  )),
  actor_account_id uuid NULL REFERENCES accounts(id),
  -- Safe metadata only: never the description, a response note or a cancel reason.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_events_meeting_idx
  ON meeting_events (meeting_id, occurred_at ASC);

-- NOTIF-003 first rule (§9.3): one row per person and rule, fired once.
CREATE TABLE IF NOT EXISTS meeting_reminders (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  rule_key text NOT NULL CHECK (rule_key IN ('meeting.upcoming')),
  fire_at timestamptz NOT NULL,
  fired_at timestamptz NULL,
  cancelled_at timestamptz NULL,
  UNIQUE (meeting_id, employee_id, rule_key)
);

CREATE INDEX IF NOT EXISTS meeting_reminders_due_idx
  ON meeting_reminders (fire_at) WHERE fired_at IS NULL AND cancelled_at IS NULL;

-- §9.2: WhatsApp hand-over to Kirim SQ, outside the business transaction. The phone number is
-- not stored; it is read from the employee record at hand-over.
CREATE TABLE IF NOT EXISTS meeting_notification_deliveries (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  event text NOT NULL CHECK (event IN ('invited', 'rescheduled', 'removed', 'cancelled', 'reminder')),
  version integer NOT NULL CHECK (version >= 1),
  channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('QUEUED', 'HANDED_OVER', 'SENT', 'FAILED', 'SKIPPED', 'DRY_RUN')),
  kirim_message_id text NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text NULL,
  -- Title/time/location as the recipient knew them, for a "removed" message: a person who is no
  -- longer invited must not learn a later title, time or location of a confidential meeting.
  message_facts jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_notification_deliveries_due_idx
  ON meeting_notification_deliveries (next_attempt_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS meeting_notification_deliveries_meeting_idx
  ON meeting_notification_deliveries (meeting_id, employee_id);
