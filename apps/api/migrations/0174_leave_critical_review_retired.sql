-- LEAVE-009 D-12 (owner decision 2026-11-18): masa kritis no longer adds an HC review stage to a
-- leave request. The unit head approves, and the unit head who approved carries the responsibility.
--
-- The code that creates and decides `leave_request_critical_reviews` rows is gone in the same
-- release, so any row still open in production would strand its request: nothing would ever move a
-- `pending` review on, and the request would sit `in_review` with no approver anywhere. This
-- migration settles those rows once, in the same transaction as the rest of the release.
--
-- What it does, following the removed HC "approve" decision as closely as SQL can:
--   * `pending` review on a request still `in_review` (line approval finished, HC had not decided)
--     -> `approved`. The request then continues where it would have: its waiting administrative HC
--     task (LEAVE-005/LEAVE-007) becomes `pending` and HC is told, or, when the request never had
--     one, the request becomes `approved` and the employee is told, plus the HC copy when
--     hc_handling = 'notify'.
--     Treating it as approved is the owner's DRAFT default and matches the decision itself: the
--     line chain had already said yes, and the step being removed is the one that no longer exists.
--   * every other open review (`waiting`, or `pending` on a request that is no longer `in_review`)
--     -> `cancelled`. It never became pending, or its request was already decided elsewhere; either
--     way nothing is owed. A `waiting` review on a request still running simply stops mattering,
--     and that request keeps running through its line chain untouched.
-- Every settled row also writes a `leave.critical_review.retired` event, so the history says why
-- the step ended without an HC decision instead of looking like a silent approval.
--
-- Two deliberate limits:
--   * The removed handler refused (409 HC_TASK_NOT_READY) rather than ever finish a request whose
--     administrative HC stage was missing. Step 4 keeps that promise by finalising only
--     hc_handling 'notify'/'none'. A 'validate'/'approve' request whose task row is missing or
--     already terminal is left `in_review` on purpose: that is a data anomaly for HC to look at,
--     not something to approve silently.
--   * The informational ORG-004 oversight notification (`leave.oversight.approved`, only ever sent
--     in STRUCTURE rollout mode) is resolved in application code and is not emitted here.
--
-- The tables themselves are kept: decided rows are the record of reviews that really happened, and
-- the leave history and audit still read them. Nothing writes them after this release.
--
-- Down: no automatic down. Re-opening settled reviews would contradict the approvals and
-- notifications this migration already wrote. Rolling the release back only needs the code:
-- the old build reads these rows, and finds them decided.

-- 1. The record of why each open review ended. 'approved' only where the request is still waiting
--    on it; anything else ends as 'cancelled'.
INSERT INTO leave_request_events (id, leave_request_id, actor_account_id, event_type, payload)
SELECT
  gen_random_uuid(),
  review.leave_request_id,
  NULL,
  'leave.critical_review.retired',
  jsonb_build_object(
    'reviewId', review.id,
    'previousStatus', review.status,
    'settledAs',
      CASE WHEN review.status = 'pending' AND request.status = 'in_review' THEN 'approved' ELSE 'cancelled' END,
    'decision', 'LEAVE-009 D-12 (2026-11-18)'
  )
FROM leave_request_critical_reviews review
JOIN leave_requests request ON request.id = review.leave_request_id
WHERE review.status IN ('waiting', 'pending');

-- 2. The review rows themselves, by the same rule.
UPDATE leave_request_critical_reviews review
   SET status = CASE WHEN review.status = 'pending' AND request.status = 'in_review' THEN 'approved' ELSE 'cancelled' END,
       note = coalesce(review.note, 'Tahap tinjauan HC masa kritis dihapus (keputusan owner 2026-11-18, LEAVE-009 D-12).'),
       acted_at = CASE
         WHEN review.status = 'pending' AND request.status = 'in_review' THEN now()
         ELSE review.acted_at
       END,
       updated_at = now()
  FROM leave_requests request
 WHERE request.id = review.leave_request_id
   AND review.status IN ('waiting', 'pending');

-- 3. Requests that were waiting only on that review move on. First the administrative HC task,
--    which the review used to hold back (LEAVE-005 validation, LEAVE-007 approval). HC is told it
--    is theirs now, and the employee is told their line approval is through.
WITH settled AS (
  SELECT request.id, request.employee_id, request.hc_handling
    FROM leave_requests request
    JOIN leave_request_events event
      ON event.leave_request_id = request.id
     AND event.event_type = 'leave.critical_review.retired'
     AND event.payload ->> 'settledAs' = 'approved'
   WHERE request.status = 'in_review'
), activated AS (
  UPDATE leave_request_hc_tasks task
     SET status = 'pending', updated_at = now()
    FROM settled
   WHERE task.leave_request_id = settled.id
     AND task.task_kind = settled.hc_handling
     AND task.status = 'waiting'
  RETURNING task.leave_request_id, task.task_kind, settled.employee_id
), logged AS (
  INSERT INTO leave_request_events (id, leave_request_id, actor_account_id, event_type, payload)
  SELECT
    gen_random_uuid(), activated.leave_request_id, NULL,
    CASE WHEN activated.task_kind = 'approve' THEN 'leave.hc.approval_pending' ELSE 'leave.hc.validation_pending' END,
    '{}'::jsonb
  FROM activated
  RETURNING 1
)
INSERT INTO leave_notification_outbox (id, leave_request_id, event_type, target_type, target_key)
SELECT
  gen_random_uuid(), activated.leave_request_id,
  CASE WHEN activated.task_kind = 'approve' THEN 'leave.hc.approval.requested' ELSE 'leave.hc.validation.requested' END,
  'role', 'human_capital'
FROM activated
UNION ALL
SELECT
  gen_random_uuid(), activated.leave_request_id,
  'leave.line_approval.completed.employee_notify', 'employee', activated.employee_id::text
FROM activated;

-- 4. Requests with no administrative HC stage of their own are finished, exactly as an HC approval
--    would have. hc_handling 'validate'/'approve' is never finished here (see the header).
WITH finalised AS (
  UPDATE leave_requests request
     SET status = 'approved', final_decided_at = now(), updated_at = now()
   WHERE request.status = 'in_review'
     AND request.hc_handling IN ('notify', 'none')
     AND EXISTS (
       SELECT 1 FROM leave_request_events event
        WHERE event.leave_request_id = request.id
          AND event.event_type = 'leave.critical_review.retired'
          AND event.payload ->> 'settledAs' = 'approved'
     )
     AND NOT EXISTS (
       SELECT 1 FROM leave_request_hc_tasks task
        WHERE task.leave_request_id = request.id
          AND task.status IN ('waiting', 'pending', 'needs_correction')
     )
  RETURNING request.id, request.employee_id, request.hc_handling
)
INSERT INTO leave_notification_outbox (id, leave_request_id, event_type, target_type, target_key)
SELECT gen_random_uuid(), finalised.id, 'leave.request.approved', 'employee', finalised.employee_id::text
  FROM finalised
UNION ALL
SELECT gen_random_uuid(), finalised.id, 'leave.request.approved.hc_notify', 'role', 'human_capital'
  FROM finalised
 WHERE finalised.hc_handling = 'notify';
