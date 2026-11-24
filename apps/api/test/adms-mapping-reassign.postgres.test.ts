import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { alignmentProjectionTargets } from "../src/modules/attendance/adms/mapping-alignment.js";
import { applyMappingReassign, planMappingReassign } from "../src/modules/attendance/adms/mapping-reassign.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

// ADMS-R2d "Ganti pegawai" against the real schema, overlap trigger and audit constraint.
// Synthetic rows only, inside one transaction that is always rolled back.
describe.skipIf(!allowed)("ADMS-R2d PIN mapped to the wrong employee (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let accountId: string;
  let deviceId: string;
  let requestId: string;
  let wrong: string;
  let right: string;
  let inactive: string;
  let noStart: string;
  let mapping: string;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  async function scan(at: string, pin = "R2D-1") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO attendance_adms_events (
         id, device_id, source_request_id, event_identity_hash, pin,
         occurred_at_raw, occurred_at, raw_line, raw_fields, raw_line_sha256, received_at
       ) VALUES ($1::uuid, $2, $3, $1::uuid::text, $5, $4::text, $4::text::timestamptz, 'synthetic', '[]'::jsonb,
                 $1::uuid::text, $4::text::timestamptz)`,
      [id, deviceId, requestId, at, pin],
    );
  }

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    accountId = randomUUID();
    wrong = randomUUID();
    right = randomUUID();
    inactive = randomUUID();
    noStart = randomUUID();
    await client.query(
      `INSERT INTO employees (id, employee_number, full_name, status, started_on) VALUES
         ($1::uuid, $5, 'Synthetic Wrong Pick', 'active', '2015-09-01'),
         ($2::uuid, $6, 'Synthetic Right Owner', 'active', '2019-07-01'),
         ($3::uuid, $7, 'Synthetic Resigned', 'resigned', '2018-01-01'),
         ($4::uuid, $8, 'Synthetic No TMT', 'active', NULL)`,
      [wrong, right, inactive, noStart, `R2D-${wrong}`, `R2D-${right}`, `R2D-${inactive}`, `R2D-${noStart}`],
    );
    await client.query(
      "INSERT INTO accounts (id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
      [accountId, right, `r2d-${accountId}@example.invalid`],
    );
    deviceId = randomUUID();
    requestId = randomUUID();
    await client.query(
      `INSERT INTO attendance_adms_devices (id, serial_number, lifecycle, timezone, display_name)
       VALUES ($1, $2, 'active', 'Asia/Jakarta', 'Synthetic R2d Device')`,
      [deviceId, `R2D-${deviceId}`],
    );
    await client.query(
      `INSERT INTO attendance_adms_request_journal (
         id, device_id, method, path, raw_query, safe_metadata, body, body_sha256, body_byte_length,
         body_captured, classification, response_status, response_body, received_at
       ) VALUES ($1, $2, 'POST', '/iclock/cdata', '?table=ATTLOG', '{}'::jsonb, NULL, NULL, 0, true, 'attlog', 200, 'OK', now())`,
      [requestId, deviceId],
    );
    // The admin picked the wrong employee: the mapping starts at the wrong employee's TMT.
    mapping = randomUUID();
    await client.query(
      `INSERT INTO attendance_adms_employee_mappings (id, device_id, pin, employee_id, effective_from)
       VALUES ($1, $2, 'R2D-1', $3, '2015-09-01T00:00:00+07:00')`,
      [mapping, deviceId, wrong],
    );
    await scan("2018-05-02T07:00:00+07:00"); // before the right owner's TMT: belongs to nobody after the fix
    await scan("2026-11-20T07:00:00+07:00");
    await scan("2026-11-24T07:05:00+07:00");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  it("plans the move to the right employee from their TMT", async () => {
    const plan = await planMappingReassign(client, mapping, right);
    expect(plan).toMatchObject({
      status: "change",
      pin: "R2D-1",
      effectiveTo: null,
      previous: { employeeId: wrong, effectiveFrom: "2015-08-31T17:00:00.000Z" },
      next: { employeeId: right, startedOn: "2019-07-01", effectiveFrom: "2019-06-30T17:00:00.000Z" },
      scansFromPrevious: 3,
      scansToNext: 2,
    });
  });

  it("applies with an audit row and returns the days of both employees to re-project", async () => {
    const { plan, spans } = await applyMappingReassign(client, mapping, right, accountId, "Salah pilih pegawai");
    expect(plan.status).toBe("change");
    const stored = await client.query(
      "SELECT employee_id, effective_from, effective_to FROM attendance_adms_employee_mappings WHERE id = $1",
      [mapping],
    );
    expect(stored.rows[0]).toMatchObject({ employee_id: right, effective_to: null });
    expect(stored.rows[0].effective_from.toISOString()).toBe("2019-06-30T17:00:00.000Z");

    const audit = await client.query(
      "SELECT action, before_state, after_state FROM attendance_adms_admin_audit_events WHERE mapping_id = $1",
      [mapping],
    );
    expect(audit.rows).toEqual([expect.objectContaining({
      action: "mapping_reassigned",
      before_state: expect.objectContaining({ employeeId: wrong, effectiveFrom: "2015-08-31T17:00:00.000Z" }),
      after_state: expect.objectContaining({ employeeId: right, reason: "Salah pilih pegawai", scansFromPrevious: 3, scansToNext: 2 }),
    })]);

    const targets = await alignmentProjectionTargets(client, spans);
    expect(targets).toEqual(expect.arrayContaining([
      { employeeId: wrong, attendanceDate: "2018-05-02" },
      { employeeId: wrong, attendanceDate: "2026-11-20" },
      { employeeId: wrong, attendanceDate: "2026-11-24" },
      { employeeId: right, attendanceDate: "2026-11-20" },
      { employeeId: right, attendanceDate: "2026-11-24" },
    ]));
    expect(targets).toHaveLength(5);

    const again = await planMappingReassign(client, mapping, right);
    expect(again.status).toBe("same_employee");
  });

  it("refuses an inactive employee, one without TMT, an unknown one and a start after the mapping ended", async () => {
    expect((await planMappingReassign(client, mapping, inactive)).status).toBe("employee_not_active");
    expect((await planMappingReassign(client, mapping, noStart)).status).toBe("missing_start_date");
    expect((await planMappingReassign(client, mapping, randomUUID())).status).toBe("employee_not_found");
    expect((await planMappingReassign(client, randomUUID(), right)).status).toBe("not_found");

    await client.query(
      "UPDATE attendance_adms_employee_mappings SET effective_to = '2019-01-01T00:00:00+07:00' WHERE id = $1",
      [mapping],
    );
    const ended = await applyMappingReassign(client, mapping, right, accountId, "Tidak boleh");
    expect(ended.plan.status).toBe("invalid_range");
    const stored = await client.query("SELECT employee_id FROM attendance_adms_employee_mappings WHERE id = $1", [mapping]);
    expect(stored.rows[0].employee_id).toBe(wrong);
  });

  it("starts after an earlier holder of a recycled PIN", async () => {
    await client.query(
      "UPDATE attendance_adms_employee_mappings SET effective_from = '2021-01-01T00:00:00+07:00' WHERE id = $1",
      [mapping],
    );
    await client.query(
      `INSERT INTO attendance_adms_employee_mappings (id, device_id, pin, employee_id, effective_from, effective_to)
       VALUES ($1, $2, 'R2D-1', $3, '2018-01-01T00:00:00+07:00', '2021-01-01T00:00:00+07:00')`,
      [randomUUID(), deviceId, inactive],
    );
    const plan = await planMappingReassign(client, mapping, right);
    expect(plan).toMatchObject({ status: "change", next: { effectiveFrom: "2020-12-31T17:00:00.000Z" }, scansToNext: 2 });
  });
});
