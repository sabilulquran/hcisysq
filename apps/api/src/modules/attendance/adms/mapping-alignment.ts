import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { projectAdmsAttendanceDay } from "./projection.js";

// ADMS-R2c (ATT-014 §20.5, D-14-20): a PIN mapping is valid from the employee's start date (TMT,
// employees.started_on, 00:00 WIB), not from the moment it was created. "Sesuaikan dengan TMT" moves
// an existing mapping's start there. A recycled PIN keeps its earlier holder: the new start is never
// before the end of an earlier mapping of the same PIN on the same device. Every change is audited
// with the previous start (mapping_aligned_to_start_date), which is also the recovery path.

export type MappingAlignmentStatus =
  | "change"
  | "unchanged"
  | "missing_start_date"
  | "invalid_range"
  | "overlap"
  /** TMT is later than the current start and scans would lose their owner: not applied (DRAFT). */
  | "removes_scans";

export type MappingAlignmentItem = {
  mappingId: string;
  deviceId: string;
  deviceName: string;
  pin: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  startedOn: string | null;
  currentFrom: string;
  targetFrom: string | null;
  effectiveTo: string | null;
  /** Machine scans that become this employee's (target earlier than the current start). */
  scansAdded: number;
  /** Machine scans that stop being this employee's (target later than the current start). */
  scansRemoved: number;
  status: MappingAlignmentStatus;
};

type PlanRow = {
  mappingId: string;
  deviceId: string;
  deviceName: string;
  pin: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  startedOn: string | null;
  currentFrom: Date;
  targetFrom: Date | null;
  effectiveTo: Date | null;
  scansAdded: number;
  scansRemoved: number;
  overlaps: boolean;
};

export async function planMappingAlignment(
  db: Pick<PoolClient, "query">,
  mappingIds: readonly string[],
): Promise<MappingAlignmentItem[]> {
  const result = await db.query<PlanRow>(
    `WITH base AS (
       SELECT mapping.id, mapping.device_id, mapping.pin, mapping.employee_id, mapping.effective_from,
         mapping.effective_to, employee.employee_number, employee.full_name, employee.started_on,
         coalesce(device.display_name, device.serial_number) AS device_name,
         -- greatest() ignores NULLs: without a TMT the target is NULL and the row is reported, not moved.
         CASE WHEN employee.started_on IS NULL THEN NULL ELSE greatest(
           (employee.started_on::timestamp AT TIME ZONE 'Asia/Jakarta'),
           (SELECT max(earlier.effective_to)
            FROM attendance_adms_employee_mappings earlier
            WHERE earlier.device_id = mapping.device_id AND earlier.pin = mapping.pin
              AND earlier.id <> mapping.id AND earlier.effective_from < mapping.effective_from)
         ) END AS target_from
       FROM attendance_adms_employee_mappings mapping
       JOIN employees employee ON employee.id = mapping.employee_id
       JOIN attendance_adms_devices device ON device.id = mapping.device_id
       WHERE mapping.id = ANY($1::uuid[])
     )
     SELECT base.id AS "mappingId", base.device_id AS "deviceId", base.device_name AS "deviceName",
       base.pin, base.employee_id AS "employeeId", base.employee_number AS "employeeNumber",
       base.full_name AS "employeeName", base.started_on::text AS "startedOn",
       base.effective_from AS "currentFrom", base.target_from AS "targetFrom",
       base.effective_to AS "effectiveTo",
       (SELECT count(*)::int FROM attendance_adms_events event
        WHERE event.device_id = base.device_id AND event.pin = base.pin
          AND base.target_from < base.effective_from
          AND event.occurred_at >= base.target_from AND event.occurred_at < base.effective_from) AS "scansAdded",
       (SELECT count(*)::int FROM attendance_adms_events event
        WHERE event.device_id = base.device_id AND event.pin = base.pin
          AND base.target_from > base.effective_from
          AND event.occurred_at >= base.effective_from AND event.occurred_at < base.target_from) AS "scansRemoved",
       EXISTS (
         SELECT 1 FROM attendance_adms_employee_mappings other
         WHERE other.id <> base.id AND other.device_id = base.device_id AND other.pin = base.pin
           AND base.target_from IS NOT NULL
           AND tstzrange(other.effective_from, coalesce(other.effective_to, 'infinity'::timestamptz), '[)')
             && tstzrange(base.target_from, coalesce(base.effective_to, 'infinity'::timestamptz), '[)')
       ) AS overlaps
     FROM base
     ORDER BY base.device_name, base.pin`,
    [mappingIds],
  );
  return result.rows.map((row) => {
    const status: MappingAlignmentStatus =
      row.targetFrom === null ? "missing_start_date"
        : row.effectiveTo !== null && row.targetFrom.getTime() >= row.effectiveTo.getTime() ? "invalid_range"
        : row.overlaps ? "overlap"
        : row.targetFrom.getTime() === row.currentFrom.getTime() ? "unchanged"
        // The legacy daily projection cannot clear a day whose scans leave the employee, so a later
        // start that drops scans is reported, never applied (§20.11).
        : row.scansRemoved > 0 ? "removes_scans"
        : "change";
    return {
      mappingId: row.mappingId,
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      pin: row.pin,
      employeeId: row.employeeId,
      employeeNumber: row.employeeNumber,
      employeeName: row.employeeName,
      startedOn: row.startedOn,
      currentFrom: row.currentFrom.toISOString(),
      targetFrom: row.targetFrom?.toISOString() ?? null,
      effectiveTo: row.effectiveTo?.toISOString() ?? null,
      scansAdded: row.scansAdded,
      scansRemoved: row.scansRemoved,
      status,
    };
  });
}

