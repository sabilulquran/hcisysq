import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { jakartaWorkDate, materializeAttendanceResult } from "./engine.js";

// ATT-014-2 Kalkulasi (docs/domain/attendance-report-calculation.md §6.2). Runs are processed inside
// the API process, one at a time across the server, pair by pair through the unchanged ATT-007
// engine. There is no interval worker: a run starts when it is requested or when the API starts.

export const CALCULATION_MAX_DAYS = 93;
const PROGRESS_EVERY = 25;

export type CalculationStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type CalculationRun = {
  id: string;
  requestedByAccountId: string;
  unitId: string | null;
  employeeId: string | null;
  dateFrom: string;
  dateTo: string;
  status: CalculationStatus;
  totalPairs: number;
  processedPairs: number;
  failedPairs: number;
  uncoveredPairs: number;
  cancelRequestedAt: Date | null;
  errorCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export const RUN_COLUMNS = `
  id, requested_by_account_id AS "requestedByAccountId", unit_id AS "unitId", employee_id AS "employeeId",
  date_from::text AS "dateFrom", date_to::text AS "dateTo", status,
  total_pairs AS "totalPairs", processed_pairs AS "processedPairs", failed_pairs AS "failedPairs",
  uncovered_pairs AS "uncoveredPairs", cancel_requested_at AS "cancelRequestedAt", error_code AS "errorCode",
  created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;

export type CalculationScope = { unitId?: string | null; employeeId?: string | null; from: string; to: string };
export type CalculationPair = { employeeId: string; workDate: string };

export function daysInclusive(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function eachDate(from: string, to: string) {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export type CalculationRangeError = "INVALID_CALCULATION_RANGE" | "CALCULATION_RANGE_TOO_LARGE" | "CALCULATION_DATE_IN_FUTURE";

/** D-14-2 and §6.2 precondition: from ≤ to, at most 93 days, and nothing after today (Asia/Jakarta). */
export function validateCalculationRange(from: string, to: string, now = new Date()): CalculationRangeError | null {
  if (Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`)) || from > to) {
    return "INVALID_CALCULATION_RANGE";
  }
  if (daysInclusive(from, to) > CALCULATION_MAX_DAYS) return "CALCULATION_RANGE_TOO_LARGE";
  if (to > jakartaWorkDate(now)) return "CALCULATION_DATE_IN_FUTURE";
  return null;
}

/**
 * Employed pairs in scope, split by the D-14-3 coverage rule. A pair is employed when the employee
 * works on that date (started_on ≤ date ≤ ended_on; inactive employees only up to ended_on). It is
 * covered when a machine PIN mapping is valid on that date, or a mobile/manual event or an approved
 * clarification exists for it. Uncovered pairs are never written; they read as "Tidak tercatat".
 */
export async function calculationPairs(pool: Pick<Pool, "query">, scope: CalculationScope) {
  const result = await pool.query<{ employeeId: string; workDate: string; covered: boolean }>(
    `WITH scoped AS (
       SELECT employee.id, employee.started_on, employee.ended_on, employee.status
       FROM employees employee
       WHERE ($1::uuid IS NULL OR employee.id = $1)
         AND ($2::uuid IS NULL OR employee.organizational_unit_id = $2)
         AND (employee.status = 'active' OR employee.ended_on >= $3::date)
         AND (employee.started_on IS NULL OR employee.started_on <= $4::date)
     ), pairs AS (
       SELECT scoped.id AS employee_id, day::date AS work_date,
              (day::date::timestamp AT TIME ZONE 'Asia/Jakarta') AS day_start
       FROM scoped
       CROSS JOIN generate_series($3::date, $4::date, interval '1 day') day
       WHERE (scoped.started_on IS NULL OR scoped.started_on <= day::date)
         AND (scoped.ended_on IS NULL OR scoped.ended_on >= day::date)
         AND (scoped.status = 'active' OR scoped.ended_on IS NOT NULL)
     )
     SELECT pairs.employee_id AS "employeeId", pairs.work_date::text AS "workDate",
       (
         EXISTS (
           SELECT 1 FROM attendance_adms_employee_mappings mapping
           WHERE mapping.employee_id = pairs.employee_id
             AND mapping.effective_from < pairs.day_start + interval '1 day'
             AND (mapping.effective_to IS NULL OR mapping.effective_to > pairs.day_start)
         )
         OR EXISTS (
           SELECT 1 FROM attendance_events event
           WHERE event.employee_id = pairs.employee_id
             AND event.source <> 'adms'
             AND event.occurred_at >= pairs.day_start
             AND event.occurred_at < pairs.day_start + interval '1 day'
         )
         OR EXISTS (
           SELECT 1 FROM attendance_clarifications clarification
           WHERE clarification.employee_id = pairs.employee_id
             AND clarification.work_date = pairs.work_date
             AND clarification.status = 'approved'
         )
       ) AS covered
     FROM pairs
     ORDER BY pairs.work_date, pairs.employee_id`,
    [scope.employeeId ?? null, scope.unitId ?? null, scope.from, scope.to],
  );
  const covered: CalculationPair[] = [];
  const uncovered: CalculationPair[] = [];
  for (const row of result.rows) (row.covered ? covered : uncovered).push({ employeeId: row.employeeId, workDate: row.workDate });
  return { covered, uncovered };
}

async function insertAudit(pool: Pick<Pool, "query">, actorAccountId: string, action: string, runId: string, payload: Record<string, unknown>) {
  await pool.query(
    `INSERT INTO access_audit_events (id, actor_account_id, action, entity_type, entity_id, payload)
     VALUES ($1, $2, $3, 'attendance_calculation_run', $4, $5::jsonb)`,
    [randomUUID(), actorAccountId, action, runId, JSON.stringify(payload)],
  );
}

