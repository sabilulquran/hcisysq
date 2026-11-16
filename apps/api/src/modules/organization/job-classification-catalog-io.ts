// ORG-011 Package 4: export, audited CSV import, change history, and the per-employee read view.
// Spec: docs/domain/job-classification-grade.md §5.1-§5.4. ADR: ADR-0004.
//
// Nothing here holds money or grants authority. Import reuses the same create/amend rules as the
// one-at-a-time screen (codes permanent, no write behind a later version, grade must exist on the
// row's date), so a file can never put the catalog in a state the screen would have refused.

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { quoteCsvCell } from "../../lib/csv.js";
import { bindingsOn, resolveJobClassifications, type ResolvedJobClassifications } from "./job-classification-resolver.js";
import {
  CLASSIFICATION_CODE_PATTERN,
  GRADE_CODE_PATTERN,
  JOB_FAMILIES,
  JobClassificationError,
  amendClassificationIn,
  amendGradeIn,
  classificationOn,
  createClassificationIn,
  createGradeIn,
  gradeOn,
  writeCatalogAudit,
  type JobFamily,
} from "./job-classification-service.js";

type QueryTarget = Pool | PoolClient;

export type CatalogKind = "CLASSIFICATION" | "GRADE";

/** Above this an export is refused rather than cut short (ENG-LIST-001: never truncate silently). */
export const EXPORT_ROW_LIMIT = 10_000;
/** One import file is one reviewed batch; YSQ is expected to hold tens of codes, not thousands. */
export const IMPORT_ROW_LIMIT = 1_000;

const CODE_PATTERN: Record<CatalogKind, RegExp> = {
  CLASSIFICATION: CLASSIFICATION_CODE_PATTERN,
  GRADE: GRADE_CODE_PATTERN,
};

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/**
 * RFC 4180 reader: comma separated, double-quote quoting, CRLF or LF line ends. Returns each
 * record with the 1-based line it started on, so an error points at the line the operator sees.
 */
export function parseCsv(text: string): Array<{ line: number; cells: string[] }> {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 2; continue; }
        quoted = false; index += 1; continue;
      }
      if (char === "\n") line += 1;
      cell += char; index += 1; continue;
    }
    if (char === '"' && cell === "") { quoted = true; index += 1; continue; }
    if (char === ",") { cells.push(cell); cell = ""; index += 1; continue; }
    if (char === "\r" || char === "\n") {
      cells.push(cell);
      records.push({ line: recordLine, cells });
      cells = []; cell = "";
      index += char === "\r" && source[index + 1] === "\n" ? 2 : 1;
      line += 1; recordLine = line;
      continue;
    }
    cell += char; index += 1;
  }
  if (quoted) {
    throw new JobClassificationError(400, "IMPORT_CSV_MALFORMED", `Tanda kutip pada baris ${recordLine} tidak ditutup.`);
  }
  if (cell !== "" || cells.length > 0) {
    cells.push(cell);
    records.push({ line: recordLine, cells });
  }
  // A blank line is not a row. Spreadsheet exports often end with one or two.
  return records.filter((record) => record.cells.some((value) => value.trim() !== ""));
}

/**
 * Undo the export's formula guard: `'=x` was written for `=x`. Only a leading apostrophe in
 * front of a formula character is removed, so an apostrophe the operator typed survives.
 */