export function summarizeAlignment(items: readonly MappingAlignmentItem[]) {
  const count = (status: MappingAlignmentStatus) => items.filter((item) => item.status === status).length;
  return {
    mappings: items.length,
    change: count("change"),
    unchanged: count("unchanged"),
    missingStartDate: count("missing_start_date"),
    invalidRange: count("invalid_range"),
    overlap: count("overlap"),
    removesScans: count("removes_scans"),
    scansAdded: items.reduce((sum, item) => sum + (item.status === "change" ? item.scansAdded : 0), 0),
    scansRemoved: items.reduce((sum, item) => sum + (item.status === "change" ? item.scansRemoved : 0), 0),
  };
}

/**
 * Moves every "change" mapping to its target inside the caller's transaction and audits each one.
 * Rows are locked first and the plan is recomputed under the lock, so a concurrent edit cannot be
 * overwritten with a stale target.
 */
export async function applyMappingAlignment(
  client: PoolClient,
  mappingIds: readonly string[],
  actorAccountId: string,
  reason: string,
) {
  await client.query(
    "SELECT id FROM attendance_adms_employee_mappings WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE",
    [mappingIds],
  );
  const items = await planMappingAlignment(client, mappingIds);
  for (const item of items) {
    if (item.status !== "change") continue;
    await client.query(
      "UPDATE attendance_adms_employee_mappings SET effective_from = $2, updated_at = now() WHERE id = $1",
      [item.mappingId, new Date(item.targetFrom!)],
    );
    await client.query(
      `INSERT INTO attendance_adms_admin_audit_events (
         id, actor_account_id, action, device_id, mapping_id, before_state, after_state
       ) VALUES ($1, $2, 'mapping_aligned_to_start_date', $3, $4, $5::jsonb, $6::jsonb)`,
      [
        randomUUID(),
        actorAccountId,
        item.deviceId,
        item.mappingId,
        JSON.stringify({ effectiveFrom: item.currentFrom }),
        JSON.stringify({
          effectiveFrom: item.targetFrom,
          startedOn: item.startedOn,
          scansAdded: item.scansAdded,
          scansRemoved: item.scansRemoved,
          reason,
        }),
      ],
    );
  }
  return items;
}

export type ProjectionSpan = { deviceId: string; pin: string; employeeId: string; from: string; to: string };

export function alignmentSpans(items: readonly MappingAlignmentItem[]): ProjectionSpan[] {
  return items.filter((item) => item.status === "change").map((item) => ({
    deviceId: item.deviceId,
    pin: item.pin,
    employeeId: item.employeeId,
    from: item.targetFrom! < item.currentFrom ? item.targetFrom! : item.currentFrom,
    to: item.targetFrom! < item.currentFrom ? item.currentFrom : item.targetFrom!,
  }));
}

/**
 * Restores the start a mapping had before its latest alignment that is not reverted yet. Reverts
 * reference the alignment audit they undo, so a chain A→B→C unwinds C→B then B→A.
 */
