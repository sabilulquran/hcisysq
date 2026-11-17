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
 * On a PAY-003 slip drafted with the block "Ditanggung yayasan" (PAY-003 section 7.6) "Total
 * pendapatan" no longer carries the employer-borne BPJS Kesehatan allowance, so the letter states
 * the gross the employee was shown; "Gaji bersih" is the same on both layouts.
 */
export const GROSS_LABELS = ["total bruto gaji", "total bruto", "total penghasilan", "total pendapatan"] as const;
export const NET_LABELS = ["gaji neto", "gaji netto", "gaji bersih"] as const;

/**
 * D-27 DRAFT: the line of the slip's block "Ditanggung yayasan" (`section: "employer"`) that
 * carries the BPJS Kesehatan contribution the yayasan pays on the employee's behalf — the catalog
 * display name of `BPJS_KES` (`payroll-calculation-v1.md` §7.6.3 S4). PPh21 the yayasan bears sits
 * in the same block but is deliberately **not** read here: it is tax paid for the employee, not a
 * contribution that used to be part of the slip's gross, and adding the two into one figure would
 * make the letter irreconcilable with 1721-A1 line 5.
 */
export const EMPLOYER_PREMIUM_LABELS: readonly string[] = ["iuran bpjs kesehatan"];

/**
 * D-27 DRAFT: the other lines the block may carry, which the letter deliberately leaves out — PPh21
 * the yayasan bears, positive or as the refund of over-withheld TER on a final masa pajak
 * (`payroll-calculation-v1.md` §7.6.6 S3). Listed rather than ignored: both label sets come from
 * `payroll_components.display_name`, so a rename would otherwise make the letter state Rp0 for a
 * contribution that was really paid. A block line matching neither list refuses the letter
 * (`DOCUMENT_INCOME_UNREADABLE`) instead.
 */
export const EMPLOYER_OTHER_LABELS: readonly string[] = [
  "pph21 ditanggung yayasan",
  "pengembalian kelebihan pph21 ditanggung yayasan",
];

export interface PayslipLine {
  label: string;
  value: string;
  section?: string;
}

/**
 * D-27 DRAFT: which definition of "total pendapatan" the slip of that month was written with.
 * Read from the slip itself, never from the policy: `EMPLOYER_BLOCK` when the slip states the
 * employer-borne BPJS Kesehatan contribution on a line of its block "Ditanggung yayasan", so its
 * gross leaves that contribution out; `LEGACY` otherwise. A slip whose block holds only PPh21 the
 * yayasan bears — someone with no BPJS contribution, or one whose pair the layout could not
 * recognise (DRAFT S5) — reads as `LEGACY`, which is right in substance: nothing left its gross.
 */
export type IncomeLayout = "EMPLOYER_BLOCK" | "LEGACY";

export interface IncomeMonth {
  /** `YYYY-MM`. */
  period: string;
  /** Whole rupiah as a decimal string, or with two decimals when the slip had sen. */
  gross: string;
  net: string;
  /** D-27: the BPJS Kesehatan contribution the yayasan bears, as the slip's block states it; "0" on a `LEGACY` slip. */
  employerBorne: string;
  layout: IncomeLayout;
  /**
   * D-27: on a `LEGACY` slip, the same contribution as it sits **inside** that month's gross — the
   * slip's own "Tunjangan BPJS Kesehatan" income line, read, never derived. `null` when the slip
   * does not carry that line (a PAY-001/PAY-002 import names it differently and lumps the extra
   * family member in with it, so it is deliberately not matched) or its amount is not readable.
   * Always `null` on an `EMPLOYER_BLOCK` slip, whose gross holds nothing of the kind. The letter
   * uses it to let a bank reconcile the two bases of a mixed window.
   */
  employerBorneInGross: string | null;
}

