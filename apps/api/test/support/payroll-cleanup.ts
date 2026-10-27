// Shared cleanup for the payroll integration suites.
//
// Test files run in parallel against one CI database, so a suite that clears the
// payroll tables wholesale pulls the ground out from under whatever another suite
// is doing. Each suite therefore remembers the periods it created and clears only
// those, in dependency order.
//
// The whole cleanup runs in one transaction. Payslips carry a deferred check that
// allows at most one current slip per employee and month, and breaking a revision
// link makes its predecessor current again for a moment: judged statement by
// statement that reads as two current slips, judged at commit it is none.

import type { Pool } from "pg";

export async function clearOwnPeriods(pool: Pool, periodIds: readonly string[]): Promise<void> {
  if (periodIds.length === 0) return;
  const ids = [...periodIds];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // A published slip is immutable by design (PAYSLIP-001), which is exactly
    // what production needs and exactly what has to be stood down to clean a
    // test database.
    await client.query("ALTER TABLE payslips DISABLE TRIGGER payslips_published_immutable");

    // A revision and the slip it replaced point at each other with ON DELETE
    // RESTRICT, so the links are broken before the rows go.
    await client.query(
      `UPDATE payslips SET superseded_by_id = NULL, revision_of = NULL
       WHERE source_period_id = ANY($1::uuid[])`,
      [ids],
    );
    await client.query("DELETE FROM payslips WHERE source_period_id = ANY($1::uuid[])", [ids]);
    await client.query("ALTER TABLE payslips ENABLE TRIGGER payslips_published_immutable");

    await client.query(
      `DELETE FROM payroll_result_lines
       WHERE result_id IN (SELECT id FROM payroll_results WHERE period_id = ANY($1::uuid[]))`,
      [ids],
    );
    // A revision points at the result it replaced, so the newest goes first.
    await client.query(
      `UPDATE payroll_results SET previous_result_id = NULL WHERE period_id = ANY($1::uuid[])`,
      [ids],
    );
    await client.query("DELETE FROM payroll_results WHERE period_id = ANY($1::uuid[])", [ids]);
    await client.query("DELETE FROM payroll_loan_deductions WHERE period_id = ANY($1::uuid[])", [ids]);
    await client.query("DELETE FROM payroll_period_inputs WHERE period_id = ANY($1::uuid[])", [ids]);
    await client.query("DELETE FROM payroll_period_transitions WHERE period_id = ANY($1::uuid[])", [ids]);
    await client.query("DELETE FROM payroll_audit_events WHERE period_id = ANY($1::uuid[])", [ids]);
    await client.query("DELETE FROM payroll_periods WHERE id = ANY($1::uuid[])", [ids]);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