export type CalculationRunnerOptions = {
  materialize?: (pool: Pool, employeeId: string, workDate: string, now: Date) => Promise<unknown>;
  pause?: () => Promise<void>;
  log?: (message: string, details: Record<string, unknown>) => void;
};

export type CalculationRunner = {
  /** Marks runs left running by a previous process as failed with INTERRUPTED (§6.2 rule 7). */
  recoverInterrupted(): Promise<number>;
  /** Starts processing queued runs unless a loop is already active. Never throws. */
  kick(): void;
  /** Resolves when the current loop (if any) has drained the queue. */
  idle(): Promise<void>;
};

export function createCalculationRunner(pool: Pool, options: CalculationRunnerOptions = {}): CalculationRunner {
  const materialize = options.materialize ?? materializeAttendanceResult;
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const log = options.log ?? (() => undefined);
  let loop: Promise<void> | null = null;
  let again = false;

  async function claimNext(): Promise<CalculationRun | null> {
    try {
      const result = await pool.query<CalculationRun>(
        `UPDATE attendance_calculation_runs
         SET status = 'running', started_at = now()
         WHERE id = (
           SELECT id FROM attendance_calculation_runs
           WHERE status = 'queued'
           ORDER BY created_at, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         AND NOT EXISTS (SELECT 1 FROM attendance_calculation_runs WHERE status = 'running')
         RETURNING ${RUN_COLUMNS}`,
      );
      return result.rows[0] ?? null;
    } catch (error) {
      // Another process won the single running slot.
      if ((error as { code?: string }).code === "23505") return null;
      throw error;
    }
  }

  async function finish(run: CalculationRun, status: CalculationStatus, counts: { processed: number; failed: number }, errorCode: string | null) {
    await pool.query(
      `UPDATE attendance_calculation_runs
       SET status = $2, processed_pairs = $3, failed_pairs = $4, error_code = $5, finished_at = now()
       WHERE id = $1`,
      [run.id, status, counts.processed, counts.failed, errorCode],
    );
    const action = status === "completed" ? "attendance.calculation.completed"
      : status === "cancelled" ? "attendance.calculation.cancelled"
        : "attendance.calculation.failed";
    await insertAudit(pool, run.requestedByAccountId, action, run.id, {
      processedPairs: counts.processed,
      failedPairs: counts.failed,
      uncoveredPairs: run.uncoveredPairs,
      durationMs: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null,
      errorCode,
    });
    log("attendance calculation finished", { runId: run.id, status, processed: counts.processed, failed: counts.failed, errorCode });
  }

  async function processRun(run: CalculationRun) {
    const counts = { processed: 0, failed: 0 };
    try {
      const { covered, uncovered } = await calculationPairs(pool, {
        unitId: run.unitId, employeeId: run.employeeId, from: run.dateFrom, to: run.dateTo,
      });
      run.totalPairs = covered.length;
      run.uncoveredPairs = uncovered.length;
      await pool.query(
        "UPDATE attendance_calculation_runs SET total_pairs = $2, uncovered_pairs = $3 WHERE id = $1",
        [run.id, covered.length, uncovered.length],
      );
      for (const [index, pair] of covered.entries()) {
        if (index > 0 && index % PROGRESS_EVERY === 0) {
          const progress = await pool.query<{ cancelRequested: boolean }>(
            `UPDATE attendance_calculation_runs SET processed_pairs = $2, failed_pairs = $3
             WHERE id = $1 RETURNING cancel_requested_at IS NOT NULL AS "cancelRequested"`,
            [run.id, counts.processed, counts.failed],
          );
          if (progress.rows[0]?.cancelRequested) return finish(run, "cancelled", counts, null);
        }
        try {
          // Each pair uses the current server time, so today is calculated as a provisional result (D-14-4).
          await materialize(pool, pair.employeeId, pair.workDate, new Date());
        } catch (error) {
          counts.failed += 1;
          log("attendance calculation pair failed", { runId: run.id, error: error instanceof Error ? error.name : "unknown" });
        }
        counts.processed += 1;
        await pause();
      }
      const cancel = await pool.query<{ cancelRequested: boolean }>(
        `SELECT cancel_requested_at IS NOT NULL AS "cancelRequested" FROM attendance_calculation_runs WHERE id = $1`,
        [run.id],
      );
      return finish(run, cancel.rows[0]?.cancelRequested && counts.processed < covered.length ? "cancelled" : "completed", counts, null);
    } catch (error) {
      log("attendance calculation failed", { runId: run.id, error: error instanceof Error ? error.name : "unknown" });
      return finish(run, "failed", counts, "CALCULATION_FAILED");
    }
  }

  async function drain() {
    do {
      again = false;
      for (let run = await claimNext(); run; run = await claimNext()) await processRun(run);
    } while (again);
  }

  return {
    async recoverInterrupted() {
      const result = await pool.query<{ id: string; requestedByAccountId: string }>(
        `UPDATE attendance_calculation_runs
         SET status = 'failed', error_code = 'INTERRUPTED', finished_at = now()
         WHERE status = 'running'
         RETURNING id, requested_by_account_id AS "requestedByAccountId"`,
      );
      for (const row of result.rows) {
        await insertAudit(pool, row.requestedByAccountId, "attendance.calculation.failed", row.id, { errorCode: "INTERRUPTED" });
      }
      return result.rows.length;
    },
    kick() {
      if (loop) {
        again = true;
        return;
      }
      loop = drain()
        .catch((error: unknown) => log("attendance calculation loop stopped", { error: error instanceof Error ? error.name : "unknown" }))
        .finally(() => { loop = null; });
    },
    async idle() {
      while (loop) await loop;
    },
  };
}
