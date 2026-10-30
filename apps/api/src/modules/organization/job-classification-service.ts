// ORG-011 Package 1 service: effective-dated catalogs for job classification and grade.
// Spec: docs/domain/job-classification-grade.md. ADR: ADR-0004.
//
// The catalogs hold no money and no authority. They exist so payroll allowance tables and
// placements can name a class of work by a code that survives an ORG-004 structure revision.

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type QueryTarget = Pool | PoolClient;

export const JOB_FAMILIES = ["FUNCTIONAL", "STRUCTURAL", "SUPPORT"] as const;
export type JobFamily = (typeof JOB_FAMILIES)[number];

export class JobClassificationError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "JobClassificationError";
  }
}

const JAKARTA_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
});

export function jakartaDate(instant: Date): string {
  return JAKARTA_DATE.format(instant);
}

/** The day before `date`, used to close the previous version when a code is amended. */
export function previousDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

export interface EffectiveRow {
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Inclusive on both ends; an open end runs forever. */
export function coversDate(row: EffectiveRow, onDate: string): boolean {
  if (onDate < row.effectiveFrom) return false;
  return row.effectiveTo === null || onDate <= row.effectiveTo;
}

export interface JobGrade {
  id: string;
  code: string;
  name: string;
  rankOrder: number;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface JobClassification {
  id: string;
  code: string;
  name: string;
  family: JobFamily;
  gradeCode: string | null;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

const GRADE_COLUMNS = `
  id, code, name, rank_order AS "rankOrder", active,
  to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
  to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo"
`;

const CLASSIFICATION_COLUMNS = `
  id, code, name, family, grade_code AS "gradeCode", active,
  to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
  to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo"
`;

export async function writeCatalogAudit(
  target: QueryTarget,
  event: {
    actorAccountId: string | null;
    action: string;
    entityType: "JOB_GRADE" | "JOB_CLASSIFICATION";
    entityId: string | null;
    entityCode: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await target.query(
    `INSERT INTO job_classification_audit_events
       (id, actor_account_id, action, entity_type, entity_id, entity_code, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      randomUUID(), event.actorAccountId, event.action, event.entityType,
      event.entityId, event.entityCode, JSON.stringify(event.payload ?? {}),
    ],
  );
}

/** The version of a code that covers `onDate`, or null when the code does not exist then. */
export async function gradeOn(
  target: QueryTarget, code: string, onDate: string,
): Promise<JobGrade | null> {
  const result = await target.query<JobGrade>(
    `SELECT ${GRADE_COLUMNS} FROM job_grades
      WHERE code = $1 AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)`,
    [code, onDate],
  );
  return result.rows[0] ?? null;
}

export async function classificationOn(
  target: QueryTarget, code: string, onDate: string,
): Promise<JobClassification | null> {
  const result = await target.query<JobClassification>(
    `SELECT ${CLASSIFICATION_COLUMNS} FROM job_classifications
      WHERE code = $1 AND effective_from <= $2::date
        AND (effective_to IS NULL OR effective_to >= $2::date)`,
    [code, onDate],
  );
  return result.rows[0] ?? null;
}

/**
 * A classification may only name a grade that exists on its own first day. Checked here
 * rather than by a foreign key: both sides are effective-dated, and an FK would compare rows
 * without regard to their dates while blocking a grade from ever being superseded.
 */
async function assertGradeResolvable(
  target: QueryTarget, gradeCode: string | null, onDate: string,
): Promise<void> {
  if (gradeCode === null) return;
  const grade = await gradeOn(target, gradeCode, onDate);
  if (!grade) {
    throw new JobClassificationError(
      400, "GRADE_NOT_EFFECTIVE",
      `Golongan ${gradeCode} tidak berlaku pada ${onDate}.`,
    );
  }
}

export interface CatalogListQuery {
  onDate?: string | undefined;
  includeSuperseded?: boolean | undefined;
  family?: JobFamily | undefined;
  limit: number;
  offset: number;
}

export async function listGrades(
  target: QueryTarget, query: CatalogListQuery,
): Promise<{ rows: JobGrade[]; total: number }> {
  const filters: string[] = [];
  const values: unknown[] = [];
  if (query.onDate) {
    values.push(query.onDate);
    filters.push(`effective_from <= $${values.length}::date
      AND (effective_to IS NULL OR effective_to >= $${values.length}::date)`);
  }
  if (!query.includeSuperseded) filters.push("active = true");
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  // ENG-LIST-001: filters run before LIMIT and the caller receives the true total.
  const totals = await target.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM job_grades ${where}`, values,
  );
  const rows = await target.query<JobGrade>(
    `SELECT ${GRADE_COLUMNS} FROM job_grades ${where}
      ORDER BY rank_order ASC, code ASC, effective_from DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, query.limit, query.offset],
  );
  return { rows: rows.rows, total: Number(totals.rows[0]?.total ?? "0") };
}

export async function listClassifications(
  target: QueryTarget, query: CatalogListQuery,
): Promise<{ rows: JobClassification[]; total: number }> {
  const filters: string[] = [];
  const values: unknown[] = [];
  if (query.onDate) {
    values.push(query.onDate);
    filters.push(`effective_from <= $${values.length}::date
      AND (effective_to IS NULL OR effective_to >= $${values.length}::date)`);
  }
  if (query.family) {
    values.push(query.family);
    filters.push(`family = $${values.length}`);
  }
  if (!query.includeSuperseded) filters.push("active = true");
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const totals = await target.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM job_classifications ${where}`, values,
  );
  const rows = await target.query<JobClassification>(
    `SELECT ${CLASSIFICATION_COLUMNS} FROM job_classifications ${where}
      ORDER BY family ASC, code ASC, effective_from DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, query.limit, query.offset],
  );
  return { rows: rows.rows, total: Number(totals.rows[0]?.total ?? "0") };
}

export interface GradeInput {
  code: string;
  name: string;
  rankOrder: number;
  effectiveFrom: string;
}

export interface ClassificationInput {
  code: string;
  name: string;
  family: JobFamily;
  gradeCode: string | null;
  effectiveFrom: string;
}

/**
 * Create the first version of a code. A code that already covers `effectiveFrom` is an amend,
 * not a create, so this refuses rather than letting the exclusion constraint surface as 500.
 */
export async function createGrade(
  pool: Pool, input: GradeInput, actorAccountId: string | null,
): Promise<JobGrade> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await gradeOn(client, input.code, input.effectiveFrom);
    if (existing) {
      throw new JobClassificationError(
        409, "GRADE_CODE_IN_USE",
        `Golongan ${input.code} sudah berlaku pada ${input.effectiveFrom}. Gunakan perubahan, bukan penambahan.`,
      );
    }
    const id = randomUUID();
    const inserted = await client.query<JobGrade>(
      `INSERT INTO job_grades (id, code, name, rank_order, effective_from)
       VALUES ($1, $2, $3, $4, $5::date) RETURNING ${GRADE_COLUMNS}`,
      [id, input.code, input.name, input.rankOrder, input.effectiveFrom],
    );
    await writeCatalogAudit(client, {
      actorAccountId, action: "job_grade.created", entityType: "JOB_GRADE",
      entityId: id, entityCode: input.code,
      payload: { name: input.name, rankOrder: input.rankOrder, effectiveFrom: input.effectiveFrom },
    });
    await client.query("COMMIT");
    return inserted.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createClassification(
  pool: Pool, input: ClassificationInput, actorAccountId: string | null,
): Promise<JobClassification> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await classificationOn(client, input.code, input.effectiveFrom);
    if (existing) {
      throw new JobClassificationError(
        409, "CLASSIFICATION_CODE_IN_USE",
        `Klasifikasi ${input.code} sudah berlaku pada ${input.effectiveFrom}. Gunakan perubahan, bukan penambahan.`,
      );
    }
    await assertGradeResolvable(client, input.gradeCode, input.effectiveFrom);
    const id = randomUUID();
    const inserted = await client.query<JobClassification>(
      `INSERT INTO job_classifications (id, code, name, family, grade_code, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6::date) RETURNING ${CLASSIFICATION_COLUMNS}`,
      [id, input.code, input.name, input.family, input.gradeCode, input.effectiveFrom],
    );
    await writeCatalogAudit(client, {
      actorAccountId, action: "job_classification.created", entityType: "JOB_CLASSIFICATION",
      entityId: id, entityCode: input.code,
      payload: {
        name: input.name, family: input.family,
        gradeCode: input.gradeCode, effectiveFrom: input.effectiveFrom,
      },
    });
    await client.query("COMMIT");
    return inserted.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface AmendInput {
  effectiveFrom: string;
  name?: string | undefined;
  rankOrder?: number | undefined;
  family?: JobFamily | undefined;
  gradeCode?: string | null | undefined;
}

/**
 * Amend a code from a date: close the version in force the day before and insert a new one.
 * The code itself never changes (spec §2.6) — payroll policy stores it verbatim and past
 * periods read it back, so a rename would silently detach old policy rows from their meaning.
 *
 * family is amendable here because the slot a class belongs to is a property of the work, and
 * getting it wrong at creation must be fixable; it still only takes effect from the new date,
 * so a period already calculated keeps the family it was calculated with.
 */
export async function amendClassification(
  pool: Pool, code: string, input: AmendInput, actorAccountId: string | null,
): Promise<JobClassification> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await classificationOn(client, code, input.effectiveFrom);
    if (!current) {
      throw new JobClassificationError(
        404, "CLASSIFICATION_NOT_EFFECTIVE",
        `Klasifikasi ${code} tidak berlaku pada ${input.effectiveFrom}.`,
      );
    }
    if (current.effectiveFrom === input.effectiveFrom) {
      throw new JobClassificationError(
        409, "CLASSIFICATION_SAME_DAY_AMEND",
        "Perubahan harus berlaku setelah tanggal mulai versi yang berjalan.",
      );
    }
    const next = {
      name: input.name ?? current.name,
      family: input.family ?? current.family,
      gradeCode: input.gradeCode === undefined ? current.gradeCode : input.gradeCode,
    };
    await assertGradeResolvable(client, next.gradeCode, input.effectiveFrom);

    await client.query(
      `UPDATE job_classifications SET effective_to = $2::date, updated_at = now() WHERE id = $1`,
      [current.id, previousDay(input.effectiveFrom)],
    );
    const id = randomUUID();
    const inserted = await client.query<JobClassification>(
      `INSERT INTO job_classifications (id, code, name, family, grade_code, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6::date) RETURNING ${CLASSIFICATION_COLUMNS}`,
      [id, code, next.name, next.family, next.gradeCode, input.effectiveFrom],
    );
    await writeCatalogAudit(client, {
      actorAccountId, action: "job_classification.amended", entityType: "JOB_CLASSIFICATION",
      entityId: id, entityCode: code,
      payload: { supersededId: current.id, effectiveFrom: input.effectiveFrom, ...next },
    });
    await client.query("COMMIT");
    return inserted.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function amendGrade(
  pool: Pool, code: string, input: AmendInput, actorAccountId: string | null,
): Promise<JobGrade> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await gradeOn(client, code, input.effectiveFrom);
    if (!current) {
      throw new JobClassificationError(
        404, "GRADE_NOT_EFFECTIVE", `Golongan ${code} tidak berlaku pada ${input.effectiveFrom}.`,
      );
    }
    if (current.effectiveFrom === input.effectiveFrom) {
      throw new JobClassificationError(
        409, "GRADE_SAME_DAY_AMEND",
        "Perubahan harus berlaku setelah tanggal mulai versi yang berjalan.",
      );
    }
    const next = {
      name: input.name ?? current.name,
      rankOrder: input.rankOrder ?? current.rankOrder,
    };
    await client.query(
      `UPDATE job_grades SET effective_to = $2::date, updated_at = now() WHERE id = $1`,
      [current.id, previousDay(input.effectiveFrom)],
    );
    const id = randomUUID();
    const inserted = await client.query<JobGrade>(
      `INSERT INTO job_grades (id, code, name, rank_order, effective_from)
       VALUES ($1, $2, $3, $4, $5::date) RETURNING ${GRADE_COLUMNS}`,
      [id, code, next.name, next.rankOrder, input.effectiveFrom],
    );
    await writeCatalogAudit(client, {
      actorAccountId, action: "job_grade.amended", entityType: "JOB_GRADE",
      entityId: id, entityCode: code,
      payload: { supersededId: current.id, effectiveFrom: input.effectiveFrom, ...next },
    });
    await client.query("COMMIT");
    return inserted.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Close a code from a date. The rows stay: a payroll period already calculated reads the
 * version that covered its own dates, so deleting would make a paid month unexplainable.
 */
export async function deactivateClassification(
  pool: Pool, code: string, endOn: string, reason: string, actorAccountId: string | null,
): Promise<JobClassification> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await classificationOn(client, code, endOn);
    if (!current) {
      throw new JobClassificationError(
        404, "CLASSIFICATION_NOT_EFFECTIVE", `Klasifikasi ${code} tidak berlaku pada ${endOn}.`,
      );
    }
    const updated = await client.query<JobClassification>(
      `UPDATE job_classifications
          SET effective_to = $2::date, active = false, updated_at = now()
        WHERE id = $1 RETURNING ${CLASSIFICATION_COLUMNS}`,
      [current.id, endOn],
    );
    await writeCatalogAudit(client, {
      actorAccountId, action: "job_classification.deactivated", entityType: "JOB_CLASSIFICATION",
      entityId: current.id, entityCode: code, payload: { endOn, reason },
    });
    await client.query("COMMIT");
    return updated.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deactivateGrade(
  pool: Pool, code: string, endOn: string, reason: string, actorAccountId: string | null,
): Promise<JobGrade> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await gradeOn(client, code, endOn);
    if (!current) {
      throw new JobClassificationError(
        404, "GRADE_NOT_EFFECTIVE", `Golongan ${code} tidak berlaku pada ${endOn}.`,
      );
    }
    // A grade that classifications still name on the day after it closes would leave those
    // classifications pointing at nothing, so refuse instead of breaking them silently.
    const dependants = await client.query<{ code: string }>(
      `SELECT DISTINCT code FROM job_classifications
        WHERE grade_code = $1 AND (effective_to IS NULL OR effective_to > $2::date)
        ORDER BY code LIMIT 5`,
      [code, endOn],
    );
    if (dependants.rows.length > 0) {
      throw new JobClassificationError(
        409, "GRADE_STILL_REFERENCED",
        `Golongan ${code} masih dipakai klasifikasi ${dependants.rows.map((row) => row.code).join(", ")}.`,
      );
    }
    const updated = await client.query<JobGrade>(
      `UPDATE job_grades SET effective_to = $2::date, active = false, updated_at = now()
        WHERE id = $1 RETURNING ${GRADE_COLUMNS}`,
      [current.id, endOn],
    );
    await writeCatalogAudit(client, {
      actorAccountId, action: "job_grade.deactivated", entityType: "JOB_GRADE",
      entityId: current.id, entityCode: code, payload: { endOn, reason },
    });
    await client.query("COMMIT");
    return updated.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
