// EMP-003 P2-4 against real PostgreSQL. What matters here is the table's own
// state machine — a decided proposal must name its decider, a rejection must
// carry a reason — and that the worklist's two queries agree. A fake pool can
// prove neither.
// Loopback CI database only; every write is rolled back.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  decideDataChangeRequest,
  getDataChangeRequest,
  insertDataChangeRequest,
  listDataChangeRequests,
  listOwnDataChangeRequests,
  lockDataChangeRequest,
  updateEmployeeContact,
} from "../src/modules/employees/infrastructure/postgres-employee-profile-store.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

const ADDRESS_PAYLOAD = {
  kind: "DOMISILI",
  addressLine: "Jalan Sintetis 9",
  city: "Bandung",
  validFrom: "2026-11-01",
};

describe.skipIf(!allowed)("EMP-003 §4.5 usulan perubahan data, against PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;
  let employeeId: string;
  let accountId: string;
  let unitId: string;
  let savepoint = 0;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Sintetis P24')",
      [unitId, `unit-p24-${unitId}`],
    );
    employeeId = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, organizational_unit_id)
       VALUES ($1, $2, 'Pegawai Sintetis', 'active', $3)`,
      [employeeId, `EMP-P24-${employeeId}`, unitId],
    );
    accountId = randomUUID();
    await client.query(
      "INSERT INTO accounts(id, email, principal_type, status, employee_id) VALUES ($1, $2, 'EMPLOYEE', 'active', $3)",
      [accountId, `p24-${accountId}@example.org`, employeeId],
    );
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  async function expectViolation(work: () => Promise<unknown>, code: string) {
    savepoint += 1;
    const name = `sp_${savepoint}`;
    await client.query(`SAVEPOINT ${name}`);
    let thrown: { code?: string } | null = null;
    try {
      await work();
    } catch (error) {
      thrown = error as { code?: string };
    }
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    expect(thrown?.code).toBe(code);
  }

  function submit(target = "ALAMAT" as const, payload: Record<string, unknown> = ADDRESS_PAYLOAD) {
    return insertDataChangeRequest(client, {
      employeeId,
      submittedByAccountId: accountId,
      target,
      payload,
    });
  }

  it("opens a proposal as DIAJUKAN with nothing decided", async () => {
    const id = await submit();
    expect(await getDataChangeRequest(client, id)).toMatchObject({
      state: "DIAJUKAN",
      decidedAt: null,
      decidedByAccountId: null,
      decisionNote: null,
      employeeId,
      unitName: "Unit Sintetis P24",
    });
  });

  it("refuses a decision that names no decider, and a rejection with no reason", async () => {
    const id = await submit();
    await expectViolation(
      () => decideDataChangeRequest(client, id, { state: "DITERIMA", decidedByAccountId: null, decisionNote: null }),
      "23514",
    );
    await expectViolation(
      () => decideDataChangeRequest(client, id, { state: "DITOLAK", decidedByAccountId: accountId, decisionNote: null }),
      "23514",
    );
    await expectViolation(
      () => decideDataChangeRequest(client, id, { state: "DITOLAK", decidedByAccountId: accountId, decisionNote: "x" }),
      "23514",
    );
  });

  it("lets the proposer withdraw without naming a decider", async () => {
    const id = await submit();
    await decideDataChangeRequest(client, id, { state: "DIBATALKAN", decidedByAccountId: null, decisionNote: null });
    expect(await getDataChangeRequest(client, id)).toMatchObject({ state: "DIBATALKAN", decidedByAccountId: null });
  });

  it("accepts with a decider and a note", async () => {
    const id = await submit();
    await decideDataChangeRequest(client, id, {
      state: "DITERIMA",
      decidedByAccountId: accountId,
      decisionNote: "Sesuai dokumen",
    });
    expect(await getDataChangeRequest(client, id)).toMatchObject({
      state: "DITERIMA",
      decidedByAccountId: accountId,
      decisionNote: "Sesuai dokumen",
    });
  });

  it("reports the proposal and its employee to the lock, removal included", async () => {
    const id = await submit();
    expect(await lockDataChangeRequest(client, id))
      .toMatchObject({ employeeId, state: "DIAJUKAN", target: "ALAMAT", employeeRemoved: false });
    expect(await lockDataChangeRequest(client, randomUUID())).toBeNull();
    await client.query(
      "UPDATE employees SET removed_at = now(), removal_reason = 'Uji sintetis' WHERE id = $1",
      [employeeId],
    );
    expect((await lockDataChangeRequest(client, id))!.employeeRemoved).toBe(true);
  });

  it("gives the employee their own proposals, newest first", async () => {
    const first = await submit();
    await client.query("UPDATE employee_data_change_requests SET created_at = now() - interval '2 days' WHERE id = $1", [first]);
    const second = await submit("KONTAK", { email: "pegawai@example.org", phone: null });
    const rows = await listOwnDataChangeRequests(client, employeeId);
    expect(rows.map((row) => row.id)).toEqual([second, first]);
  });

  it("gives HC the ones waiting longest first, filtered by state and unit", async () => {
    const older = await submit();
    await client.query("UPDATE employee_data_change_requests SET created_at = now() - interval '9 days' WHERE id = $1", [older]);
    const newer = await submit("KEAHLIAN", { kind: "KEAHLIAN", name: "Excel", category: "TEKNOLOGI" });
    const decided = await submit("KONTAK", { email: "lain@example.org" });
    await decideDataChangeRequest(client, decided, {
      state: "DITOLAK",
      decidedByAccountId: accountId,
      decisionNote: "Tidak sesuai dokumen",
    });

    const pending = await listDataChangeRequests(client, { state: "DIAJUKAN", unitId, page: 1, pageSize: 100 });
    expect(pending.rows.map((row) => row.id)).toEqual([older, newer]);
    expect(pending.total).toBe(2);

    const rejected = await listDataChangeRequests(client, { state: "DITOLAK", unitId, page: 1, pageSize: 100 });
    expect(rejected.rows.map((row) => row.id)).toEqual([decided]);

    const otherUnit = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1, $2, 'Unit Lain P24')",
      [otherUnit, `unit-p24b-${otherUnit}`],
    );
    expect((await listDataChangeRequests(client, { state: "DIAJUKAN", unitId: otherUnit, page: 1, pageSize: 100 })).total)
      .toBe(0);
  });

  it("counts the real total even on a page past the end, with and without a filter", async () => {
    await submit();
    await submit();
    for (const unit of [unitId, null]) {
      const first = await listDataChangeRequests(client, { state: "DIAJUKAN", unitId: unit, page: 1, pageSize: 1 });
      const far = await listDataChangeRequests(client, { state: "DIAJUKAN", unitId: unit, page: 99, pageSize: 1 });
      expect(first.rows).toHaveLength(1);
      expect(far.rows).toHaveLength(0);
      expect(far.total).toBe(first.total);
      expect(far.total).toBeGreaterThanOrEqual(2);
    }
  });

  it("writes a contact proposal to the master's own columns", async () => {
    await updateEmployeeContact(client, employeeId, { email: "baru@example.org", phone: "0800000001" });
    const row = (await client.query<{ email: string | null; phone: string | null }>(
      "SELECT email, phone FROM employees WHERE id = $1",
      [employeeId],
    )).rows[0];
    expect(row).toMatchObject({ email: "baru@example.org", phone: "0800000001" });
  });

  it("refuses a target it does not know and a payload that is not an object", async () => {
    await expectViolation(() => submit("GAJI" as never), "23514");
    await expectViolation(
      () => client.query(
        `INSERT INTO employee_data_change_requests (id, employee_id, submitted_by_account_id, target, payload)
         VALUES ($1, $2, $3, 'ALAMAT', '[]'::jsonb)`,
        [randomUUID(), employeeId, accountId],
      ),
      "23514",
    );
  });
});