export async function revertMappingAlignment(
  client: PoolClient,
  mappingId: string,
  actorAccountId: string,
  reason: string,
) {
  const locked = await client.query<{ deviceId: string; pin: string; employeeId: string; effectiveFrom: Date }>(
    `SELECT device_id AS "deviceId", pin, employee_id AS "employeeId", effective_from AS "effectiveFrom"
     FROM attendance_adms_employee_mappings WHERE id = $1 FOR UPDATE`,
    [mappingId],
  );
  const mapping = locked.rows[0];
  if (!mapping) return { status: "not_found" as const };
  const audit = await client.query<{ id: string; previousFrom: string; alignedFrom: string }>(
    `SELECT aligned.id, aligned.before_state->>'effectiveFrom' AS "previousFrom",
       aligned.after_state->>'effectiveFrom' AS "alignedFrom"
     FROM attendance_adms_admin_audit_events aligned
     WHERE aligned.mapping_id = $1 AND aligned.action = 'mapping_aligned_to_start_date'
       AND NOT EXISTS (
         SELECT 1 FROM attendance_adms_admin_audit_events reverted
         WHERE reverted.mapping_id = $1 AND reverted.action = 'mapping_alignment_reverted'
           AND reverted.after_state->>'revertedAuditId' = aligned.id::text
       )
     ORDER BY aligned.created_at DESC, aligned.id DESC
     LIMIT 1`,
    [mappingId],
  );
  const last = audit.rows[0];
  if (!last || new Date(last.alignedFrom).getTime() !== mapping.effectiveFrom.getTime()) {
    return { status: "not_aligned" as const };
  }
  const previous = new Date(last.previousFrom);
  const current = mapping.effectiveFrom;
  const moved = await client.query<{ scans: number }>(
    `SELECT count(*)::int AS scans FROM attendance_adms_events
     WHERE device_id = $1 AND pin = $2 AND occurred_at >= least($3::timestamptz, $4::timestamptz)
       AND occurred_at < greatest($3::timestamptz, $4::timestamptz)`,
    [mapping.deviceId, mapping.pin, previous, current],
  );
  await client.query(
    "UPDATE attendance_adms_employee_mappings SET effective_from = $2, updated_at = now() WHERE id = $1",
    [mappingId, previous],
  );
  await client.query(
    `INSERT INTO attendance_adms_admin_audit_events (
       id, actor_account_id, action, device_id, mapping_id, before_state, after_state
     ) VALUES ($1, $2, 'mapping_alignment_reverted', $3, $4, $5::jsonb, $6::jsonb)`,
    [
      randomUUID(),
      actorAccountId,
      mapping.deviceId,
      mappingId,
      JSON.stringify({ effectiveFrom: current.toISOString() }),
      JSON.stringify({ effectiveFrom: previous.toISOString(), revertedAuditId: last.id, scansMoved: moved.rows[0]!.scans, reason }),
    ],
  );
  const span: ProjectionSpan = {
    deviceId: mapping.deviceId,
    pin: mapping.pin,
    employeeId: mapping.employeeId,
    from: (previous < current ? previous : current).toISOString(),
    to: (previous < current ? current : previous).toISOString(),
  };
  return { status: "reverted" as const, effectiveFrom: previous.toISOString(), scansMoved: moved.rows[0]!.scans, span };
}

/** Employee-days whose legacy daily projection may change because scans moved between owners. */
export async function alignmentProjectionTargets(
  db: Pick<PoolClient, "query">,
  spans: readonly ProjectionSpan[],
) {
  const changed = spans;
  if (changed.length === 0) return [];
  const result = await db.query<{ employeeId: string; attendanceDate: string }>(
    `SELECT DISTINCT span.employee_id AS "employeeId",
       ((event.occurred_at AT TIME ZONE 'Asia/Jakarta')::date)::text AS "attendanceDate"
     FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::timestamptz[], $5::timestamptz[])
       AS span(device_id, pin, employee_id, range_from, range_to)
     JOIN attendance_adms_events event
       ON event.device_id = span.device_id AND event.pin = span.pin
      AND event.occurred_at >= span.range_from AND event.occurred_at < span.range_to
     ORDER BY 1, 2`,
    [
      changed.map((item) => item.deviceId),
      changed.map((item) => item.pin),
      changed.map((item) => item.employeeId),
      changed.map((item) => item.from),
      changed.map((item) => item.to),
    ],
  );
  return result.rows;
}

type ProjectionTarget = { employeeId: string; attendanceDate: string };

/** Re-projects the legacy daily rows one by one. The attendance engine reads raw scans and does not need this. */
export async function reprojectAlignment(pool: Pool, targets: readonly ProjectionTarget[]) {
  const failed: ProjectionTarget[] = [];
  for (const target of targets) {
    try {
      await projectAdmsAttendanceDay(pool, target.employeeId, target.attendanceDate);
    } catch {
      failed.push(target);
    }
  }
  return { total: targets.length, failed };
}

// One background re-projection at a time per API process, so concurrent applies cannot exhaust the pool.
let projectionQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs the legacy re-projection after the reply, serialized. Lost on restart; the attendance engine
 * does not depend on it, and a later mapping change or the next ADMS punch re-projects those days.
 */
export function queueReprojection(
  pool: Pool,
  targets: readonly ProjectionTarget[],
  log: { info: (data: object, message: string) => void; error: (data: object, message: string) => void },
) {
  if (targets.length === 0) return;
  projectionQueue = projectionQueue.then(async () => {
    try {
      const outcome = await reprojectAlignment(pool, targets);
      if (outcome.failed.length) log.error({ total: outcome.total, failed: outcome.failed }, "ADMS mapping re-projection had failures");
      else log.info({ total: outcome.total }, "ADMS mapping re-projection finished");
    } catch (error) {
      log.error({ err: error }, "ADMS mapping re-projection failed");
    }
  });
}
