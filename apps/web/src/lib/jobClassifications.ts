// ORG-011: the job classification and grade catalogs.
// Spec: docs/domain/job-classification-grade.md.
//
// The catalog holds no monetary value and grants no authority. It exists so payroll allowance
// tables and placements can name a class of work by a code that survives a structure revision.

import { AdminApiError } from "@/lib/adminEmployees";

export const jobFamilies = ["FUNCTIONAL", "STRUCTURAL", "SUPPORT"] as const;
export type JobFamily = (typeof jobFamilies)[number];

export const jobFamilyLabels: Record<JobFamily, string> = {
  FUNCTIONAL: "Fungsional",
  STRUCTURAL: "Struktural",
  SUPPORT: "Penunjang",
};

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

export interface CatalogPagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface JobGradeList {
  grades: JobGrade[];
  onDate: string;
  includeHistory: boolean;
  pagination: CatalogPagination;
}

export interface JobClassificationList {
  classifications: JobClassification[];
  onDate: string;
  includeHistory: boolean;
  pagination: CatalogPagination;
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  // A proxy error or a gateway timeout answers with HTML, not JSON. Parsing it blindly would
  // throw a SyntaxError and lose the status the operator actually needs to see.
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    if (!response.ok) {
      throw new AdminApiError(response.status, "UNEXPECTED_RESPONSE", "Permintaan gagal diproses.");
    }
    throw new AdminApiError(response.status, "UNEXPECTED_RESPONSE", "Jawaban server tidak dikenali.");
  }
  if (!response.ok) {
    const problem = (body ?? {}) as { code?: string; message?: string };
    throw new AdminApiError(
      response.status,
      problem.code ?? "UNKNOWN",
      problem.message ?? "Permintaan gagal diproses.",
    );
  }
  return body as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  return readJson<T>(response);
}

export interface CatalogQuery {
  page?: number;
  pageSize?: number;
  onDate?: string;
  /** All versions of every code, including superseded and retired ones. */
  includeHistory?: boolean;
  family?: JobFamily;
}

