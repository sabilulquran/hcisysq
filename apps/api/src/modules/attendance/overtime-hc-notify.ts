import type { PoolClient } from "pg";

import { notifyAccount } from "../notifications/service.js";
import { PostgresOrganizationRepository } from "../organization/repository.js";
import { employeeUnitChain } from "../organization/structure-lookups.js";
import { jakartaBusinessDate } from "../organization/jakarta-date.js";

// ATT-011-6b-3 D-11 (§7.4): when overtime becomes approved, HC staff of the employee's unit get a short
// in-app notice. Recipients are active accounts holding attendance.overtime.manage through a role
// assignment scoped to the employee's unit or a unit above it (the ORG-008-6 legacy-unit link, shared
// with GET /admin/organization/units/:nodeKey/hc-staff). With nobody there, it falls back to the
// organisation-scoped holders (direct assignment or a role that follows a seat, AUTH-015) so the notice
// is never lost silently. The approver and the employee are left out (they are told separately).
// Computed when the approval is written, inside the same transaction, as one row per recipient.
// In-app only: no WhatsApp or email channel is involved.

const PERMISSION = "attendance.overtime.manage";

export async function overtimeHcRecipients(
  client: Pick<PoolClient, "query">,
  input: { employeeId: string; excludeAccountIds: string[]; asOf?: string },
): Promise<{ accountIds: string[]; scope: "unit" | "organization"; unitIds: string[] }> {
  const asOf = input.asOf ?? jakartaBusinessDate();
  const employee = await client.query<{ organizationalUnitId: string | null }>(
    `SELECT organizational_unit_id AS "organizationalUnitId" FROM employees WHERE id = $1`,
    [input.employeeId],
  );
  const snapshot = await new PostgresOrganizationRepository(client).loadEffectiveSnapshot(asOf);
  const unitIds = employeeUnitChain(snapshot, { id: input.employeeId, organizationalUnitId: employee.rows[0]?.organizationalUnitId ?? null }, asOf);
  const exclude = input.excludeAccountIds.filter(Boolean);
  if (unitIds.length) {
    const unit = await client.query<{ accountId: string }>(
      `SELECT DISTINCT account.id AS "accountId"
       FROM account_role_assignments assignment
       JOIN role_permissions grant_row ON grant_row.role_id = assignment.role_id AND grant_row.permission_key = $1
       JOIN accounts account ON account.id = assignment.account_id
       JOIN employees holder ON holder.id = account.employee_id
       WHERE assignment.scope_type = 'unit'
         AND assignment.organizational_unit_id = ANY($2::uuid[])
         AND account.principal_type = 'EMPLOYEE' AND account.status = 'active' AND holder.status = 'active'
         AND (assignment.starts_on IS NULL OR assignment.starts_on <= $3::date)
         AND (assignment.ends_on IS NULL OR assignment.ends_on >= $3::date)
       ORDER BY 1`,
      [PERMISSION, unitIds, asOf],
    );
    // Fall back when nobody of the unit is left once the people told separately are removed.
    const accountIds = unit.rows.map((row) => row.accountId).filter((id) => !exclude.includes(id));
    if (accountIds.length) return { accountIds, scope: "unit", unitIds };
  }
  const organization = await client.query<{ accountId: string }>(
    `SELECT account.id AS "accountId"
     FROM account_role_assignments assignment
     JOIN role_permissions grant_row ON grant_row.role_id = assignment.role_id AND grant_row.permission_key = $1
     JOIN accounts account ON account.id = assignment.account_id
     JOIN employees holder ON holder.id = account.employee_id
     WHERE assignment.scope_type = 'organization' AND assignment.organizational_unit_id IS NULL
       AND account.principal_type = 'EMPLOYEE' AND account.status = 'active' AND holder.status = 'active'
       AND (assignment.starts_on IS NULL OR assignment.starts_on <= $2::date)
       AND (assignment.ends_on IS NULL OR assignment.ends_on >= $2::date)
     UNION
     SELECT seat.account_id FROM hcis_seat_permissions($2::date) seat WHERE seat.permission_key = $1
     ORDER BY 1`,
    [PERMISSION, asOf],
  );
  return { accountIds: organization.rows.map((row) => row.accountId).filter((id) => !exclude.includes(id)), scope: "organization", unitIds };
}

/**
 * Short notice, no reason text (§7.4). The approver, the employee and the supervisor of the request
 * are told separately, so they are left out here (D-5c dedupe). Returns how many accounts were notified.
 */
export async function notifyHcOfApprovedOvertime(
  client: Pick<PoolClient, "query">,
  input: { overtimeId: string; employeeId: string; supervisorEmployeeId: string | null; workDate: string; minutes: number; approverAccountId: string },
): Promise<{ notified: number; scope: "unit" | "organization" }> {
  const people = await client.query<{ fullName: string | null; accountIds: string[] }>(
    `SELECT (SELECT full_name FROM employees WHERE id = $1) AS "fullName",
       coalesce(array_agg(account.id::text) FILTER (WHERE account.id IS NOT NULL), '{}') AS "accountIds"
     FROM accounts account
     WHERE account.employee_id = ANY($2::uuid[]) AND account.principal_type = 'EMPLOYEE'`,
    [input.employeeId, [input.employeeId, input.supervisorEmployeeId].filter(Boolean)],
  );
  const recipients = await overtimeHcRecipients(client, {
    employeeId: input.employeeId,
    excludeAccountIds: [input.approverAccountId, ...(people.rows[0]?.accountIds ?? [])],
  });
  for (const accountId of recipients.accountIds) {
    await notifyAccount(client as PoolClient, {
      recipientAccountId: accountId,
      eventKey: `overtime:${input.overtimeId}:approved:hc`,
      category: "attendance",
      title: "Lembur disetujui",
      body: `Lembur ${people.rows[0]?.fullName ?? "pegawai"} ${input.workDate} disetujui ${input.minutes} menit. Pantau di Waktu & Kehadiran → Lembur.`,
      // In-app links may only point into /app; the HC Lembur screen is in the admin area.
      href: null,
      actorAccountId: input.approverAccountId,
      metadata: { overtimeId: input.overtimeId, workDate: input.workDate, recipientScope: recipients.scope },
    });
  }
  return { notified: recipients.accountIds.length, scope: recipients.scope };
}
