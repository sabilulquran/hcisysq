// EMP-005 baseline run (spec §8.2): dry-run by default, idempotent, one
// transaction, counts-only summary. Never touches accounts.

import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import {
  DEFAULT_EMPLOYMENT_POLICY,
  EMPLOYMENT_CATEGORIES,
  planBaseline,
  type BaselineIssueCode,
  type EmploymentCategory,
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

export class EmploymentBaselineReclassifyRefusedError extends Error {
  constructor(
    readonly code:
      | "EMPLOYMENT_BASELINE_MODE_AUTHORITATIVE"
      | "EMPLOYMENT_BASELINE_RECLASSIFY_REASON_REQUIRED"
      | "EMPLOYMENT_BASELINE_RECLASSIFY_CATEGORY_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "EmploymentBaselineReclassifyRefusedError";
  }
}

export interface BaselineReclassifyOptions {
  apply: boolean;
  employeeIds: string[];
  category: EmploymentCategory;
  /** Why the baseline category is wrong; stored in the audit event. */
  reason: string;
  actorAccountId?: string | null;
}

/** Why one selected employee was not reclassified. Codes only, never data. */
export type BaselineReclassifySkip =
  | "NO_BASELINE_EMPLOYMENT"
  | "MULTIPLE_EMPLOYMENTS"
  | "HAS_REAL_ACTIONS"
  | "MULTIPLE_TERMS"
  | "ALREADY_IN_CATEGORY";

export interface BaselineReclassifySummary {
  dryRun: boolean;
  category: EmploymentCategory;
  considered: number;
  reclassified: number;
  fromCategories: Partial<Record<EmploymentCategory, number>>;
  skipped: Partial<Record<BaselineReclassifySkip, number>>;
}

/**
 * Corrects the category of a baseline term in place (spec §8.2, "Koreksi kategori
 * baseline"). A `--rerun` would purge the employment and create one with a new id,
 * which is refused once payroll profiles or other records point at it; this keeps
 * the employment and its id and changes only the term's category.
 *
 * Allowed only while the history is not authoritative (OFF or SHADOW) and only for
 * an employment whose sole action is the BASELINE action and which has exactly one
 * term, opened by that action. Anything else is a real history and is changed with
 * a CATEGORY_CHANGE action. Each correction writes `employment.baseline.reclassified`.
 */
export async function reclassifyBaseline(
  pool: Pool,
  options: BaselineReclassifyOptions,
): Promise<BaselineReclassifySummary> {
  if (!EMPLOYMENT_CATEGORIES.includes(options.category) || options.category === "BELUM_DIKLASIFIKASIKAN") {
    throw new EmploymentBaselineReclassifyRefusedError(
      "EMPLOYMENT_BASELINE_RECLASSIFY_CATEGORY_INVALID",
      "Kategori tujuan harus salah satu kategori kepegawaian D-02.",
    );
  }
  const reason = options.reason.trim();
  if (reason.length < 10) {
    throw new EmploymentBaselineReclassifyRefusedError(
      "EMPLOYMENT_BASELINE_RECLASSIFY_REASON_REQUIRED",
      "Alasan koreksi wajib diisi (minimal 10 karakter).",
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('employment-baseline'))");
    const { mode } = await getRolloutMode(client);
    if (mode === "AUTHORITATIVE") {
      throw new EmploymentBaselineReclassifyRefusedError(
        "EMPLOYMENT_BASELINE_MODE_AUTHORITATIVE",
        "Koreksi baseline hanya boleh pada mode OFF atau SHADOW; gunakan tindakan CATEGORY_CHANGE.",
      );
    }

    const summary: BaselineReclassifySummary = {
      dryRun: !options.apply,
      category: options.category,
      considered: options.employeeIds.length,
      reclassified: 0,
      fromCategories: {},
      skipped: {},
    };
    const skip = (code: BaselineReclassifySkip) => {
      summary.skipped[code] = (summary.skipped[code] ?? 0) + 1;
    };

    for (const employeeId of options.employeeIds) {
      const employments = await client.query<{ id: string; actionTypes: string[] }>(
        `SELECT e.id,
                array(SELECT a.action_type FROM employment_actions a WHERE a.employment_id = e.id) AS "actionTypes"
         FROM employments e
         WHERE e.employee_id = $1 AND e.voided_by_action_id IS NULL
         FOR UPDATE`,
        [employeeId],
      );
      if (employments.rows.length === 0) { skip("NO_BASELINE_EMPLOYMENT"); continue; }
      if (employments.rows.length > 1) { skip("MULTIPLE_EMPLOYMENTS"); continue; }
      const employment = employments.rows[0]!;
      if (employment.actionTypes.length !== 1 || employment.actionTypes[0] !== "BASELINE") {
        skip(employment.actionTypes.includes("BASELINE") ? "HAS_REAL_ACTIONS" : "NO_BASELINE_EMPLOYMENT");
        continue;
      }
      const terms = await client.query<{ id: string; category: EmploymentCategory; actionId: string }>(
        `SELECT t.id, t.category, t.opened_by_action_id AS "actionId"
         FROM employment_terms t
         JOIN employment_actions a ON a.id = t.opened_by_action_id AND a.action_type = 'BASELINE'
         WHERE t.employment_id = $1 AND t.voided_by_action_id IS NULL
         FOR UPDATE OF t`,
        [employment.id],
      );
      const allTerms = await client.query("SELECT 1 FROM employment_terms WHERE employment_id = $1", [employment.id]);
      if (terms.rows.length !== 1 || allTerms.rowCount !== 1) { skip("MULTIPLE_TERMS"); continue; }
      const term = terms.rows[0]!;
      if (term.category === options.category) { skip("ALREADY_IN_CATEGORY"); continue; }

      summary.reclassified += 1;
      summary.fromCategories[term.category] = (summary.fromCategories[term.category] ?? 0) + 1;
      if (!options.apply) continue;

      await client.query("UPDATE employment_terms SET category = $2 WHERE id = $1", [term.id, options.category]);
      // Keep the BASELINE action's snapshot consistent with the term it opened.
      await client.query(
        `UPDATE employment_actions
         SET new_snapshot = jsonb_set(new_snapshot, '{category}', to_jsonb($2::text), true)
         WHERE id = $1`,
        [term.actionId, options.category],
      );
      await audit(client, {
        actorAccountId: options.actorAccountId ?? null,
        action: "employment.baseline.reclassified",
        entityType: "employment",
        entityId: employment.id,
        employeeId,
        payload: { employmentId: employment.id, termId: term.id, from: term.category, to: options.category, reason, mode },
      });
    }

    if (options.apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    return summary;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
