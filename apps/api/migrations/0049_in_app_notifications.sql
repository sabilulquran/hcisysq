-- NOTIF-004 in-app notification center

CREATE TABLE IF NOT EXISTS in_app_notifications (
  id uuid PRIMARY KEY,
  recipient_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  event_key text NOT NULL,
  category text NOT NULL CHECK (category IN ('attendance','payslip','system')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  href text NULL CHECK (href IS NULL OR (href LIKE '/app/%' AND char_length(href) <= 500)),
  actor_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_account_id, event_key)
);

CREATE INDEX IF NOT EXISTS in_app_notifications_recipient_created_idx
  ON in_app_notifications (recipient_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS in_app_notifications_unread_idx
  ON in_app_notifications (recipient_account_id, created_at DESC)
  WHERE read_at IS NULL;

COMMENT ON TABLE in_app_notifications IS
  'NOTIF-004 recipient-owned in-app notifications. No external delivery or reminder scheduling implied.';
