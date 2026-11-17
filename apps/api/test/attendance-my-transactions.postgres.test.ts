// ATT-014 §6.5c (DRAFT) Transaksi saya against a real schema: own punches only, through the PIN
// mapping valid at scan time, live (no calculation), flagged when recorded after the latest result.
// Synthetic identities only; every test runs inside one rolled-back transaction.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { myAttendanceTransactions } from "../src/modules/attendance/my-transactions.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("ATT-014 §6.5c Transaksi saya", () => {
  let pool: Pool;
  let client: PoolClient;
  let me: string;
  let other: string;
  let deviceId: string;
  let requestId: string;

  async function scan(at: string, pin: string, recordedAt = at) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO attendance_adms_events (
         id, device_id, source_request_id, event_identity_hash, pin,
         occurred_at_raw, occurred_at, raw_line, raw_fields, raw_line_sha256, received_at, created_at
       ) VALUES ($1::uuid, $2, $3, $1::uuid::text, $5, $4::text, $4::text::timestamptz, 'synthetic', '[]'::jsonb,
                 $1::uuid::text, $6::text::timestamptz, $6::text::timestamptz)`,
      [id, deviceId, requestId, at, pin, recordedAt],
    );
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    me = randomUUID();
    other = randomUUID();
    await client.query(
      `INSERT INTO employees (id, employee_number, full_name, status, started_on)
       VALUES ($1, $3, 'Synthetic Me', 'active', '2025-01-01'),
              ($2, $4, 'Synthetic Other', 'active', '2025-01-01')`,
      [me, other, `TRX-${me}`, `TRX-${other}`],
    );
    deviceId = randomUUID();
    requestId = randomUUID();
    await client.query(
      `INSERT INTO attendance_adms_devices (id, serial_number, lifecycle, timezone, display_name)
       VALUES ($1, $2, 'active', 'Asia/Jakarta', 'Mesin Lobi Sintetis')`,
      [deviceId, `TRX-${deviceId}`],
    );
    await client.query(
      `INSERT INTO attendance_adms_request_journal (
         id, device_id, method, path, raw_query, safe_metadata, body, body_sha256, body_byte_length,
         body_captured, classification, response_status, response_body, received_at
       ) VALUES ($1, $2, 'POST', '/iclock/cdata', '?table=ATTLOG', '{}'::jsonb, NULL, NULL, 0, true, 'attlog', 200, 'OK', now())`,
      [requestId, deviceId],
    );
    // PIN TRX-1 belonged to the other employee until 10 Nov 2026 07:00 WIB, then to me.
    await client.query(
      `INSERT INTO attendance_adms_employee_mappings (id, device_id, pin, employee_id, effective_from, effective_to)
       VALUES ($1, $2, 'TRX-1', $3, '2025-01-01T00:00:00+07:00', '2026-11-10T07:00:00+07:00')`,
      [randomUUID(), deviceId, other],
    );
    await client.query(
      `INSERT INTO attendance_adms_employee_mappings (id, device_id, pin, employee_id, effective_from)
       VALUES ($1, $2, 'TRX-1', $3, '2026-11-10T07:00:00+07:00')`,
      [randomUUID(), deviceId, me],
    );
    // PIN TRX-2 is always the other employee's.
    await client.query(
      `INSERT INTO attendance_adms_employee_mappings (id, device_id, pin, employee_id, effective_from)
       VALUES ($1, $2, 'TRX-2', $3, '2025-01-01T00:00:00+07:00')`,
      [randomUUID(), deviceId, other],
    );
  });

  afterEach(async () => {
    await client?.query("ROLLBACK");
    client?.release();
  });

  it("reads only my punches, through the mapping valid at scan time", async () => {
    await scan("2026-11-10T06:55:00+07:00", "TRX-1"); // still the other employee's
    await scan("2026-11-10T07:05:00+07:00", "TRX-1"); // mine
    await scan("2026-11-10T16:10:00+07:00", "TRX-1"); // mine
    await scan("2026-11-10T07:00:00+07:00", "TRX-2"); // the other employee's
    await scan("2026-11-12T07:00:00+07:00", "TRX-UNMAPPED");
    await client.query(
      `INSERT INTO attendance_events (id, employee_id, source, event_kind, occurred_at, source_reference)
       VALUES ($1, $2, 'mobile', 'check_in', '2026-11-11T07:30:00+07:00', $3),
              ($4, $5, 'mobile', 'check_in', '2026-11-11T07:31:00+07:00', $6)`,
      [randomUUID(), me, `test:${randomUUID()}`, randomUUID(), other, `test:${randomUUID()}`],
    );

    const body = await myAttendanceTransactions(client, me, "2026-11-09", "2026-11-12");
    expect(body.truncated).toBe(false);
    expect(body.items.map((item) => [item.occurredAt, item.source, item.kind, item.deviceName])).toEqual([
      ["2026-11-10T00:05:00.000Z", "adms", null, "Mesin Lobi Sintetis"],
      ["2026-11-10T09:10:00.000Z", "adms", null, "Mesin Lobi Sintetis"],
      ["2026-11-11T00:30:00.000Z", "mobile", "check_in", null],
    ]);
    expect(body.days).toEqual([
      { workDate: "2026-11-10", firstScanAt: "2026-11-10T00:05:00.000Z", lastScanAt: "2026-11-10T09:10:00.000Z", scanCount: 2, calculatedAt: null, newSinceCalculation: false },
      { workDate: "2026-11-11", firstScanAt: "2026-11-11T00:30:00.000Z", lastScanAt: null, scanCount: 1, calculatedAt: null, newSinceCalculation: false },
    ]);
    // Nothing internal leaks.
    expect(JSON.stringify(body)).not.toMatch(/TRX-|pin|serial/i);

    const theirs = await myAttendanceTransactions(client, other, "2026-11-10", "2026-11-11");
    expect(theirs.items.map((item) => item.occurredAt)).toEqual([
      "2026-11-09T23:55:00.000Z",
      "2026-11-10T00:00:00.000Z",
      "2026-11-11T00:31:00.000Z",
    ]);
  });

  it("keeps the WIB calendar range and flags punches recorded after the latest result", async () => {
    await scan("2026-11-09T23:59:00+07:00", "TRX-1"); // before the mapping, and outside the range
    await scan("2026-11-10T07:05:00+07:00", "TRX-1", "2026-11-10T07:06:00+07:00");
    await scan("2026-11-10T16:10:00+07:00", "TRX-1", "2026-11-10T18:00:00+07:00"); // arrived after the run
    await scan("2026-11-11T00:01:00+07:00", "TRX-1"); // next WIB day, outside the range
    await client.query(
      `INSERT INTO attendance_result_versions (id, employee_id, work_date, version, status, input_hash, created_at)
       VALUES ($1::uuid, $2, '2026-11-10', 1, 'incomplete', encode(sha256($1::uuid::text::bytea), 'hex'), '2026-11-10T12:00:00+07:00')`,
      [randomUUID(), me],
    );

    const body = await myAttendanceTransactions(client, me, "2026-11-10", "2026-11-10");
    expect(body.items.map((item) => [item.occurredAt, item.afterCalculation])).toEqual([
      ["2026-11-10T00:05:00.000Z", false],
      ["2026-11-10T09:10:00.000Z", true],
    ]);
    expect(body.days).toEqual([{
      workDate: "2026-11-10",
      firstScanAt: "2026-11-10T00:05:00.000Z",
      lastScanAt: "2026-11-10T09:10:00.000Z",
      scanCount: 2,
      calculatedAt: "2026-11-10T05:00:00.000Z",
      newSinceCalculation: true,
    }]);
  });
});
