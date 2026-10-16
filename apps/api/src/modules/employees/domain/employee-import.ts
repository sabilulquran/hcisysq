export const EMPLOYEE_IMPORT_SHEET = "Master Data SDM YSQ";
export const EMPLOYEE_IMPORT_HEADER_ROW = 2;
export const EMPLOYEE_IMPORT_FIRST_DATA_ROW = 3;
export const EMPLOYEE_IMPORT_CSV_SOURCE = "CSV";

export const EMPLOYEE_SOURCE_HEADERS = {
  employeeNumber: "NIP",
  fullName: "NAMA",
  status: "STATUS AKTIF",
  employmentStatus: "STATUS KEPEGAWAIAN",
  unitName: "UNIT",
  positionName: "JABATAN",
  employmentType: "JENIS KEPEGAWAIAN",
  functionalPosition: "JABATAN FUNGSIONAL",
  structuralPosition: "JABATAN STRUKTURAL",
  email: "EMAIL",
  phone: "NO HP",
  education: "PENDIDIKAN TERAKHIR",
  startedOn: "TMT",
  endedOn: "TAHUN KELUAR (TTTT-BB)",
} as const;

export const REQUIRED_EMPLOYEE_SOURCE_HEADERS = [
  EMPLOYEE_SOURCE_HEADERS.employeeNumber,
  EMPLOYEE_SOURCE_HEADERS.fullName,
  EMPLOYEE_SOURCE_HEADERS.status,
] as const;

export type EmployeeStatus = "active" | "inactive" | "resigned";
export type ImportSeverity = "warning" | "error";
export type ImportAction = "insert" | "update" | "error" | "skip";

export interface ImportIssue {
  severity: ImportSeverity;
  code: string;
  field: string | null;
  message: string;
}

export interface EmployeeImportCandidate {
  employeeNumber: string;
  fullName: string;
  status: EmployeeStatus;
  employmentStatus: string | null;
  unitName: string | null;
  positionName: string | null;
  employmentType: string | null;
  functionalPosition: string | null;
  structuralPosition: string | null;
  email: string | null;
  phone: string | null;
  education: string | null;
  startedOn: string | null;
  endedOn: string | null;
  /**
   * EMP-005 baseline source: raw classification values exactly as written in
   * the workbook (codes only, no personal data). STATUS AKTIF is otherwise
   * collapsed to active/inactive/resigned, which loses "Aktif BUMY" and
   * "Aktif PKWT" (spec §4.2.1). Absent on previews created before this field.
   */
  sourceClassification?: EmployeeSourceClassification;
}

export interface EmployeeSourceClassification {
  statusActive: string | null;
  employmentStatus: string | null;
  employmentType: string | null;
  endedOn: string | null;
}

export const EMPLOYEE_SOURCE_CLASSIFICATION_HEADERS = {
  statusActive: EMPLOYEE_SOURCE_HEADERS.status,
  employmentStatus: EMPLOYEE_SOURCE_HEADERS.employmentStatus,
  employmentType: EMPLOYEE_SOURCE_HEADERS.employmentType,
  endedOn: EMPLOYEE_SOURCE_HEADERS.endedOn,
} as const;

function rawSourceText(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  const normalized = text(value);
  return normalized ? normalized.slice(0, 120) : null;
}

export interface NormalizedEmployeeImportRow {
  rowNumber: number;
  candidate: EmployeeImportCandidate | null;
  issues: ImportIssue[];
}

export interface PlannedEmployeeImportRow extends NormalizedEmployeeImportRow {
  action: ImportAction;
}

export interface EmployeeImportSummary {
  importId: string;
  sourceFilename: string;
  sourceSheet: string;
  checksumSha256: string;
  rowCount: number;
  insertCount: number;
  updateCount: number;
  warningCount: number;
  errorCount: number;
  status: "previewed" | "committed" | "failed";
  createdAt: string;
  committedAt: string | null;
}

export interface EmployeeImportPreview extends EmployeeImportSummary {
  rows: Array<{
    rowNumber: number;
    action: ImportAction;
    issues: ImportIssue[];
  }>;
}

export interface EmployeeImportCommitResult extends EmployeeImportSummary {
  committedCount: number;
}

const spreadsheetErrorValues = new Set([
  "#DIV/0!",
  "#N/A",
  "#NAME?",
  "#NULL!",
  "#NUM!",
  "#REF!",
  "#VALUE!",
]);

const namedMonths: Record<string, number> = {
  januari: 1,
  january: 1,
  februari: 2,
  february: 2,
  maret: 3,
  march: 3,
  april: 4,
  mei: 5,
  may: 5,
  juni: 6,
  june: 6,
  juli: 7,
  july: 7,
  agustus: 8,
  august: 8,
  september: 9,
  oktober: 10,
  october: 10,
  november: 11,
  desember: 12,
  december: 12,
};

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u00a0/g, " ").trim();
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  if (!normalized || normalized === "-") return null;
  return normalized;
}

