// RPT-001 Package 1: report definitions, scope arithmetic and file building, free of HTTP and
// database. Spec: docs/domain/hr-reports.md.

import { quoteCsvCell } from "../../lib/csv.js";

export const HR_REPORTS = ["employees", "leave", "overtime", "trips", "training"] as const;
export type HrReport = (typeof HR_REPORTS)[number];

export type ReportCell = string | number | null;
export interface ReportColumn {
  key: string;
  label: string;
  kind: "text" | "number" | "date";
}

export interface ReportDefinition {
  title: string;
  /** Recap reports need a from/to period (D-10); the employee list does not. */
  period: boolean;
  columns: ReportColumn[];
}

const identity: ReportColumn[] = [
  { key: "employeeNumber", label: "NIP", kind: "text" },
  { key: "fullName", label: "Nama", kind: "text" },
  { key: "unitName", label: "Unit", kind: "text" },
];

// §6. D-04: no national ID, bank account, address, birth date, phone, email, education or money,
// in any report. SENSITIVE_COLUMN_KEYS below is what the tests hold every definition against.
export const REPORT_DEFINITIONS: Readonly<Record<HrReport, ReportDefinition>> = {
  employees: {
    title: "Daftar Pegawai",
    period: false,
    columns: [
      ...identity,
      { key: "positionName", label: "Jabatan", kind: "text" },
      { key: "employmentType", label: "Jenis kepegawaian", kind: "text" },
      { key: "employmentStatus", label: "Status kepegawaian", kind: "text" },
      { key: "statusLabel", label: "Status", kind: "text" },
      { key: "startedOn", label: "Mulai bekerja", kind: "date" },
      { key: "endedOn", label: "Berakhir", kind: "date" },
    ],
  },
  leave: {
    title: "Rekap Cuti",
    period: true,
    columns: [
      ...identity,
      { key: "annualDays", label: "Cuti Tahunan (hari)", kind: "number" },
      { key: "unpaidDays", label: "Cuti Tanpa Gaji (hari)", kind: "number" },
      { key: "otherDays", label: "Cuti lainnya (hari)", kind: "number" },
      { key: "totalDays", label: "Total (hari)", kind: "number" },
      { key: "approvedCount", label: "Pengajuan disetujui", kind: "number" },
      { key: "pendingCount", label: "Pengajuan menunggu", kind: "number" },
    ],
  },
  overtime: {
    title: "Rekap Lembur",
    period: true,
    columns: [
      ...identity,
      { key: "approvedCount", label: "Lembur disetujui (kali)", kind: "number" },
      { key: "approvedHours", label: "Jam lembur disetujui", kind: "number" },
      { key: "pendingCount", label: "Pengajuan menunggu", kind: "number" },
    ],
  },
  trips: {
    title: "Rekap Perjalanan Dinas",
    period: true,
    columns: [
      ...identity,
      { key: "destination", label: "Tujuan", kind: "text" },
      { key: "startOn", label: "Mulai", kind: "date" },
      { key: "endOn", label: "Selesai", kind: "date" },
      { key: "days", label: "Hari", kind: "number" },
      { key: "statusLabel", label: "Status", kind: "text" },
    ],
  },
  training: {
    title: "Rekap Pelatihan",
    period: true,
    columns: [
      ...identity,
      { key: "internalHours", label: "Jam internal", kind: "number" },
      { key: "externalHours", label: "Jam eksternal", kind: "number" },
      { key: "totalHours", label: "Total jam peserta", kind: "number" },
      { key: "speakerHours", label: "Jam pemateri", kind: "number" },
      { key: "recordCount", label: "Catatan pelatihan", kind: "number" },
    ],
  },
};

/** D-04: never a column key in any report, whatever its label. */
export const SENSITIVE_COLUMN_KEYS = [
  "nik", "nationalId", "identityNumber", "bankAccount", "accountNumber", "address", "birthDate", "birthPlace",
  "phone", "email", "education", "salary", "amount", "purpose", "completionReport", "note", "reason",
] as const;

