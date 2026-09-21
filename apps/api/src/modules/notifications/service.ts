import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type QueryTarget = Pool | PoolClient;

export interface NotificationInput {
  recipientAccountId: string;
  eventKey: string;
  category: "attendance" | "payslip" | "system";
  title: string;
  body: string;
  href?: string | null;
  actorAccountId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function notifyAccount(db: QueryTarget, input: NotificationInput) {
  await db.query(
    `INSERT INTO in_app_notifications (
       id, recipient_account_id, event_key, category, title, body, href,
       actor_account_id, safe_metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (recipient_account_id, event_key) DO NOTHING`,
    [
      randomUUID(), input.recipientAccountId, input.eventKey, input.category,
      input.title, input.body, input.href ?? null, input.actorAccountId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function accountIdForEmployee(db: QueryTarget, employeeId: string) {
  const result = await db.query<{ accountId: string }>(
    `SELECT account.id AS "accountId"
     FROM accounts account
     JOIN employees employee ON employee.id = account.employee_id
     WHERE account.employee_id = $1
       AND account.principal_type = 'EMPLOYEE'
       AND account.status = 'active'
       AND employee.status = 'active'
     ORDER BY account.id
     LIMIT 1`,
    [employeeId],
  );
  return result.rows[0]?.accountId ?? null;
}

export async function notifyEmployee(
  db: QueryTarget,
  employeeId: string,
  input: Omit<NotificationInput, "recipientAccountId">,
) {
  const accountId = await accountIdForEmployee(db, employeeId);
  if (!accountId) return false;
  await notifyAccount(db, { ...input, recipientAccountId: accountId });
  return true;
}
