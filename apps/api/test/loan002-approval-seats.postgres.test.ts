// LOAN-002: the approval seat registry, the Pembina threshold configuration and the loan
// account-principal columns, against the real schema (migrations 0177 and 0178).
// Synthetic rows only; every test runs inside one rolled-back transaction.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("LOAN-002 approval seat registry", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  /**
   * A failing statement aborts the whole transaction in PostgreSQL, so every expected refusal runs
   * inside its own savepoint and the test can carry on afterwards.
   */
  async function refused(run: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
    await client.query("SAVEPOINT attempt");
    let succeeded = false;
    try {
      await run();
      succeeded = true;
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT attempt");
      await client.query("RELEASE SAVEPOINT attempt");
      return error as { code?: string; message: string };
    }
    if (succeeded) {
      await client.query("RELEASE SAVEPOINT attempt");
      throw new Error("expected the statement to be refused");
    }
    throw new Error("unreachable");
  }

  async function mapSeat(seatKey: string, positionKey = randomUUID(), from = "2026-11-18") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO organization_approval_seats (id, seat_key, position_key, seat_label, effective_from)
       VALUES ($1, $2, $3, $4, $5::date)`,
      [id, seatKey, positionKey, `${seatKey} - sintetis`, from],
    );
    return { id, positionKey };
  }

  it("D-16: holds one open mapping per seat and refuses a key outside the closed set", async () => {
    await mapSeat("DIREKTUR");
    expect((await refused(() => mapSeat("DIREKTUR"))).code).toBe("23505");
    expect((await refused(() => mapSeat("KEPALA_HCM"))).code).toBe("23514");
    // Ending the open mapping frees the seat for a new one, so a change of office is expressible.
    await client.query(
      `UPDATE organization_approval_seats
          SET effective_to = DATE '2026-12-31', ended_at = now(), end_reason = 'Pergantian jabatan'
        WHERE seat_key = 'DIREKTUR' AND effective_to IS NULL`,
    );
    expect(await mapSeat("DIREKTUR", randomUUID(), "2027-01-01")).toBeTruthy();
  });

  it("D-16: a mapping is never deleted, never retargeted, and ends only once", async () => {
    await mapSeat("KETUA_YAYASAN");
    expect((await refused(() => client.query(
      "DELETE FROM organization_approval_seats WHERE seat_key = 'KETUA_YAYASAN'",
    ))).message).toMatch(/never deleted/);
    expect((await refused(() => client.query(
      "UPDATE organization_approval_seats SET position_key = $1 WHERE seat_key = 'KETUA_YAYASAN'",
      [randomUUID()],
    ))).message).toMatch(/only be ended once/);
    await client.query(
      `UPDATE organization_approval_seats
          SET effective_to = DATE '2027-01-01', ended_at = now() WHERE seat_key = 'KETUA_YAYASAN'`,
    );
    expect((await refused(() => client.query(
      `UPDATE organization_approval_seats
          SET effective_to = DATE '2027-02-01' WHERE seat_key = 'KETUA_YAYASAN'`,
    ))).message).toMatch(/only be ended once/);
  });

  it("D-17: the Pembina threshold is seeded configuration, not a constant in code", async () => {
    const seeded = await client.query<{ threshold: string; from: string }>(
      `SELECT pembina_threshold_amount::text AS threshold, to_char(effective_from, 'YYYY-MM-DD') AS from
         FROM employee_loan_approval_policy_versions
        ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
    );
    expect(seeded.rows[0]).toEqual({ threshold: "5000000", from: "2026-11-18" });
    // Changing it is one new row, not a release.
    await client.query(
      `INSERT INTO employee_loan_approval_policy_versions (id, effective_from, pembina_threshold_amount, reason)
       VALUES ($1, DATE '2026-12-01', 7500000, 'Keputusan pemilik')`,
      [randomUUID()],
    );
    const current = await client.query<{ threshold: string }>(
      `SELECT pembina_threshold_amount::text AS threshold
         FROM employee_loan_approval_policy_versions
        WHERE effective_from <= DATE '2026-12-15'
        ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
    );
    expect(current.rows[0]?.threshold).toBe("7500000");
  });

  it("ORG-013-5: a loan step names exactly one principal, employee or organ account", async () => {
    const employeeId = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on)
       VALUES ($1, $2, 'Sintetis LOAN-002', 'active', '2020-01-06')`,
      [employeeId, `L002-${employeeId.slice(0, 8)}`],
    );
    const accountId = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status)
       VALUES ($1, NULL, $2, 'FOUNDATION_BOARD', 'active')`,
      [accountId, `organ-${accountId}@example.invalid`],
    );
    const loanId = randomUUID();
    await client.query(
      `INSERT INTO employee_loans (id, employee_id, principal_amount, tenor_months, purpose, status, idempotency_key)
       VALUES ($1, $2, 1000000, 3, 'Keperluan mendesak keluarga', 'IN_REVIEW', $3)`,
      [loanId, employeeId, randomUUID()],
    );
    const step = async (order: number, values: [string | null, string | null]) => client.query(
      `INSERT INTO employee_loan_approval_steps (
         id, loan_id, step_order, approver_employee_id, approver_account_id, sources, status
       ) VALUES ($1, $2, $3, $4, $5, ARRAY['SEAT_KETUA_YAYASAN']::text[], 'waiting')`,
      [randomUUID(), loanId, order, values[0], values[1]],
    );
    expect(await step(1, [employeeId, null])).toBeTruthy();
    expect(await step(2, [null, accountId])).toBeTruthy();
    expect((await refused(() => step(3, [null, null]))).code).toBe("23514");
    expect((await refused(() => step(4, [employeeId, accountId]))).code).toBe("23514");
  });

  it("ORG-013-E for loans: the role carries exactly the one loan governance permission", async () => {
    const grants = await client.query<{ permissionKey: string }>(
      `SELECT grant_row.permission_key AS "permissionKey"
         FROM roles role
         JOIN role_permissions grant_row ON grant_row.role_id = role.id
        WHERE role.role_key = 'governance_loan_approver'
        ORDER BY grant_row.permission_key`,
    );
    expect(grants.rows.map((row) => row.permissionKey)).toEqual(["loans.governance.approve"]);
    const role = await client.query<{ isSystem: boolean }>(
      `SELECT is_system AS "isSystem" FROM roles WHERE role_key = 'governance_loan_approver'`,
    );
    expect(role.rows[0]?.isSystem).toBe(true);
  });
});
