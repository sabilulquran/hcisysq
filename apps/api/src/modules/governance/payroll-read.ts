import type { Pool } from "pg";

import { GOVERNANCE_PAYROLL_READ_PERMISSION } from "../auth/permissions.js";
import { APPROVED_ONWARDS } from "../payroll/lifecycle.js";
import { listResults } from "../payroll/inputs-store.js";
import { listEmploymentIdentities } from "../payroll/store.js";

/**
 * ADR-0008 — what an organ account may read of payroll, and nothing beyond it.
 *
 * Written as its own module for the same reason ORG-014's employee list is: the boundary of what
 * leaves HCIS to the Portal Organ Yayasan should be readable in one file, not inferred from a
 * handler. Everything the ADR leaves closed — the transfer list with its account numbers, the
 * period inputs, the policy, and every lifecycle action — simply has no function here.
 */

export class GovernancePayrollDenied extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly reason: string,
  ) {
    super(code);
    this.name = "GovernancePayrollDenied";
  }
}

/**
 * ORG-013-1 point 3 as ADR-0008 D-3 restates it: holding the Ketua, Sekretaris or Bendahara seat
 * never confers this capability. It comes from an explicit, dated, organization-scoped assignment
 * of `governance_payroll_reader` and from nothing else.
 *
 * A separate query from `hasOrganizationPermission` because that one reads EMPLOYEE accounts only
 * (it joins `employees`), exactly as ORG-013's `assertGovernanceApprovalCapability` does.
 */
export async function assertGovernancePayrollReadCapability(pool: Pool, accountId: string): Promise<void> {
  const capability = await pool.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM account_role_assignments ara
       JOIN role_permissions rp ON rp.role_id = ara.role_id
       WHERE ara.account_id = $1
         AND rp.permission_key = $2
         AND ara.scope_type = 'organization'
         AND ara.organizational_unit_id IS NULL
         AND (ara.starts_on IS NULL OR ara.starts_on <= (now() AT TIME ZONE 'Asia/Jakarta')::date)
         AND (ara.ends_on IS NULL OR ara.ends_on >= (now() AT TIME ZONE 'Asia/Jakarta')::date)
     ) AS allowed`,
    [accountId, GOVERNANCE_PAYROLL_READ_PERMISSION],
  );
  if (!capability.rows[0]?.allowed) {
    throw new GovernancePayrollDenied(403, "PAYROLL_READ_FORBIDDEN", "PAYROLL_READ_FORBIDDEN");
  }
}

export interface GovernancePayrollPeriod {
  id: string;
  kind: string;
  periodMonth: string;
  state: string;
  payDate: string | null;
}

/**
 * The periods an organ account may open: APPROVED or later, as every report reader sees them
 * (payroll specification section 6). A period still being worked on is not listed at all, so the
 * portal cannot offer a door that would answer 409.
 */
export async function listGovernancePayrollPeriods(pool: Pool): Promise<GovernancePayrollPeriod[]> {
  const { rows } = await pool.query<GovernancePayrollPeriod>(
    `SELECT p.id, p.kind, to_char(p.period_month, 'YYYY-MM-DD') AS "periodMonth", p.state,
            to_char(p.pay_date, 'YYYY-MM-DD') AS "payDate"
     FROM payroll_periods p
     WHERE p.state = ANY($1::text[])
     ORDER BY p.period_month DESC, p.id`,
    [[...APPROVED_ONWARDS]],
  );
  return rows;
}

export interface GovernancePayrollPerson {
  employeeNumber: string;
  fullName: string;
  gross: string;
  deductions: string;
  net: string;
  payable: string;
  /** The payslip rows themselves: which component, in which category, for how much. */
  lines: Array<{ componentCode: string; category: string; amount: string; displayOrder: number }>;
}

/**
 * One period's per-person figures and payslip lines.
 *
 * The employment id is deliberately dropped and the person named by employee number instead: the
 * portal has no use for an internal key, and ADR-0008 opens the figures, not HCIS's identifiers.
 * The employer cost, the pay factor, the BPJS base and the blockers stay in HCIS as well — they
 * are working data for the people running the period, not what the owner decided to open.
 */
export async function loadGovernancePayrollResults(
  pool: Pool,
  periodId: string,
): Promise<GovernancePayrollPerson[]> {
  const [{ results, lines }, identities] = await Promise.all([
    listResults(pool, periodId),
    listEmploymentIdentities(pool, periodId),
  ]);
  const names = new Map(identities.map((identity) => [identity.employmentId, identity]));
  return results.map((result) => {
    const identity = names.get(result.employmentId);
    return {
      employeeNumber: identity?.employeeNumber ?? "",
      fullName: identity?.fullName ?? "",
      gross: result.gross,
      deductions: result.deductions,
      net: result.net,
      payable: result.payable,
      lines: lines
        .filter((line) => line.employmentId === result.employmentId)
        .map((line) => ({
          componentCode: line.componentCode,
          category: line.category,
          amount: line.amount,
          displayOrder: line.displayOrder,
        })),
    };
  });
}