function normalizeEmail(value: unknown): { value: string | null; warning: ImportIssue | null } {
  const normalized = nullableText(value)?.toLowerCase() ?? null;
  if (!normalized) return { value: null, warning: null };

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
  if (valid) return { value: normalized, warning: null };

  return {
    value: null,
    warning: {
      severity: "warning",
      code: "invalid_email_ignored",
      field: "email",
      message:
        "Email tidak valid dan diabaikan; employee tetap dapat diimpor dan email dapat dikoreksi manual setelah konfirmasi.",
    },
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isEmptyDateSentinel(value: unknown): boolean {
  if (value === 0) return true;
  const raw = text(value).toLowerCase();
  return (
    raw === "0" ||
    raw === "0.0" ||
    raw === "00" ||
    raw === "00:00:00" ||
    raw === "0:00:00" ||
    raw === "n/a" ||
    raw === "na"
  );
}

function normalizedDateValue(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function normalizeDate(
  value: unknown,
  field: "startedOn" | "endedOn",
): { value: string | null; warning: ImportIssue | null } {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === "-" ||
    isEmptyDateSentinel(value)
  ) {
    return { value: null, warning: null };
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    if (field === "endedOn" && year <= 1900) {
      return { value: null, warning: null };
    }
    return {
      value: normalizedDateValue(year, value.getMonth() + 1, value.getDate()),
      warning: null,
    };
  }

  const raw = text(value);
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}:\d{2})?$/.exec(raw);
  if (
    isoDate &&
    isValidDateParts(Number(isoDate[1]), Number(isoDate[2]), Number(isoDate[3]))
  ) {
    const year = Number(isoDate[1]);
    if (field === "endedOn" && year <= 1900) {
      return { value: null, warning: null };
    }
    return {
      value: normalizedDateValue(year, Number(isoDate[2]), Number(isoDate[3])),
      warning: null,
    };
  }

  const namedDate = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/i.exec(raw);
  if (namedDate) {
    const day = Number(namedDate[1]);
    const month = namedMonths[namedDate[2]!.toLowerCase()] ?? 0;
    const year = Number(namedDate[3]);
    if (month > 0 && isValidDateParts(year, month, day)) {
      if (field === "endedOn" && year <= 1900) {
        return { value: null, warning: null };
      }
      return { value: normalizedDateValue(year, month, day), warning: null };
    }
  }

  const monthOnly = /^(\d{4})-(\d{2})$/.exec(raw);
  if (monthOnly && Number(monthOnly[2]) >= 1 && Number(monthOnly[2]) <= 12) {
    return {
      value: `${monthOnly[1]}-${monthOnly[2]}-01`,
      warning: {
        severity: "warning",
        code: "month_only_date_normalized",
        field,
        message: "Tanggal hanya berisi tahun-bulan dan dinormalisasi ke hari pertama bulan tersebut.",
      },
    };
  }

  const dayFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  if (
    dayFirst &&
    isValidDateParts(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]))
  ) {
    const year = Number(dayFirst[3]);
    if (field === "endedOn" && year <= 1900) {
      return { value: null, warning: null };
    }
    return {
      value: normalizedDateValue(year, Number(dayFirst[2]), Number(dayFirst[1])),
      warning: {
        severity: "warning",
        code: "date_format_normalized",
        field,
        message: "Format tanggal dinormalisasi ke YYYY-MM-DD.",
      },
    };
  }

  return {
    value: null,
    warning: {
      severity: "warning",
      code: "invalid_date_ignored",
      field,
      message: "Tanggal tidak dikenali dan diabaikan untuk import ini.",
    },
  };
}

function normalizeStatus(value: unknown): { value: EmployeeStatus; warning: ImportIssue | null } {
  const raw = text(value).toLowerCase().replace(/\s+/g, " ");

  if (raw.includes("resign") || raw.includes("keluar")) {
    return { value: "resigned", warning: null };
  }

  if (raw.includes("tidak aktif") || raw.includes("nonaktif") || raw.includes("non aktif")) {
    return { value: "inactive", warning: null };
  }

  if (raw === "aktif" || raw.startsWith("aktif ")) {
    return { value: "active", warning: null };
  }

  return {
    value: "inactive",
    warning: {
      severity: "warning",
      code: "unknown_status_defaulted_inactive",
      field: "status",
      message: "Status pegawai tidak dikenali dan dinormalisasi menjadi inactive agar akses gagal tertutup.",
    },
  };
}

