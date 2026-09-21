-- Candidate inventory only; NOT a deletion allowlist.
-- Run in an authorized private database console, not public Actions logs.
-- Naming hints can be false positives and do not find every UAT fixture.
-- Review exact account/employee IDs with the owner before any separate action.
-- No names, email values, passwords, tokens, cookies, or photo data are returned.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
WITH candidates AS (
  SELECT account.id AS account_id, account.employee_id, account.principal_type,
         account.status AS account_status, employee.status AS employee_status,
         concat_ws(', ',
           CASE WHEN lower(account.email) LIKE '%@example.invalid' THEN 'synthetic email domain' END,
           CASE WHEN employee.employee_number LIKE 'UAT-%' THEN 'UAT employee-number prefix' END,
           CASE WHEN employee.employee_number LIKE 'AUTH011-%' THEN 'AUTH011 fixture prefix' END,
           CASE WHEN employee.employee_number LIKE 'YSQ-DEMO-%' THEN 'demo employee-number prefix' END
         ) AS review_hint
  FROM accounts account
  LEFT JOIN employees employee ON employee.id = account.employee_id
  WHERE lower(account.email) LIKE '%@example.invalid'
     OR employee.employee_number LIKE 'UAT-%'
     OR employee.employee_number LIKE 'AUTH011-%'
     OR employee.employee_number LIKE 'YSQ-DEMO-%'
)
SELECT candidate.*,
       (SELECT count(*) FROM auth_sessions session WHERE session.account_id = candidate.account_id) AS session_rows,
       (SELECT count(*) FROM account_role_assignments assignment WHERE assignment.account_id = candidate.account_id) AS role_assignment_rows,
       (SELECT count(*) FROM leave_requests request WHERE request.employee_id = candidate.employee_id) AS leave_request_rows,
       (SELECT count(*) FROM attendance_events event WHERE event.employee_id = candidate.employee_id) AS attendance_event_rows,
       (SELECT count(*) FROM attendance_shift_swap_requests swap WHERE swap.requester_employee_id = candidate.employee_id OR swap.counterpart_employee_id = candidate.employee_id) AS shift_swap_rows
FROM candidates candidate
ORDER BY candidate.account_id;
ROLLBACK;
