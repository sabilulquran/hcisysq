import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import type { ProjectionSpan } from "./mapping-alignment.js";

// ADMS-R2d (ATT-014 §20.13): "Ganti pegawai" corrects a PIN that was mapped to the wrong employee.
// The mapping keeps its id, device, PIN and end; only the employee changes, and its start becomes the
// new employee's TMT (never before an earlier holder of the same PIN let go). Every scan in the old
// range leaves the wrong employee, so the wrong employee is never credited with someone else's
// attendance. Ending the mapping ("Akhiri") is not a correction: it keeps the past scans on the wrong
// employee and the right one could only start from today.

export type MappingReassignStatus =
  | "change"
  | "not_found"
  | "same_employee"
  | "employee_not_found"
  | "employee_not_active"
  | "missing_start_date"
  | "invalid_range"
  | "overlap";

export type MappingReassignPlan = {
  status: MappingReassignStatus;
  mappingId: string;
  deviceId: string | null;
  pin: string | null;
  effectiveTo: string | null;
  previous: { employeeId: string; employeeNumber: string; employeeName: string; effectiveFrom: string } | null;
  next: {
    employeeId: string;
    employeeNumber: string;
    employeeName: string;
    startedOn: string | null;
    effectiveFrom: string | null;
  } | null;
  /** Machine scans that stop being the previous employee's. */
  scansFromPrevious: number;
  /** Machine scans that become the new employee's. */
  scansToNext: number;
};

