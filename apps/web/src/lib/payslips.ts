export type PayslipSourceFormat = "generic" | "tetap" | "honorer";
export type PayslipLineSection = "identity" | "income" | "deduction" | "summary" | "other";
export type PayslipRowResolutionStatus = "pending" | "drafted" | "excluded";

export interface PayslipSummary {
  id: string;
  period: string;
  sourceFormat: PayslipSourceFormat;
  publishedAt: string;
}

export interface PayslipLine {
  label: string;
  value: string;
  section?: PayslipLineSection;
}

export interface PayslipDetail extends PayslipSummary {
  lines: PayslipLine[];
  signer: {
    title: "Kepala Human Capital Management" | "Direktur";
    name: string | null;
  };
}

export interface PayslipImportBatch {
  id: string;
  sourceFilename: string;
  sourceFormat: PayslipSourceFormat;
  status: "previewed" | "committed" | "published";
  rowCount: number;
  validCount: number;
  errorCount: number;
  draftedCount: number;
  pendingValidCount: number;
  unresolvedCount: number;
  excludedCount: number;
  createdAt: string;
  committedAt: string | null;
  publishedAt: string | null;
}

export interface PayslipImportRow {
  rowNumber: number;
  employeeNumber: string;
  period: string | null;
  lines: PayslipLine[] | null;
  errors: string[];
  resolutionStatus: PayslipRowResolutionStatus;
  draftPayslipId: string | null;
  excludedAt: string | null;
}

export interface PayslipImportDetail extends PayslipImportBatch {
  rows: PayslipImportRow[];
}

export class PayslipApiError extends Error {}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new PayslipApiError(payload?.message ?? "Permintaan payslip gagal diproses.");
  }
  return (await response.json()) as T;
}

export function getMyPayslips() {
  return request<{ items: PayslipSummary[] }>("/api/payslips");
}

export function getMyPayslip(id: string) {
  return request<PayslipDetail>(`/api/payslips/${encodeURIComponent(id)}`);
}

export function listPayslipImports() {
  return request<{ items: PayslipImportBatch[] }>("/api/admin/payslip-imports");
}

export function getPayslipImport(batchId: string) {
  return request<PayslipImportDetail>(`/api/admin/payslip-imports/${encodeURIComponent(batchId)}`);
}

export function previewPayslipImport(file: File, fallbackPeriod?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "text/csv",
    "X-File-Name": encodeURIComponent(file.name),
  };
  if (fallbackPeriod) headers["X-Payslip-Period"] = fallbackPeriod;
  return request<{
    batchId: string;
    sourceFormat: PayslipSourceFormat;
    status: string;
    rowCount: number;
    validCount: number;
    errorCount: number;
  }>("/api/admin/payslip-imports/preview", {
    method: "POST",
    headers,
    body: file,
  });
}

export function correctPayslipImportRow(
  batchId: string,
  rowNumber: number,
  input: { employeeNumber: string; period: string },
) {
  return request<PayslipImportRow>(
    `/api/admin/payslip-imports/${encodeURIComponent(batchId)}/rows/${rowNumber}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function excludePayslipImportRow(batchId: string, rowNumber: number) {
  return request<PayslipImportRow>(
    `/api/admin/payslip-imports/${encodeURIComponent(batchId)}/rows/${rowNumber}`,
    { method: "DELETE" },
  );
}

export function bulkCorrectPayslipImportRows(
  batchId: string,
  rows: Array<{ rowNumber: number; employeeNumber: string; period: string }>,
) {
  return request<{ updatedCount: number; rows: PayslipImportRow[] }>(
    `/api/admin/payslip-imports/${encodeURIComponent(batchId)}/rows`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    },
  );
}

export function bulkExcludePayslipImportRows(batchId: string, rowNumbers: number[]) {
  return request<{ excludedCount: number }>(
    `/api/admin/payslip-imports/${encodeURIComponent(batchId)}/rows/exclude`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rowNumbers }),
    },
  );
}

export function commitPayslipImport(batchId: string) {
  return request<{
    batchId: string;
    status: string;
    draftedNow: number;
    draftedCount: number;
    pendingValidCount: number;
    unresolvedCount: number;
    excludedCount: number;
  }>(`/api/admin/payslip-imports/${batchId}/commit`, { method: "POST" });
}

export function publishPayslipImport(batchId: string) {
  return request<{ batchId: string; status: string }>(`/api/admin/payslip-imports/${batchId}/publish`, { method: "POST" });
}
