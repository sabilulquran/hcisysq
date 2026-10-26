import type { Pool } from "pg";

// ATT-014 §20.3 "Tanpa Jadwal" (package R2a): explains why a report is empty. Read-only.
//
// A. Employees with captured punches on dates that no schedule pattern or published roster covers.
//    Read from raw machine scans through the PIN mapping valid at scan time plus mobile/manual events,
//    so it does not depend on Kalkulasi. Grouped by position on screen; scan times are information
//    only and are never used to propose shift hours (I-4).
// B. Machine scans that cannot be attributed to an employee yet: the PIN has no mapping, or the scan
//    happened before the mapping became effective. PINs are device data, so the route returns this
//    part only to accounts with attendance.devices.read.

export type UnscheduledFilter = {
  from: string;
  to: string;
  unitId?: string | null;
  employeeId?: string | null;
  page: number;
  pageSize: number;
};

export type UnscheduledEmployee = {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  position: string | null;
  days: number;
  firstDate: string;
  lastDate: string;
  earliestLastScan: string;
  latestLastScan: string;
  /**
   * Start of the first schedule pattern that begins after the first uncovered day, if any: the days
   * before it are not judged, and a new pattern for those days must end the day before it so the two
   * never overlap (overlapping patterns make the engine report configuration_error).
   */
  scheduleStartsOn: string | null;
};

export type UnattributedPin = {
  deviceId: string;
  deviceName: string;
  pin: string;
  scans: number;
  firstScanAt: string;
  lastScanAt: string;
  /** unmapped: no employee holds the PIN; before_mapping: scans precede the holder's mapping; outside_mapping: other gaps (e.g. after a mapping ended). */
  status: "unmapped" | "before_mapping" | "outside_mapping";
  mappedEmployeeId: string | null;
  mappedEmployeeName: string | null;
  mappedEmployeeStartedOn: string | null;
  mappingEffectiveFrom: string | null;
};

const BOUNDS = `bounds AS (
       SELECT ($1::date::timestamp AT TIME ZONE 'Asia/Jakarta') AS start_at,
              (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta') AS end_at
     )`;

export async function unscheduledEmployees(pool: Pick<Pool, "query">, filter: UnscheduledFilter) {
  const result = await pool.query<UnscheduledEmployee & { total: number }>(
    `WITH ${BOUNDS}, scoped AS (
       SELECT employee.id, employee.employee_number, employee.full_name, unit.name AS unit_name,
         coalesce(nullif(employee.functional_position, ''), position.name, nullif(employee.structural_position, '')) AS position
       FROM employees employee
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       LEFT JOIN positions position ON position.id = employee.position_id
       WHERE ($3::uuid IS NULL OR employee.id = $3)
         AND ($4::uuid IS NULL OR employee.organizational_unit_id = $4)
     ), punches AS (
       SELECT mapping.employee_id, event.occurred_at
       FROM attendance_adms_events event
       JOIN attendance_adms_employee_mappings mapping
         ON mapping.device_id = event.device_id
        AND mapping.pin = event.pin
        AND event.occurred_at >= mapping.effective_from
        AND (mapping.effective_to IS NULL OR event.occurred_at < mapping.effective_to)
       JOIN scoped ON scoped.id = mapping.employee_id
       CROSS JOIN bounds
       WHERE event.occurred_at >= bounds.start_at AND event.occurred_at < bounds.end_at
       UNION ALL
       SELECT event.employee_id, event.occurred_at
       FROM attendance_events event
       JOIN scoped ON scoped.id = event.employee_id
       CROSS JOIN bounds
       WHERE event.source <> 'adms' AND event.occurred_at >= bounds.start_at AND event.occurred_at < bounds.end_at
     ), days AS (
       SELECT employee_id, (occurred_at AT TIME ZONE 'Asia/Jakarta')::date AS work_date, max(occurred_at) AS last_scan
       FROM punches
       GROUP BY 1, 2
     ), uncovered AS (
       SELECT days.*
       FROM days
       WHERE NOT EXISTS (
           SELECT 1 FROM attendance_schedule_assignments assignment
           WHERE assignment.employee_id = days.employee_id
             AND days.work_date >= assignment.effective_from
             AND (assignment.effective_to IS NULL OR days.work_date <= assignment.effective_to)
             -- The pattern only gives a schedule when its shift has a version valid on that date (§20.10).
             AND EXISTS (
               SELECT 1 FROM attendance_schedule_versions version
               WHERE version.schedule_template_id = assignment.schedule_template_id
                 AND version.effective_from <= ((days.work_date + time '12:00') AT TIME ZONE 'Asia/Jakarta')
                 AND (version.effective_to IS NULL OR version.effective_to > ((days.work_date + time '12:00') AT TIME ZONE 'Asia/Jakarta'))
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM attendance_roster_entries entry
           JOIN attendance_rosters roster ON roster.id = entry.roster_id AND roster.status = 'PUBLISHED'
           WHERE entry.employee_id = days.employee_id AND entry.work_date = days.work_date
         )
     )
     SELECT scoped.id AS "employeeId", scoped.employee_number AS "employeeNumber", scoped.full_name AS "employeeName",
       scoped.unit_name AS "unitName", scoped.position,
       count(*)::int AS days, min(uncovered.work_date)::text AS "firstDate", max(uncovered.work_date)::text AS "lastDate",
       min(to_char(uncovered.last_scan AT TIME ZONE 'Asia/Jakarta', 'HH24:MI')) AS "earliestLastScan",
       max(to_char(uncovered.last_scan AT TIME ZONE 'Asia/Jakarta', 'HH24:MI')) AS "latestLastScan",
       (SELECT min(assignment.effective_from)::text FROM attendance_schedule_assignments assignment
         WHERE assignment.employee_id = scoped.id AND assignment.effective_from > min(uncovered.work_date)) AS "scheduleStartsOn",
       count(*) OVER ()::int AS total
     FROM uncovered
     JOIN scoped ON scoped.id = uncovered.employee_id
     GROUP BY scoped.id, scoped.employee_number, scoped.full_name, scoped.unit_name, scoped.position
     ORDER BY scoped.position NULLS LAST, scoped.unit_name NULLS LAST, scoped.full_name
     LIMIT $5 OFFSET $6`,
    [filter.from, filter.to, filter.employeeId ?? null, filter.unitId ?? null, filter.pageSize, (filter.page - 1) * filter.pageSize],
  );
  const total = result.rows[0]?.total ?? 0;
  return {
    page: filter.page,
    pageSize: filter.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / filter.pageSize)),
    items: result.rows.map(({ total: rowTotal, ...row }) => {
      void rowTotal;
      return row;
    }),
  };
}

