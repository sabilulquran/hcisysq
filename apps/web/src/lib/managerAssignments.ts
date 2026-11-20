// ORG-001: penetapan atasan langsung massal. Dry-run dulu, baru konfirmasi;
// token preview dikirim kembali apa adanya supaya server dapat menolak bila
// data sudah bergeser sejak dry-run.

import { AdminApiError } from "./adminEmployees";

export type ManagerAssignmentRowOutcome = "unchanged" | "change" | "refused";

export interface ManagerAssignmentPersonRef {
  employeeNumber: string;
  fullName: string;
}

export interface ManagerAssignmentPreviewRow {
  rowNumber: number;
  employeeNumber: string;
  employeeName: string | null;
  managerNumber: string | null;
  outcome: ManagerAssignmentRowOutcome;
  fromManager: ManagerAssignmentPersonRef | null;
  toManager: ManagerAssignmentPersonRef | null;
  code: string | null;
  message: string | null;
}

export interface ManagerAssignmentPreview {
  sourceFilename: string;
  checksumSha256: string;
  previewToken: string;
  rowCount: number;
  unchangedCount: number;
  changeCount: number;
  refusedCount: number;
  applicable: boolean;
  rows: ManagerAssignmentPreviewRow[];
}

export interface ManagerAssignmentApplyResult {
  batchId: string;
  previewToken: string;
  rowCount: number;
  appliedCount: number;
  unchangedCount: number;
}

export const MANAGER_ASSIGNMENT_CSV_TEMPLATE = [
  "NIP,NIP ATASAN",
  "YSQ-DEMO-002,YSQ-DEMO-001",
  "YSQ-DEMO-003,-",
].join("\r\n");

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

export async function previewManagerAssignments(file: File): Promise<ManagerAssignmentPreview> {
  const response = await fetch("/api/admin/employees/manager-assignments/preview", {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "text/csv",
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: await file.arrayBuffer(),
  });
  return readJson<ManagerAssignmentPreview>(response);
}

export async function applyManagerAssignments(
  file: File,
  previewToken: string,
): Promise<ManagerAssignmentApplyResult> {
  const response = await fetch("/api/admin/employees/manager-assignments/apply", {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "text/csv",
      "X-File-Name": encodeURIComponent(file.name),
      "X-Preview-Token": previewToken,
    },
    body: await file.arrayBuffer(),
  });
  return readJson<ManagerAssignmentApplyResult>(response);
}

/** Label satu baris preview untuk tabel HC. */
export function managerAssignmentOutcomeLabel(outcome: ManagerAssignmentRowOutcome): string {
  if (outcome === "unchanged") return "Tidak berubah";
  if (outcome === "change") return "Akan berubah";
  return "Ditolak";
}

export function managerAssignmentPersonLabel(person: ManagerAssignmentPersonRef | null): string {
  return person ? `${person.fullName} (${person.employeeNumber})` : "Tanpa atasan";
}
