import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { pageOffset, pagination, type PageQuery } from "../../../lib/pagination.js";
import type {
  EmployeeImportCandidate,
  EmployeeImportCommitResult,
  EmployeeImportPreview,
  EmployeeImportPreviewPage,
  EmployeeImportSummary,
  ImportAction,
  ImportIssue,
} from "../domain/employee-import.js";
import { EMPLOYEE_SOURCE_CLASSIFICATION_HEADERS, normalizeReferenceName } from "../domain/employee-import.js";
import type {
  EmployeeImportRowFilter,
  EmployeeImportStore,
  SaveEmployeeImportPreviewInput,
} from "../application/employee-import-store.js";
import { PROJECTED_IMPORT_FIELDS } from "../../employment/domain/index.js";
import { loadEmploymentManagedEmployeeIds } from "../../employment/infrastructure/postgres-action-store.js";
import { audit } from "../../employment/infrastructure/postgres-employment-store.js";

interface ImportJobRow {
  id: string;
  source_filename: string;
  source_sheet: string;
  checksum_sha256: string;
  row_count: number;
  insert_count: number;
  update_count: number;
  warning_count: number;
  error_count: number;
  status: "previewed" | "committed" | "failed";
  created_at: Date;
  committed_at: Date | null;
}

interface ImportDetailRow {
  row_number: number;
  action: ImportAction;
  payload: EmployeeImportCandidate | null;
  messages: ImportIssue[];
}

export class EmployeeImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmployeeImportConflictError";
  }
}

function toSummary(row: ImportJobRow): EmployeeImportSummary {
  return {
    importId: row.id,
    sourceFilename: row.source_filename,
    sourceSheet: row.source_sheet,
    checksumSha256: row.checksum_sha256,
    rowCount: row.row_count,
    insertCount: row.insert_count,
    updateCount: row.update_count,
    warningCount: row.warning_count,
    errorCount: row.error_count,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    committedAt: row.committed_at?.toISOString() ?? null,
  };
}

export class PostgresEmployeeImportStore implements EmployeeImportStore {
  constructor(private readonly pool: Pool) {}

  async findExistingEmployeeNumbers(employeeNumbers: string[]): Promise<Set<string>> {
    if (employeeNumbers.length === 0) return new Set();

    const result = await this.pool.query<{ employee_number: string }>(
      "SELECT employee_number FROM employees WHERE employee_number = ANY($1::text[])",
      [employeeNumbers],
    );
    return new Set(result.rows.map((row) => row.employee_number));
  }