type MappingRow = {
  deviceId: string;
  pin: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

type TargetRow = {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: string;
  startedOn: string | null;
  targetFrom: Date | null;
};

export async function planMappingReassign(
  db: Pick<PoolClient, "query">,
  mappingId: string,
  employeeId: string,
  options: { lock?: boolean } = {},
): Promise<MappingReassignPlan> {
  const lock = options.lock ? " FOR UPDATE OF mapping" : "";
  const mappingResult = await db.query<MappingRow>(
    `SELECT mapping.device_id AS "deviceId", mapping.pin, mapping.employee_id AS "employeeId",
       employee.employee_number AS "employeeNumber", employee.full_name AS "employeeName",
       mapping.effective_from AS "effectiveFrom", mapping.effective_to AS "effectiveTo"
     FROM attendance_adms_employee_mappings mapping
     JOIN employees employee ON employee.id = mapping.employee_id
     WHERE mapping.id = $1${lock}`,
    [mappingId],
  );
  const mapping = mappingResult.rows[0];
  const empty: MappingReassignPlan = {
    status: "not_found",
    mappingId,
    deviceId: null,
    pin: null,
    effectiveTo: null,
    previous: null,
    next: null,
    scansFromPrevious: 0,
    scansToNext: 0,
  };
  if (!mapping) return empty;

  const base: MappingReassignPlan = {
    ...empty,
    deviceId: mapping.deviceId,
    pin: mapping.pin,
    effectiveTo: mapping.effectiveTo?.toISOString() ?? null,
    previous: {
      employeeId: mapping.employeeId,
      employeeNumber: mapping.employeeNumber,
      employeeName: mapping.employeeName,
      effectiveFrom: mapping.effectiveFrom.toISOString(),
    },
  };
  if (mapping.employeeId === employeeId) return { ...base, status: "same_employee" };

  const targetResult = await db.query<TargetRow>(
    `SELECT employee.id, employee.employee_number AS "employeeNumber", employee.full_name AS "fullName",
       employee.status, employee.started_on::text AS "startedOn",
       -- greatest() ignores NULLs: without a TMT the target start is NULL and the plan is refused.
       CASE WHEN employee.started_on IS NULL THEN NULL ELSE greatest(
         (employee.started_on::timestamp AT TIME ZONE 'Asia/Jakarta'),
         (SELECT max(earlier.effective_to) FROM attendance_adms_employee_mappings earlier
          WHERE earlier.device_id = $2 AND earlier.pin = $3 AND earlier.id <> $4
            AND earlier.effective_from < $5)
       ) END AS "targetFrom"
     FROM employees employee
     WHERE employee.id = $1${options.lock ? " FOR UPDATE" : ""}`,
    [employeeId, mapping.deviceId, mapping.pin, mappingId, mapping.effectiveFrom],
  );
  const target = targetResult.rows[0];
  if (!target) return { ...base, status: "employee_not_found" };
  const next = {
    employeeId: target.id,
    employeeNumber: target.employeeNumber,
    employeeName: target.fullName,
    startedOn: target.startedOn,
    effectiveFrom: target.targetFrom?.toISOString() ?? null,
  };
  if (target.status !== "active") return { ...base, next, status: "employee_not_active" };
  if (!target.targetFrom) return { ...base, next, status: "missing_start_date" };
  if (mapping.effectiveTo && target.targetFrom.getTime() >= mapping.effectiveTo.getTime()) {
    return { ...base, next, status: "invalid_range" };
  }

  const counts = await db.query<{ fromPrevious: number; toNext: number; overlaps: boolean }>(
    `SELECT
       (SELECT count(*)::int FROM attendance_adms_events event
        WHERE event.device_id = $1 AND event.pin = $2 AND event.occurred_at >= $3
          AND event.occurred_at < coalesce($5::timestamptz, 'infinity'::timestamptz)) AS "fromPrevious",
       (SELECT count(*)::int FROM attendance_adms_events event
        WHERE event.device_id = $1 AND event.pin = $2 AND event.occurred_at >= $4
          AND event.occurred_at < coalesce($5::timestamptz, 'infinity'::timestamptz)) AS "toNext",
       EXISTS (
         SELECT 1 FROM attendance_adms_employee_mappings other
         WHERE other.id <> $6 AND other.device_id = $1 AND other.pin = $2
           AND tstzrange(other.effective_from, coalesce(other.effective_to, 'infinity'::timestamptz), '[)')
             && tstzrange($4, coalesce($5::timestamptz, 'infinity'::timestamptz), '[)')
       ) AS overlaps`,
    [mapping.deviceId, mapping.pin, mapping.effectiveFrom, target.targetFrom, mapping.effectiveTo, mappingId],
  );
  const row = counts.rows[0]!;
  return {
    ...base,
    next,
    status: row.overlaps ? "overlap" : "change",
    scansFromPrevious: row.fromPrevious,
    scansToNext: row.toNext,
  };
}

/** Applies a "change" plan inside the caller's transaction; the plan is recomputed under row locks. */
export async function applyMappingReassign(
  client: PoolClient,
  mappingId: string,
  employeeId: string,
  actorAccountId: string,
  reason: string,
) {
  const plan = await planMappingReassign(client, mappingId, employeeId, { lock: true });
  if (plan.status !== "change") return { plan, spans: [] as ProjectionSpan[] };
  const previous = plan.previous!;
  const next = plan.next!;
  await client.query(
    `UPDATE attendance_adms_employee_mappings
     SET employee_id = $2, effective_from = $3, updated_at = now()
     WHERE id = $1`,
    [mappingId, next.employeeId, new Date(next.effectiveFrom!)],
  );
  await client.query(
    `INSERT INTO attendance_adms_admin_audit_events (
       id, actor_account_id, action, device_id, mapping_id, before_state, after_state
     ) VALUES ($1, $2, 'mapping_reassigned', $3, $4, $5::jsonb, $6::jsonb)`,
    [
      randomUUID(),
      actorAccountId,
      plan.deviceId,
      mappingId,
      JSON.stringify(previous),
      JSON.stringify({
        employeeId: next.employeeId,
        employeeNumber: next.employeeNumber,
        employeeName: next.employeeName,
        effectiveFrom: next.effectiveFrom,
        startedOn: next.startedOn,
        scansFromPrevious: plan.scansFromPrevious,
        scansToNext: plan.scansToNext,
        reason,
      }),
    ],
  );
  const to = plan.effectiveTo ?? "infinity";
  const spans: ProjectionSpan[] = [
    { deviceId: plan.deviceId!, pin: plan.pin!, employeeId: previous.employeeId, from: previous.effectiveFrom, to },
    { deviceId: plan.deviceId!, pin: plan.pin!, employeeId: next.employeeId, from: next.effectiveFrom!, to },
  ];
  return { plan, spans };
}
