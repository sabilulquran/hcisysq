// EMP-005 S5 projection refresh (spec §8.4). Scheduled actions and contract
// ends change what the nine legacy `employees` columns should say on a given
// day without anyone recording anything, so this runs once a day and after a
// manual request. Counts only: no names, no NIP.

import type { Pool } from "pg";

import { audit } from "../infrastructure/postgres-employment-store.js";
import {
  employeesNeedingProjection,
  loadProjectedEmployeeIds,
  refreshProjection,
} from "../infrastructure/postgres-action-store.js";

export interface ProjectionRefreshSummary {
  date: string;
  mode: "due" | "all";
  considered: number;
  updated: number;
  skipped: number;
  applied: boolean;
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
  const targets = options.employeeIds?.length
    ? options.employeeIds
    : scope === "all"
      ? await loadProjectedEmployeeIds(pool)
      : await employeesNeedingProjection(pool, options.date);

  const summary: ProjectionRefreshSummary = {
    date: options.date,
    mode: scope,
    considered: targets.length,
    updated: 0,
    skipped: 0,
    applied: options.apply === true,
  };
  if (!options.apply || targets.length === 0) {
    summary.skipped = targets.length;
    return summary;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const employeeId of targets) {
      const projection = await refreshProjection(client, employeeId, options.date);
      if (projection) summary.updated += 1;
      else summary.skipped += 1;
    }
    await audit(client, {
      actorAccountId: null,
      action: "employment.projection.refreshed",
      entityType: "employment_projection",
      entityId: null,
      employeeId: null,
      payload: { date: summary.date, scope, considered: summary.considered, updated: summary.updated },
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
