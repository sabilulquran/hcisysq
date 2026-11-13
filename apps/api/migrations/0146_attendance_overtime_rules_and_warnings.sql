-- ATT-011-6b-3 (docs/domain/attendance-operational-simplification-spec.md §7.7, §7.8, §10.11).
--
-- 1. attendance_overtime_eligibility_rules (D-10): "overtime does not apply" to a position (ORG-004
--    stable key) or a role key, effective-dated. HC adds and ends rules; a rule is never deleted and
--    its target never changes, so an old decision stays explainable. No person or employee id here.
-- 2. attendance_overtime_excluding_rule(employee, date): the rule that excludes an employee's overtime
--    on a date, or NULL. Position rules match a PRIMARY or ACTING seat in the structure in force on
--    that date (acting Direktur included: DRAFT); role rules match a direct role assignment effective
--    on that date or a role that follows a held seat (AUTH-015, hcis_seat_role_holders). A direct
--    assignment counts from the later of starts_on and the day it was recorded, so granting a role never
--    reaches back over days already worked. Read by the overtime routes, the attendance engine, the
--    overtime reports and the PAY-003 overtime input, so all agree.
-- 3. attendance_overtime_policy_versions (D-5b): effective-dated warning thresholds. No row means the
--    DRAFT defaults in code (4 hours a day, 18 hours an ISO week). Warnings never block.
-- 4. attendance_overtime_events accepts 'auto_cancelled': a waiting request whose employee became
--    excluded is cancelled when someone tries to approve it (409 OVERTIME_NO_LONGER_APPLICABLE).
-- 5. No seed. The repo holds no stable key of the production Direktur position, and the system role
--    'director' (0069) is the PAY-003 payroll-approval bundle, not a job title. HC adds the Direktur
--    position rule in Pengaturan > Aturan lembur (DRAFT, spec section 10.11). No structure, attendance
--    or account row is changed.
--
-- Additive. Nothing existing is rewritten: stored attendance results keep their overtime minutes until
-- the day is calculated again.
--
-- Rollback (an old build ignores the new tables; it then no longer enforces D-10 or shows warnings):
--   DROP FUNCTION IF EXISTS attendance_overtime_excluding_rule(uuid, date);
--   DROP TRIGGER IF EXISTS attendance_overtime_eligibility_rules_append_only ON attendance_overtime_eligibility_rules;
--   DROP FUNCTION IF EXISTS attendance_overtime_eligibility_rules_guard();
--   DROP TABLE IF EXISTS attendance_overtime_eligibility_rules;
--   DROP TABLE IF EXISTS attendance_overtime_policy_versions;
--   -- only once no event uses 'auto_cancelled' (UPDATE those to 'cancelled' first if needed):
--   ALTER TABLE attendance_overtime_events DROP CONSTRAINT attendance_overtime_events_event_type_check;
--   ALTER TABLE attendance_overtime_events ADD CONSTRAINT attendance_overtime_events_event_type_check CHECK (event_type IN (
--     'submitted', 'approved', 'rejected', 'cancelled', 'ordered', 'employee_agreed', 'employee_declined', 'admin_voided', 'reassigned'));
-- Recovery: the rule and policy rows are configuration; their history is also in access_audit_events
-- (attendance.overtime_rule.created/ended, attendance.overtime_policy.updated). After a rollback, a
-- recalculation (Hitung ulang) restores overtime minutes on excluded days.
--
-- Idempotent: rerunning changes nothing further.

-- The function body reads hcis_seat_role_holders (0139) and organization tables; checked on first call.
SET LOCAL check_function_bodies = off;

