// EMP-010-A against real PostgreSQL: the jsonb snapshot term against contract_from::text,
// the document lock that a link sets, and the baseline purge keeping linked evidence.
// Only runs on the loopback CI database; every write is rolled back.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EMPLOYMENT_POLICY as policy, planDocumentLink, type LinkableAction } from "../src/modules/employment/domain/index.js";
import { loadDecisionDocumentRefs } from "../src/modules/employment/infrastructure/postgres-action-store.js";
import { getDecisionDocument } from "../src/modules/employment/infrastructure/postgres-decision-document-store.js";
import { purgeBaseline } from "../src/modules/employment/infrastructure/postgres-employment-store.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("EMP-010-A document links against PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  async function employmentWithAction(actionType: string, snapshot: Record<string, unknown>) {
    const employeeId = randomUUID();
    const employmentId = randomUUID();
    const baselineId = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Pegawai Sintetis S4b', 'active')`,
      [employeeId, `EMP-S4B-${employeeId}`],
    );
    await client.query(
      `INSERT INTO employments(id, employee_id, staff_type, started_on, start_basis, service_start_on, source, opened_by_action_id)
       VALUES ($1, $2, 'PENDIDIK', '2026-07-01', 'RECORDED', '2026-07-01', 'BASELINE_FROM_MASTER', $3)`,
      [employmentId, employeeId, baselineId],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, recorded_at)
       VALUES ($1, $2, $3, 'BASELINE', now() - interval '1 day')`,
      [baselineId, employeeId, employmentId],
    );
    let actionId = baselineId;
    if (actionType !== "BASELINE") {
      actionId = randomUUID();
      await client.query(
        `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, effective_on, new_snapshot, recorded_at)
         VALUES ($1, $2, $3, $4, '2027-07-01', $5::jsonb, now())`,
        [actionId, employeeId, employmentId, actionType, JSON.stringify(snapshot)],
      );
    }
    return { employeeId, employmentId, actionId };
  }

  async function addPk(employeeId: string, from: string, to: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employment_decision_documents(id, document_kind, document_number, signed_on, pk_type, employee_id,
         contract_from, contract_to, category)
       VALUES ($1, 'PERJANJIAN_KERJA', $2, '2027-06-20', 'PK_PERPANJANGAN', $3, $4, $5, 'KONTRAK')`,
      [id, `PK-S4B-${id}`, employeeId, from, to],
    );
    return id;
  }

  async function action(actionId: string): Promise<LinkableAction> {
    const row = await client.query(
      `SELECT id, employee_id AS "employeeId", action_type AS "actionType", state, reason_code AS "reasonCode",
              new_snapshot AS "newSnapshot"
       FROM employment_actions WHERE id = $1 FOR UPDATE`,
      [actionId],
    );
    return row.rows[0];
  }

  it("compares the stored jsonb term with the PK dates read as text", async () => {
    const { employeeId, actionId } = await employmentWithAction("CONTRACT_EXTENSION", {
      category: "KONTRAK", termFrom: "2027-07-01", termTo: "2028-06-30",
    });
    const matching = await addPk(employeeId, "2027-07-01", "2028-06-30");
    const other = await addPk(employeeId, "2027-07-01", "2028-12-31");
    const refs = await loadDecisionDocumentRefs(client, [matching, other]);
    const target = await action(actionId);
    expect(planDocumentLink(target, refs.filter((ref) => ref.id === matching), [], policy).link).toEqual([matching]);
    expect(() => planDocumentLink(target, refs.filter((ref) => ref.id === other), [], policy)).toThrow(/Masa kontrak/);
  });

  it("locks a document once it is linked, so a plain edit sees it as linked", async () => {
    const { employeeId, actionId } = await employmentWithAction("CONTRACT_EXTENSION", {
      category: "KONTRAK", termFrom: "2027-07-01", termTo: "2028-06-30",
    });
    const pk = await addPk(employeeId, "2027-07-01", "2028-06-30");
    expect((await getDecisionDocument(client, pk))?.linkedActionCount).toBe(0);
    await client.query("INSERT INTO employment_action_documents (action_id, document_id) VALUES ($1, $2)", [actionId, pk]);
    expect((await getDecisionDocument(client, pk))?.linkedActionCount).toBe(1);
  });

  it("keeps a baseline employment whose baseline carries a linked document when purging", async () => {
    const linked = await employmentWithAction("BASELINE", {});
    const plain = await employmentWithAction("BASELINE", {});
    const pk = await addPk(linked.employeeId, "2026-07-01", "2027-06-30");
    await client.query("INSERT INTO employment_action_documents (action_id, document_id) VALUES ($1, $2)", [linked.actionId, pk]);
    const purged = await purgeBaseline(client, [linked.employeeId, plain.employeeId]);
    expect(purged).toBe(1);
    const left = await client.query("SELECT id FROM employments WHERE id = ANY($1::uuid[])", [[linked.employmentId, plain.employmentId]]);
    expect(left.rows.map((row) => row.id)).toEqual([linked.employmentId]);
  });
});
