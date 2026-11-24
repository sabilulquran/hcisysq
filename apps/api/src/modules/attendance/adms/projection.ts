import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

export type AdmsPunchBoundaryInput = {
  id: string;
  occurredAt: Date;
};

export type AdmsPunchWindow = {
  checkInAt: Date;
  checkOutAt: Date | null;
  firstEventId: string;
  lastEventId: string;
};

type PunchRow = AdmsPunchBoundaryInput & {
  mappingId: string;
};

type AttendanceRow = {
  employeeId: string;
  attendanceDate: string;
  checkInAt: Date | null;
  checkOutAt: Date | null;
  source: "manual" | "integration";
  sourceReference: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ProjectionTargetRow = {
  employeeId: string;
  attendanceDate: string;
};

export type AdmsProjectionResult = {
  employeeId: string;
  attendanceDate: string;
  status:
    | "created"
    | "updated"
    | "unchanged"
    | "manual_conflict"
    | "foreign_integration_conflict"
    | "no_events"
    | "cleared";
};

export function resolveAdmsPunchWindow(
  punches: readonly AdmsPunchBoundaryInput[],
): AdmsPunchWindow | null {
  if (punches.length === 0) return null;
  const sorted = [...punches].sort((left, right) => {
    const timeDifference = left.occurredAt.getTime() - right.occurredAt.getTime();
    return timeDifference !== 0 ? timeDifference : left.id.localeCompare(right.id);
  });
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  return {
    checkInAt: first.occurredAt,
    checkOutAt: sorted.length > 1 ? last.occurredAt : null,
    firstEventId: first.id,
    lastEventId: last.id,
  };
}

export function admsSourceReference(firstEventId: string, lastEventId: string) {
  return `adms:${firstEventId}:${lastEventId}`;
}

function sameInstant(left: Date | null, right: Date | null) {
  return left?.getTime() === right?.getTime();
}

function snapshotAttendance(row: AttendanceRow | null) {
  if (!row) return null;
  return {
    employeeId: row.employeeId,
    attendanceDate: row.attendanceDate,
    checkInAt: row.checkInAt?.toISOString() ?? null,
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    source: row.source,
    sourceReference: row.sourceReference,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function lockAttendanceKey(
  client: PoolClient,
  employeeId: string,
  attendanceDate: string,
) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `attendance:${employeeId}:${attendanceDate}`,
  ]);
}

async function loadAttendanceForUpdate(
  client: PoolClient,
  employeeId: string,
  attendanceDate: string,
): Promise<AttendanceRow | null> {
  const result = await client.query<AttendanceRow>(
    `SELECT
       employee_id AS "employeeId",
       attendance_date::text AS "attendanceDate",
       check_in_at AS "checkInAt",
       check_out_at AS "checkOutAt",
       source,
       source_reference AS "sourceReference",
       note,
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM attendance_daily_records
     WHERE employee_id = $1
       AND attendance_date = $2::date
     FOR UPDATE`,
    [employeeId, attendanceDate],
  );
  return result.rows[0] ?? null;
}

async function loadMappedPunches(
  client: PoolClient,
  employeeId: string,
  attendanceDate: string,
): Promise<PunchRow[]> {
  const result = await client.query<PunchRow>(
    `SELECT
       e.id,
       e.occurred_at AS "occurredAt",
       m.id AS "mappingId"
     FROM attendance_adms_events e
     JOIN attendance_adms_employee_mappings m
       ON m.device_id = e.device_id
      AND m.pin = e.pin
      AND e.occurred_at >= m.effective_from
      AND (m.effective_to IS NULL OR e.occurred_at < m.effective_to)
     WHERE m.employee_id = $1
       AND (e.occurred_at AT TIME ZONE 'Asia/Jakarta')::date = $2::date
     ORDER BY e.occurred_at, e.id`,
    [employeeId, attendanceDate],
  );
  return result.rows;
}

async function writeProjectionAudit(
  client: PoolClient,
  input: {
    employeeId: string;
    attendanceDate: string;
    action: "created" | "updated" | "skipped_manual_conflict" | "skipped_foreign_integration" | "cleared";
    mappingIds: string[];
    sourceEventIds: string[];
    before: AttendanceRow | null;
    after: AttendanceRow | null;
  },
) {
  await client.query(
    `INSERT INTO attendance_adms_projection_audit_events (
       id, employee_id, attendance_date, action, mapping_ids,
       source_event_ids, before_record, after_record
     ) VALUES ($1, $2, $3::date, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)`,
    [
      randomUUID(),
      input.employeeId,
      input.attendanceDate,
      input.action,
      JSON.stringify(input.mappingIds),
      JSON.stringify(input.sourceEventIds),
      input.before ? JSON.stringify(snapshotAttendance(input.before)) : null,
      input.after ? JSON.stringify(snapshotAttendance(input.after)) : null,
    ],
  );
}