CREATE TABLE IF NOT EXISTS attendance_overtime_eligibility_rules (
  id uuid PRIMARY KEY,
  target_kind text NOT NULL CHECK (target_kind IN ('position', 'role')),
  target_ref text NOT NULL CHECK (char_length(target_ref) BETWEEN 1 AND 120),
  -- What HC saw when choosing the target (position title and unit, or role name), for display only.
  target_label text NOT NULL CHECK (char_length(btrim(target_label)) BETWEEN 1 AND 300),
  effect text NOT NULL DEFAULT 'not_applicable' CHECK (effect = 'not_applicable'),
  reason_label text NOT NULL CHECK (char_length(btrim(reason_label)) BETWEEN 3 AND 200),
  effective_from date NOT NULL,
  -- Last day the rule applies (inclusive, like the structure). effective_from - 1 = never applied.
  effective_to date NULL,
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  ended_at timestamptz NULL,
  end_reason text NULL,
  CONSTRAINT attendance_overtime_rules_position_key
    CHECK (target_kind <> 'position' OR target_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT attendance_overtime_rules_period CHECK (effective_to IS NULL OR effective_to >= effective_from - 1),
  CONSTRAINT attendance_overtime_rules_end_recorded CHECK ((effective_to IS NULL) = (ended_at IS NULL))
);

-- One open rule per target; an ended rule can be followed by a new one.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_overtime_rules_open_target_idx
  ON attendance_overtime_eligibility_rules (target_kind, target_ref) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS attendance_overtime_rules_period_idx
  ON attendance_overtime_eligibility_rules (effective_from, effective_to);

-- Add and end only: no delete, and only the end columns may change, once.
CREATE OR REPLACE FUNCTION attendance_overtime_eligibility_rules_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'attendance_overtime_eligibility_rules are never deleted; end the rule instead';
  END IF;
  IF OLD.effective_to IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.target_kind <> OLD.target_kind OR NEW.target_ref <> OLD.target_ref
     OR NEW.target_label <> OLD.target_label OR NEW.effect <> OLD.effect OR NEW.reason_label <> OLD.reason_label
     OR NEW.effective_from <> OLD.effective_from OR NEW.created_at <> OLD.created_at
     OR NEW.created_by_account_id IS DISTINCT FROM OLD.created_by_account_id THEN
    RAISE EXCEPTION 'attendance_overtime_eligibility_rules may only be ended once';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS attendance_overtime_eligibility_rules_append_only ON attendance_overtime_eligibility_rules;
CREATE TRIGGER attendance_overtime_eligibility_rules_append_only
  BEFORE UPDATE OR DELETE ON attendance_overtime_eligibility_rules
  FOR EACH ROW EXECUTE FUNCTION attendance_overtime_eligibility_rules_guard();

CREATE OR REPLACE FUNCTION attendance_overtime_excluding_rule(for_employee uuid, on_date date)
RETURNS uuid
LANGUAGE sql STABLE AS $$
  WITH structure AS (
    SELECT id FROM organization_change_sets
     WHERE status = 'PUBLISHED' AND effective_on <= on_date
     ORDER BY effective_on DESC, published_at DESC, created_at DESC, id DESC
     LIMIT 1
  )
  SELECT rule.id
    FROM attendance_overtime_eligibility_rules rule
   WHERE rule.effective_from <= on_date
     AND (rule.effective_to IS NULL OR rule.effective_to >= on_date)
     AND (
       (rule.target_kind = 'position' AND EXISTS (
          SELECT 1
            FROM structure
            JOIN organization_incumbencies seat ON seat.change_set_id = structure.id
           WHERE seat.employee_id = for_employee
             AND seat.position_key::text = rule.target_ref
             AND seat.kind IN ('PRIMARY', 'ACTING')
             AND seat.effective_from <= on_date
             AND (seat.effective_to IS NULL OR seat.effective_to >= on_date)))
       OR (rule.target_kind = 'role' AND (
          EXISTS (
            SELECT 1
              FROM account_role_assignments assignment
              JOIN accounts account ON account.id = assignment.account_id
              JOIN roles role ON role.id = assignment.role_id
             WHERE account.employee_id = for_employee
               AND role.role_key = rule.target_ref
               AND greatest(assignment.starts_on, (assignment.created_at AT TIME ZONE 'Asia/Jakarta')::date) <= on_date
               AND (assignment.ends_on IS NULL OR assignment.ends_on >= on_date))
          OR EXISTS (
            SELECT 1 FROM hcis_seat_role_holders(on_date) holder
             WHERE holder.employee_id = for_employee AND holder.role_key = rule.target_ref)))
     )
   ORDER BY rule.effective_from, rule.created_at, rule.id
   LIMIT 1
$$;

CREATE TABLE IF NOT EXISTS attendance_overtime_policy_versions (
  id uuid PRIMARY KEY,
  effective_from date NOT NULL,
  daily_warning_minutes integer NOT NULL CHECK (daily_warning_minutes BETWEEN 1 AND 1440),
  weekly_warning_minutes integer NOT NULL CHECK (weekly_warning_minutes BETWEEN 1 AND 10080),
  reason text NULL CHECK (reason IS NULL OR char_length(reason) <= 1000),
  created_by_account_id uuid NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attendance_overtime_policy_versions_effective_idx
  ON attendance_overtime_policy_versions (effective_from DESC, created_at DESC);

ALTER TABLE attendance_overtime_events
  DROP CONSTRAINT IF EXISTS attendance_overtime_events_event_type_check;
ALTER TABLE attendance_overtime_events
  ADD CONSTRAINT attendance_overtime_events_event_type_check CHECK (event_type IN (
    'submitted', 'approved', 'rejected', 'cancelled',
    'ordered', 'employee_agreed', 'employee_declined', 'admin_voided', 'reassigned',
    'auto_cancelled'
  ));