function searchParams(query: CatalogQuery): string {
  const params = new URLSearchParams();
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  if (query.onDate) params.set("onDate", query.onDate);
  // The API reads the two words, not a coerced boolean, so send them literally.
  if (query.includeHistory !== undefined) params.set("includeHistory", query.includeHistory ? "true" : "false");
  if (query.family) params.set("family", query.family);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function listJobGrades(query: CatalogQuery = {}): Promise<JobGradeList> {
  return request<JobGradeList>(`/admin/job-grades${searchParams(query)}`);
}

export function listJobClassifications(query: CatalogQuery = {}): Promise<JobClassificationList> {
  return request<JobClassificationList>(`/admin/job-classifications${searchParams(query)}`);
}

export function createJobGrade(input: {
  code: string; name: string; rankOrder: number; effectiveFrom: string;
}): Promise<{ grade: JobGrade }> {
  return request("/admin/job-grades", { method: "POST", body: JSON.stringify(input) });
}

export function createJobClassification(input: {
  code: string; name: string; family: JobFamily; gradeCode: string | null; effectiveFrom: string;
}): Promise<{ classification: JobClassification }> {
  return request("/admin/job-classifications", { method: "POST", body: JSON.stringify(input) });
}

/**
 * An amendment opens a new version from a date and closes the running one the day before.
 * The code itself never changes: versioned payroll policy stores it verbatim and past periods
 * read it back, so a rename would detach old policy rows from their meaning.
 */
export function amendJobGrade(code: string, input: {
  effectiveFrom: string; name?: string; rankOrder?: number;
}): Promise<{ grade: JobGrade }> {
  return request(`/admin/job-grades/${encodeURIComponent(code)}/amendments`, {
    method: "POST", body: JSON.stringify(input),
  });
}

export function amendJobClassification(code: string, input: {
  effectiveFrom: string; name?: string; family?: JobFamily; gradeCode?: string | null;
}): Promise<{ classification: JobClassification }> {
  return request(`/admin/job-classifications/${encodeURIComponent(code)}/amendments`, {
    method: "POST", body: JSON.stringify(input),
  });
}

/** Closing a code keeps its history: a paid period still resolves the version it ran under. */
export function deactivateJobGrade(code: string, input: {
  endOn: string; reason: string;
}): Promise<{ grade: JobGrade }> {
  return request(`/admin/job-grades/${encodeURIComponent(code)}/deactivation`, {
    method: "POST", body: JSON.stringify(input),
  });
}

export function deactivateJobClassification(code: string, input: {
  endOn: string; reason: string;
}): Promise<{ classification: JobClassification }> {
  return request(`/admin/job-classifications/${encodeURIComponent(code)}/deactivation`, {
    method: "POST", body: JSON.stringify(input),
  });
}

// ---------------------------------------------------------------------------------------------
// Package 4: export, audited import, change history, per-employee view.
// ---------------------------------------------------------------------------------------------

export type CatalogKind = "CLASSIFICATION" | "GRADE";

/** A plain link: the browser downloads the CSV with the session cookie, no script involved. */
export function catalogExportUrl(kind: CatalogKind, query: { onDate?: string; includeHistory?: boolean }): string {
  const base = kind === "CLASSIFICATION" ? "/api/admin/job-classifications/export" : "/api/admin/job-grades/export";
  const params = new URLSearchParams();
  if (query.includeHistory) params.set("includeHistory", "true");
  else if (query.onDate) params.set("onDate", query.onDate);
  const text = params.toString();
  return text ? `${base}?${text}` : base;
}

export type ImportOutcome = "CREATE" | "AMEND" | "UNCHANGED" | "ERROR";

export interface CatalogImportReport {
  importId: string;
  kind: CatalogKind;
  dryRun: boolean;
  applied: boolean;
  summary: { rows: number; create: number; amend: number; unchanged: number; error: number };
  rows: Array<{ line: number; code: string | null; outcome: ImportOutcome; errorCode?: string; message?: string }>;
}

/**
 * Send one CSV file. A rejected real import answers 422 with the same report as a dry run, so
 * the report is returned in both cases and only a request-level problem throws.
 */
export async function importJobCatalog(input: {
  kind: CatalogKind; csv: string; dryRun: boolean; fileName: string | null;
}): Promise<CatalogImportReport> {
  const response = await fetch("/api/admin/job-classification-imports", {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 422) {
    const body = (await response.json()) as { report: CatalogImportReport };
    return body.report;
  }
  const body = await readJson<{ report: CatalogImportReport }>(response);
  return body.report;
}

export const importOutcomeLabels: Record<ImportOutcome, string> = {
  CREATE: "Kode baru",
  AMEND: "Versi baru",
  UNCHANGED: "Tidak berubah",
  ERROR: "Ditolak",
};

export interface CatalogAuditEvent {
  id: string;
  action: string;
  entityType: "JOB_GRADE" | "JOB_CLASSIFICATION";
  entityCode: string | null;
  payload: Record<string, unknown>;
  actorName: string | null;
  occurredAt: string;
}

export function listJobCatalogAuditEvents(query: {
  page?: number; pageSize?: number; entityCode?: string;
} = {}): Promise<{ events: CatalogAuditEvent[]; pagination: CatalogPagination }> {
  const params = new URLSearchParams();
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  if (query.entityCode) params.set("entityCode", query.entityCode);
  const text = params.toString();
  return request(`/admin/job-classification-audit-events${text ? `?${text}` : ""}`);
}

export const catalogAuditActionLabels: Record<string, string> = {
  "job_classification.created": "Klasifikasi dibuat",
  "job_classification.amended": "Klasifikasi diubah",
  "job_classification.deactivated": "Klasifikasi ditutup",
  "job_classification.imported": "Impor klasifikasi",
  "job_grade.created": "Golongan dibuat",
  "job_grade.amended": "Golongan diubah",
  "job_grade.deactivated": "Golongan ditutup",
  "job_grade.imported": "Impor golongan",
};

export interface ResolvedClassification {
  code: string;
  name: string;
  gradeCode: string | null;
  source: "PLACEMENT" | "POSITION";
}

export interface EmployeeClassificationEmployment {
  employmentId: string;
  slots: { functional: ResolvedClassification | null; structural: ResolvedClassification | null } | null;
  error: { code: string; message: string } | null;
  bindings: Array<{
    code: string; source: "PLACEMENT" | "POSITION";
    name: string | null; family: JobFamily | null; gradeCode: string | null;
  }>;
}

export function getEmployeeJobClassifications(employeeId: string, onDate?: string): Promise<{
  employeeId: string; onDate: string; employments: EmployeeClassificationEmployment[];
}> {
  const suffix = onDate ? `?onDate=${encodeURIComponent(onDate)}` : "";
  return request(`/admin/employees/${encodeURIComponent(employeeId)}/job-classifications${suffix}`);
}
