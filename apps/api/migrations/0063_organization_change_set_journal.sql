-- ORG-008-4a: the list of what an operator changed in a change set, in their own order.
-- docs/domain/organization-designer-ux-spec.md 5.3.
--
-- One row per combined command applied to a change set. It is the source of the "Yang berubah" list,
-- and later of per-line undo and rebase (ORG-008-4c), which replay the commands onto a fresh base.
--
-- The journal records what was asked for, not personal data: identifiers, keys, dates, and the
-- operator's own reason text for an acting appointment, which ORG-004 already requires and audits.
-- It never carries an identity number, address, payslip figure, or document content.
--
-- Additive, and no row is seeded. An older release ignores the table: commands write the ordinary
-- node, position, membership, incumbency, binding and override records, so a change set stays
-- complete and publishable without the journal.
--
-- Rollback/recovery:
--   DROP TABLE IF EXISTS organization_change_set_journal;
--   Draft contents and published history are unaffected, because the journal only describes writes
--   that were already made as primitive records.
--
-- Idempotent: rerunning changes nothing further.

CREATE TABLE IF NOT EXISTS organization_change_set_journal (
  id uuid PRIMARY KEY,
  change_set_id uuid NOT NULL REFERENCES organization_change_sets(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  command_type text NOT NULL CHECK (length(btrim(command_type)) > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (change_set_id, seq)
);

CREATE INDEX IF NOT EXISTS organization_change_set_journal_order_idx
  ON organization_change_set_journal (change_set_id, seq);
