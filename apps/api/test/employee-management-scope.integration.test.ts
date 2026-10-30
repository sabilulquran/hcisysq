// EMP-005 S2B against real PostgreSQL: the CHECKs that keep the marker
// honest, and the two questions every consumer will ask of it. A fake pool
// can prove neither.
// Loopback CI database only; every write is rolled back.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { isOutsideHcis, outsideHcisEmployeeNumbers } from "../src/modules/employees/management-scope.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("EMP-005 §8.7 management scope, against PostgreSQL", () => {
  let pool: Pool;
  let client: PoolClient;
  let employeeId: string;
  let employeeNumber: string;
  let accountId: string;
  let savepoint = 0;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    employeeId = randomUUID();
    employeeNumber = `EMP-S2B-${employeeId}`;
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Pegawai Sintetis', 'active')",
      [employeeId, employeeNumber],
    );
    accountId = randomUUID();
    await client.query(
      "INSERT INTO accounts(id, email, principal_type, status, employee_id) VALUES ($1, $2, 'EMPLOYEE', 'active', $3)",
      [accountId, `s2b-${accountId}@example.org`, employeeId],
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

  function mark(reason: string | null, markedAt: string | null = "now()", note: string | null = "Dikonfirmasi HC") {
    return client.query(
      `UPDATE employees
       SET management_scope = 'OUTSIDE_HCIS',
           management_scope_reason = $2,
           management_scope_note = $4,
           management_scope_marked_at = ${markedAt ?? "NULL"},
           management_scope_marked_by_account_id = $3
       WHERE id = $1`,
      [employeeId, reason, accountId, note],
    );
  }

  it("starts every record managed by HCIS", async () => {
    const row = (await client.query<{ scope: string }>(
      "SELECT management_scope AS scope FROM employees WHERE id = $1",
      [employeeId],
    )).rows[0];
    expect(row?.scope).toBe("MANAGED");
    expect(await isOutsideHcis(client, employeeId)).toBe(false);
  });

  it("marks a record with a reason, and reports it to every write path", async () => {
    await mark("BUMY");
    expect(await isOutsideHcis(client, employeeId)).toBe(true);
    expect(await outsideHcisEmployeeNumbers(client, [employeeNumber])).toEqual(new Set([employeeNumber]));
  });

  it("carries the tightened marked-row rule from migration 0108", async () => {
    // Pinned on the definition itself: a rule tightened in a later migration
    // only reaches a database that actually ran it, and the shape of the
    // rule is what the cases below depend on.
    const definition = (await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'employees_management_scope_marked_check'`,
    )).rows[0]?.def ?? "";
    expect(definition).toContain("management_scope_note");
    expect(definition).toContain("management_scope_marked_by_account_id");
  });

  it("refuses a mark with no reason, an unknown reason, no marked-at, and no note", async () => {
    await expectViolation(() => mark(null), "23514");
    await expectViolation(() => mark("LAINNYA"), "23514");
    await expectViolation(() => mark("BUMY", null), "23514");
    // Without a note nobody can say later why this record left HCIS. Written
    // out in full rather than through the helper: the rule is about one
    // column being NULL, so the statement says NULL literally.
    await expectViolation(
      () => client.query(
        `UPDATE employees
         SET management_scope = 'OUTSIDE_HCIS',
             management_scope_reason = 'BUMY',
             management_scope_note = NULL,
             management_scope_marked_at = now(),
             management_scope_marked_by_account_id = $2
         WHERE id = $1`,
        [employeeId, accountId],
      ),
      "23514",
    );
  });

  it("refuses a managed row that still carries a marker", async () => {
    await mark("BUMY");
    // Clearing the scope but leaving when it was marked, or by whom, would
    // make MANAGED rows carry a marker that means nothing any more.
    await expectViolation(
      () => client.query(
        `UPDATE employees
         SET management_scope = 'MANAGED', management_scope_reason = NULL,
             management_scope_marked_by_account_id = NULL
         WHERE id = $1`,
        [employeeId],
      ),
      "23514",
    );
    await expectViolation(
      () => client.query(
        `UPDATE employees
         SET management_scope = 'MANAGED', management_scope_reason = NULL,
             management_scope_marked_at = NULL
         WHERE id = $1`,
        [employeeId],
      ),
      "23514",
    );
  });

  it("keeps the last note when the record is managed again", async () => {
    // The audit carries only the note's length, so the row is the one place
    // an unmark's justification can live (§8.7).
    await mark("BUMY");
    await client.query(
      `UPDATE employees
       SET management_scope = 'MANAGED', management_scope_reason = NULL,
           management_scope_note = 'Salah tanda, pegawai yayasan',
           management_scope_marked_at = NULL, management_scope_marked_by_account_id = NULL
       WHERE id = $1`,
      [employeeId],
    );
    const row = (await client.query<{ note: string | null }>(
      'SELECT management_scope_note AS note FROM employees WHERE id = $1',
      [employeeId],
    )).rows[0];
    expect(row?.note).toBe("Salah tanda, pegawai yayasan");
  });

  it("refuses a reason left behind on a record that is managed again", async () => {
    await mark("BUMY");
    await expectViolation(
      () => client.query("UPDATE employees SET management_scope = 'MANAGED' WHERE id = $1", [employeeId]),
      "23514",
    );
    // Unmarking clears the marker whole, which is what the route does.
    await client.query(
      `UPDATE employees SET management_scope = 'MANAGED', management_scope_reason = NULL,
         management_scope_marked_at = NULL, management_scope_marked_by_account_id = NULL
       WHERE id = $1`,
      [employeeId],
    );
    expect(await isOutsideHcis(client, employeeId)).toBe(false);
  });

  it("refuses a scope we do not know", async () => {
    await expectViolation(
      () => client.query("UPDATE employees SET management_scope = 'SEPARUH' WHERE id = $1", [employeeId]),
      "23514",
    );
  });

  it("is separate from removal and from employment status", async () => {
    // All three say different things, and marking must not disturb the others.
    await mark("PENGURUS_YAYASAN");
    const row = (await client.query<{ removedAt: Date | null; status: string; reason: string }>(
      `SELECT removed_at AS "removedAt", status, management_scope_reason AS reason
       FROM employees WHERE id = $1`,
      [employeeId],
    )).rows[0];
    expect(row).toMatchObject({ removedAt: null, status: "active", reason: "PENGURUS_YAYASAN" });
  });

  it("answers the import's question in numbers, and leaves managed rows out", async () => {
    const otherId = randomUUID();
    const otherNumber = `EMP-S2B-${otherId}`;
    await client.query(
      "INSERT INTO employees(id, employee_number, full_name, status) VALUES ($1, $2, 'Pegawai Lain', 'active')",
      [otherId, otherNumber],
    );
    await mark("BUMY");
    expect(await outsideHcisEmployeeNumbers(client, [employeeNumber, otherNumber]))
      .toEqual(new Set([employeeNumber]));
    expect(await outsideHcisEmployeeNumbers(client, [])).toEqual(new Set());
  });

  it("keeps the record's own history readable", async () => {
    // §8.7: nothing is deleted and nothing is rewritten; the row is still
    // there, with its number and name, for every reader that may see it.
    await mark("BUMY");
    const row = (await client.query<{ fullName: string; employeeNumber: string }>(
      `SELECT full_name AS "fullName", employee_number AS "employeeNumber" FROM employees WHERE id = $1`,
      [employeeId],
    )).rows[0];
    expect(row).toMatchObject({ fullName: "Pegawai Sintetis", employeeNumber });
  });
});
