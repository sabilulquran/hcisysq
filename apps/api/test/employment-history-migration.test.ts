// 0056 EMP-005/EMP-006/EMP-010 S1 schema guards against real PostgreSQL.
// Runs only against the loopback CI database; every write is rolled back.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("0056 employment history foundation migration", () => {
  let pool: Pool;
  let client: PoolClient;
  let employeeId: string;
  let unitId: string;
  let savepoint = 0;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    employeeId = randomUUID();
    unitId = randomUUID();
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Synthetic Employment Test', 'active')",
      [employeeId, `EMP-HIST-${employeeId}`],
    );
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Synthetic Unit')",
      [unitId, `synthetic-unit-${unitId}`],
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  async function expectSqlError(sql: string, values: unknown[], code: string) {
    const name = `employment_test_${++savepoint}`;
    await client.query(`SAVEPOINT ${name}`);
    let caught: unknown;
    try {
      await client.query(sql, values);
    } catch (error) {
      caught = error;
    }
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    expect((caught as { code?: string } | undefined)?.code).toBe(code);
  }

  async function insertEmployment(startedOn: string | null, endedOn: string | null = null) {
    const employmentId = randomUUID();
    const actionId = randomUUID();
    await client.query(
      `INSERT INTO employments(id, employee_id, started_on, start_basis, ended_on, end_basis, end_reason, end_precision, source, opened_by_action_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTION', $9)`,
      [
        employmentId, employeeId, startedOn, startedOn ? "RECORDED" : "UNKNOWN", endedOn,
        endedOn ? "RECORDED" : null, endedOn ? "RESIGN" : null, endedOn ? "DAY" : null, actionId,
      ],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on)
       VALUES ($1, $2, $3, 'HIRE', $4)`,
      [actionId, employeeId, employmentId, startedOn ?? "2020-01-01"],
    );
    return { employmentId, actionId };
  }

  it("creates the additive tables without seeding a rollout row (mode OFF)", async () => {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'employment%'
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "employment_action_documents",
      "employment_actions",
      "employment_audit_events",
      "employment_decision_document_corrections",
      "employment_decision_documents",
      "employment_placements",
      "employment_rollout_settings",
      "employment_terms",
      "employments",
    ]);
    const settings = await client.query("SELECT 1 FROM employment_rollout_settings");
    expect(settings.rowCount).toBe(0);
  });

  it("rejects overlapping employments and allows a later rehire", async () => {
    await insertEmployment("2025-01-01", "2026-12-31");
    const rehire = await insertEmployment("2027-01-01");
    expect(rehire.employmentId).toBeTruthy();
    await expectSqlError(
      `INSERT INTO employments(id, employee_id, started_on, start_basis, source, opened_by_action_id)
       VALUES ($1, $2, '2027-06-01', 'RECORDED', 'ACTION', $3)`,
      [randomUUID(), employeeId, rehire.actionId],
      "23P01",
    );
  });

  it("rejects overlapping terms and overlapping primary placements, but allows additional ones", async () => {
    const { employmentId, actionId } = await insertEmployment("2027-01-01");
    await client.query(
      `INSERT INTO employment_terms(id, employment_id, sequence, category, effective_from, effective_to, opened_by_action_id)
       VALUES ($1, $2, 1, 'KONTRAK', '2027-01-01', '2027-12-31', $3)`,
      [randomUUID(), employmentId, actionId],
    );
    await expectSqlError(
      `INSERT INTO employment_terms(id, employment_id, sequence, category, effective_from, effective_to, opened_by_action_id)
       VALUES ($1, $2, 2, 'KONTRAK', '2027-12-01', '2028-11-30', $3)`,
      [randomUUID(), employmentId, actionId],
      "23P01",
    );

    const placement = `INSERT INTO employment_placements(id, employment_id, kind, legacy_unit_id, job_title_label, effective_from, effective_from_basis, opened_by_action_id)
       VALUES ($1, $2, $3, $4, 'Guru', $5, 'RECORDED', $6)`;
    await client.query(placement, [randomUUID(), employmentId, "PRIMARY", unitId, "2027-01-01", actionId]);
    await expectSqlError(placement, [randomUUID(), employmentId, "PRIMARY", unitId, "2027-06-01", actionId], "23P01");
    await client.query(placement, [randomUUID(), employmentId, "ADDITIONAL", unitId, "2027-06-01", actionId]);
  });

  it("requires exactly one unit reference on a placement", async () => {
    const { employmentId, actionId } = await insertEmployment("2027-01-01");
    await expectSqlError(
      `INSERT INTO employment_placements(id, employment_id, kind, org_node_key, legacy_unit_id, job_title_label, effective_from, effective_from_basis, opened_by_action_id)
       VALUES ($1, $2, 'PRIMARY', $3, $4, 'Guru', '2027-01-01', 'RECORDED', $5)`,
      [randomUUID(), employmentId, randomUUID(), unitId, actionId],
      "23514",
    );
  });

  it("forbids deleting history rows unless the baseline purge opts in", async () => {
    const { employmentId, actionId } = await insertEmployment("2027-01-01");
    const termId = randomUUID();
    await client.query(
      `INSERT INTO employment_terms(id, employment_id, sequence, category, effective_from, opened_by_action_id)
       VALUES ($1, $2, 1, 'TETAP', '2027-01-01', $3)`,
      [termId, employmentId, actionId],
    );
    await expectSqlError("DELETE FROM employment_terms WHERE id = $1", [termId], "23001");
    await client.query("SET LOCAL hcis.employment_baseline_purge = 'on'");
    const deleted = await client.query("DELETE FROM employment_terms WHERE id = $1", [termId]);
    expect(deleted.rowCount).toBe(1);
  });

  it("keeps Perjanjian Kerja and SK fields separate and numbers them in separate series (EMP-010)", async () => {
    const insertPk = `INSERT INTO employment_decision_documents(id, document_kind, document_number, signed_on, pk_type, employee_id, contract_from, contract_to, category)
       VALUES ($1, 'PERJANJIAN_KERJA', $2, '2027-06-15', 'PK_BARU', $3, '2027-07-01', '2028-06-30', 'KONTRAK')`;
    await client.query(insertPk, [randomUUID(), "001/PK/2027", employeeId]);
    await expectSqlError(insertPk, [randomUUID(), "001/pk/2027 ", employeeId], "23505");

    // The same number is allowed as an SK: PK and SK are different series.
    await client.query(
      `INSERT INTO employment_decision_documents(id, document_kind, document_number, signed_on, sk_type, subject, issuing_authority_label, effective_on)
       VALUES ($1, 'SURAT_KEPUTUSAN', '001/PK/2027', '2027-06-15', 'SK_MUTASI', 'Mutasi sintetis', 'Ketua Yayasan', '2027-07-01')`,
      [randomUUID()],
    );
    // A PK carrying SK fields is rejected.
    await expectSqlError(
      `INSERT INTO employment_decision_documents(id, document_kind, document_number, signed_on, pk_type, employee_id, contract_from, contract_to, category, sk_type)
       VALUES ($1, 'PERJANJIAN_KERJA', '002/PK/2027', '2027-06-15', 'PK_BARU', $2, '2027-07-01', '2028-06-30', 'KONTRAK', 'SK_MUTASI')`,
      [randomUUID(), employeeId],
      "23514",
    );
  });

  it("requires a reason code for termination and a target for a reversal", async () => {
    const { employmentId } = await insertEmployment("2027-01-01");
    await expectSqlError(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on)
       VALUES ($1, $2, $3, 'TERMINATION', '2027-12-31')`,
      [randomUUID(), employeeId, employmentId],
      "23514",
    );
    await expectSqlError(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on, reason_code)
       VALUES ($1, $2, $3, 'REVERSAL', '2027-12-31', 'X')`,
      [randomUUID(), employeeId, employmentId],
      "23514",
    );
  });
});
