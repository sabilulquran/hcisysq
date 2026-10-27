// EMP-005 S5A (spec §8.5, D-15): what a former employee may still reach.
//
// When an employment ends, the linked HCIS account is deactivated — in the
// termination transaction if the last day has passed, otherwise by the daily
// job. Both can be late, so authentication checks the employment itself and
// fails closed: an EMPLOYEE account whose latest employment ended before today
// is refused unless an unexpired temporary reactivation exists, and such a
// reactivation opens only the three read-only self-service pages the owner
// allowed. Everything here is about the HCIS account; Akun SQ is not touched.

import type { Pool, PoolClient } from "pg";

type Db = Pick<Pool, "query"> | PoolClient;

export const MAX_REACTIVATION_DAYS = 30;

export interface EmploymentAccessState {
  /** The latest non-voided employment ended before today (Asia/Jakarta). */
  employmentEnded: boolean;
  /** An unexpired, unrevoked grant, if one exists. */
  reactivationExpiresAt: string | null;
}

/**
 * One query per check, so a late job can never widen access: the employment
 * dates and the grant window decide, not the stored account status.
 */
export async function loadEmploymentAccessState(db: Db, accountId: string): Promise<EmploymentAccessState> {
  const result = await db.query<{ employmentEnded: boolean; reactivationExpiresAt: Date | null }>(
    `WITH account_employee AS (
       SELECT employee_id FROM accounts WHERE id = $1 AND principal_type = 'EMPLOYEE'
     ),
     latest AS (
       SELECT e.ended_on, e.end_basis
       FROM employments e
       JOIN account_employee ae ON ae.employee_id = e.employee_id
       WHERE e.voided_by_action_id IS NULL
       ORDER BY e.started_on DESC NULLS LAST, e.created_at DESC
       LIMIT 1
     )
     SELECT
       COALESCE((SELECT ended_on IS NOT NULL AND ended_on < (now() AT TIME ZONE 'Asia/Jakarta')::date FROM latest), false)
         AS "employmentEnded",
       (SELECT expires_at FROM account_temporary_reactivations
        WHERE account_id = $1 AND revoked_at IS NULL AND starts_at <= now() AND expires_at > now()
        ORDER BY expires_at DESC LIMIT 1) AS "reactivationExpiresAt"`,
    [accountId],
  );
  const row = result.rows[0];
  return {
    employmentEnded: row?.employmentEnded ?? false,
    reactivationExpiresAt: row?.reactivationExpiresAt?.toISOString() ?? null,
  };
}

/**
 * The allowlist a temporary reactivation opens (owner, 2026-10-16): own
 * payslips, own attendance history, own leave history — read-only. Anything
 * else, including the employee's own employment history, stays closed.
 */
const RESTRICTED_ALLOWLIST: readonly RegExp[] = [
  /^\/payslips$/,
  /^\/payslips\/[^/]+$/,
  /^\/attendance\/me$/,
  /^\/attendance\/me\/workforce$/,
  /^\/attendance\/resolutions\/me$/,
  /^\/leave\/me\/requests$/,
  /^\/leave\/me\/summary$/,
  /^\/leave\/planned\/me\/summary$/,
  /^\/leave\/special\/me\/summary$/,
  // The SPA cannot show any of the three pages without these two.
  /^\/auth\/me$/,
  /^\/auth\/launcher$/,
  /^\/auth\/logout$/,
];

/** True when a reactivated former employee may call this request. */
export function isAllowedWhileReactivated(method: string, url: string): boolean {
  const path = (url.split("?")[0] ?? "").replace(/\/+$/, "") || "/";
  if (path === "/auth/logout") return method === "POST";
  if (method !== "GET") return false;
  return RESTRICTED_ALLOWLIST.some((pattern) => pattern.test(path));
}

export interface TemporaryReactivationRow {
  id: string;
  accountId: string;
  reason: string;
  startsAt: string;
  expiresAt: string;
  grantedByAccountId: string | null;
  revokedAt: string | null;
  revokedByAccountId: string | null;
}

