// ORG-001: pembacaan berkas penetapan atasan langsung secara massal.
//
// Berkas dikunci pada NIP, tidak pernah pada nama: nama tidak unik dan HC
// bekerja dari spreadsheet. Formatnya mengikuti impor pegawai (EMP-004) —
// CSV UTF-8, pemisah koma atau titik koma, header dicari pada sepuluh baris
// pertama — karena itu bentuk yang sudah dipakai HC dan sudah ada parsernya.

import {
  CsvFormatError,
  detectCsvDelimiter,
  findHeaderRecord,
  headerKey,
  parseCsvRecords,
} from "./csv-records.js";

export const MANAGER_ASSIGNMENT_SOURCE_HEADERS = {
  employeeNumber: "NIP",
  managerNumber: "NIP ATASAN",
} as const;

export const REQUIRED_MANAGER_ASSIGNMENT_HEADERS = [
  MANAGER_ASSIGNMENT_SOURCE_HEADERS.employeeNumber,
  MANAGER_ASSIGNMENT_SOURCE_HEADERS.managerNumber,
] as const;

/** Sel `-` berarti "kosongkan atasan", mengikuti arti `-` pada impor pegawai. */
export const CLEAR_MANAGER_TOKEN = "-";

export type ManagerAssignmentSourceIssueCode =
  | "EMPLOYEE_NUMBER_REQUIRED"
  | "MANAGER_NUMBER_REQUIRED"
  | "DUPLICATE_EMPLOYEE_NUMBER";

export const MANAGER_ASSIGNMENT_SOURCE_MESSAGES: Record<ManagerAssignmentSourceIssueCode, string> = {
  EMPLOYEE_NUMBER_REQUIRED: "Kolom NIP wajib diisi.",
  MANAGER_NUMBER_REQUIRED:
    "Kolom NIP ATASAN wajib diisi. Isi dengan - bila atasan langsung memang ingin dikosongkan.",
  DUPLICATE_EMPLOYEE_NUMBER: "NIP ini muncul lebih dari satu kali pada berkas yang sama.",
};

export interface ManagerAssignmentSourceRow {
  /** Nomor baris pada berkas, dihitung dari 1 seperti yang dilihat HC di spreadsheet. */
  rowNumber: number;
  employeeNumber: string;
  /** null berarti permintaan mengosongkan atasan (sel berisi `-`). */
  managerNumber: string | null;
  issue: { code: ManagerAssignmentSourceIssueCode; message: string } | null;
}

function cell(record: readonly string[], headers: Map<string, number>, name: string): string {
  const column = headers.get(headerKey(name));
  if (column === undefined) return "";
  return (record[column] ?? "").replace(/\u00a0/g, " ").trim();
}

export function parseManagerAssignmentCsv(
  buffer: Buffer,
  options: { maxRows?: number } = {},
): ManagerAssignmentSourceRow[] {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) throw new CsvFormatError("CSV kosong.");

  const delimiter = detectCsvDelimiter(text);
  const records = parseCsvRecords(text, delimiter);
  const { headerIndex, headers } = findHeaderRecord(records, REQUIRED_MANAGER_ASSIGNMENT_HEADERS);

  const maxRows = options.maxRows ?? 2_000;
  const rows: ManagerAssignmentSourceRow[] = [];

  for (let recordIndex = headerIndex + 1; recordIndex < records.length; recordIndex += 1) {
    if (rows.length >= maxRows) {
      throw new CsvFormatError(`Berkas melebihi batas ${maxRows} baris.`);
    }

    const record = records[recordIndex]!;
    const employeeNumber = cell(record, headers, MANAGER_ASSIGNMENT_SOURCE_HEADERS.employeeNumber);
    const managerCell = cell(record, headers, MANAGER_ASSIGNMENT_SOURCE_HEADERS.managerNumber);

    const row: ManagerAssignmentSourceRow = {
      rowNumber: recordIndex + 1,
      employeeNumber,
      managerNumber: managerCell === CLEAR_MANAGER_TOKEN ? null : managerCell,
      issue: null,
    };

    if (!employeeNumber) {
      row.issue = {
        code: "EMPLOYEE_NUMBER_REQUIRED",
        message: MANAGER_ASSIGNMENT_SOURCE_MESSAGES.EMPLOYEE_NUMBER_REQUIRED,
      };
    } else if (!managerCell) {
      // Sel kosong tidak diartikan "kosongkan atasan": berkas HC yang belum
      // selesai diisi tidak boleh diam-diam menghapus atasan seseorang.
      row.issue = {
        code: "MANAGER_NUMBER_REQUIRED",
        message: MANAGER_ASSIGNMENT_SOURCE_MESSAGES.MANAGER_NUMBER_REQUIRED,
      };
    }

    rows.push(row);
  }

  if (rows.length === 0) {
    throw new CsvFormatError("Berkas hanya memuat header, tanpa satu pun baris data.");
  }

  return flagDuplicateEmployeeNumbers(rows);
}

/** NIP ganda dalam satu berkas memblokir seluruh berkas (EMP-004 memakai aturan yang sama). */
export function flagDuplicateEmployeeNumbers(
  rows: readonly ManagerAssignmentSourceRow[],
): ManagerAssignmentSourceRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.employeeNumber) continue;
    counts.set(row.employeeNumber, (counts.get(row.employeeNumber) ?? 0) + 1);
  }

  return rows.map((row) =>
    row.issue === null && row.employeeNumber && (counts.get(row.employeeNumber) ?? 0) > 1
      ? {
          ...row,
          issue: {
            code: "DUPLICATE_EMPLOYEE_NUMBER" as const,
            message: MANAGER_ASSIGNMENT_SOURCE_MESSAGES.DUPLICATE_EMPLOYEE_NUMBER,
          },
        }
      : row,
  );
}
