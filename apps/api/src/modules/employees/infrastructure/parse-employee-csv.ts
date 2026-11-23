import {
  EMPLOYEE_SOURCE_HEADERS,
  REQUIRED_EMPLOYEE_SOURCE_HEADERS,
  flagDuplicateEmployeeNumbers,
  normalizeEmployeeImportRow,
  type NormalizedEmployeeImportRow,
} from "../domain/employee-import.js";
import {
  CsvFormatError,
  detectCsvDelimiter,
  findHeaderRecord,
  headerKey,
  parseCsvRecords,
} from "./csv-records.js";

/** Tetap kelas tersendiri agar pesan impor pegawai dapat dikenali, tetapi aturan
 * pembacaan CSV-nya kini satu dengan impor atasan langsung (`csv-records.ts`). */
export class EmployeeCsvFormatError extends CsvFormatError {
  constructor(message: string) {
    super(message);
    this.name = "EmployeeCsvFormatError";
  }
}

export function parseEmployeeCsv(
  buffer: Buffer,
  options: { maxRows?: number } = {},
): NormalizedEmployeeImportRow[] {
  const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
  if (!text.trim()) throw new EmployeeCsvFormatError("CSV kosong.");

  const delimiter = detectCsvDelimiter(text);
  const records = parseCsvRecords(text, delimiter);
  const { headerIndex, headers } = findHeaderRecord(records, REQUIRED_EMPLOYEE_SOURCE_HEADERS);

  const maxRows = options.maxRows ?? 2_000;
  const rows: NormalizedEmployeeImportRow[] = [];
  const knownHeaders = Object.values(EMPLOYEE_SOURCE_HEADERS);

  for (let recordIndex = headerIndex + 1; recordIndex < records.length; recordIndex += 1) {
    if (rows.length >= maxRows) {
      throw new EmployeeCsvFormatError(`Import melebihi batas ${maxRows} baris.`);
    }

    const record = records[recordIndex]!;
    const source: Record<string, unknown> = {};
    for (const name of knownHeaders) {
      const column = headers.get(headerKey(name));
      if (column !== undefined) source[name] = record[column] ?? "";
    }

    const normalized = normalizeEmployeeImportRow(recordIndex + 1, source);
    if (normalized.candidate || normalized.issues.length > 0) rows.push(normalized);
  }

  return flagDuplicateEmployeeNumbers(rows);
}
