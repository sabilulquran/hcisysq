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
  const body = text ? (JSON.parse(text) as unknown) : null;
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