export interface IncomeFacts {
  months: IncomeMonth[];
  monthCount: number;
  averageGross: string;
  averageNet: string;
  /**
   * D-27: the average of `employerBorne`, over the same months as the other averages. On a mixed
   * window it averages months that state the contribution with months that do not, although the
   * yayasan paid it in both, so the letter **does not print it** there (§7.6.6 S8).
   */
  averageEmployerBorne: string;
  /**
   * D-27: true when the window holds slips of both layouts, so the average gross adds up two
   * presentations of the same pay. The letter then says so and names the months; it never averages
   * two definitions in silence.
   */
  mixedLayout: boolean;
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
 * D-27: which basis the slip's "Total pendapatan" is on. Decided by the **premium line alone**, not
 * by the presence of a block: the block also carries PPh21 the yayasan bears, which never was part
 * of gross. A slip whose BPJS pair the layout could not recognise (DRAFT S5) keeps the allowance in
 * its income list, so its gross is still on the legacy basis even though a PPh21 line gives it a
 * block — reading it as `EMPLOYER_BLOCK` would hide a 5% step between two months of the letter.
 */
export function slipLayout(lines: readonly PayslipLine[]): IncomeLayout {
  return lines.some((line) => line.section === "employer" && EMPLOYER_PREMIUM_LABELS.includes(normalizeLabel(line.label)))
    ? "EMPLOYER_BLOCK"
    : "LEGACY";
}

/**
 * D-27: the employer-borne BPJS Kesehatan contribution of one slip, read from its block
 * "Ditanggung yayasan" alone. 0 when the slip has no such line. `null` when a block line cannot be
 * read — its amount is not a figure, or its label is one this letter does not know — which refuses
 * the letter rather than printing a zero that would read as "the yayasan pays nothing".
 */
export function findEmployerBorne(lines: readonly PayslipLine[]): bigint | null {
  let total = 0n;
  for (const line of lines) {
    if (line.section !== "employer") continue;
    const label = normalizeLabel(line.label);
    if (EMPLOYER_OTHER_LABELS.includes(label)) continue;
    if (!EMPLOYER_PREMIUM_LABELS.includes(label)) return null;
    const amount = parseRupiahToSen(line.value);
    if (amount === null) return null;
    total += amount;
  }
  return total;
}

/**
 * D-27: the allowance line of a `LEGACY` slip that carries the employer-borne contribution inside
 * the gross — `BPJS_KES_ALLOW`'s catalog display name, matched exactly so a PAY-001/PAY-002 import
 * ("Tunjangan BPJS", which also holds the extra family member) is never read as this figure.
 */
export const LEGACY_PREMIUM_IN_GROSS_LABELS: readonly string[] = ["tunjangan bpjs kesehatan"];

/**
 * D-27: the contribution sitting inside a `LEGACY` month's gross, read from that slip's own income
 * lines. **All** of them are summed, not just the first: the engine can write more than one
 * `BPJS_KES_ALLOW` earning on a retro or adjustment month, `employerBorneHealthContribution` sums
 * them, and the slip lists one line per result line — naming only the first would understate the
 * one figure whose whole job is reconciliation. `null` when the slip states none of them, or when
 * any of them is unreadable; the letter then says the month is on the earlier basis without naming
 * an amount, which is better than naming one it did not read in full.
 */
export function findEmployerBorneInGross(lines: readonly PayslipLine[]): bigint | null {
  const matches = lines.filter(
    (candidate) => candidate.section === "income" && LEGACY_PREMIUM_IN_GROSS_LABELS.includes(normalizeLabel(candidate.label)),
  );
  if (!matches.length) return null;
  let total = 0n;
  for (const line of matches) {
    const amount = parseRupiahToSen(line.value);
    if (amount === null) return null;
    total += amount;
  }
  return total;
}

/**
 * Pure assembly of the figures from the slips found in the window. Throws when a slip has no
 * readable gross or net figure: the letter would otherwise state a month without its income.
 *
 * D-27: each month also carries the layout its slip was written with and the employer-borne BPJS
 * Kesehatan contribution the slip states, and the facts say whether the window mixes the two
 * layouts. The average gross is still the average of what the employee was shown — the letter is
 * read beside the payslips the employee attaches — but a mixed window is never silent.
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
  const months: Array<{
    period: string;
    gross: bigint;
    net: bigint;
    employerBorne: bigint;
    layout: IncomeLayout;
    employerBorneInGross: bigint | null;
  }> = [];
  for (const slip of slips) {
    const gross = findFigure(slip.lines, GROSS_LABELS);
    const net = findFigure(slip.lines, NET_LABELS);
    const employerBorne = findEmployerBorne(slip.lines);
    if (gross === null || net === null || employerBorne === null) unreadable.push(slip.period);
    else {
      const layout = slipLayout(slip.lines);
      months.push({
        period: slip.period,
        gross,
        net,
        employerBorne,
        layout,
        employerBorneInGross: layout === "LEGACY" ? findEmployerBorneInGross(slip.lines) : null,
      });
    }
  }
  if (unreadable.length) {
    throw new DocumentError(
      409,
      "DOCUMENT_INCOME_UNREADABLE",
      `Total bruto, gaji neto, atau nilai blok "Ditanggung yayasan" tidak terbaca pada slip gaji periode ${unreadable.join(", ")}. Periksa slip tersebut sebelum menerbitkan surat.`,
    );
  }
  return {
    months: months.map((month) => ({
      period: month.period,
      gross: senToAmount(month.gross),
      net: senToAmount(month.net),
      employerBorne: senToAmount(month.employerBorne),
      layout: month.layout,
      employerBorneInGross: month.employerBorneInGross === null ? null : senToAmount(month.employerBorneInGross),
    })),
    monthCount: months.length,
    averageGross: senToAmount(averageSen(months.map((month) => month.gross))),
    averageNet: senToAmount(averageSen(months.map((month) => month.net))),
    averageEmployerBorne: senToAmount(averageSen(months.map((month) => month.employerBorne))),
    mixedLayout:
      months.some((month) => month.layout === "EMPLOYER_BLOCK") && months.some((month) => month.layout === "LEGACY"),
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
