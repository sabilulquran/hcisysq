-- ORG-015-3: idempotency for decisions forwarded by the Portal Organ Yayasan.
--
-- The portal creates one id per action and reuses it when it resends, which happens whenever the
-- first answer did not reach it. The column records which id decided the step, so a resend with
-- the same id answers with the decision already made instead of deciding a second time, and a
-- different id on a decided step is refused.
--
-- Decisions made with an HCIS cookie session leave it NULL, as do all rows written before this
-- migration. The column is additive and nothing references it.
--
-- Down: ALTER TABLE leave_request_approval_steps DROP COLUMN decision_request_id;
ALTER TABLE leave_request_approval_steps
  ADD COLUMN IF NOT EXISTS decision_request_id uuid;

COMMENT ON COLUMN leave_request_approval_steps.decision_request_id IS
  'ORG-015: the Portal Organ requestId that decided this step; NULL for cookie-session decisions.';
