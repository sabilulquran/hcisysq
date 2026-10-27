import { createHash } from "node:crypto";

import {
  EMPLOYEE_IMPORT_CSV_SOURCE,
  EMPLOYEE_IMPORT_SHEET,
  type EmployeeImportCommitResult,
  type EmployeeImportPreview,
  type EmployeeImportPreviewPage,
  type PlannedEmployeeImportRow,
} from "../domain/employee-import.js";
import { parseEmployeeCsv } from "../infrastructure/parse-employee-csv.js";
import { parseEmployeeWorkbook } from "../infrastructure/parse-employee-workbook.js";
import type { PageQuery } from "../../../lib/pagination.js";
import type { EmployeeImportRowFilter, EmployeeImportStore } from "./employee-import-store.js";

export class EmployeeImportService {
  constructor(private readonly store: EmployeeImportStore) {}

  async preview(input: { filename: string; buffer: Buffer }): Promise<EmployeeImportPreview> {
    const lowerFilename = input.filename.toLowerCase();
    const isCsv = lowerFilename.endsWith(".csv");
    const isXlsx = lowerFilename.endsWith(".xlsx");
    if (!isCsv && !isXlsx) {
      throw new Error("Employee import hanya menerima file .csv atau .xlsx.");
    }

    const parsedRows = isCsv
      ? parseEmployeeCsv(input.buffer)
      : await parseEmployeeWorkbook(input.buffer);
    const employeeNumbers = parsedRows
      .map((row) => row.candidate?.employeeNumber ?? null)
      .filter((value): value is string => Boolean(value));
    const existing = await this.store.findExistingEmployeeNumbers(employeeNumbers);

    const plannedRows: PlannedEmployeeImportRow[] = parsedRows.map((row) => {
      const hasError = row.issues.some((issue) => issue.severity === "error");
      if (hasError || !row.candidate) return { ...row, action: "error" };

      return {
        ...row,
        action: existing.has(row.candidate.employeeNumber) ? "update" : "insert",
      };
    });

    return this.store.savePreview({
      sourceFilename: input.filename,
      sourceSheet: isCsv ? EMPLOYEE_IMPORT_CSV_SOURCE : EMPLOYEE_IMPORT_SHEET,
      checksumSha256: createHash("sha256").update(input.buffer).digest("hex"),
      rows: plannedRows,
    });
  }

  getPreview(importId: string): Promise<EmployeeImportPreview | null> {
    return this.store.getPreview(importId);
  }

  getPreviewPage(
    importId: string,
    page: PageQuery,
    filter: EmployeeImportRowFilter = "all",
  ): Promise<EmployeeImportPreviewPage | null> {
    return this.store.getPreviewPage(importId, page, filter);
  }

  commit(importId: string): Promise<EmployeeImportCommitResult> {
    return this.store.commit(importId);
  }
}
