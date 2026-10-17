// EMP-005 baseline run (spec §8.2): dry-run by default, idempotent, one
// transaction, counts-only summary. Never touches accounts.

import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  DEFAULT_EMPLOYMENT_POLICY,
  planBaseline,
  type BaselineIssueCode,
  type EmploymentPolicy,
} from "../domain/index.js";
import {
  audit,
  getRolloutMode,
  insertBaseline,
  loadBaselineSources,
  loadHistories,
  purgeBaseline,
} from "../infrastructure/postgres-employment-store.js";

export class EmploymentBaselineRefusedError extends Error {
  constructor(readonly code: "EMPLOYMENT_BASELINE_MODE_AUTHORITATIVE", message: string) {
    super(message);
    this.name = "EmploymentBaselineRefusedError";
  }
}

export interface BaselineRunOptions {
  apply: boolean;
  cutoff: string;
  employeeIds?: string[];
  /** Re-run: purge baseline-only employments of the selected employees first. */
  rerun?: boolean;
  actorAccountId?: string | null;
  policy?: EmploymentPolicy;
}

export interface BaselineRunSummary {
  dryRun: boolean;
  cutoff: string;
  considered: number;
  created: number;
  skippedExisting: number;
  purged: number;
  excluded: { BUMY: number; PENGURUS_YAYASAN: number };
  issueCounts: Partial<Record<BaselineIssueCode, number>>;
}

export async function runEmploymentBaseline(pool: Pool, options: BaselineRunOptions): Promise<BaselineRunSummary> {
  const policy = options.policy ?? DEFAULT_EMPLOYMENT_POLICY;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent runs.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('employment-baseline'))");
    const { mode } = await getRolloutMode(client);
    if (mode === "AUTHORITATIVE") {
      throw new EmploymentBaselineRefusedError(
        "EMPLOYMENT_BASELINE_MODE_AUTHORITATIVE",
        "Baseline hanya boleh dijalankan pada mode OFF atau SHADOW.",
      );
    }

    let purged = 0;
    if (options.rerun) {
      if (!options.employeeIds?.length) throw new Error("Re-run baseline membutuhkan daftar pegawai.");
      purged = await purgeBaseline(client, options.employeeIds);
    }

    const sources = await loadBaselineSources(client, options.employeeIds);
    const histories = await loadHistories(client, options.employeeIds);
    const summary: BaselineRunSummary = {
      dryRun: !options.apply,
      cutoff: options.cutoff,
      considered: sources.length,
      created: 0,
      skippedExisting: 0,
      purged,
      excluded: { BUMY: 0, PENGURUS_YAYASAN: 0 },
      issueCounts: {},
    };

    for (const source of sources) {
      const history = histories.get(source.employeeId);
      if (history?.employments.some((employment) => !employment.voided)) {
        summary.skippedExisting += 1;
        continue;
      }
      const plan = planBaseline(source, options.cutoff, policy, randomUUID);
      for (const issue of plan.issues) summary.issueCounts[issue] = (summary.issueCounts[issue] ?? 0) + 1;
      if (plan.outcome === "EXCLUDED") {
        summary.excluded[plan.exclusion] += 1;
        continue;
      }
      if (options.apply) await insertBaseline(client, plan, options.actorAccountId ?? null);
      summary.created += 1;
    }

    if (options.apply) {
      await audit(client, {
        actorAccountId: options.actorAccountId ?? null,
        action: "employment.baseline.run",
        entityType: "employment_baseline",
        entityId: null,
        employeeId: null,
        payload: { ...summary, mode },
      });
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
    return summary;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
