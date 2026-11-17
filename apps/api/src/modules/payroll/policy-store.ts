/**
 * PAY-003 policy lookups that need the database.
 *
 * policy.ts stays free of `pg`: it only parses and validates payloads. Reading
 * which version of a policy is in force on a date is storage, and it belongs
 * here rather than in reports.ts — publication.ts needs the payslip layout to
 * draft slips, and a reporting module is not where that answer lives.
 *
 * `findPph21Settings`, `findPph21Policy` and `findPph21AnnualPolicy` belong here
 * too; they stay in reports.ts for now so this change does not reach into the
 * files another payroll change is editing. Move them with the next change that
 * touches them.
 */

import type { Pool } from "pg";

import { DEFAULT_PAYSLIP_LAYOUT, parsePayslipLayoutPolicy, type PayslipLayoutPolicy } from "./policy.js";

export type PayslipLayoutLookup =
  | { ok: true; versionId: string | null; layout: PayslipLayoutPolicy }
  | { ok: false; message: string };

/**
 * PAYSLIP_LAYOUT in force on a pay date. No row means the earlier layout, which
 * is what every slip before the owner decision of 2026-11-17 was drafted with; a
 * row that does not parse is refused rather than silently read as the earlier
 * layout, like PPH21_SETTINGS.
 */
export async function findPayslipLayout(db: Pick<Pool, "query">, payDate: string): Promise<PayslipLayoutLookup> {
  const { rows } = await db.query<{ id: string; payload: unknown }>(
    `SELECT id, payload FROM payroll_policy_versions
     WHERE policy_key = 'PAYSLIP_LAYOUT'
       AND effective_from <= $1::date
       AND (effective_to IS NULL OR effective_to >= $1::date)
     ORDER BY effective_from DESC
     LIMIT 1`,
    [payDate],
  );
  const row = rows[0];
  if (!row) return { ok: true, versionId: null, layout: DEFAULT_PAYSLIP_LAYOUT };
  const parsed = parsePayslipLayoutPolicy(row.payload);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, versionId: row.id, layout: parsed.layout };
}