export const EMPLOYEE_STATUS_LABELS: Readonly<Record<string, string>> = {
  active: "Aktif",
  inactive: "Nonaktif",
  resigned: "Berhenti",
};

export const TRIP_STATUS_LABELS: Readonly<Record<string, string>> = {
  APPROVED: "Disetujui",
  ISSUED: "Surat tugas terbit",
  COMPLETED: "Selesai",
};

/** D-08: only travel that was approved counts. */
export const REPORTED_TRIP_STATUSES = ["APPROVED", "ISSUED", "COMPLETED"] as const;

export const MAX_PERIOD_DAYS = 366;
/** D-11. */
export const EXPORT_BATCH_SIZE = 1000;
export const EXPORT_ROW_LIMIT = 50_000;

// ---------------------------------------------------------------------------------------- scope

/** D-02: the whole organization, or the union of the units of every unit-scoped assignment. */
export interface ReportScope {
  organization: boolean;
  unitIds: string[];
}

export const NO_SCOPE: ReportScope = { organization: false, unitIds: [] };

export function scopeFromAssignments(rows: Array<{ scopeType: string; unitId: string | null }>): ReportScope {
  if (rows.some((row) => row.scopeType === "organization")) return { organization: true, unitIds: [] };
  const unitIds = [...new Set(rows.filter((row) => row.scopeType === "unit" && row.unitId).map((row) => row.unitId!))].sort();
  return { organization: false, unitIds };
}

export function isEmptyScope(scope: ReportScope): boolean {
  return !scope.organization && scope.unitIds.length === 0;
}

/** §4: an export is never wider than what may be read. */
export function intersectScopes(left: ReportScope, right: ReportScope): ReportScope {
  if (left.organization) return right;
  if (right.organization) return left;
  const other = new Set(right.unitIds);
  return { organization: false, unitIds: left.unitIds.filter((id) => other.has(id)) };
}

export function scopeAllowsUnit(scope: ReportScope, unitId: string): boolean {
  return scope.organization || scope.unitIds.includes(unitId);
}

// ---------------------------------------------------------------------------------------- period

export type PeriodError = "PERIOD_REQUIRED" | "PERIOD_REVERSED" | "PERIOD_TOO_LONG";

/** D-10: inclusive dates, at most 366 days. Dates are already shape-checked. */
export function periodError(from: string | undefined, to: string | undefined): PeriodError | null {
  if (!from || !to) return "PERIOD_REQUIRED";
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return "PERIOD_REQUIRED";
  if (end < start) return "PERIOD_REVERSED";
  if ((end - start) / 86_400_000 + 1 > MAX_PERIOD_DAYS) return "PERIOD_TOO_LONG";
  return null;
}

export const PERIOD_MESSAGES: Readonly<Record<PeriodError, string>> = {
  PERIOD_REQUIRED: "Pilih tanggal mulai dan tanggal akhir periode.",
  PERIOD_REVERSED: "Tanggal akhir tidak boleh sebelum tanggal mulai.",
  PERIOD_TOO_LONG: `Periode laporan paling panjang ${MAX_PERIOD_DAYS} hari.`,
};

// ---------------------------------------------------------------------------------------- files

const BOM = String.fromCharCode(0xfeff);

function cellText(value: ReportCell): string {
  return value === null || value === undefined ? "" : String(value);
}

/** §5.2: UTF-8 with BOM, every cell quoted and formula-neutralised (SEC-13). */
export function reportCsv(columns: readonly ReportColumn[], rows: ReadonlyArray<Record<string, ReportCell>>): string {
  const lines = [columns.map((column) => quoteCsvCell(column.label)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => quoteCsvCell(cellText(row[column.key] ?? null))).join(","));
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

export function exportFileName(report: HrReport, today: string, format: "csv" | "xlsx"): string {
  return `hcis-laporan-${report}-${today}.${format}`;
}