export function normalizeEmployeeImportRow(
  rowNumber: number,
  source: Record<string, unknown>,
): NormalizedEmployeeImportRow {
  const issues: ImportIssue[] = [];
  const rawEmployeeNumber = text(source[EMPLOYEE_SOURCE_HEADERS.employeeNumber]);
  const employeeNumberHasSpreadsheetError = spreadsheetErrorValues.has(
    rawEmployeeNumber.toUpperCase(),
  );
  const employeeNumber = employeeNumberHasSpreadsheetError ? "" : rawEmployeeNumber;
  const fullName = text(source[EMPLOYEE_SOURCE_HEADERS.fullName]);

  if (!rawEmployeeNumber && !fullName) {
    return { rowNumber, candidate: null, issues };
  }

  if (employeeNumberHasSpreadsheetError) {
    issues.push({
      severity: "error",
      code: "invalid_employee_number_source_error",
      field: "employeeNumber",
      message: "NIP berisi error formula spreadsheet dan harus diperbaiki pada sumber data.",
    });
  } else if (!employeeNumber) {
    issues.push({
      severity: "error",
      code: "missing_employee_number",
      field: "employeeNumber",
      message: "NIP wajib diisi.",
    });
  }

  if (!fullName) {
    issues.push({
      severity: "error",
      code: "missing_full_name",
      field: "fullName",
      message: "Nama pegawai wajib diisi.",
    });
  }

  const status = normalizeStatus(source[EMPLOYEE_SOURCE_HEADERS.status]);
  if (status.warning) issues.push(status.warning);

  const email = normalizeEmail(source[EMPLOYEE_SOURCE_HEADERS.email]);
  if (email.warning) issues.push(email.warning);

  const startedOn = normalizeDate(source[EMPLOYEE_SOURCE_HEADERS.startedOn], "startedOn");
  if (startedOn.warning) issues.push(startedOn.warning);

  const endedOn = normalizeDate(source[EMPLOYEE_SOURCE_HEADERS.endedOn], "endedOn");
  if (endedOn.warning) issues.push(endedOn.warning);

  const unitName = nullableText(source[EMPLOYEE_SOURCE_HEADERS.unitName]);
  if (!unitName) {
    issues.push({
      severity: "warning",
      code: "missing_unit",
      field: "unitName",
      message: "Unit belum terisi; reporting hierarchy perlu dilengkapi sebelum approval digunakan.",
    });
  }

  const positionName = nullableText(source[EMPLOYEE_SOURCE_HEADERS.positionName]);
  if (!positionName) {
    issues.push({
      severity: "warning",
      code: "missing_position",
      field: "positionName",
      message: "Jabatan belum terisi.",
    });
  }

  return {
    rowNumber,
    candidate: {
      employeeNumber,
      fullName,
      status: status.value,
      employmentStatus: nullableText(source[EMPLOYEE_SOURCE_HEADERS.employmentStatus]),
      unitName,
      positionName,
      employmentType: nullableText(source[EMPLOYEE_SOURCE_HEADERS.employmentType]),
      functionalPosition: nullableText(source[EMPLOYEE_SOURCE_HEADERS.functionalPosition]),
      structuralPosition: nullableText(source[EMPLOYEE_SOURCE_HEADERS.structuralPosition]),
      email: email.value,
      phone: nullableText(source[EMPLOYEE_SOURCE_HEADERS.phone]),
      education: nullableText(source[EMPLOYEE_SOURCE_HEADERS.education]),
      startedOn: startedOn.value,
      endedOn: endedOn.value,
      sourceClassification: {
        statusActive: rawSourceText(source[EMPLOYEE_SOURCE_HEADERS.status]),
        employmentStatus: rawSourceText(source[EMPLOYEE_SOURCE_HEADERS.employmentStatus]),
        employmentType: rawSourceText(source[EMPLOYEE_SOURCE_HEADERS.employmentType]),
        endedOn: rawSourceText(source[EMPLOYEE_SOURCE_HEADERS.endedOn]),
      },
    },
    issues,
  };
}

export function flagDuplicateEmployeeNumbers(
  rows: NormalizedEmployeeImportRow[],
): NormalizedEmployeeImportRow[] {
  const firstSeen = new Map<string, NormalizedEmployeeImportRow>();

  for (const row of rows) {
    const employeeNumber = row.candidate?.employeeNumber;
    if (!employeeNumber) continue;

    const previous = firstSeen.get(employeeNumber);
    if (!previous) {
      firstSeen.set(employeeNumber, row);
      continue;
    }

    const duplicateIssue: ImportIssue = {
      severity: "error",
      code: "duplicate_employee_number_in_file",
      field: "employeeNumber",
      message: "NIP muncul lebih dari sekali dalam file import yang sama.",
    };
    row.issues.push(duplicateIssue);
    if (!previous.issues.some((issue) => issue.code === duplicateIssue.code)) {
      previous.issues.push(duplicateIssue);
    }
  }

  return rows;
}

export function normalizeReferenceName(value: string): string {
  return value.replace(/\u00a0/g, " ").trim().replace(/\s+/g, " ").toLowerCase();
}
