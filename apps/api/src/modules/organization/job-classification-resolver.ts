// ORG-011 Package 2: resolve the classifications in force for one employment on one date.
// Spec: docs/domain/job-classification-grade.md §3.3 and §4. ADR: ADR-0004.
//
// This is the only contract PAY-003 consumes. It returns TWO slots, functional and
// structural, because that is how compensation is shaped: a teacher who also heads a unit
// holds both at once, and the allowance tables key off them separately. The two slots map
// one-to-one onto payroll_compensation_profiles.functional_position_ref and
// .structural_position_ref, so switching those over changes no amount.
//
// Nothing here reads or grants authority (ADR-0004 §2): the caller gets codes, not rights.

import type { Pool, PoolClient } from "pg";

import { JobClassificationError, type JobFamily } from "./job-classification-service.js";

type QueryTarget = Pool | PoolClient;

export interface ResolvedClassification {
  code: string;
  name: string;
  gradeCode: string | null;
  /** PLACEMENT when the person's own placement named it, POSITION when the seat's default did. */
  source: "PLACEMENT" | "POSITION";
}

export interface ResolvedJobClassifications {
  functional: ResolvedClassification | null;
  structural: ResolvedClassification | null;
}

interface BindingRow {
  code: string;
  source: "PLACEMENT" | "POSITION";
}

/**
 * Every classification bound to an employment on `onDate`, one row per placement.
 *
 * A placement's own code wins over the seat's default (spec §3.3). The seat is read from the
 * change set published for that date, not from today's structure, so a past period resolves
 * against the organisation as it stood then.
 *
 * Voided placements are excluded: a correction that voided a placement must not keep paying.
 */
async function bindingsOn(
  target: QueryTarget, employmentId: string, onDate: string,
): Promise<BindingRow[]> {
  const result = await target.query<BindingRow>(
    `WITH effective_change_set AS (
       SELECT id FROM organization_change_sets
        WHERE status = 'PUBLISHED' AND effective_on <= $2::date
        ORDER BY effective_on DESC, published_at DESC, created_at DESC, id DESC
        LIMIT 1
     )
     SELECT
       COALESCE(placement.job_classification_code, position_row.job_classification_code) AS code,
       CASE WHEN placement.job_classification_code IS NOT NULL THEN 'PLACEMENT' ELSE 'POSITION' END AS source
     FROM employment_placements placement
     JOIN employments employment ON employment.id = placement.employment_id
     LEFT JOIN effective_change_set ON true
     LEFT JOIN organization_positions position_row
       ON position_row.change_set_id = effective_change_set.id
      AND position_row.stable_key = placement.org_position_key
      -- The seat must itself be in force. A deactivated or not-yet-effective seat still has a
      -- row in the change set, and reading its classification would pay an allowance for a
      -- job nobody holds. Same filter the rest of ORG-004 applies to positions.
      AND position_row.active
      AND position_row.effective_from <= $2::date
      AND (position_row.effective_to IS NULL OR position_row.effective_to >= $2::date)
     WHERE placement.employment_id = $1
       AND placement.voided_by_action_id IS NULL
       -- A voided employment stops paying, exactly as a voided placement does.
       AND employment.voided_by_action_id IS NULL
       AND placement.effective_from <= $2::date
       AND (placement.effective_to IS NULL OR placement.effective_to >= $2::date)
       AND COALESCE(placement.job_classification_code, position_row.job_classification_code) IS NOT NULL
     -- Deterministic order so that a slot filled twice with the same code always reports the
     -- same source; PLACEMENT sorts first because it is the more specific statement.
     ORDER BY source, code, placement.effective_from, placement.id`,
    [employmentId, onDate],
  );
  return result.rows;
}

/**
 * Resolve the functional and structural classifications for one employment on one date.
 *
 * Returns both slots empty when nothing is bound yet, which is the state of every employment
 * until Human Capital fills the catalog in. Callers must handle that explicitly rather than
 * treating it as "no allowance": PAY-003 keeps its own blockers for that decision.
 *
 * Throws CLASSIFICATION_AMBIGUOUS when two placements fill the same slot. Agreed with the
 * PAY-003 session (2026-10-27): a distinct code, never POSITION_NOT_MAPPED, because the cause
 * is an ambiguous placement and the fix is in ORG, not in payroll policy.
 */
export async function resolveJobClassifications(
  target: QueryTarget, employmentId: string, onDate: string,
): Promise<ResolvedJobClassifications> {
  const bindings = await bindingsOn(target, employmentId, onDate);
  if (bindings.length === 0) return { functional: null, structural: null };

  const codes = [...new Set(bindings.map((row) => row.code))];
  const classifications = await target.query<{
    code: string; name: string; family: JobFamily; gradeCode: string | null;
  }>(
    `SELECT code, name, family, grade_code AS "gradeCode" FROM job_classifications
      WHERE code = ANY($1::text[])
        AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)`,
    [codes, onDate],
  );

  // A code bound to a placement but not in force on this date is a catalog mistake, not an
  // empty slot: resolving it to nothing would quietly drop an allowance.
  const byCode = new Map(classifications.rows.map((row) => [row.code, row]));
  const missing = codes.filter((code) => !byCode.has(code));
  if (missing.length > 0) {
    throw new JobClassificationError(
      409, "CLASSIFICATION_NOT_EFFECTIVE",
      `Klasifikasi ${missing.sort().join(", ")} tidak berlaku pada ${onDate}.`,
    );
  }

  const slots: ResolvedJobClassifications = { functional: null, structural: null };
  for (const binding of bindings) {
    const classification = byCode.get(binding.code)!;
    // SUPPORT belongs to neither slot by design (spec §3.2): staff who carry no functional or
    // positional allowance are still classified, without payroll then looking a slot up.
    if (classification.family === "SUPPORT") continue;
    const slot = classification.family === "FUNCTIONAL" ? "functional" : "structural";
    const existing = slots[slot];
    if (existing && existing.code !== classification.code) {
      throw new JobClassificationError(
        409, "CLASSIFICATION_AMBIGUOUS",
        `Dua klasifikasi ${classification.family} berlaku bersamaan pada ${onDate}: `
        + `${[existing.code, classification.code].sort().join(" dan ")}.`,
      );
    }
    if (existing) continue;
    slots[slot] = {
      code: classification.code,
      name: classification.name,
      gradeCode: classification.gradeCode,
      source: binding.source,
    };
  }
  return slots;
}
