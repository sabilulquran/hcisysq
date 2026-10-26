import type { Pool } from "pg";

// ATT-014 §19.1 step ③ Data Transaksi: every captured punch in scope, one row each, read-only.
// The date column is the calendar date of the punch in WIB (the work date for a correction).
// Machine scans are read raw from attendance_adms_events through the PIN mapping valid at scan time,
// so scans the engine has not normalised yet still appear. Mobile/manual events come from
// attendance_events; approved correction times come from attendance_clarifications. Nothing here
// calculates a verdict or writes data.
//
// ATT-011-3R (§19.7): a mobile punch carries its review state ("Perlu ditinjau") for every reader.
// GPS details and the evidence id that opens the photo are only returned when the caller may manage
// clarifications (includeEvidence); the photo itself is fetched one at a time by its own endpoint.

export type TransactionSource = "adms" | "mobile" | "manual" | "correction";

export type AttendanceTransactionFilter = {
  from: string;
  to: string;
  unitId?: string | null;
  employeeId?: string | null;
  source?: TransactionSource | null;
  reviewState?: "needs_review" | null;
  includeEvidence?: boolean;
  page: number;
  pageSize: number;
};

export type MobileEvidenceDetail = {
  evidenceId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  distanceMeters: number | null;
  geofenceStatus: "inside" | "outside" | "uncertain_accuracy" | "unassigned_location";
  workLocationName: string | null;
  radiusMeters: number | null;
};

export type AttendanceTransactionRow = {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  unitName: string | null;
  occurredAt: Date;
  workDate: string;
  source: TransactionSource;
  correctionBy: "hc" | "employee" | null;
  boundary: "check_in" | "check_out" | null;
  deviceName: string | null;
  usedInResult: boolean;
  reviewState: "accepted" | "needs_review" | null;
  geofenceStatus: MobileEvidenceDetail["geofenceStatus"] | null;
};

