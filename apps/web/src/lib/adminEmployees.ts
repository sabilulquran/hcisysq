export type EmployeeStatus = "active" | "inactive" | "resigned";
export type ImportAction = "insert" | "update" | "error" | "skip";
export type ImportStatus = "previewed" | "committed" | "failed";

export interface ReferenceOption {
  id: string;
  name: string;
}

export interface AdminEmployeeListItem {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: EmployeeStatus;
  employmentStatus: string | null;
  unitId: string | null;
  unitName: string | null;
  positionId: string | null;
  positionName: string | null;
  employmentType: string | null;
  functionalPosition: string | null;
  structuralPosition: string | null;
  email: string | null;
  phone: string | null;
  education: string | null;
  startedOn: string | null;
  endedOn: string | null;
  updatedAt: string;
}

/** EMP-005 S2B §8.7: the list hides marked records unless asked. */
export type EmployeeManagementScopeFilter = "MANAGED" | "OUTSIDE_HCIS" | "ALL";

export interface AdminEmployeeListResponse {
  items: AdminEmployeeListItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
  };
  summary: {
    /** The population HCIS manages; marked records are counted apart. */
    total: number;
    active: number;
    inactive: number;
    resigned: number;
    outsideHcis: number;
  };
  scope: EmployeeManagementScopeFilter;
  filters: {
    units: ReferenceOption[];
    positions: ReferenceOption[];
  };
}

export interface ImportIssue {
  severity: "warning" | "error";
  code: string;
  field: string | null;
  message: string;
}

export interface EmployeeImportPreview {
  importId: string;
  sourceFilename: string;
  sourceSheet: string;
  checksumSha256: string;
  rowCount: number;
  insertCount: number;
  updateCount: number;
  warningCount: number;
  errorCount: number;
  status: ImportStatus;
  createdAt: string;
  committedAt: string | null;
  /** One page of rows; aggregates below cover the whole import (ENG-LIST-001). */
  rows: Array<{
    rowNumber: number;
    action: ImportAction;
    issues: ImportIssue[];
  }>;
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
  skipCount: number;
  issueSummary: Array<{ code: string; severity: "warning" | "error"; count: number }>;
}

export type EmployeeImportRowFilter = "all" | "issues";

export interface EmployeeImportCommitResult
  extends Omit<EmployeeImportPreview, "rows" | "pagination" | "skipCount" | "issueSummary"> {
  committedCount: number;
}

export interface EmployeeImportHistoryItem {
  importId: string;
  sourceFilename: string;
  checksumSha256: string;
  rowCount: number;
  insertCount: number;
  updateCount: number;
  warningCount: number;
  errorCount: number;
  status: ImportStatus;
  createdAt: string;
  committedAt: string | null;
  createdByEmail: string | null;
  committedByEmail: string | null;
}

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  const body = (await response.json().catch(() => null)) as
    | { code?: string; message?: string }
    | null;
  throw new AdminApiError(
    response.status,
    body?.code ?? "REQUEST_FAILED",
    body?.message ?? "Permintaan tidak dapat diproses.",
  );
}

export async function listEmployees(input: {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: EmployeeStatus | "";
  unitId?: string;
  positionId?: string;
  scope?: EmployeeManagementScopeFilter;
} = {}): Promise<AdminEmployeeListResponse> {
  const params = new URLSearchParams();
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? 25));
  if (input.q) params.set("q", input.q);
  if (input.status) params.set("status", input.status);
  if (input.unitId) params.set("unitId", input.unitId);
  if (input.positionId) params.set("positionId", input.positionId);
  if (input.scope) params.set("scope", input.scope);

  const response = await fetch(`/api/admin/employees?${params.toString()}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson<AdminEmployeeListResponse>(response);
}

export async function previewEmployeeImport(file: File): Promise<EmployeeImportPreview> {
  const isCsv = file.name.toLowerCase().endsWith(".csv");
  const response = await fetch("/api/admin/employee-imports/preview", {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": isCsv
        ? "text/csv"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: await file.arrayBuffer(),
  });
  return readJson<EmployeeImportPreview>(response);
}

export async function getEmployeeImport(
  importId: string,
  query: { page?: number; pageSize?: number; filter?: EmployeeImportRowFilter } = {},
): Promise<EmployeeImportPreview> {
  const params = new URLSearchParams();
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  if (query.filter && query.filter !== "all") params.set("filter", query.filter);
  const suffix = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`/api/admin/employee-imports/${importId}${suffix}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson<EmployeeImportPreview>(response);
}

export async function commitEmployeeImport(
  importId: string,
): Promise<EmployeeImportCommitResult> {
  const response = await fetch(`/api/admin/employee-imports/${importId}/commit`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson<EmployeeImportCommitResult>(response);
}

export async function listEmployeeImports(query: { page?: number; pageSize?: number } = {}): Promise<{
  items: EmployeeImportHistoryItem[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
}> {
  const params = new URLSearchParams();
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  const suffix = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`/api/admin/employee-imports${suffix}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  return readJson<{
    items: EmployeeImportHistoryItem[];
    pagination: { page: number; pageSize: number; total: number; pageCount: number };
  }>(response);
}
