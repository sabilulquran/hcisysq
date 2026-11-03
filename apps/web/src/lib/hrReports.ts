// RPT-001 client. The API decides scope, columns and who may export; this module only shapes
// requests. Spec: docs/domain/hr-reports.md.

export type HrReportKey = "employees" | "leave" | "overtime" | "trips" | "training";
export type EmployeeStatusFilter = "active" | "inactive" | "resigned" | "all";
export type ReportCell = string | number | null;

export interface ReportColumn {
  key: string;
  label: string;
  kind: "text" | "number" | "date";
}

export interface ReportUnit {
  id: string;
  name: string;
}

export interface HrReportAccess {
  scope: { type: "organization" | "unit"; units: ReportUnit[] };
  canExport: boolean;
  exportScope: { type: "organization" | "unit"; unitIds: string[] } | null;
  reports: Array<{ key: HrReportKey; title: string; period: boolean; columns: ReportColumn[] }>;
  filters: { units: ReportUnit[]; employmentTypes: string[] };
  limits: { maxPeriodDays: number; exportRowLimit: number };
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface HrReportPage {
  report: HrReportKey;
  title: string;
  columns: ReportColumn[];
  items: Array<Record<string, ReportCell> & { rowId: string }>;
  pagination: Pagination;
}

export interface HrReportFilters {
  unitId?: string;
  status?: EmployeeStatusFilter;
  employmentType?: string;
  from?: string;
  to?: string;
  q?: string;
}

export class HrReportApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HrReportApiError";
  }
}

async function failure(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  throw new HrReportApiError(response.status, body?.code ?? "REPORT_FAILED", body?.message ?? "Laporan tidak dapat dimuat.");
}

/** Only the filters the report uses; the export never receives q (D-12). */
export function reportSearchParams(report: HrReportKey, filters: HrReportFilters, extra: Record<string, string> = {}) {
  const params = new URLSearchParams(extra);
  if (filters.unitId) params.set("unitId", filters.unitId);
  if (report === "employees") {
    if (filters.status) params.set("status", filters.status);
    if (filters.employmentType) params.set("employmentType", filters.employmentType);
  } else {
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
  }
  if (filters.q && !("format" in extra)) params.set("q", filters.q);
  return params;
}

export async function getHrReportAccess(): Promise<HrReportAccess> {
  const response = await fetch("/api/admin/reports/hr/access", { credentials: "include", headers: { Accept: "application/json" } });
  if (!response.ok) return failure(response);
  return (await response.json()) as HrReportAccess;
}

export async function getHrReportPage(report: HrReportKey, filters: HrReportFilters, page: number, pageSize: number): Promise<HrReportPage> {
  const params = reportSearchParams(report, filters, { page: String(page), pageSize: String(pageSize) });
  const response = await fetch(`/api/admin/reports/hr/${report}?${params.toString()}`, {
    credentials: "include", headers: { Accept: "application/json" },
  });
  if (!response.ok) return failure(response);
  return (await response.json()) as HrReportPage;
}

/** Downloads the file the server built; the server audits the export before sending it. */
export async function downloadHrReport(report: HrReportKey, filters: HrReportFilters, format: "csv" | "xlsx") {
  const params = reportSearchParams(report, filters, { format });
  const response = await fetch(`/api/admin/reports/hr/${report}/export?${params.toString()}`, { credentials: "include" });
  if (!response.ok) return failure(response);
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `hcis-laporan-${report}.${format}`;
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * UI hint for the API rule (§4): an export is refused when it would be narrower than the screen,
 * so the buttons are offered only when the chosen unit, or the whole read scope, may be exported.
 */
export function exportAllowedFor(access: HrReportAccess, unitId: string | undefined): boolean {
  const exportScope = access.exportScope;
  if (!access.canExport || !exportScope) return false;
  if (exportScope.type === "organization") return true;
  if (unitId) return exportScope.unitIds.includes(unitId);
  const readUnits = access.scope.type === "unit" ? access.scope.units.map((unit) => unit.id) : null;
  return readUnits !== null && readUnits.length === exportScope.unitIds.length
    && readUnits.every((id) => exportScope.unitIds.includes(id));
}

/** The current month in Jakarta, as the default period (D-10). */
export function currentMonthPeriod(now = new Date()): { from: string; to: string } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [year, month] = today.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (value: number) => String(value).padStart(2, "0");
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
}

export function formatReportCell(column: ReportColumn, value: ReportCell | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (column.kind === "date" && typeof value === "string") {
    return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${value}T00:00:00Z`));
  }
  if (column.kind === "number" && typeof value === "number") return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(value);
  return String(value);
}