export async function attendanceTransactions(pool: Pick<Pool, "query">, filter: AttendanceTransactionFilter) {
  const offset = (filter.page - 1) * filter.pageSize;
  const result = await pool.query<AttendanceTransactionRow & { total: number; needsReviewTotal: number }>(
    `WITH scoped AS (
       SELECT employee.id, employee.employee_number, employee.full_name, unit.name AS unit_name
       FROM employees employee
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       WHERE ($1::uuid IS NULL OR employee.id = $1)
         AND ($2::uuid IS NULL OR employee.organizational_unit_id = $2)
     ), bounds AS (
       SELECT ($3::date::timestamp AT TIME ZONE 'Asia/Jakarta') AS start_at,
              (($4::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta') AS end_at
     ), latest AS (
       SELECT DISTINCT ON (version.employee_id, version.work_date)
         version.employee_id, version.work_date, version.source_event_ids, version.source_clarification_ids
       FROM attendance_result_versions version
       JOIN scoped ON scoped.id = version.employee_id
       WHERE version.work_date BETWEEN $3::date - 1 AND $4::date + 1
       ORDER BY version.employee_id, version.work_date, version.version DESC
     ), rows AS (
       SELECT event.id, scoped.id AS employee_id, event.occurred_at,
              (event.occurred_at AT TIME ZONE 'Asia/Jakarta')::date AS work_date,
              'adms'::text AS source, NULL::text AS correction_by, NULL::text AS boundary,
              coalesce(device.display_name, device.serial_number) AS device_name,
              EXISTS (
                SELECT 1 FROM attendance_events normalized
                JOIN latest ON latest.employee_id = normalized.employee_id
                WHERE normalized.source_reference = 'adms:' || event.id::text
                  AND latest.source_event_ids ? normalized.id::text
              ) AS used_in_result,
              NULL::text AS review_state, NULL::text AS geofence_status
       FROM attendance_adms_events event
       JOIN attendance_adms_employee_mappings mapping
         ON mapping.device_id = event.device_id
        AND mapping.pin = event.pin
        AND event.occurred_at >= mapping.effective_from
        AND (mapping.effective_to IS NULL OR event.occurred_at < mapping.effective_to)
       JOIN scoped ON scoped.id = mapping.employee_id
       JOIN attendance_adms_devices device ON device.id = event.device_id
       CROSS JOIN bounds
       WHERE event.occurred_at >= bounds.start_at AND event.occurred_at < bounds.end_at
       UNION ALL
       SELECT event.id, event.employee_id, event.occurred_at,
              (event.occurred_at AT TIME ZONE 'Asia/Jakarta')::date,
              event.source, NULL, NULL, NULL,
              EXISTS (
                SELECT 1 FROM latest
                WHERE latest.employee_id = event.employee_id AND latest.source_event_ids ? event.id::text
              ),
              evidence.review_state, evidence.geofence_status
       FROM attendance_events event
       JOIN scoped ON scoped.id = event.employee_id
       LEFT JOIN attendance_mobile_evidence evidence ON evidence.event_id = event.id
       CROSS JOIN bounds
       WHERE event.source <> 'adms'
         AND event.occurred_at >= bounds.start_at AND event.occurred_at < bounds.end_at
       UNION ALL
       SELECT clarification.id, clarification.employee_id, boundary.occurred_at,
              clarification.work_date,
              'correction',
              CASE WHEN EXISTS (
                SELECT 1 FROM attendance_clarification_events submitted
                WHERE submitted.clarification_id = clarification.id
                  AND submitted.payload->>'administrativeCorrection' = 'true'
              ) THEN 'hc' ELSE 'employee' END,
              boundary.kind, NULL,
              EXISTS (
                SELECT 1 FROM latest
                WHERE latest.employee_id = clarification.employee_id
                  AND latest.work_date = clarification.work_date
                  AND latest.source_clarification_ids ? clarification.id::text
              ),
              NULL, NULL
       FROM attendance_clarifications clarification
       JOIN scoped ON scoped.id = clarification.employee_id
       CROSS JOIN LATERAL (
         VALUES ('check_in', clarification.proposed_check_in_at), ('check_out', clarification.proposed_check_out_at)
       ) AS boundary(kind, occurred_at)
       WHERE clarification.status = 'approved'
         AND clarification.mode = 'correction'
         AND boundary.occurred_at IS NOT NULL
         AND clarification.work_date BETWEEN $3::date AND $4::date
     )
     SELECT rows.id, rows.employee_id AS "employeeId", scoped.employee_number AS "employeeNumber",
       scoped.full_name AS "employeeName", scoped.unit_name AS "unitName",
       rows.occurred_at AS "occurredAt",
       rows.work_date::text AS "workDate",
       rows.source, rows.correction_by AS "correctionBy", rows.boundary, rows.device_name AS "deviceName",
       rows.used_in_result AS "usedInResult",
       rows.review_state AS "reviewState", rows.geofence_status AS "geofenceStatus",
       count(*) OVER ()::int AS total,
       (SELECT count(*)::int FROM rows WHERE rows.review_state = 'needs_review') AS "needsReviewTotal"
     FROM rows
     JOIN scoped ON scoped.id = rows.employee_id
     WHERE ($5::text IS NULL OR rows.source = $5)
       AND ($8::text IS NULL OR rows.review_state = $8)
     ORDER BY rows.occurred_at DESC, rows.id
     LIMIT $6 OFFSET $7`,
    [
      filter.employeeId ?? null, filter.unitId ?? null, filter.from, filter.to, filter.source ?? null,
      filter.pageSize, offset, filter.reviewState ?? null,
    ],
  );
  const mobileIds = result.rows.filter((row) => row.source === "mobile").map((row) => row.id);
  const evidence = filter.includeEvidence && mobileIds.length
    ? new Map((await pool.query<MobileEvidenceDetail & { eventId: string }>(
        `SELECT evidence.event_id AS "eventId", evidence.id AS "evidenceId",
           evidence.latitude, evidence.longitude, evidence.accuracy_meters AS "accuracyMeters",
           evidence.distance_meters AS "distanceMeters", evidence.geofence_status AS "geofenceStatus",
           location.name AS "workLocationName", location.radius_meters AS "radiusMeters"
         FROM attendance_mobile_evidence evidence
         LEFT JOIN attendance_work_locations location ON location.id = evidence.work_location_id
         WHERE evidence.event_id = ANY($1::uuid[])`,
        [mobileIds],
      )).rows.map(({ eventId, ...detail }) => [eventId, detail]))
    : null;
  const total: number = result.rows[0]?.total ?? (filter.page > 1 ? await countOnly(pool, filter) : 0);
  return {
    from: filter.from,
    to: filter.to,
    page: filter.page,
    pageSize: filter.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / filter.pageSize)),
    needsReviewTotal: result.rows[0]?.needsReviewTotal ?? 0,
    items: result.rows.map(({ total, needsReviewTotal, ...row }) => {
      void total;
      void needsReviewTotal;
      return {
        ...row,
        occurredAt: new Date(row.occurredAt).toISOString(),
        ...(evidence ? { evidence: evidence.get(row.id) ?? null } : {}),
      };
    }),
  };
}

// A page past the end returns no rows and therefore no window count; ask once for the total.
async function countOnly(pool: Pick<Pool, "query">, filter: AttendanceTransactionFilter): Promise<number> {
  const first: { total: number } = await attendanceTransactions(pool, { ...filter, page: 1, pageSize: 1 });
  return first.total;
}
