// REWARD-001 rules that need no database: month finality, candidate selection (R-03, R-07,
// R-11, R-15), the next rank (R-08), the manual CSV snapshot (R-14) and certificate wording.
// Spec: docs/domain/rewards.md.

import { randomBytes } from "node:crypto";

export const FOUNDATION_SEATS = 3;
export const REWARD_LABELS = ["AUTO", "SELF_REPORTED"] as const;
export type RewardLabel = (typeof REWARD_LABELS)[number];
export type RewardScope = "FOUNDATION" | "UNIT";

export class RewardError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "RewardError";
  }
}

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const MONTH_NAMES = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

export function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function monthParts(month: string): [number, number] {
  const [year, monthNumber] = month.split("-").map(Number) as [number, number];
  return [year, monthNumber];
}

/** QURAN-001 \§7.3/\§9.3: a month is final on the 3rd of the next month at 00:00 WIB. */
export function monthFinalAt(month: string): Date {
  const [year, monthNumber] = monthParts(month);
  return new Date(Date.UTC(year, monthNumber, 3) - JAKARTA_OFFSET_MS);
}

export function isMonthFinal(month: string, now: Date): boolean {
  return now.getTime() >= monthFinalAt(month).getTime();
}

/** \§4.1: the automatic round for the previous month is due on the 3rd at 06:00 WIB. */
export function dueMonth(now: Date): string | null {
  const wib = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const year = wib.getUTCFullYear();
  const monthIndex = wib.getUTCMonth();
  const dueAt = Date.UTC(year, monthIndex, 3, 6) - JAKARTA_OFFSET_MS;
  if (now.getTime() < dueAt) return null;
  const previous = new Date(Date.UTC(year, monthIndex - 1, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const [year, monthNumber] = monthParts(month);
  return `${MONTH_NAMES[monthNumber - 1]} ${year}`;
}

export function categoryLabel(category: RewardScope, seat: number, unitName: string | null): string {
  return category === "FOUNDATION"
    ? `Terbaik Tilawah Yayasan — Peringkat ${seat}`
    : `Terbaik Tilawah ${unitName ?? "Unit"}`;
}

/** \§4.3: at least 128 random bits. 26 Crockford base32 characters carry 130. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function generateVerificationCode(): string {
  // 256 is a multiple of 32, so masking keeps every character uniform.
  return [...randomBytes(26)].map((byte) => CROCKFORD[byte & 31]).join("");
}

export function normalizeVerificationCode(raw: string): string | null {
  const code = raw.trim().toUpperCase().replace(/[-\s]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(code) ? code : null;
}

export interface SnapshotRow {
  scope: RewardScope;
  /** '' for the foundation scope. */
  unitRef: string;
  personRef: string;
  rank: number;
  pages: number;
  activeDays: number;
  khatam: number;
  labels: RewardLabel[];
}

export interface CandidateSeat {
  category: RewardScope;
  unitRef: string;
  seat: number;
  row: SnapshotRow;
}

function byRank(rows: SnapshotRow[]): SnapshotRow[] {
  // Stable: the source's order breaks no tie; equal ranks stay equal (R-11).
  return rows.map((row, index) => ({ row, index }))
    .sort((left, right) => left.row.rank - right.row.rank || left.index - right.index)
    .map(({ row }) => row);
}

/**
 * R-03: top 3 of the foundation and top 1 of each unit. R-11: everyone tied at a seat's
 * boundary is a candidate for it. R-07: a foundation candidate is skipped on unit boards, so the
 * unit seat falls to the next rank. R-15 DRAFT: a person is a candidate once per round, so a person
 * already chosen for one unit board is skipped on the next (boards are read in snapshot order).
 * Rows with pages 0 never become candidates.
 */
export function selectCandidates(rows: SnapshotRow[]): CandidateSeat[] {
  const seats: CandidateSeat[] = [];
  const taken = new Set<string>();
  const foundation = byRank(rows.filter((row) => row.scope === "FOUNDATION" && row.pages > 0));
  for (const row of foundation) {
    const last = seats.at(-1);
    if (seats.length >= FOUNDATION_SEATS && last?.row.rank !== row.rank) break;
    seats.push({ category: "FOUNDATION", unitRef: "", seat: Math.min(row.rank, FOUNDATION_SEATS), row });
    taken.add(row.personRef);
  }
  const unitRefs = [...new Set(rows.filter((row) => row.scope === "UNIT").map((row) => row.unitRef))];
  for (const unitRef of unitRefs) {
    const board = byRank(rows.filter((row) => row.scope === "UNIT" && row.unitRef === unitRef && row.pages > 0
      && !taken.has(row.personRef)));
    const first = board[0];
    if (!first) continue;
    for (const row of board.filter((entry) => entry.rank === first.rank)) {
      seats.push({ category: "UNIT", unitRef, seat: 1, row });
      taken.add(row.personRef);
    }
  }
  return seats;
}

/**
 * R-08: the next rank on the same board of the same snapshot. Everyone tied at that rank comes
 * in together (R-11). People already candidates anywhere in the round are skipped (R-07, R-15).
 */
export function nextRank(boardRows: SnapshotRow[], candidatePersons: ReadonlySet<string>): SnapshotRow[] {
  const remaining = byRank(boardRows.filter((row) => row.pages > 0 && !candidatePersons.has(row.personRef)));
  const first = remaining[0];
  return first ? remaining.filter((row) => row.rank === first.rank) : [];
}

// ---------------------------------------------------------------------------------------------
// R-14 DRAFT: the manual CSV snapshot.

export const MANUAL_CSV_HEADER = ["cakupan", "peringkat", "nip", "halaman", "hari_aktif", "khatam", "label"] as const;
export const MAX_IMPORT_ROWS = 20_000;
export const MAX_IMPORT_BYTES = 2_000_000;

export interface ManualRow {
  line: number;
  /** "YAYASAN", or what identifies a unit: hcis:org-node:<uuid>, the bare uuid, or its name. */
  scopeToken: string;
  rank: number;
  employeeNumber: string;
  pages: number;
  activeDays: number;
  khatam: number;
  labels: RewardLabel[];
}

export interface ImportProblem {
  line: number;
  message: string;
}

/** RFC 4180 subset: commas or semicolons, double-quoted fields, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === "\"") {
        if (source[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"" && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

function parseLabels(raw: string): RewardLabel[] | null {
  const labels = new Set<RewardLabel>();
  for (const part of raw.split(/[|;/]/).map((value) => value.trim().toLowerCase()).filter(Boolean)) {
    if (part === "otomatis" || part === "auto") labels.add("AUTO");
    else if (part === "mandiri" || part === "self_reported") labels.add("SELF_REPORTED");
    else return null;
  }
  return [...labels];
}

function integer(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= min && value <= max ? value : null;
}

export function parseManualSnapshot(text: string): { rows: ManualRow[]; problems: ImportProblem[] } {
  const problems: ImportProblem[] = [];
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((cell) => cell.trim().toLowerCase());
  if (header.length !== MANUAL_CSV_HEADER.length || header.some((cell, index) => cell !== MANUAL_CSV_HEADER[index])) {
    return { rows: [], problems: [{ line: 1, message: `Baris judul harus: ${MANUAL_CSV_HEADER.join(",")}` }] };
  }
  const body = table.slice(1);
  if (!body.length) return { rows: [], problems: [{ line: 2, message: "Berkas tidak berisi baris data." }] };
  if (body.length > MAX_IMPORT_ROWS) {
    return { rows: [], problems: [{ line: MAX_IMPORT_ROWS + 2, message: `Paling banyak ${MAX_IMPORT_ROWS} baris.` }] };
  }
  const rows: ManualRow[] = [];
  const seen = new Set<string>();
  body.forEach((cells, index) => {
    const line = index + 2;
    if (problems.length >= 50) return;
    if (cells.length !== MANUAL_CSV_HEADER.length) {
      problems.push({ line, message: `Harus ada ${MANUAL_CSV_HEADER.length} kolom.` });
      return;
    }
    const [scopeRaw, rankRaw, nipRaw, pagesRaw, daysRaw, khatamRaw, labelRaw] = cells.map((cell) => cell.trim()) as [
      string, string, string, string, string, string, string,
    ];
    const scopeToken = scopeRaw.toUpperCase() === "YAYASAN" ? "YAYASAN" : scopeRaw;
    const rank = integer(rankRaw, 1, 100_000);
    const pagesText = pagesRaw.replace(",", ".");
    const pages = /^\d{1,6}(\.\d)?$/.test(pagesText) ? Number(pagesText) : null;
    const activeDays = integer(daysRaw, 0, 31);
    const khatam = integer(khatamRaw, 0, 1000);
    const labels = parseLabels(labelRaw);
    const issues = [
      !scopeToken || scopeToken.length > 200 ? "cakupan kosong" : null,
      rank === null ? "peringkat harus bilangan bulat 1 atau lebih" : null,
      !/^[A-Za-z0-9./-]{1,40}$/.test(nipRaw) ? "NIP tidak valid" : null,
      pages === null ? "halaman harus angka dengan paling banyak satu desimal" : null,
      activeDays === null ? "hari_aktif harus 0–31" : null,
      khatam === null ? "khatam harus bilangan bulat 0 atau lebih" : null,
      labels === null ? "label hanya boleh kosong, otomatis, mandiri, atau otomatis|mandiri" : null,
    ].filter(Boolean);
    if (issues.length) {
      problems.push({ line, message: issues.join("; ") });
      return;
    }
    const key = `${scopeToken.toLowerCase()}\u0000${nipRaw.toLowerCase()}`;
    if (seen.has(key)) {
      problems.push({ line, message: "NIP yang sama muncul dua kali dalam satu cakupan." });
      return;
    }
    seen.add(key);
    rows.push({
      line, scopeToken, rank: rank!, employeeNumber: nipRaw, pages: pages!, activeDays: activeDays!, khatam: khatam!, labels: labels!,
    });
  });
  if (!problems.length && !rows.some((row) => row.scopeToken === "YAYASAN")) {
    problems.push({ line: 2, message: "Harus ada papan YAYASAN (cakupan YAYASAN)." });
  }
  return { rows: problems.length ? [] : rows, problems };
}
