import type { Pool } from "pg";

// ATT-014 §6.5c (DRAFT): Transaksi saya — the raw punches of the signed-in employee, read live.
//
// Transaksi (raw fact) and hasil kehadiran (calculation) are two different things. This read model
// is the first: every machine scan mapped to the employee through the PIN mapping valid at scan
// time (same source and join as HC's Data Transaksi, transactions.ts), plus the employee's own
// HP presensi and HC manual punches. It never calculates a verdict, never writes, and never
// materialises a result. Machine scans are read straight from attendance_adms_events, so a scan the
// engine has not normalised yet still appears.
//
// What is deliberately NOT returned: the PIN, the device serial number or id, raw ADMS lines, event
// ids, GPS coordinates and photo ids. The employee only needs the time, the source and the kind.

/** Hard ceiling per request; a 31-day range normally holds a few hundred rows at most. */
export const MY_TRANSACTIONS_ROW_CEILING = 2000;

export type MyTransactionSource = "adms" | "mobile" | "manual";

export type MyTransaction = {
  occurredAt: string;
  /** WIB calendar date of the punch. */
  workDate: string;
  source: MyTransactionSource;
  /** Kind only when the source states it (HP presensi / manual); a machine scan is a plain punch. */
  kind: "check_in" | "check_out" | null;
  /** Display name of the machine, never its serial number; null for non-machine sources. */
  deviceName: string | null;
  /** HP presensi review state; null for other sources. */
  reviewState: "accepted" | "needs_review" | null;
  /** The punch was recorded after the latest calculated result of its date. */
  afterCalculation: boolean;
};

export type MyTransactionDay = {
  workDate: string;
  firstScanAt: string;
  lastScanAt: string | null;
  scanCount: number;
  /** Latest result version of the date, or null when the date was never calculated. */
  calculatedAt: string | null;
  /** The date has a result, and at least one punch was recorded after it. */
  newSinceCalculation: boolean;
};

type Row = {
  occurredAt: Date;
  workDate: string;
  source: MyTransactionSource;
  kind: "check_in" | "check_out" | null;
  deviceName: string | null;
  reviewState: "accepted" | "needs_review" | null;
  calculatedAt: Date | null;
  afterCalculation: boolean;
};

/** One query for the whole range (Mi8VPS load), never one per date. */
export async function myAttendanceTransactions(
  pool: Pick<Pool, "query">,
  employeeId: string,
  from: string,
  to: string,
) {
  const result = await pool.query<Row>(
    `WITH bounds AS (
       SELECT ($2::date::timestamp AT TIME ZONE 'Asia/Jakarta') AS start_at,
              (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Jakarta') AS end_at
     ), scans AS (
       SELECT event.occurred_at, event.created_at AS recorded_at, 'adms'::text AS source,
              NULL::text AS kind, nullif(btrim(device.display_name), '') AS device_name,
              NULL::text AS review_state
       -- Start from the employee's own mappings so the planner walks (device_id, occurred_at) per
       -- mapped device instead of every scan in the window. Mappings of one device+PIN never
       -- overlap (migration 0023), so one scan joins at most one mapping.
       FROM attendance_adms_employee_mappings mapping
       CROSS JOIN bounds
       JOIN attendance_adms_events event
         ON event.device_id = mapping.device_id
        AND event.pin = mapping.pin
        AND event.occurred_at >= mapping.effective_from
        AND (mapping.effective_to IS NULL OR event.occurred_at < mapping.effective_to)
        AND event.occurred_at >= bounds.start_at AND event.occurred_at < bounds.end_at
       JOIN attendance_adms_devices device ON device.id = event.device_id
       WHERE mapping.employee_id = $1
       UNION ALL
       SELECT event.occurred_at, event.created_at, event.source,
              CASE WHEN event.event_kind IN ('check_in', 'check_out') THEN event.event_kind END,
              NULL, evidence.review_state
       FROM attendance_events event
       LEFT JOIN attendance_mobile_evidence evidence ON evidence.event_id = event.id
       CROSS JOIN bounds
       WHERE event.employee_id = $1
         AND event.source <> 'adms'
         AND event.occurred_at >= bounds.start_at AND event.occurred_at < bounds.end_at
     ), latest AS (
       SELECT DISTINCT ON (version.work_date) version.work_date, version.created_at
       FROM attendance_result_versions version
       WHERE version.employee_id = $1 AND version.work_date BETWEEN $2::date AND $3::date
       ORDER BY version.work_date, version.version DESC
     )
     SELECT scans.occurred_at AS "occurredAt",
       ((scans.occurred_at AT TIME ZONE 'Asia/Jakarta')::date)::text AS "workDate",
       scans.source, scans.kind, scans.device_name AS "deviceName", scans.review_state AS "reviewState",
       latest.created_at AS "calculatedAt",
       (latest.created_at IS NOT NULL AND scans.recorded_at > latest.created_at) AS "afterCalculation"
     FROM scans
     LEFT JOIN latest ON latest.work_date = (scans.occurred_at AT TIME ZONE 'Asia/Jakarta')::date
     ORDER BY scans.occurred_at DESC, scans.source DESC
     LIMIT $4`,
    [employeeId, from, to, MY_TRANSACTIONS_ROW_CEILING + 1],
  );
  // Newest first before the ceiling, so a cut drops the oldest dates, never today's; then ascending.
  const truncated = result.rows.length > MY_TRANSACTIONS_ROW_CEILING;
  const rows = (truncated ? result.rows.slice(0, MY_TRANSACTIONS_ROW_CEILING) : result.rows).reverse();
  const items: MyTransaction[] = rows.map((row) => ({
    occurredAt: new Date(row.occurredAt).toISOString(),
    workDate: row.workDate,
    source: row.source,
    kind: row.kind,
    deviceName: row.deviceName,
    reviewState: row.reviewState,
    afterCalculation: Boolean(row.afterCalculation),
  }));
  return { from, to, truncated, items, days: summariseDays(rows) };
}

/** First and last punch per date, ascending input. Pure display facts, no verdict. */
function summariseDays(rows: Row[]): MyTransactionDay[] {
  const days = new Map<string, MyTransactionDay>();
  for (const row of rows) {
    const at = new Date(row.occurredAt).toISOString();
    const day = days.get(row.workDate);
    if (!day) {
      days.set(row.workDate, {
        workDate: row.workDate,
        firstScanAt: at,
        lastScanAt: null,
        scanCount: 1,
        calculatedAt: row.calculatedAt ? new Date(row.calculatedAt).toISOString() : null,
        newSinceCalculation: Boolean(row.afterCalculation),
      });
      continue;
    }
    day.scanCount += 1;
    if (at !== day.firstScanAt) day.lastScanAt = at;
    if (row.afterCalculation) day.newSinceCalculation = true;
  }
  return [...days.values()];
}