async function insertIntegratedAttendance(
  client: PoolClient,
  input: {
    employeeId: string;
    attendanceDate: string;
    checkInAt: Date;
    checkOutAt: Date | null;
    sourceReference: string;
  },
): Promise<AttendanceRow> {
  const result = await client.query<AttendanceRow>(
    `INSERT INTO attendance_daily_records (
       employee_id, attendance_date, check_in_at, check_out_at,
       source, source_reference, note, created_by_account_id, updated_by_account_id
     ) VALUES ($1, $2::date, $3, $4, 'integration', $5, NULL, NULL, NULL)
     RETURNING
       employee_id AS "employeeId",
       attendance_date::text AS "attendanceDate",
       check_in_at AS "checkInAt",
       check_out_at AS "checkOutAt",
       source,
       source_reference AS "sourceReference",
       note,
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [
      input.employeeId,
      input.attendanceDate,
      input.checkInAt,
      input.checkOutAt,
      input.sourceReference,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("ADMS attendance insert did not return a record");
  return row;
}

async function updateIntegratedAttendance(
  client: PoolClient,
  input: {
    employeeId: string;
    attendanceDate: string;
    checkInAt: Date;
    checkOutAt: Date | null;
    sourceReference: string;
  },
): Promise<AttendanceRow> {
  const result = await client.query<AttendanceRow>(
    `UPDATE attendance_daily_records
     SET check_in_at = $3,
         check_out_at = $4,
         source_reference = $5,
         note = NULL,
         updated_by_account_id = NULL,
         updated_at = now()
     WHERE employee_id = $1
       AND attendance_date = $2::date
       AND source = 'integration'
     RETURNING
       employee_id AS "employeeId",
       attendance_date::text AS "attendanceDate",
       check_in_at AS "checkInAt",
       check_out_at AS "checkOutAt",
       source,
       source_reference AS "sourceReference",
       note,
       created_at AS "createdAt",
       updated_at AS "updatedAt"`,
    [
      input.employeeId,
      input.attendanceDate,
      input.checkInAt,
      input.checkOutAt,
      input.sourceReference,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("ADMS attendance update did not return a record");
  return row;
}

export async function projectAdmsAttendanceDay(
  db: Pool,
  employeeId: string,
  attendanceDate: string,
): Promise<AdmsProjectionResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockAttendanceKey(client, employeeId, attendanceDate);

    const punches = await loadMappedPunches(client, employeeId, attendanceDate);
    const window = resolveAdmsPunchWindow(punches);
    if (!window) {
      // ADMS-R2d: a day whose scans all left this employee (a corrected wrong mapping) still holds the
      // row ADMS projected earlier. Only that row is removed; manual and foreign rows stay untouched.
      const stale = await loadAttendanceForUpdate(client, employeeId, attendanceDate);
      if (stale?.source === "integration" && stale.sourceReference?.startsWith("adms:")) {
        await client.query(
          `DELETE FROM attendance_daily_records
           WHERE employee_id = $1 AND attendance_date = $2::date AND source = 'integration'`,
          [employeeId, attendanceDate],
        );
        await writeProjectionAudit(client, {
          employeeId,
          attendanceDate,
          action: "cleared",
          mappingIds: [],
          sourceEventIds: [],
          before: stale,
          after: null,
        });
        await client.query("COMMIT");
        return { employeeId, attendanceDate, status: "cleared" };
      }
      await client.query("COMMIT");
      return { employeeId, attendanceDate, status: "no_events" };
    }

    const current = await loadAttendanceForUpdate(client, employeeId, attendanceDate);
    const mappingIds = [...new Set(punches.map((punch) => punch.mappingId))];
    const sourceEventIds = punches.map((punch) => punch.id);

    if (current?.source === "manual") {
      await writeProjectionAudit(client, {
        employeeId,
        attendanceDate,
        action: "skipped_manual_conflict",
        mappingIds,
        sourceEventIds,
        before: current,
        after: null,
      });
      await client.query("COMMIT");
      return { employeeId, attendanceDate, status: "manual_conflict" };
    }

    if (
      current?.source === "integration" &&
      !current.sourceReference?.startsWith("adms:")
    ) {
      await writeProjectionAudit(client, {
        employeeId,
        attendanceDate,
        action: "skipped_foreign_integration",
        mappingIds,
        sourceEventIds,
        before: current,
        after: null,
      });
      await client.query("COMMIT");
      return { employeeId, attendanceDate, status: "foreign_integration_conflict" };
    }

    const sourceReference = admsSourceReference(window.firstEventId, window.lastEventId);
    if (
      current &&
      sameInstant(current.checkInAt, window.checkInAt) &&
      sameInstant(current.checkOutAt, window.checkOutAt) &&
      current.sourceReference === sourceReference
    ) {
      await client.query("COMMIT");
      return { employeeId, attendanceDate, status: "unchanged" };
    }

    const after = current
      ? await updateIntegratedAttendance(client, {
          employeeId,
          attendanceDate,
          checkInAt: window.checkInAt,
          checkOutAt: window.checkOutAt,
          sourceReference,
        })
      : await insertIntegratedAttendance(client, {
          employeeId,
          attendanceDate,
          checkInAt: window.checkInAt,
          checkOutAt: window.checkOutAt,
          sourceReference,
        });

    await writeProjectionAudit(client, {
      employeeId,
      attendanceDate,
      action: current ? "updated" : "created",
      mappingIds,
      sourceEventIds,
      before: current,
      after,
    });
    await client.query("COMMIT");
    return { employeeId, attendanceDate, status: current ? "updated" : "created" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function projectAdmsRequest(db: Pool, requestId: string) {
  const targetResult = await db.query<ProjectionTargetRow>(
    `SELECT DISTINCT
       m.employee_id AS "employeeId",
       ((e.occurred_at AT TIME ZONE 'Asia/Jakarta')::date)::text AS "attendanceDate"
     FROM attendance_adms_events e
     JOIN attendance_adms_employee_mappings m
       ON m.device_id = e.device_id
      AND m.pin = e.pin
      AND e.occurred_at >= m.effective_from
      AND (m.effective_to IS NULL OR e.occurred_at < m.effective_to)
     WHERE e.source_request_id = $1
     ORDER BY "employeeId", "attendanceDate"`,
    [requestId],
  );

  const results: AdmsProjectionResult[] = [];
  for (const target of targetResult.rows) {
    results.push(await projectAdmsAttendanceDay(db, target.employeeId, target.attendanceDate));
  }
  return results;
}
