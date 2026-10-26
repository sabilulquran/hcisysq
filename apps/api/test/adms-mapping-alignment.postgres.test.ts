import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  alignmentProjectionTargets,
  alignmentSpans,
  applyMappingAlignment,
  planMappingAlignment,
  revertMappingAlignment,
  summarizeAlignment,
} from "../src/modules/attendance/adms/mapping-alignment.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

// ADMS-R2c "Sesuaikan dengan TMT" against the real schema, overlap trigger and audit constraint.
// Synthetic rows only, inside one transaction that is always rolled back.
describe.skipIf(!allowed)("ADMS-R2c PIN mapping aligned to TMT (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let accountId: string;
  let deviceId: string;
  let requestId: string;
  let previousHolder: string;
  let holder: string;
  let earlierMapping: string;
  let mapping: string;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  async function scan(at: string, pin = "R2C-1") {
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
    previousHolder = randomUUID();
    holder = randomUUID();
    await client.query(
      `INSERT INTO employees (id, employee_number, full_name, status, started_on)
       VALUES ($1, $3, 'Synthetic Previous Holder', 'resigned', '2025-01-01'),
              ($2, $4, 'Synthetic Holder', 'active', '2025-07-01')`,
      [previousHolder, holder, `R2C-${previousHolder}`, `R2C-${holder}`],
    );
    await client.query(
      "INSERT INTO accounts (id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
      [accountId, holder, `r2c-${accountId}@example.invalid`],
    );
    deviceId = randomUUID();
    requestId = randomUUID();
    await client.query(
      `INSERT INTO attendance_adms_devices (id, serial_number, lifecycle, timezone, display_name)
       VALUES ($1, $2, 'active', 'Asia/Jakarta', 'Synthetic R2c Device')`,
      [deviceId, `R2C-${deviceId}`],
    );
    await client.query(
      `INSERT INTO attendance_adms_request_journal (
         id, device_id, method, path, raw_query, safe_metadata, body, body_sha256, body_byte_length,
         body_captured, classification, response_status, response_body, received_at
       ) VALUES ($1, $2, 'POST', '/iclock/cdata', '?table=ATTLOG', '{}'::jsonb, NULL, NULL, 0, true, 'attlog', 200, 'OK', now())`,
      [requestId, deviceId],
    );
    // The PIN was recycled: an earlier employee held it until 1 Aug 2026; the new holder (TMT 1 Jul 2025)
    // was mapped on 19 Oct 2026.
    earlierMapping = randomUUID();
    mapping = randomUUID();
    await client.query(
      `INSERT INTO attendance_adms_employee_mappings (id, device_id, pin, employee_id, effective_from, effective_to)
       VALUES ($1, $2, 'R2C-1', $3, '2025-01-01T00:00:00+07:00', '2026-08-01T00:00:00+07:00')`,
      [earlierMapping, deviceId, previousHolder],
    );
    await client.query(
      `INSERT INTO attendance_adms_employee_mappings (id, device_id, pin, employee_id, effective_from)
       VALUES ($1, $2, 'R2C-1', $3, '2026-10-19T11:38:00+07:00')`,
      [mapping, deviceId, holder],
    );
    await scan("2026-07-15T07:00:00+07:00"); // the earlier holder's: stays theirs
    await scan("2026-09-01T07:01:00+07:00");
    await scan("2026-10-18T15:59:00+07:00");
    await scan("2026-10-20T07:00:00+07:00"); // already covered
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  it("plans the TMT start but never before the earlier holder let go of the PIN", async () => {
    const [item] = await planMappingAlignment(client, [mapping]);
    expect(item).toMatchObject({
      status: "change",
      startedOn: "2025-07-01",
      currentFrom: "2026-10-19T04:38:00.000Z",
      targetFrom: "2026-07-31T17:00:00.000Z",
      scansAdded: 2,
      scansRemoved: 0,
    });
    const earlier = await planMappingAlignment(client, [earlierMapping]);
    expect(earlier[0]).toMatchObject({ status: "unchanged", targetFrom: "2024-12-31T17:00:00.000Z" });
  });

  it("applies with an audit row holding the previous start, then reports the mapping as aligned", async () => {
    const items = await applyMappingAlignment(client, [mapping], accountId, "Pemetaan sejak TMT");
    expect(summarizeAlignment(items)).toMatchObject({ change: 1, scansAdded: 2 });
    const stored = await client.query("SELECT effective_from FROM attendance_adms_employee_mappings WHERE id = $1", [mapping]);
    expect(stored.rows[0].effective_from.toISOString()).toBe("2026-07-31T17:00:00.000Z");
    const audit = await client.query(
      "SELECT action, before_state, after_state FROM attendance_adms_admin_audit_events WHERE mapping_id = $1",
      [mapping],
    );
    expect(audit.rows).toEqual([expect.objectContaining({
      action: "mapping_aligned_to_start_date",
      before_state: { effectiveFrom: "2026-10-19T04:38:00.000Z" },
      after_state: expect.objectContaining({ effectiveFrom: "2026-07-31T17:00:00.000Z", reason: "Pemetaan sejak TMT", scansAdded: 2 }),
    })]);
    const again = await planMappingAlignment(client, [mapping]);
    expect(again[0]!.status).toBe("unchanged");
  });

  it("lists the employee-days whose legacy projection changes", async () => {
    const items = await planMappingAlignment(client, [mapping]);
    const targets = await alignmentProjectionTargets(client, alignmentSpans(items));
    expect(targets).toEqual([
      { employeeId: holder, attendanceDate: "2026-09-01" },
      { employeeId: holder, attendanceDate: "2026-10-18" },
    ]);
  });

  it("reverts a chain of alignments one step at a time, each audited", async () => {
    await applyMappingAlignment(client, [mapping], accountId, "Pertama");
    // TMT corrected later: a second alignment moves the start again.
    await client.query("UPDATE employees SET started_on = '2026-09-15' WHERE id = $1", [holder]);
    const second = await applyMappingAlignment(client, [mapping], accountId, "Kedua");
    expect(second[0]).toMatchObject({ status: "removes_scans" });
    await client.query("UPDATE employees SET started_on = '2026-08-15' WHERE id = $1", [holder]);
    const third = await applyMappingAlignment(client, [mapping], accountId, "Ketiga");
    expect(third[0]).toMatchObject({ status: "change", scansRemoved: 0 });

    const first = await revertMappingAlignment(client, mapping, accountId, "Pulihkan");
    expect(first).toMatchObject({ status: "reverted", effectiveFrom: "2026-07-31T17:00:00.000Z", scansMoved: 0 });
    const second2 = await revertMappingAlignment(client, mapping, accountId, "Pulihkan lagi");
    expect(second2).toMatchObject({ status: "reverted", effectiveFrom: "2026-10-19T04:38:00.000Z", scansMoved: 2 });
    expect((await revertMappingAlignment(client, mapping, accountId, "Habis")).status).toBe("not_aligned");
    const audit = await client.query(
      "SELECT action, count(*)::int AS n FROM attendance_adms_admin_audit_events WHERE mapping_id = $1 GROUP BY action ORDER BY action",
      [mapping],
    );
    expect(audit.rows).toEqual([
      { action: "mapping_aligned_to_start_date", n: 2 },
      { action: "mapping_alignment_reverted", n: 2 },
    ]);
  });

  it("reports a later TMT that would drop scans, and a TMT after the mapping ended, without applying them", async () => {
    await client.query("UPDATE employees SET started_on = '2026-10-21' WHERE id = $1", [holder]);
    const [later] = await planMappingAlignment(client, [mapping]);
    expect(later).toMatchObject({ status: "removes_scans", scansRemoved: 1 });
    const applied = await applyMappingAlignment(client, [mapping], accountId, "Tidak boleh");
    expect(applied[0]!.status).toBe("removes_scans");
    const stored = await client.query("SELECT effective_from FROM attendance_adms_employee_mappings WHERE id = $1", [mapping]);
    expect(stored.rows[0].effective_from.toISOString()).toBe("2026-10-19T04:38:00.000Z");

    await client.query("UPDATE employees SET started_on = '2026-09-01' WHERE id = $1", [previousHolder]);
    const [ended] = await planMappingAlignment(client, [earlierMapping]);
    expect(ended).toMatchObject({ status: "invalid_range" });
  });

  it("starts after the latest earlier holder when the PIN was recycled more than once", async () => {
    await client.query(
      `INSERT INTO attendance_adms_employee_mappings (id, device_id, pin, employee_id, effective_from, effective_to)
       VALUES ($1, $2, 'R2C-1', $3, '2026-08-01T00:00:00+07:00', '2026-09-01T00:00:00+07:00')`,
      [randomUUID(), deviceId, previousHolder],
    );
    const [planned] = await planMappingAlignment(client, [mapping]);
    // The latest earlier end (1 Sep) wins; the 1 Sep and 18 Oct scans move, nothing overlaps.
    expect(planned).toMatchObject({ status: "change", targetFrom: "2026-08-31T17:00:00.000Z", scansAdded: 2 });
  });
});
