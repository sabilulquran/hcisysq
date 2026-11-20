// Pembacaan CSV yang dipakai bersama oleh impor pegawai (EMP-004) dan impor
// atasan langsung (ORG-001). Keduanya membaca berkas yang berasal dari sumber
// yang sama — ekspor Google Sheets milik HC — jadi pemisah, tanda kutip, dan
// pencarian baris header harus berperilaku persis sama di kedua jalur.

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvFormatError";
  }
}

/** Nama kolom dibandingkan tanpa spasi ganda, tanpa NBSP, dan tanpa beda huruf. */
export function headerKey(value: string): string {
  return value.replace(/\u00a0/g, " ").trim().replace(/\s+/g, " ").toUpperCase();
}

/** Ekspor Indonesia kerap memakai titik koma; dibaca dari baris pertama di luar tanda kutip. */
export function detectCsvDelimiter(text: string): "," | ";" {
  let comma = 0;
  let semicolon = 0;
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') {
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === "\n" || char === "\r") break;
    if (char === ",") comma += 1;
    if (char === ";") semicolon += 1;
  }

  return semicolon > comma ? ";" : ",";
}

/** Baris yang seluruh selnya kosong dibuang; baris lain dikembalikan apa adanya. */
export function parseCsvRecords(text: string, delimiter: "," | ";"): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushRow = () => {
    row.push(field);
    field = "";
    if (row.some((value) => value.trim() !== "")) records.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      pushRow();
      continue;
    }
    if (char === "\r") {
      if (text[index + 1] === "\n") index += 1;
      pushRow();
      continue;
    }
    field += char;
  }

  if (inQuotes) {
    throw new CsvFormatError("CSV memiliki quoted field yang tidak ditutup.");
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return records;
}

/**
 * EMP-004: ekspor Google Sheets yang dipakai HC menaruh baris penomoran di atas
 * header, jadi header dicari pada beberapa baris pertama, bukan hanya baris 1.
 */
export function findHeaderRecord(
  records: readonly string[][],
  requiredHeaders: readonly string[],
  scanLimit = 10,
): { headerIndex: number; headers: Map<string, number> } {
  const limit = Math.min(records.length, scanLimit);

  for (let headerIndex = 0; headerIndex < limit; headerIndex += 1) {
    const candidate = records[headerIndex]!;
    const headers = new Map<string, number>();
    candidate.forEach((value, index) => headers.set(headerKey(value), index));

    const complete = requiredHeaders.every((name) => headers.has(headerKey(name)));
    if (complete) return { headerIndex, headers };
  }

  throw new CsvFormatError(
    `Header wajib tidak ditemukan pada ${scanLimit} baris pertama: ${requiredHeaders.join(", ")}`,
  );
}
