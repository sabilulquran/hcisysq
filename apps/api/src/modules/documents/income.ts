// DOC-001 Package 2: surat keterangan penghasilan (KETERANGAN_PENGHASILAN).
// Spec: docs/domain/hr-documents.md §3 D-21..D-25, §14.
//
// The letter states figures an employee was already shown on their official published payslips.
// Nothing here calculates pay: each monthly figure is read from a slip line as published, and the
// only arithmetic is the average of those figures. Amounts never leave this module except inside
// the issued letter's snapshot; errors, audit metadata and notifications carry periods and ids only
// (payroll-calculation-v1.md §8).

import type { Pool, PoolClient } from "pg";

import { DocumentError, jakartaDate } from "./service.js";

type QueryTarget = Pool | PoolClient;

export const INCOME_DOCUMENT_CODE = "KETERANGAN_PENGHASILAN";

/**
 * D-26 (DRAFT): who may issue an income letter or read its content for someone else, besides
 * documents.manage — the same set that opens per-person payroll figures (PAY-003 §7.3).
 */
export const INCOME_READER_PERMISSIONS: readonly string[] = [
  "payroll.results.read.organization",
  "payroll.calculate",
  "payroll.inputs.manage",
];

/** D-22 DRAFT: the three full calendar months before the month of issue. */
export const INCOME_WINDOW_MONTHS = 3;

/**
 * D-23 DRAFT: the slip lines that carry the two figures, matched on the label alone (case and
 * spacing ignored), in priority order. Covers the PAYSLIP-002 `tetap` and `honorer` imports and
 * the PAY-003 publication (`publication.ts`). "Gaji Neto 80%", "Gaji Prorata" and "Nominal
 * dibayar" are deliberately not matched: they are the amount paid after a pay factor, not income.
 */
export const GROSS_LABELS = ["total bruto gaji", "total bruto", "total penghasilan", "total pendapatan"] as const;
export const NET_LABELS = ["gaji neto", "gaji netto", "gaji bersih"] as const;

export interface PayslipLine {
  label: string;
  value: string;
  section?: string;
}

export interface IncomeMonth {
  /** `YYYY-MM`. */
  period: string;
  /** Whole rupiah as a decimal string, or with two decimals when the slip had sen. */
  gross: string;
  net: string;
}

export interface IncomeFacts {
  months: IncomeMonth[];
  monthCount: number;
  averageGross: string;
  averageNet: string;
  /** The window searched, `YYYY-MM`, so the letter can say which months had no slip. */
  windowFrom: string;
  windowTo: string;
  source: "PAYSLIP_PUBLISHED";
}