export async function listTemporaryReactivations(db: Db, accountId: string): Promise<TemporaryReactivationRow[]> {
  const result = await db.query<{
    id: string; accountId: string; reason: string; startsAt: Date; expiresAt: Date;
    grantedByAccountId: string | null; revokedAt: Date | null; revokedByAccountId: string | null;
  }>(
    `SELECT id, account_id AS "accountId", reason, starts_at AS "startsAt", expires_at AS "expiresAt",
            granted_by_account_id AS "grantedByAccountId", revoked_at AS "revokedAt",
            revoked_by_account_id AS "revokedByAccountId"
     FROM account_temporary_reactivations
     WHERE account_id = $1
     ORDER BY starts_at DESC`,
    [accountId],
  );
  return result.rows.map((row) => ({
    ...row,
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  }));
}

/**
 * Deactivates every EMPLOYEE account of an employee whose employment has
 * ended, revoking sessions and activation tokens exactly as the manual status
 * change does. Returns the accounts it changed. Caller owns the transaction.
 */
export async function deactivateAccountsForEndedEmployment(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  // A second, still-running employment (or a rehire) keeps the account open:
  // ending one contract must not lock out someone who still works here.
  const stillWorking = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM employments
       WHERE employee_id = $1 AND voided_by_action_id IS NULL
         AND (started_on IS NULL OR started_on <= (now() AT TIME ZONE 'Asia/Jakarta')::date)
         AND (ended_on IS NULL OR ended_on >= (now() AT TIME ZONE 'Asia/Jakarta')::date)
         AND end_basis IS DISTINCT FROM 'UNKNOWN'
     ) AS present`,
    [employeeId],
  );
  if (stillWorking.rows[0]?.present) return [];

  const accounts = await client.query<{ id: string }>(
    `UPDATE accounts SET status = 'inactive', updated_at = now()
     WHERE employee_id = $1 AND principal_type = 'EMPLOYEE' AND status IN ('invited', 'active')
     RETURNING id`,
    [employeeId],
  );
  const ids = accounts.rows.map((row) => row.id);
  if (ids.length === 0) return ids;
  await client.query(
    `UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
     WHERE account_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
    [ids],
  );
  await client.query(
    `UPDATE account_activation_tokens SET revoked_at = coalesce(revoked_at, now())
     WHERE account_id = ANY($1::uuid[]) AND consumed_at IS NULL AND revoked_at IS NULL`,
    [ids],
  );
  return ids;
}

/**
 * Closes grants that reached their expiry and returns those accounts to
 * inactive. The grant is marked as ended in the same step, so a later run
 * cannot act on it again — otherwise a rehired employee would be locked out
 * every night by a grant from a previous employment.
 */
export async function expireTemporaryReactivations(client: PoolClient): Promise<string[]> {
  const expired = await client.query<{ accountId: string }>(
    `UPDATE account_temporary_reactivations
     SET revoked_at = expires_at
     WHERE revoked_at IS NULL AND expires_at <= now()
     RETURNING account_id AS "accountId"`,
  );
  const ids = [...new Set(expired.rows.map((row) => row.accountId))];
  const closed: string[] = [];
  for (const accountId of ids) {
    // The employment decides, as everywhere else: a rehired employee keeps
    // the account the expiry would otherwise close.
    const state = await loadEmploymentAccessState(client, accountId);
    if (!state.employmentEnded) continue;
    await client.query(
      `UPDATE accounts SET status = 'inactive', updated_at = now()
       WHERE id = $1 AND principal_type = 'EMPLOYEE' AND status IN ('invited', 'active')`,
      [accountId],
    );
    await client.query(
      `UPDATE auth_sessions SET revoked_at = coalesce(revoked_at, now())
       WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId],
    );
    closed.push(accountId);
  }
  return closed;
}

/**
 * The latest employment's end date, the same one the guard reads. Used by the
 * grant path, where "has an ended employment" must not be satisfied by an old
 * employment of someone who was rehired.
 */
export async function latestEmploymentEnd(db: Db, accountId: string): Promise<string | null> {
  const result = await db.query<{ endedOn: string | null }>(
    `SELECT e.ended_on::text AS "endedOn"
     FROM employments e
     JOIN accounts a ON a.employee_id = e.employee_id
     WHERE a.id = $1 AND a.principal_type = 'EMPLOYEE' AND e.voided_by_action_id IS NULL
     ORDER BY e.started_on DESC NULLS LAST, e.created_at DESC
     LIMIT 1`,
    [accountId],
  );
  return result.rows[0]?.endedOn ?? null;
}
