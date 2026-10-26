import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { attendanceActionQueue } from "../src/modules/attendance/action-queue.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

// ATT-011-3 "Perlu tindakan" against the real schema. Synthetic rows inside one rolled-back transaction.
describe.skipIf(!allowed)("ATT-011-3 action queue (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let unitId: string;
  let employee: string;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  async function result(workDate: string, status: string, version = 1) {
    await client.query(
      `INSERT INTO attendance_result_versions (id, employee_id, work_date, version, status, input_hash)
       VALUES ($1::uuid, $2, $3::date, $4, $5, encode(sha256($1::uuid::text::bytea), 'hex'))`,
      [randomUUID(), employee, workDate, version, status],
    );
  }

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    unitId = randomUUID();
    employee = randomUUID();
    await client.query(
      "INSERT INTO organizational_units (id, normalized_name, name) VALUES ($1, $2, 'Synthetic Queue Unit')",
      [unitId, `Q-${unitId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO employees (id, employee_number, full_name, status, started_on, organizational_unit_id)
       VALUES ($1, $2, 'Synthetic Queue Employee', 'active', '2026-01-01', $3)`,
      [employee, `Q-${employee}`, unitId],
    );
    await client.query(
      `INSERT INTO attendance_clarifications (id, employee_id, work_date, kind, mode, reason)
       VALUES ($1, $2, '2026-10-20', 'lateness', 'justification', 'Ban bocor')`,
      [randomUUID(), employee],
    );
    await result("2026-10-15", "incomplete");
    await result("2026-10-16", "incomplete");
    await result("2026-10-16", "present", 2); // fixed by a later version: not in the queue
    await result("2026-10-25", "incomplete"); // yesterday-ish: a scan may still arrive
    await result("2026-10-21", "configuration_error");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  const queue = (kinds: Array<"clarification" | "mobile_review" | "incomplete" | "configuration_error">, kind: null | "incomplete" = null) =>
    attendanceActionQueue(client, {
      page: 1, pageSize: 25, from: "2026-10-01", to: "2026-10-26", incompleteBefore: "2026-10-24",
      unitId, kind, kinds,
    });

  it("merges clarifications, old incomplete days and schedule problems, oldest first, latest version only", async () => {
    const data = await queue(["clarification", "mobile_review", "incomplete", "configuration_error"]);
    expect(data.items.map((item) => [item.kind, item.workDate])).toEqual([
      ["incomplete", "2026-10-15"],
      ["clarification", "2026-10-20"],
      ["configuration_error", "2026-10-21"],
    ]);
    expect(data.counts).toEqual({ incomplete: 1, clarification: 1, configuration_error: 1 });
  });

  it("drops an incomplete day while the employee's clarification for it waits, and filters by kind", async () => {
    await client.query(
      `INSERT INTO attendance_clarifications (id, employee_id, work_date, kind, mode, reason)
       VALUES ($1, $2, '2026-10-15', 'missing_check_out', 'justification', 'Lupa scan')`,
      [randomUUID(), employee],
    );
    const data = await queue(["incomplete"], "incomplete");
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
  });

  it("shows nothing a reader cannot act on", async () => {
    const data = await queue(["configuration_error"]);
    expect(data.items.map((item) => item.kind)).toEqual(["configuration_error"]);
  });
});