/** `YYYY-MM` months of the window, oldest first, for a Jakarta date `YYYY-MM-DD`. */
export function incomeWindow(issuedOn: string, months = INCOME_WINDOW_MONTHS): string[] {
  const [year, month] = issuedOn.split("-").map(Number);
  const result: string[] = [];
  for (let back = months; back >= 1; back -= 1) {
    const index = (year! * 12 + (month! - 1)) - back;
    result.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`);
  }
  return result;
}

/**
 * Reads a slip amount as sen (1/100 rupiah). Accepts what the slip paths actually write:
 * `Rp1.234.567` (PAY-003), `1234567`, `1.234.567`, `1,234,567`, with optional sen and an optional
 * `Rp`/`IDR` prefix or trailing `,-`. Three digits after a single dot are thousands, because a
 * rupiah amount never has three decimals. Anything else is not a number this letter can state.
 */
export function parseRupiahToSen(raw: string): bigint | null {
  let text = raw.trim().replace(/\s+/g, "");
  text = text.replace(/^(rp\.?|idr)/i, "").replace(/,-$/, "");
  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);
  let whole: string;
  let fraction = "";
  if (/^\d+$/.test(text)) {
    whole = text;
  } else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(text)) {
    [whole, fraction = ""] = text.split(",") as [string, string?];
    whole = whole.replace(/\./g, "");
  } else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(text)) {
    [whole, fraction = ""] = text.split(".") as [string, string?];
    whole = whole.replace(/,/g, "");
  } else if (/^\d+[.,]\d{1,2}$/.test(text)) {
    [whole, fraction = ""] = text.split(/[.,]/) as [string, string?];
  } else {
    return null;
  }
  const sen = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  return negative ? -sen : sen;
}

/** Sen back to the stored string: whole rupiah when there is no sen, else two decimals. */
export function senToAmount(sen: bigint): string {
  const negative = sen < 0n;
  const value = negative ? -sen : sen;
  const whole = value / 100n;
  const rest = value % 100n;
  const text = rest === 0n ? whole.toString() : `${whole}.${rest.toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/** Average to whole rupiah, half up (away from zero). */
export function averageSen(values: readonly bigint[]): bigint {
  if (!values.length) return 0n;
  const total = values.reduce((sum, value) => sum + value, 0n);
  const count = BigInt(values.length);
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  // Round the rupiah, not the sen: (sen / count) in rupiah, half up.
  const rupiah = (magnitude * 2n + count * 100n) / (count * 200n);
  return (negative ? -rupiah : rupiah) * 100n;
}

function normalizeLabel(label: string) {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The first line whose label is one of `labels`, in the priority order of `labels`. */
export function findFigure(lines: readonly PayslipLine[], labels: readonly string[]): bigint | null {
  for (const wanted of labels) {
    const line = lines.find((candidate) => normalizeLabel(candidate.label) === wanted);
    if (line) return parseRupiahToSen(line.value);
  }
  return null;
}

/**
 * Pure assembly of the figures from the slips found in the window. Throws when a slip has no
 * readable gross or net figure: the letter would otherwise state a month without its income.
 */
export function buildIncomeFacts(
  window: readonly string[],
  slips: ReadonlyArray<{ period: string; lines: readonly PayslipLine[] }>,
): IncomeFacts {
  if (!slips.length) {
    throw new DocumentError(
      409,
      "DOCUMENT_INCOME_UNAVAILABLE",
      `Belum ada slip gaji resmi yang terbit untuk ${window[0]} sampai ${window[window.length - 1]}, surat keterangan penghasilan belum dapat diterbitkan.`,
    );
  }
  const unreadable: string[] = [];
  const months: Array<{ period: string; gross: bigint; net: bigint }> = [];
  for (const slip of slips) {
    const gross = findFigure(slip.lines, GROSS_LABELS);
    const net = findFigure(slip.lines, NET_LABELS);
    if (gross === null || net === null) unreadable.push(slip.period);
    else months.push({ period: slip.period, gross, net });
  }
  if (unreadable.length) {
    throw new DocumentError(
      409,
      "DOCUMENT_INCOME_UNREADABLE",
      `Total bruto atau gaji neto tidak terbaca pada slip gaji periode ${unreadable.join(", ")}. Periksa slip tersebut sebelum menerbitkan surat.`,
    );
  }
  return {
    months: months.map((month) => ({ period: month.period, gross: senToAmount(month.gross), net: senToAmount(month.net) })),
    monthCount: months.length,
    averageGross: senToAmount(averageSen(months.map((month) => month.gross))),
    averageNet: senToAmount(averageSen(months.map((month) => month.net))),
    windowFrom: window[0]!,
    windowTo: window[window.length - 1]!,
    source: "PAYSLIP_PUBLISHED",
  };
}

/**
 * D-21 DRAFT: the official slip of each month in the window. Published and not superseded is the
 * one current slip of that month (PAY-003 §10 item 8), whichever path produced it: a PAY-001/002
 * import batch or a PAY-003 period. Returns the figures and the slip ids (for the audit trail).
 */
export async function loadIncomeFacts(db: QueryTarget, employeeId: string, issuedAt: Date) {
  const window = incomeWindow(jakartaDate(issuedAt));
  const result = await db.query<{ id: string; period: string; lines: PayslipLine[] }>(
    `SELECT DISTINCT ON (payslip.period)
            payslip.id, to_char(payslip.period, 'YYYY-MM') AS period, payslip.lines
       FROM payslips payslip
      WHERE payslip.employee_id = $1
        AND payslip.published_at IS NOT NULL
        AND payslip.superseded_by_id IS NULL
        -- PAY-003-THR T13: the monthly salary slip, never the THR slip of the same month, which
        -- would otherwise win DISTINCT ON whenever it was published later.
        AND payslip.kind = 'REGULAR'
        AND payslip.period >= $2::date
        AND payslip.period <= $3::date
      ORDER BY payslip.period ASC, payslip.published_at DESC, payslip.id DESC`,
    [employeeId, `${window[0]}-01`, `${window[window.length - 1]}-01`],
  );
  const facts = buildIncomeFacts(window, result.rows.map((row) => ({
    period: row.period,
    lines: Array.isArray(row.lines) ? row.lines : [],
  })));
  return { facts, payslipIds: result.rows.map((row) => row.id) };
}
