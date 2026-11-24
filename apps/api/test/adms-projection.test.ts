import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  admsSourceReference,
  projectAdmsAttendanceDay,
  resolveAdmsPunchWindow,
} from "../src/modules/attendance/adms/projection.js";

const databaseUrl = process.env.DATABASE_URL;

function punch(id: string, iso: string) {
  return { id, occurredAt: new Date(iso) };
}

describe("ATT-003 neutral punch projection helpers", () => {
  it("uses one punch as check-in only", () => {
    const window = resolveAdmsPunchWindow([
      punch("event-a", "2026-08-28T00:13:20.000Z"),
    ]);
    expect(window?.checkInAt.toISOString()).toBe("2026-08-28T00:13:20.000Z");
    expect(window?.checkOutAt).toBeNull();
    expect(window?.firstEventId).toBe("event-a");
    expect(window?.lastEventId).toBe("event-a");
  });

  it("uses deterministic earliest and latest punches without policy inference", () => {
    const window = resolveAdmsPunchWindow([
      punch("event-middle", "2026-08-28T05:00:00.000Z"),
      punch("event-last", "2026-08-28T09:00:00.000Z"),
      punch("event-first", "2026-08-28T00:13:20.000Z"),
    ]);
    expect(window?.checkInAt.toISOString()).toBe("2026-08-28T00:13:20.000Z");
    expect(window?.checkOutAt?.toISOString()).toBe("2026-08-28T09:00:00.000Z");
    expect(window?.firstEventId).toBe("event-first");
    expect(window?.lastEventId).toBe("event-last");
  });

  it("namespaces provenance under adms", () => {
    expect(admsSourceReference("first-id", "last-id")).toBe("adms:first-id:last-id");
  });
});

