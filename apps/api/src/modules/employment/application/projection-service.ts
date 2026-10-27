// EMP-005 S5/S5A projection refresh (spec §8.4, §8.5.1). Scheduled actions and
// contract ends change what the nine legacy `employees` columns should say on a
// given day without anyone recording anything, and a termination dated in the
// future closes the login account on the day after the last working day. This
// job does both, once a day and on request. Counts only: no names, no NIP.

import type { Pool } from "pg";

import { deactivateAccountsForEndedEmployment, expireTemporaryReactivations } from "../../auth/employment-access.js";
import {
  employeesNeedingProjection,
  loadProjectedEmployeeIds,
  refreshProjection,
} from "../infrastructure/postgres-action-store.js";
import { audit, getRolloutMode } from "../infrastructure/postgres-employment-store.js";

export interface ProjectionRefreshSummary {
  date: string;
  mode: "due" | "all";
  considered: number;
  updated: number;
  skipped: number;
  applied: boolean;
  /** Accounts closed because an employment ended by this date (D-15). */
  deactivatedAccounts: number;
  /** Temporary reactivations that reached their expiry. */
  expiredReactivations: number;
  /** Set when OFF or SHADOW refused the write: import still owns the columns. */
  refusedMode?: "OFF" | "SHADOW";
}

export interface ProjectionRefreshOptions {
  date: string;
  /** "all" re-projects every employee with history; "due" only those changing today. */
  scope?: "due" | "all";
  apply?: boolean;
  employeeIds?: string[];
}

/**
 * Idempotent: running it twice on the same day writes the same values. With
 * `apply: false` nothing is written and the summary only says how many rows
 * would be touched.
 */
export async function runProjectionRefresh(
  pool: Pool,
  options: ProjectionRefreshOptions,
): Promise<ProjectionRefreshSummary> {
  const scope = options.scope ?? "due";
  const empty = {
    date: options.date,
    mode: scope,
    considered: 0,
    updated: 0,
    skipped: 0,
    applied: false,
    deactivatedAccounts: 0,
    expiredReactivations: 0,
  } satisfies ProjectionRefreshSummary;

  // Spec §8.1: in OFF and SHADOW the nine columns still belong to the EMP-004
  // import, so the projection writer stays silent there — the mirror image of
  // the baseline CLI, which refuses in AUTHORITATIVE.
  const { mode } = await getRolloutMode(pool);
  if (options.apply && mode !== "AUTHORITATIVE") return { ...empty, refusedMode: mode };

  const targets = options.employeeIds?.length
    ? options.employeeIds
    : scope === "all"
      ? await loadProjectedEmployeeIds(pool)
      : await employeesNeedingProjection(pool, options.date);

  const summary: ProjectionRefreshSummary = {
    ...empty,
    considered: targets.length,
    applied: options.apply === true,
  };
  if (!options.apply || targets.length === 0) {
    summary.skipped = targets.length;
    return summary;
  }

  // One transaction per batch: on Mi8VPS a single transaction over every
  // employee would hold those rows for the whole run, blocking import commits.
  const BATCH_SIZE = 200;
  for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
    await refreshBatch(pool, targets.slice(offset, offset + BATCH_SIZE), options.date, summary);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    summary.expiredReactivations = (await expireTemporaryReactivations(client)).length;
    await audit(client, {
      actorAccountId: null,
      action: "employment.projection.refreshed",
      entityType: "employment_projection",
      entityId: null,
      employeeId: null,
      payload: {
        date: summary.date,
        scope,
        considered: summary.considered,
        updated: summary.updated,
        deactivatedAccounts: summary.deactivatedAccounts,
        expiredReactivations: summary.expiredReactivations,
      },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return summary;
}

async function refreshBatch(
  pool: Pool,
  employeeIds: string[],
  date: string,
  summary: ProjectionRefreshSummary,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const employeeId of employeeIds) {
      const projection = await refreshProjection(client, employeeId, date);
      if (projection) summary.updated += 1;
      else summary.skipped += 1;
      // EMP-005 §8.5.1: a termination recorded for a future date closes the
      // account on the day after the last working day, not before.
      if (projection?.endedOn && projection.endedOn < date) {
        summary.deactivatedAccounts += (await deactivateAccountsForEndedEmployment(client, employeeId)).length;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