  async savePreview(input: SaveEmployeeImportPreviewInput): Promise<EmployeeImportPreview> {
    const client = await this.pool.connect();
    const importId = randomUUID();
    const warningCount = input.rows.filter((row) =>
      row.issues.some((issue) => issue.severity === "warning"),
    ).length;
    const errorCount = input.rows.filter((row) => row.action === "error").length;
    const insertCount = input.rows.filter((row) => row.action === "insert").length;
    const updateCount = input.rows.filter((row) => row.action === "update").length;

    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO employee_import_jobs (
          id, source_filename, source_sheet, checksum_sha256, row_count,
          insert_count, update_count, warning_count, error_count, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'previewed')`,
        [
          importId,
          input.sourceFilename,
          input.sourceSheet,
          input.checksumSha256,
          input.rows.length,
          insertCount,
          updateCount,
          warningCount,
          errorCount,
        ],
      );

      for (const row of input.rows) {
        await client.query(
          `INSERT INTO employee_import_rows (
            import_job_id, row_number, employee_number, action, payload, messages
          ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
          [
            importId,
            row.rowNumber,
            row.candidate?.employeeNumber ?? null,
            row.action,
            JSON.stringify(row.candidate),
            JSON.stringify(row.issues),
          ],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const preview = await this.getPreview(importId);
    if (!preview) throw new Error("Import preview gagal dibaca setelah disimpan.");
    return preview;
  }

  async getPreview(importId: string): Promise<EmployeeImportPreview | null> {
    const job = await this.pool.query<ImportJobRow>(
      "SELECT * FROM employee_import_jobs WHERE id = $1",
      [importId],
    );
    const jobRow = job.rows[0];
    if (!jobRow) return null;

    const rows = await this.pool.query<ImportDetailRow>(
      `SELECT row_number, action, payload, messages
       FROM employee_import_rows
       WHERE import_job_id = $1
       ORDER BY row_number`,
      [importId],
    );

    return {
      ...toSummary(jobRow),
      rows: rows.rows.map((row) => ({
        rowNumber: row.row_number,
        action: row.action,
        issues: row.messages,
      })),
    };
  }

  /** Employee numbers whose employment columns the history owns right now. */
  private async employmentManagedNumbers(rows: ImportDetailRow[]): Promise<Set<string>> {
    const numbers = rows.map((row) => row.payload?.employeeNumber).filter((value): value is string => Boolean(value));
    if (numbers.length === 0) return new Set();
    const managed = await loadEmploymentManagedEmployeeIds(this.pool);
    if (managed.size === 0) return new Set();
    const found = await this.pool.query<{ employeeNumber: string }>(
      `SELECT employee_number AS "employeeNumber" FROM employees
       WHERE employee_number = ANY($1::text[]) AND id = ANY($2::uuid[])`,
      [numbers, [...managed]],
    );
    return new Set(found.rows.map((row) => row.employeeNumber));
  }

  async getPreviewPage(
    importId: string,
    page: PageQuery,
    filter: EmployeeImportRowFilter,
  ): Promise<EmployeeImportPreviewPage | null> {
    const job = await this.pool.query<ImportJobRow>(
      "SELECT * FROM employee_import_jobs WHERE id = $1",
      [importId],
    );
    const jobRow = job.rows[0];
    if (!jobRow) return null;

    // "issues" keeps only rows with at least one warning or error, so HC can work through
    // the problems of a long file page by page (ENG-LIST-001).
    const onlyIssues = filter === "issues";
    const matches = "($2::boolean IS FALSE OR jsonb_array_length(messages) > 0)";
    const [rows, count, issues] = await Promise.all([
      this.pool.query<ImportDetailRow>(
        `SELECT row_number, action, payload, messages
         FROM employee_import_rows
         WHERE import_job_id = $1 AND ${matches}
         ORDER BY row_number
         LIMIT $3 OFFSET $4`,
        [importId, onlyIssues, page.pageSize, pageOffset(page)],
      ),
      this.pool.query<{ total: number; skip: number }>(
        `SELECT count(*) FILTER (WHERE ${matches})::int AS total,
                count(*) FILTER (WHERE action = 'skip')::int AS skip
         FROM employee_import_rows
         WHERE import_job_id = $1`,
        [importId, onlyIssues],
      ),
      // One count per issue code across the whole import, worst severity first.
      this.pool.query<{ code: string; severity: "warning" | "error"; count: number }>(
        `SELECT issue ->> 'code' AS code,
                CASE WHEN bool_or(issue ->> 'severity' = 'error') THEN 'error' ELSE 'warning' END AS severity,
                count(*)::int AS count
         FROM employee_import_rows, jsonb_array_elements(messages) AS issue
         WHERE import_job_id = $1
         GROUP BY issue ->> 'code'
         ORDER BY bool_or(issue ->> 'severity' = 'error') DESC, count(*) DESC, issue ->> 'code'`,
        [importId],
      ),
    ]);
    const total = count.rows[0]?.total ?? 0;

    // EMP-005 §8.1: in AUTHORITATIVE the nine employment columns of an employee
    // that has an employment are left to the history, so the preview says so
    // instead of promising a change the commit will not make.
    const managed = await this.employmentManagedNumbers(rows.rows);

    return {
      ...toSummary(jobRow),
      rows: rows.rows.map((row) => ({
        rowNumber: row.row_number,
        action: row.action,
        issues: managed.has(row.payload?.employeeNumber ?? "")
          ? [...row.messages, {
              severity: "warning" as const,
              code: "EMPLOYMENT_FIELDS_IGNORED",
              field: null,
              message: "Diabaikan — status, unit, jabatan, dan tanggal dikelola lewat riwayat kepegawaian.",
            }]
          : row.messages,
      })),
      pagination: pagination(page, total),
      skipCount: count.rows[0]?.skip ?? 0,
      issueSummary: issues.rows,
    };
  }

  async commit(importId: string): Promise<EmployeeImportCommitResult> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const jobResult = await client.query<ImportJobRow>(
        "SELECT * FROM employee_import_jobs WHERE id = $1 FOR UPDATE",
        [importId],
      );
      const job = jobResult.rows[0];
      if (!job) throw new EmployeeImportConflictError("Import preview tidak ditemukan.");
      if (job.status !== "previewed") {
        throw new EmployeeImportConflictError("Import ini tidak lagi berada pada status previewed.");
      }
      if (job.error_count > 0) {
        throw new EmployeeImportConflictError("Import dengan error tidak dapat di-commit.");
      }

      const rows = await client.query<ImportDetailRow>(
        `SELECT row_number, action, payload, messages
         FROM employee_import_rows
         WHERE import_job_id = $1
         ORDER BY row_number
         FOR UPDATE`,
        [importId],
      );

      let insertCount = 0;
      let updateCount = 0;
      let employmentFieldsIgnoredCount = 0;
      const employmentManaged = await loadEmploymentManagedEmployeeIds(client);

      for (const row of rows.rows) {
        if (!row.payload || (row.action !== "insert" && row.action !== "update")) continue;
        const { action: actualAction, employeeId, employmentFieldsIgnored } =
          await this.upsertEmployee(client, row.payload, importId, employmentManaged);
        if (employmentFieldsIgnored) employmentFieldsIgnoredCount += 1;
        await this.writeSourceSnapshot(client, job, row.row_number, employeeId, row.payload);
        if (actualAction === "insert") insertCount += 1;
        if (actualAction === "update") updateCount += 1;

        await client.query(
          `UPDATE employee_import_rows
           SET action = $3
           WHERE import_job_id = $1 AND row_number = $2`,
          [importId, row.row_number, actualAction],
        );
      }

      if (employmentFieldsIgnoredCount > 0) {
        await audit(client, {
          actorAccountId: null,
          action: "employment.import.fields_ignored",
          entityType: "employee_import_job",
          entityId: importId,
          employeeId: null,
          payload: { employeeCount: employmentFieldsIgnoredCount, fields: [...PROJECTED_IMPORT_FIELDS] },
        });
      }

      const committed = await client.query<ImportJobRow>(
        `UPDATE employee_import_jobs
         SET status = 'committed', insert_count = $2, update_count = $3, committed_at = now()
         WHERE id = $1
         RETURNING *`,
        [importId, insertCount, updateCount],
      );

      await client.query("COMMIT");
      const summary = toSummary(committed.rows[0]!);
      return { ...summary, committedCount: insertCount + updateCount };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertEmployee(
    client: PoolClient,
    candidate: EmployeeImportCandidate,
    importId: string,
    employmentManaged: ReadonlySet<string> = new Set(),
  ): Promise<{ action: "insert" | "update"; employeeId: string; employmentFieldsIgnored: boolean }> {
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM employees WHERE employee_number = $1 FOR UPDATE",
      [candidate.employeeNumber],
    );

    // EMP-005 §8.1: in AUTHORITATIVE the nine employment columns belong to the
    // employment history, so the import updates only the rest of the master —
    // and creates no unit or position row it would then throw away.
    if (existing.rows[0] && employmentManaged.has(existing.rows[0].id)) {
      await client.query(
        `UPDATE employees SET
          full_name = $2,
          email = $3,
          phone = $4,
          education = $5,
          source_last_import_job_id = $6,
          updated_at = now()
        WHERE employee_number = $1`,
        [
          candidate.employeeNumber,
          candidate.fullName,
          candidate.email,
          candidate.phone,
          candidate.education,
          importId,
        ],
      );
      return { action: "update", employeeId: existing.rows[0].id, employmentFieldsIgnored: true };
    }

    const unitId = candidate.unitName
      ? await this.upsertReference(client, "organizational_units", candidate.unitName)
      : null;
    const positionId = candidate.positionName
      ? await this.upsertReference(client, "positions", candidate.positionName)
      : null;

    if (existing.rows[0]) {
      await client.query(
        `UPDATE employees SET
          full_name = $2,
          status = $3,
          employment_status = $4,
          organizational_unit_id = $5,
          position_id = $6,
          employment_type = $7,
          functional_position = $8,
          structural_position = $9,
          email = $10,
          phone = $11,
          education = $12,
          started_on = $13,
          ended_on = $14,
          source_last_import_job_id = $15,
          updated_at = now()
        WHERE employee_number = $1`,
        [
          candidate.employeeNumber,
          candidate.fullName,
          candidate.status,
          candidate.employmentStatus,
          unitId,
          positionId,
          candidate.employmentType,
          candidate.functionalPosition,
          candidate.structuralPosition,
          candidate.email,
          candidate.phone,
          candidate.education,
          candidate.startedOn,
          candidate.endedOn,
          importId,
        ],
      );
      return { action: "update", employeeId: existing.rows[0].id, employmentFieldsIgnored: false };
    }

    const employeeId = randomUUID();
    await client.query(
      `INSERT INTO employees (
        id, employee_number, full_name, status, employment_status,
        organizational_unit_id, position_id, employment_type,
        functional_position, structural_position, email, phone, education,
        started_on, ended_on, source_last_import_job_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        employeeId,
        candidate.employeeNumber,
        candidate.fullName,
        candidate.status,
        candidate.employmentStatus,
        unitId,
        positionId,
        candidate.employmentType,
        candidate.functionalPosition,
        candidate.structuralPosition,
        candidate.email,
        candidate.phone,
        candidate.education,
        candidate.startedOn,
        candidate.endedOn,
        importId,
      ],
    );
    return { action: "insert", employeeId, employmentFieldsIgnored: false };
  }

  /**
   * EMP-005 baseline source (spec §4.2.1, §8.2): keep the raw classification
   * values of this row. Only the allowlisted classification columns are stored.
   */
  private async writeSourceSnapshot(
    client: PoolClient,
    job: ImportJobRow,
    rowNumber: number,
    employeeId: string,
    candidate: EmployeeImportCandidate,
  ): Promise<void> {
    const classification = candidate.sourceClassification;
    if (!classification) return;
    const sourceData = {
      [EMPLOYEE_SOURCE_CLASSIFICATION_HEADERS.statusActive]: classification.statusActive,
      [EMPLOYEE_SOURCE_CLASSIFICATION_HEADERS.employmentStatus]: classification.employmentStatus,
      [EMPLOYEE_SOURCE_CLASSIFICATION_HEADERS.employmentType]: classification.employmentType,
      [EMPLOYEE_SOURCE_CLASSIFICATION_HEADERS.endedOn]: classification.endedOn,
    };
    await client.query(
      `INSERT INTO employee_import_source_snapshots (
        id, employee_id, import_job_id, row_number, source_filename, source_sheet, source_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (import_job_id, row_number) DO NOTHING`,
      [randomUUID(), employeeId, job.id, rowNumber, job.source_filename, job.source_sheet, JSON.stringify(sourceData)],
    );
  }

  private async upsertReference(
    client: PoolClient,
    table: "organizational_units" | "positions",
    name: string,
  ): Promise<string> {
    const normalized = normalizeReferenceName(name);
    const id = randomUUID();
    const result = await client.query<{ id: string }>(
      `INSERT INTO ${table} (id, normalized_name, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (normalized_name)
       DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING id`,
      [id, normalized, name.trim()],
    );
    return result.rows[0]!.id;
  }
}
