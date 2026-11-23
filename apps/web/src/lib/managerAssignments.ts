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
  /**
   * ORG-004: atasan menurut bagan organisasi terbit. Usulan untuk dibaca HC,
   * bukan keputusan — ia tidak pernah diterapkan sendiri.
   */
  chartManager: ManagerAssignmentPersonRef | null;
  chartSource: string | null;
  chartIssue: string | null;
  /** true sama dengan bagan, false berbeda, null tidak dapat dibandingkan. */
  chartAgrees: boolean | null;
}

export interface ManagerAssignmentPreview {
  sourceFilename: string;
  checksumSha256: string;
  previewToken: string;
  rowCount: number;
  unchangedCount: number;
  changeCount: number;
  /** Bagian dari `changeCount` yang akan menghapus atasan (sel `-`). */
  clearCount: number;
  /** Baris yang tujuannya berbeda dari bagan organisasi terbit. */
  differsFromChartCount: number;
  /** Baris yang sel atasannya kosong sementara bagan punya usulan. */
  chartSuggestionCount: number;
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

/**
 * ORG-004: berkas CSV yang berisi usulan bagan, untuk diunduh HC.
 *
 * Sengaja berbentuk berkas, bukan isian otomatis pada tabel pratinjau: berkas
 * yang diterapkan harus selalu berkas yang HC sendiri unggah dan konfirmasi,
 * jadi usulan bagan melewati jalur yang persis sama — unggah, dry-run, baca,
 * konfirmasi. Tidak ada usulan yang pernah diterapkan tanpa dibaca seseorang.
 *
 * Baris yang bagannya tidak menjawab tetap ditulis dengan sel atasan kosong,
 * supaya HC melihatnya sebagai pekerjaan yang tersisa, bukan hilang diam-diam.
 */
export function managerAssignmentChartCsv(rows: readonly ManagerAssignmentPreviewRow[]): string {
  return [
    "NIP,NIP ATASAN",
    ...rows.map((row) => [row.employeeNumber, row.chartManager?.employeeNumber ?? ""].map(csvCell).join(",")),
  ].join("\r\n");
}

/**
 * Satu sel CSV yang aman dibuka di spreadsheet.
 *
 * Dua hal yang dijaga, dan keduanya soal berkas ini memang dibuka orang di
 * Excel atau Sheets:
 *
 * 1. **Bentuk berkasnya.** `employees.employee_number` bertipe `text` tanpa
 *    CHECK, jadi NIP yang memuat koma, kutip, atau newline akan memecah baris
 *    bila ditulis telanjang. Setiap sel karena itu selalu dikutip dan kutip di
 *    dalamnya digandakan, sesuai RFC 4180.
 * 2. **Formula injection.** Sel yang dimulai `=`, `+`, `@`, atau `-` dieksekusi
 *    sebagai formula oleh Excel dan Sheets. Sel seperti itu diberi awalan `'`
 *    supaya dibaca sebagai teks. `-` ikut dijaga meskipun fungsi di atas tidak
 *    pernah memancarkannya sendiri: yang dijaga adalah selnya, bukan asumsi
 *    tentang pemanggilnya.
 *
 * Dengan format NIP yang dipakai hari ini keduanya praktis mustahil. Berkas
 * yang dibuat untuk dibuka di spreadsheet sebaiknya tidak punya lubang itu
 * sejak awal.
 */
function csvCell(value: string): string {
  const guarded = /^[=+@-]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