export async function unattributedPins(pool: Pick<Pool, "query">, filter: UnscheduledFilter) {
  const result = await pool.query<UnattributedPin & { total: number }>(
    `WITH ${BOUNDS}, pins AS (
       SELECT event.device_id, event.pin, count(*)::int AS scans, min(event.occurred_at) AS first_scan, max(event.occurred_at) AS last_scan
       FROM attendance_adms_events event
       CROSS JOIN bounds
       WHERE event.occurred_at >= bounds.start_at AND event.occurred_at < bounds.end_at
         AND NOT EXISTS (
           SELECT 1 FROM attendance_adms_employee_mappings mapping
           WHERE mapping.device_id = event.device_id
             AND mapping.pin = event.pin
             AND event.occurred_at >= mapping.effective_from
             AND (mapping.effective_to IS NULL OR event.occurred_at < mapping.effective_to)
         )
       GROUP BY event.device_id, event.pin
     ), described AS (
       SELECT pins.*, coalesce(device.display_name, device.serial_number) AS device_name,
         holder.employee_id, holder.effective_from, employee.full_name, employee.started_on,
         employee.organizational_unit_id
       FROM pins
       JOIN attendance_adms_devices device ON device.id = pins.device_id
       LEFT JOIN LATERAL (
         -- The mapping that holds this PIN now (or most recently); scans before it are unattributed.
         SELECT mapping.employee_id, mapping.effective_from
         FROM attendance_adms_employee_mappings mapping
         WHERE mapping.device_id = pins.device_id AND mapping.pin = pins.pin
         ORDER BY (mapping.effective_to IS NULL) DESC, mapping.effective_from DESC
         LIMIT 1
       ) holder ON true
       LEFT JOIN employees employee ON employee.id = holder.employee_id
     )
     SELECT device_id AS "deviceId", device_name AS "deviceName", pin, scans,
       first_scan AS "firstScanAt", last_scan AS "lastScanAt",
       CASE WHEN employee_id IS NULL THEN 'unmapped'
            WHEN last_scan < effective_from THEN 'before_mapping'
            ELSE 'outside_mapping' END AS status,
       employee_id AS "mappedEmployeeId", full_name AS "mappedEmployeeName",
       started_on::text AS "mappedEmployeeStartedOn", effective_from AS "mappingEffectiveFrom",
       count(*) OVER ()::int AS total
     FROM described
     -- A unit or employee scope keeps PINs held by those employees; unmapped PINs belong to no unit
     -- yet and stay visible for a unit scope so they can be mapped.
     WHERE ($3::uuid IS NULL OR employee_id = $3)
       AND ($4::uuid IS NULL OR employee_id IS NULL OR organizational_unit_id = $4)
     ORDER BY (employee_id IS NULL) DESC, scans DESC, device_name, pin
     LIMIT $5 OFFSET $6`,
    [filter.from, filter.to, filter.employeeId ?? null, filter.unitId ?? null, filter.pageSize, (filter.page - 1) * filter.pageSize],
  );
  const total = result.rows[0]?.total ?? 0;
  return {
    page: filter.page,
    pageSize: filter.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / filter.pageSize)),
    items: result.rows.map(({ total: rowTotal, ...row }) => {
      void rowTotal;
      return {
        ...row,
        firstScanAt: new Date(row.firstScanAt).toISOString(),
        lastScanAt: new Date(row.lastScanAt).toISOString(),
        mappingEffectiveFrom: row.mappingEffectiveFrom ? new Date(row.mappingEffectiveFrom).toISOString() : null,
      };
    }),
  };
}