function unguard(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

function csvLine(cells: Array<string | number | boolean | null>): string {
  return cells.map((cell) => quoteCsvCell(cell === null ? "" : String(cell))).join(",");
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export const CLASSIFICATION_EXPORT_HEADER = [
  "code", "name", "family", "grade_code", "effective_from", "effective_to", "active",
] as const;
export const GRADE_EXPORT_HEADER = [
  "code", "name", "rank_order", "effective_from", "effective_to", "active",
] as const;

export interface ExportQuery {
  onDate: string;
  includeHistory: boolean;
}

/**
 * The catalog as CSV. The columns are the import columns plus the version range, so a file
 * exported "as of a date" can be edited and imported back; unknown columns are ignored there.
 */
export async function exportCatalogCsv(
  target: QueryTarget, kind: CatalogKind, query: ExportQuery,
): Promise<{ csv: string; rowCount: number }> {
  const table = kind === "CLASSIFICATION" ? "job_classifications" : "job_grades";
  const values: unknown[] = [];
  let where = "";
  if (!query.includeHistory) {
    values.push(query.onDate);
    where = `WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to >= $1::date)`;
  }
  const total = await target.query<{ total: string }>(`SELECT count(*)::text AS total FROM ${table} ${where}`, values);
  const count = Number(total.rows[0]?.total ?? "0");
  if (count > EXPORT_ROW_LIMIT) {
    throw new JobClassificationError(
      413, "EXPORT_TOO_LARGE",
      `Ekspor memuat ${count} baris, melebihi batas ${EXPORT_ROW_LIMIT}. Pilih satu tanggal, bukan seluruh versi.`,
    );
  }
  const lines: string[] = [];
  if (kind === "CLASSIFICATION") {
    const rows = await target.query<{
      code: string; name: string; family: string; gradeCode: string | null;
      effectiveFrom: string; effectiveTo: string | null; active: boolean;
    }>(
      `SELECT code, name, family, grade_code AS "gradeCode",
              to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
              to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo", active
         FROM job_classifications ${where}
        ORDER BY family ASC, code ASC, effective_from ASC`,
      values,
    );
    lines.push(csvLine([...CLASSIFICATION_EXPORT_HEADER]));
    for (const row of rows.rows) {
      lines.push(csvLine([row.code, row.name, row.family, row.gradeCode, row.effectiveFrom, row.effectiveTo, row.active]));
    }
  } else {
    const rows = await target.query<{
      code: string; name: string; rankOrder: number;
      effectiveFrom: string; effectiveTo: string | null; active: boolean;
    }>(
      `SELECT code, name, rank_order AS "rankOrder",
              to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
              to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo", active
         FROM job_grades ${where}
        ORDER BY rank_order ASC, code ASC, effective_from ASC`,
      values,
    );
    lines.push(csvLine([...GRADE_EXPORT_HEADER]));
    for (const row of rows.rows) {
      lines.push(csvLine([row.code, row.name, row.rankOrder, row.effectiveFrom, row.effectiveTo, row.active]));
    }
  }
  // A byte-order mark so spreadsheet programs read the file as UTF-8.
  return { csv: `${String.fromCharCode(0xfeff)}${lines.join("\r\n")}\r\n`, rowCount: count };
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

export type ImportOutcome = "CREATE" | "AMEND" | "UNCHANGED" | "ERROR";

export interface ImportRowReport {
  line: number;
  code: string | null;
  outcome: ImportOutcome;
  errorCode?: string;
  message?: string;
}

export interface ImportReport {
  importId: string;
  kind: CatalogKind;
  dryRun: boolean;
  /** True only when the rows were written. A file with any error writes nothing. */
  applied: boolean;
  summary: { rows: number; create: number; amend: number; unchanged: number; error: number };
  rows: ImportRowReport[];
}

const REQUIRED_COLUMNS: Record<CatalogKind, readonly string[]> = {
  CLASSIFICATION: ["code", "name", "family", "grade_code", "effective_from"],
  GRADE: ["code", "name", "rank_order", "effective_from"],
};

function isCalendarDate(value: string): boolean {
  // From 1900: an employment catalog has no earlier meaning, and year 0000 is a JS date that
  // PostgreSQL refuses, which would otherwise surface as a database error mid-import.
  if (!/^(19|[2-9]\d)\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

class RowError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

interface ClassificationRow { code: string; name: string; family: JobFamily; gradeCode: string | null; effectiveFrom: string }
interface GradeRow { code: string; name: string; rankOrder: number; effectiveFrom: string }

function readName(value: string): string {
  const name = value.trim();
  if (name.length < 2 || name.length > 120) throw new RowError("IMPORT_INVALID_NAME", "Nama harus 2-120 huruf.");
  return name;
}

function readDate(value: string): string {
  const date = value.trim();
  if (!isCalendarDate(date)) throw new RowError("IMPORT_INVALID_DATE", "effective_from harus tanggal YYYY-MM-DD.");
  return date;
}

function readCode(kind: CatalogKind, value: string): string {
  // Codes are stored verbatim in payroll policy (spec §2.6), so the shape is not normalised:
  // "func_guru" is refused instead of silently becoming FUNC_GURU.
  const code = value.trim();
  if (!CODE_PATTERN[kind].test(code)) {
    throw new RowError("IMPORT_INVALID_CODE", "Kode harus huruf besar, angka, atau garis bawah, diawali huruf.");
  }
  return code;
}

function readClassificationRow(cell: (name: string) => string): ClassificationRow {
  const family = cell("family").trim();
  if (!(JOB_FAMILIES as readonly string[]).includes(family)) {
    throw new RowError("IMPORT_INVALID_FAMILY", `family harus salah satu dari ${JOB_FAMILIES.join(", ")}.`);
  }
  const grade = cell("grade_code").trim();
  if (grade !== "" && !CODE_PATTERN.GRADE.test(grade)) {
    throw new RowError("IMPORT_INVALID_GRADE", "grade_code harus kosong atau kode golongan yang sah.");
  }
  return {
    code: readCode("CLASSIFICATION", cell("code")),
    name: readName(cell("name")),
    family: family as JobFamily,
    gradeCode: grade === "" ? null : grade,
    effectiveFrom: readDate(cell("effective_from")),
  };
}

function readGradeRow(cell: (name: string) => string): GradeRow {
  const rank = cell("rank_order").trim();
  if (!/^\d{1,4}$/.test(rank)) throw new RowError("IMPORT_INVALID_RANK", "rank_order harus bilangan bulat 0-9999.");
  return {
    code: readCode("GRADE", cell("code")),
    name: readName(cell("name")),
    rankOrder: Number(rank),
    effectiveFrom: readDate(cell("effective_from")),
  };
}

export interface ImportInput {
  kind: CatalogKind;
  csv: string;
  dryRun: boolean;
  fileName: string | null;
}

/**
 * Import one CSV file in a single transaction.
 *
 * Every row runs through the same create/amend functions the screen uses, inside a savepoint,
 * so rows that depend on earlier rows in the file (a grade then a classification naming it) are
 * validated against the state the file itself builds up. A dry run, or a file with any error,
 * is rolled back as a whole: Human Capital either gets the whole file or nothing.
 *
 * Each written row leaves its ordinary audit event carrying the importId, and the batch leaves
 * one `*.imported` event with the file digest, so a payroll reviewer can trace a code to the
 * file that introduced it. A dry run writes no audit, because it changes nothing.
 */
export async function importCatalog(
  pool: Pool, input: ImportInput, actorAccountId: string | null,
): Promise<ImportReport> {
  const records = parseCsv(input.csv);
  if (records.length === 0) {
    throw new JobClassificationError(400, "IMPORT_EMPTY", "Berkas kosong. Baris pertama harus judul kolom.");
  }
  const [headerRecord, ...dataRecords] = records;
  const header = headerRecord!.cells.map((name) => name.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS[input.kind].filter((name) => !header.includes(name));
  if (missing.length > 0) {
    throw new JobClassificationError(400, "IMPORT_MISSING_COLUMNS", `Kolom wajib tidak ada: ${missing.join(", ")}.`);
  }
  const duplicateHeader = header.find((name, index) => name !== "" && header.indexOf(name) !== index);
  if (duplicateHeader) {
    throw new JobClassificationError(400, "IMPORT_DUPLICATE_COLUMN", `Kolom ${duplicateHeader} muncul lebih dari sekali.`);
  }
  if (dataRecords.length === 0) {
    throw new JobClassificationError(400, "IMPORT_EMPTY", "Berkas tidak memuat baris data.");
  }
  if (dataRecords.length > IMPORT_ROW_LIMIT) {
    throw new JobClassificationError(
      400, "IMPORT_TOO_MANY_ROWS", `Berkas memuat ${dataRecords.length} baris; batasnya ${IMPORT_ROW_LIMIT} per berkas.`,
    );
  }

  const importId = randomUUID();
  const digest = createHash("sha256").update(input.csv, "utf8").digest("hex");
  const auditContext = { importId };
  const rows: ImportRowReport[] = [];
  const seen = new Set<string>();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Two imports at once would each validate against a catalog the other is changing.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('org011.catalog.import'))`);

    for (const record of dataRecords) {
      const cell = (name: string) => unguard(record.cells[header.indexOf(name)] ?? "");
      let code: string | null = cell("code").trim() || null;
      try {
        const parsed = input.kind === "CLASSIFICATION" ? readClassificationRow(cell) : readGradeRow(cell);
        code = parsed.code;
        // One code once per file: two rows for one code would depend on row order to mean anything.
        if (seen.has(parsed.code)) throw new RowError("IMPORT_DUPLICATE_CODE", "Kode ini sudah muncul di baris sebelumnya.");
        seen.add(parsed.code);

        await client.query("SAVEPOINT import_row");
        try {
          const outcome = input.kind === "CLASSIFICATION"
            ? await importClassificationRow(client, parsed as ClassificationRow, actorAccountId, auditContext)
            : await importGradeRow(client, parsed as GradeRow, actorAccountId, auditContext);
          await client.query("RELEASE SAVEPOINT import_row");
          rows.push({ line: record.line, code, outcome });
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT import_row");
          await client.query("RELEASE SAVEPOINT import_row");
          throw error;
        }
      } catch (error) {
        if (error instanceof RowError || error instanceof JobClassificationError) {
          rows.push({ line: record.line, code, outcome: "ERROR", errorCode: error.code, message: error.message });
          continue;
        }
        const sqlState = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        // 23P01 is the (code, range) exclusion constraint: same meaning as the service's conflict.
        if (sqlState === "23P01") {
          rows.push({
            line: record.line, code, outcome: "ERROR", errorCode: "CATALOG_VERSION_CONFLICT",
            message: "Rentang berlaku bertabrakan dengan versi lain kode ini.",
          });
          continue;
        }
        // Any other data or constraint error (classes 22, 23) is about this row's values; the row
        // savepoint already undid it, so report the line instead of failing the whole file.
        if (typeof sqlState === "string" && (sqlState.startsWith("22") || sqlState.startsWith("23"))) {
          rows.push({
            line: record.line, code, outcome: "ERROR", errorCode: "IMPORT_ROW_REJECTED",
            message: "Nilai baris ini ditolak basis data. Periksa tanggal dan isian lain.",
          });
          continue;
        }
        throw error;
      }
    }

    const summary = {
      rows: rows.length,
      create: rows.filter((row) => row.outcome === "CREATE").length,
      amend: rows.filter((row) => row.outcome === "AMEND").length,
      unchanged: rows.filter((row) => row.outcome === "UNCHANGED").length,
      error: rows.filter((row) => row.outcome === "ERROR").length,
    };
    const apply = !input.dryRun && summary.error === 0;
    if (apply && summary.create + summary.amend > 0) {
      await writeCatalogAudit(client, {
        actorAccountId,
        action: input.kind === "CLASSIFICATION" ? "job_classification.imported" : "job_grade.imported",
        entityType: input.kind === "CLASSIFICATION" ? "JOB_CLASSIFICATION" : "JOB_GRADE",
        entityId: null,
        entityCode: null,
        payload: { importId, fileName: input.fileName, sha256: digest, ...summary },
      });
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return { importId, kind: input.kind, dryRun: input.dryRun, applied: apply, summary, rows };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function importClassificationRow(
  client: PoolClient, row: ClassificationRow, actorAccountId: string | null, auditContext: Record<string, unknown>,
): Promise<ImportOutcome> {
  const current = await classificationOn(client, row.code, row.effectiveFrom);
  if (!current) {
    // Refuses a code that ever existed (CLASSIFICATION_CODE_IN_USE): codes are never resurrected.
    await createClassificationIn(client, row, actorAccountId, auditContext);
    return "CREATE";
  }
  if (current.name === row.name && current.family === row.family && current.gradeCode === row.gradeCode) {
    return "UNCHANGED";
  }
  await amendClassificationIn(client, row.code, {
    effectiveFrom: row.effectiveFrom, name: row.name, family: row.family, gradeCode: row.gradeCode,
  }, actorAccountId, auditContext);
  return "AMEND";
}

async function importGradeRow(
  client: PoolClient, row: GradeRow, actorAccountId: string | null, auditContext: Record<string, unknown>,
): Promise<ImportOutcome> {
  const current = await gradeOn(client, row.code, row.effectiveFrom);
  if (!current) {
    await createGradeIn(client, row, actorAccountId, auditContext);
    return "CREATE";
  }
  if (current.name === row.name && current.rankOrder === row.rankOrder) return "UNCHANGED";
  await amendGradeIn(client, row.code, {
    effectiveFrom: row.effectiveFrom, name: row.name, rankOrder: row.rankOrder,
  }, actorAccountId, auditContext);
  return "AMEND";
}

// ---------------------------------------------------------------------------------------------
// Change history
// ---------------------------------------------------------------------------------------------

export interface CatalogAuditEvent {
  id: string;
  action: string;
  entityType: "JOB_GRADE" | "JOB_CLASSIFICATION";
  entityCode: string | null;
  payload: Record<string, unknown>;
  actorName: string | null;
  occurredAt: string;
}

export async function listCatalogAuditEvents(
  target: QueryTarget,
  query: { entityType?: "JOB_GRADE" | "JOB_CLASSIFICATION" | undefined; entityCode?: string | undefined; limit: number; offset: number },
): Promise<{ rows: CatalogAuditEvent[]; total: number }> {
  const filters: string[] = [];
  const values: unknown[] = [];
  if (query.entityType) { values.push(query.entityType); filters.push(`event.entity_type = $${values.length}`); }
  if (query.entityCode) { values.push(query.entityCode); filters.push(`event.entity_code = $${values.length}`); }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  // ENG-LIST-001: filters before LIMIT, true total returned.
  const total = await target.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM job_classification_audit_events event ${where}`, values,
  );
  const rows = await target.query<Omit<CatalogAuditEvent, "occurredAt"> & { occurredAt: Date }>(
    `SELECT event.id, event.action, event.entity_type AS "entityType", event.entity_code AS "entityCode",
            event.payload, COALESCE(employee.full_name, account.email) AS "actorName",
            event.occurred_at AS "occurredAt"
       FROM job_classification_audit_events event
       LEFT JOIN accounts account ON account.id = event.actor_account_id
       LEFT JOIN employees employee ON employee.id = account.employee_id
       ${where}
      ORDER BY event.occurred_at DESC, event.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, query.limit, query.offset],
  );
  return {
    rows: rows.rows.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() })),
    total: Number(total.rows[0]?.total ?? "0"),
  };
}

// ---------------------------------------------------------------------------------------------
// Per-employee read view
// ---------------------------------------------------------------------------------------------

export interface EmployeeClassificationBinding {
  code: string;
  source: "PLACEMENT" | "POSITION";
  /** Null when the code is bound but not in force on the date: a catalog mistake to fix. */
  name: string | null;
  family: JobFamily | null;
  gradeCode: string | null;
}

export interface EmployeeClassificationEmployment {
  employmentId: string;
  /** What payroll would read. Null when resolution failed; `error` then says why. */
  slots: ResolvedJobClassifications | null;
  error: { code: string; message: string } | null;
  /** Every bound code, SUPPORT included, so HC sees what the two slots leave out. */
  bindings: EmployeeClassificationBinding[];
}

/**
 * The classifications in force for one employee on one date, per employment.
 *
 * Read-only and informational: it calls the same resolver payroll is contracted to use, and
 * reports its blockers (CLASSIFICATION_AMBIGUOUS, CLASSIFICATION_NOT_EFFECTIVE) as data, so
 * Human Capital can fix a placement before a payroll period trips over it.
 */
export async function employeeJobClassifications(
  target: QueryTarget, employeeId: string, onDate: string,
): Promise<EmployeeClassificationEmployment[] | null> {
  const employee = await target.query(`SELECT 1 FROM employees WHERE id = $1`, [employeeId]);
  if ((employee.rowCount ?? 0) === 0) return null;
  const employments = await target.query<{ id: string }>(
    `SELECT id FROM employments
      WHERE employee_id = $1 AND voided_by_action_id IS NULL
        AND (started_on IS NULL OR started_on <= $2::date)
        AND (ended_on IS NULL OR ended_on >= $2::date)
      ORDER BY started_on NULLS FIRST, id`,
    [employeeId, onDate],
  );
  const result: EmployeeClassificationEmployment[] = [];
  for (const employment of employments.rows) {
    const bindings = await bindingsOn(target, employment.id, onDate);
    const codes = [...new Set(bindings.map((binding) => binding.code))];
    const catalog = codes.length === 0 ? [] : (await target.query<{
      code: string; name: string; family: JobFamily; gradeCode: string | null;
    }>(
      `SELECT code, name, family, grade_code AS "gradeCode" FROM job_classifications
        WHERE code = ANY($1::text[]) AND effective_from <= $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)`,
      [codes, onDate],
    )).rows;
    const byCode = new Map(catalog.map((row) => [row.code, row]));
    let slots: ResolvedJobClassifications | null = null;
    let error: { code: string; message: string } | null = null;
    try {
      slots = await resolveJobClassifications(target, employment.id, onDate);
    } catch (cause) {
      if (!(cause instanceof JobClassificationError)) throw cause;
      error = { code: cause.code, message: cause.message };
    }
    result.push({
      employmentId: employment.id,
      slots,
      error,
      bindings: bindings.map((binding) => {
        const entry = byCode.get(binding.code);
        return {
          code: binding.code,
          source: binding.source,
          name: entry?.name ?? null,
          family: entry?.family ?? null,
          gradeCode: entry?.gradeCode ?? null,
        };
      }),
    });
  }
  return result;
}
