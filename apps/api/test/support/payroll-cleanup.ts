// Shared cleanup for the payroll integration suites.
//
// Test files run in parallel against one CI database, so a suite that clears the
// payroll tables wholesale pulls the ground out from under whatever another suite
// is doing. Each suite therefore remembers the periods it created and clears only
// those, in dependency order.

import type { Pool } from "pg";

export async function clearOwnPeriods(pool: Pool, periodIds: readonly string[]): Promise<void> {
  if (periodIds.length === 0) return;
  const ids = [...periodIds];

  // A published slip is immutable by design (PAYSLIP-001), which is exactly what
  // production needs and exactly what has to be stood down to clean a database.
  await pool.query("ALTER TABLE payslips DISABLE TRIGGER payslips_published_immutable");
  try {
    // A revision and the slip it replaced point at each other with ON DELETE
    // RESTRICT, so the links are broken before the rows go.
    await pool.query(
      `UPDATE payslips SET superseded_by_id = NULL, revision_of = NULL
       WHERE source_period_id = ANY($1::uuid[])`,
      [ids],
    );
    await pool.query("DELETE FROM payslips WHERE source_period_id = ANY($1::uuid[])", [ids]);
  } finally {
    await pool.query("ALTER TABLE payslips ENABLE TRIGGER payslips_published_immutable");
  }

  await pool.query(
    `DELETE FROM payroll_result_lines
     WHERE result_id IN (SELECT id FROM payroll_results WHERE period_id = ANY($1::uuid[]))`,
    [ids],
  );
  // A revision points at the result it replaced, so the newest goes first.
  await pool.query(
    `DELETE FROM payroll_results WHERE period_id = ANY($1::uuid[])
     AND id NOT IN (SELECT previous_result_id FROM payroll_results
                    WHERE period_id = ANY($1::uuid[]) AND previous_result_id IS NOT NULL)`,
    [ids],
  );
  await pool.query("DELETE FROM payroll_results WHERE period_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payroll_loan_deductions WHERE period_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payroll_period_inputs WHERE period_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payroll_period_transitions WHERE period_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payroll_audit_events WHERE period_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payroll_periods WHERE id = ANY($1::uuid[])", [ids]);
}