describe.skipIf(!databaseUrl)("ATT-003 PostgreSQL projection integration", () => {
  let pool: Pool;
  const employeeId = randomUUID();
  const manualEmployeeId = randomUUID();
  const deviceId = randomUUID();
  const requestId = randomUUID();
  const mappingId = randomUUID();
  const manualMappingId = randomUUID();
  const firstEventId = randomUUID();
  const middleEventId = randomUUID();
  const lastEventId = randomUUID();
  const manualEventId = randomUUID();
  const pin = "0042";
  const manualPin = "0043";

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl! });
    await pool.query(
      `INSERT INTO employees (id, employee_number, full_name, status)
       VALUES ($1, $2, 'ADMS Projection Synthetic', 'active'),
              ($3, $4, 'ADMS Manual Conflict Synthetic', 'active')`,
      [
        employeeId,
        `ADMS-${employeeId}`,
        manualEmployeeId,
        `ADMS-${manualEmployeeId}`,
      ],
    );
    await pool.query(
      `INSERT INTO attendance_adms_devices (
         id, serial_number, lifecycle, timezone, display_name
       ) VALUES ($1, $2, 'active', 'Asia/Jakarta', 'Synthetic ADMS Device')`,
      [deviceId, `SYNTH-${deviceId}`],
    );
    await pool.query(
      `INSERT INTO attendance_adms_request_journal (
         id, device_id, method, path, raw_query, safe_metadata, body,
         body_sha256, body_byte_length, body_captured, classification,
         response_status, response_body, received_at
       ) VALUES (
         $1, $2, 'POST', '/iclock/cdata', '?table=ATTLOG', '{}'::jsonb, NULL,
         NULL, 0, true, 'attlog', 200, 'OK: 4', '2026-08-28T10:00:00.000Z'
       )`,
      [requestId, deviceId],
    );
    await pool.query(
      `INSERT INTO attendance_adms_employee_mappings (
         id, device_id, pin, employee_id, effective_from
       ) VALUES
         ($1, $2, $3, $4, '2026-08-27T00:00:00.000Z'),
         ($5, $2, $6, $7, '2026-08-27T00:00:00.000Z')`,
      [mappingId, deviceId, pin, employeeId, manualMappingId, manualPin, manualEmployeeId],
    );
    await pool.query(
      `INSERT INTO attendance_adms_events (
         id, device_id, source_request_id, event_identity_hash, pin,
         occurred_at_raw, occurred_at, raw_line, raw_fields, raw_line_sha256, received_at
       ) VALUES
         ($1, $5, $6, $1::uuid::text, $7, '2026-08-28 07:13:20', '2026-08-28T00:13:20.000Z', 'first', '[]'::jsonb, $1::uuid::text, '2026-08-28T10:00:00.000Z'),
         ($2, $5, $6, $2::uuid::text, $7, '2026-08-28 12:00:00', '2026-08-28T05:00:00.000Z', 'middle', '[]'::jsonb, $2::uuid::text, '2026-08-28T10:00:00.000Z'),
         ($3, $5, $6, $3::uuid::text, $7, '2026-08-28 16:00:00', '2026-08-28T09:00:00.000Z', 'last', '[]'::jsonb, $3::uuid::text, '2026-08-28T10:00:00.000Z'),
         ($4, $5, $6, $4::uuid::text, $8, '2026-08-28 08:00:00', '2026-08-28T01:00:00.000Z', 'manual-conflict', '[]'::jsonb, $4::uuid::text, '2026-08-28T10:00:00.000Z')`,
      [
        firstEventId,
        middleEventId,
        lastEventId,
        manualEventId,
        deviceId,
        requestId,
        pin,
        manualPin,
      ],
    );
    await pool.query(
      `INSERT INTO attendance_daily_records (
         employee_id, attendance_date, check_in_at, source, source_reference, note
       ) VALUES ($1, '2026-08-28', '2026-08-28T00:30:00.000Z', 'manual', NULL, 'synthetic manual fact')`,
      [manualEmployeeId],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("projects mapped punches into one native integration daily record", async () => {
    const projected = await projectAdmsAttendanceDay(pool, employeeId, "2026-08-28");
    expect(projected.status).toBe("created");

    const result = await pool.query<{
      checkInAt: Date;
      checkOutAt: Date | null;
      source: string;
      sourceReference: string | null;
    }>(
      `SELECT
         check_in_at AS "checkInAt",
         check_out_at AS "checkOutAt",
         source,
         source_reference AS "sourceReference"
       FROM attendance_daily_records
       WHERE employee_id = $1 AND attendance_date = '2026-08-28'`,
      [employeeId],
    );
    expect(result.rows[0]?.checkInAt.toISOString()).toBe("2026-08-28T00:13:20.000Z");
    expect(result.rows[0]?.checkOutAt?.toISOString()).toBe("2026-08-28T09:00:00.000Z");
    expect(result.rows[0]?.source).toBe("integration");
    expect(result.rows[0]?.sourceReference).toBe(
      admsSourceReference(firstEventId, lastEventId),
    );
  });

  it("is idempotent when earliest/latest provenance is unchanged", async () => {
    const projected = await projectAdmsAttendanceDay(pool, employeeId, "2026-08-28");
    expect(projected.status).toBe("unchanged");
  });

  it("does not overwrite a manual daily record", async () => {
    const projected = await projectAdmsAttendanceDay(pool, manualEmployeeId, "2026-08-28");
    expect(projected.status).toBe("manual_conflict");
    const result = await pool.query<{ source: string; note: string | null }>(
      `SELECT source, note
       FROM attendance_daily_records
       WHERE employee_id = $1 AND attendance_date = '2026-08-28'`,
      [manualEmployeeId],
    );
    expect(result.rows[0]).toMatchObject({
      source: "manual",
      note: "synthetic manual fact",
    });
  });

  // ADMS-R2d: a corrected wrong mapping moves every scan away; the row ADMS projected is removed,
  // a manual row never is.
  it("clears the ADMS row of a day whose scans all left the employee, and keeps manual rows", async () => {
    const rightEmployeeId = randomUUID();
    await pool.query(
      `INSERT INTO employees (id, employee_number, full_name, status)
       VALUES ($1, $2, 'ADMS Right Owner Synthetic', 'active')`,
      [rightEmployeeId, `ADMS-${rightEmployeeId}`],
    );
    await pool.query(
      "UPDATE attendance_adms_employee_mappings SET employee_id = $2 WHERE id = ANY($1::uuid[])",
      [[mappingId, manualMappingId], rightEmployeeId],
    );

    const cleared = await projectAdmsAttendanceDay(pool, employeeId, "2026-08-28");
    expect(cleared.status).toBe("cleared");
    const gone = await pool.query(
      "SELECT 1 FROM attendance_daily_records WHERE employee_id = $1 AND attendance_date = '2026-08-28'",
      [employeeId],
    );
    expect(gone.rowCount).toBe(0);
    const audit = await pool.query<{ action: string; before_record: { source: string } | null }>(
      `SELECT action, before_record FROM attendance_adms_projection_audit_events
       WHERE employee_id = $1 AND attendance_date = '2026-08-28' ORDER BY created_at DESC LIMIT 1`,
      [employeeId],
    );
    expect(audit.rows[0]).toMatchObject({ action: "cleared", before_record: { source: "integration" } });
    expect((await projectAdmsAttendanceDay(pool, employeeId, "2026-08-28")).status).toBe("no_events");

    const manual = await projectAdmsAttendanceDay(pool, manualEmployeeId, "2026-08-28");
    expect(manual.status).toBe("no_events");
    const kept = await pool.query<{ source: string }>(
      "SELECT source FROM attendance_daily_records WHERE employee_id = $1 AND attendance_date = '2026-08-28'",
      [manualEmployeeId],
    );
    expect(kept.rows[0]?.source).toBe("manual");

    expect((await projectAdmsAttendanceDay(pool, rightEmployeeId, "2026-08-28")).status).toBe("created");
  });
});
