import type { PageQuery } from "../../../lib/pagination.js";
import type {
  EmployeeImportCommitResult,
  EmployeeImportPreview,
  EmployeeImportPreviewPage,
  PlannedEmployeeImportRow,
} from "../domain/employee-import.js";

export type EmployeeImportRowFilter = "all" | "issues";

export interface SaveEmployeeImportPreviewInput {
  sourceFilename: string;
  sourceSheet: string;
  checksumSha256: string;
  rows: PlannedEmployeeImportRow[];
}

export interface EmployeeImportStore {
  findExistingEmployeeNumbers(employeeNumbers: string[]): Promise<Set<string>>;
  savePreview(input: SaveEmployeeImportPreviewInput): Promise<EmployeeImportPreview>;
  getPreview(importId: string): Promise<EmployeeImportPreview | null>;
  getPreviewPage(
    importId: string,
    page: PageQuery,
    filter: EmployeeImportRowFilter,
  ): Promise<EmployeeImportPreviewPage | null>;
  commit(importId: string): Promise<EmployeeImportCommitResult>;
}
