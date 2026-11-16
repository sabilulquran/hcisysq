/**
 * PAY-003 annual PPh21 and 1721-A1: the database side (specification section 7.4).
 * The arithmetic is pph21-annual.ts; this file reads what it needs and nothing else.
 */

import type { Pool } from "pg";

import { quoteCsvCell } from "../../lib/csv.js";
import { buildPph21Report } from "./pph21.js";
import {
  annualMonthsOfPeriod,
  buildAnnualSegments,
  type AnnualMonth,
  type AnnualSegment,
} from "./pph21-annual.js";
import { A1_LINE_KEYS, parsePph21AnnualPolicy, type Pph21AnnualPolicy } from "./policy.js";
import { findPph21Policy, loadPph21SourceRows, UTF8_BOM } from "./reports.js";
import { maskTaxNumber, openTaxIdentity } from "./tax-identity.js";

/** States whose results are final: the monthly report reads the same ones (section 7.2 P3). */
export const FINAL_STATES: readonly string[] = ["APPROVED", "PAYMENT_CONFIRMED", "PUBLISHED", "REOPEN_REQUESTED"];

export type AnnualPolicyLookup =
  | { ok: true; versionId: string; effectiveFrom: string; policy: Pph21AnnualPolicy }
  | { ok: false; code: "PPH21_ANNUAL_POLICY_MISSING" | "PPH21_ANNUAL_POLICY_INVALID"; message: string };

/** The PPH21_ANNUAL version in force on the last day of the tax year (DRAFT). */
export async function findPph21AnnualPolicy(pool: Pool, year: number): Promise<AnnualPolicyLookup> {
  const date = `${year}-12-31`;
  const { rows } = await pool.query<{ id: string; effectiveFrom: string; payload: unknown }>(
    `SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom", payload
     FROM payroll_policy_versions
     WHERE policy_key = 'PPH21_ANNUAL'
       AND effective_from <= $1::date
       AND (effective_to IS NULL OR effective_to >= $1::date)
     ORDER BY effective_from DESC
     LIMIT 1`,
    [date],
  );
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      code: "PPH21_ANNUAL_POLICY_MISSING",
      message: `Kebijakan PPH21_ANNUAL belum berlaku pada ${date}; muat PTKP, biaya jabatan, dan tarif Pasal 17 yang sudah diverifikasi lebih dulu.`,
    };
  }
  const parsed = parsePph21AnnualPolicy(row.payload);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "PPH21_ANNUAL_POLICY_INVALID",
      message: `Isi kebijakan PPH21_ANNUAL yang berlaku tidak sesuai bentuk yang dibutuhkan: ${parsed.message}.`,
    };
  }
  return { ok: true, versionId: row.id, effectiveFrom: row.effectiveFrom, policy: parsed.policy };
}

export type AnnualYear = {
  year: number;
  segments: AnnualSegment[];
  /** Periods of the year whose results are not final yet; their months are not counted. */
  pendingPeriods: Array<{ periodMonth: string; state: string }>;
  /** Final periods whose TER table was missing or invalid: their months carry no TER tax. */
  periodsWithoutTer: string[];
};

/**
 * Every final period of the year, its people as AnnualMonth rows, settled into
 * spans. With employeeId only that person's rows are read; TER is a rate on one
 * person's gross, so their figures are the same either way.
 */
export async function loadAnnualYear(
  pool: Pool,
  year: number,
  policy: Pph21AnnualPolicy,
  employeeId?: string,
): Promise<AnnualYear> {
  const periods = await pool.query<{
    id: string;
    periodMonth: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    state: string;
  }>(
    `SELECT id,
            to_char(period_month, 'YYYY-MM-DD') AS "periodMonth",
            to_char(period_start, 'YYYY-MM-DD') AS "periodStart",
            to_char(period_end, 'YYYY-MM-DD') AS "periodEnd",
            to_char(pay_date, 'YYYY-MM-DD') AS "payDate",
            state
     FROM payroll_periods
     WHERE extract(year FROM period_month)::int = $1
     ORDER BY period_month`,
    [year],
  );

  const months: AnnualMonth[] = [];
  const pendingPeriods: AnnualYear["pendingPeriods"] = [];
  const periodsWithoutTer: string[] = [];
  for (const period of periods.rows) {
    if (!FINAL_STATES.includes(period.state)) {
      pendingPeriods.push({ periodMonth: period.periodMonth.slice(0, 7), state: period.state });
      continue;
    }
    const all = await loadPph21SourceRows(pool, period.id);
    const rows = employeeId === undefined ? all : all.filter((row) => row.employeeId === employeeId);
    if (rows.length === 0) continue;
    const ter = await findPph21Policy(pool, period.payDate);
    let terTaxByEmployee: Map<string, number | null> | null = null;
    if (ter.ok) {
      const report = buildPph21Report({ period, policy: ter.policy, rows });
      terTaxByEmployee = new Map(report.rows.map((row) => [row.employeeId, row.tax]));
    } else {
      periodsWithoutTer.push(period.periodMonth.slice(0, 7));
    }
    months.push(...annualMonthsOfPeriod({ period, rows, terTaxByEmployee, policy }));
  }
  return { year, segments: buildAnnualSegments(policy, months), pendingPeriods, periodsWithoutTer };
}

export type TaxIdentityRow = {
  employeeId: string;
  nikSealed: string | null;
  nikLast4: string | null;
  npwpSealed: string | null;
  npwpLast4: string | null;
  updatedAt: string | null;
};

export async function loadTaxIdentities(pool: Pool, employeeIds: readonly string[]): Promise<Map<string, TaxIdentityRow>> {
  if (employeeIds.length === 0) return new Map();
  const { rows } = await pool.query<TaxIdentityRow>(
    `SELECT employee_id AS "employeeId", nik_sealed AS "nikSealed", nik_last4 AS "nikLast4",
            npwp_sealed AS "npwpSealed", npwp_last4 AS "npwpLast4",
            to_char(updated_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS') AS "updatedAt"
     FROM payroll_tax_identities
     WHERE employee_id = ANY($1::uuid[])`,
    [employeeIds],
  );
  return new Map(rows.map((row) => [row.employeeId, row]));
}

/** The opened numbers, for a document that must print them. Never log the result. */
export function openedTaxIdentity(
  serverKeyHex: string,
  row: TaxIdentityRow | undefined,
): { nik: string | null; npwp: string | null } {
  if (!row) return { nik: null, npwp: null };
  return {
    nik: row.nikSealed === null ? null : openTaxIdentity(serverKeyHex, row.employeeId, "nik", row.nikSealed),
    npwp: row.npwpSealed === null ? null : openTaxIdentity(serverKeyHex, row.employeeId, "npwp", row.npwpSealed),
  };
}

export function maskedTaxIdentity(row: TaxIdentityRow | undefined) {
  return {
    nikMasked: maskTaxNumber(row?.nikLast4 ?? null),
    npwpMasked: maskTaxNumber(row?.npwpLast4 ?? null),
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Position printed on the A1: the structural one when there is one (DRAFT). */
export async function loadEmployeeHeader(
  pool: Pool,
  employeeId: string,
): Promise<{ employeeId: string; employeeNumber: string; fullName: string; position: string | null } | null> {
  const { rows } = await pool.query<{ employeeId: string; employeeNumber: string; fullName: string; position: string | null }>(
    `SELECT id AS "employeeId", employee_number AS "employeeNumber", full_name AS "fullName",
            nullif(trim(coalesce(nullif(trim(structural_position), ''), functional_position)), '') AS position
     FROM employees WHERE id = $1`,
    [employeeId],
  );
  return rows[0] ?? null;
}

/** What a flag means, in the words the CSV and the screen both use. */
export function annualSegmentNote(segment: AnnualSegment): string {
  const notes: string[] = [];
  if (segment.flags.includes("OPEN")) {
    notes.push("Masa pajak terakhir belum tiba; angka berjalan, bukan bukti potong");
  }
  if (segment.flags.includes("PTKP_MISSING")) {
    notes.push("Status PTKP awal masa kosong atau bukan bentuk TK/n atau K/n; PPh21 setahun belum dapat dihitung");
  }
  if (segment.flags.includes("PRIOR_TAX_INCOMPLETE")) {
    notes.push("PPh21 TER salah satu bulan sebelumnya belum dapat dihitung; PPh21 masa terakhir belum dapat ditetapkan");
  }
  if (segment.finalMasaTax !== null && segment.finalMasaTax < 0) {
    notes.push("Lebih potong: dikembalikan kepada pegawai");
  }
  return notes.join("; ");
}

const ANNUAL_HEADER = [
  "NIP",
  "Nama",
  "NIK",
  "NPWP",
  "Status PTKP",
  "Masa awal",
  "Masa akhir",
  "Jumlah bulan",
  "Penghasilan bruto",
  "Biaya jabatan",
  "Iuran pensiun/JHT",
  "Penghasilan neto",
  "PTKP",
  "PKP",
  "PPh21 setahun",
  "PPh21 TER sebelumnya",
  "PPh21 masa terakhir",
  "Bukti potong",
  "Catatan",
];

/** A tax number is an identifier: forced to text so a spreadsheet keeps all 16 digits. */
function asTaxText(value: string | null): string {
  return value === null ? "" : `'${value}`;
}

/**
 * Recap for e-Bupot 1721-A1, UTF-8 with BOM and CRLF like the other payroll
 * exports. It is the one export that carries NIK and NPWP, because the bukti
 * potong is filed with them; every export is recorded without the values.
 */
export function annualRecapToCsv(
  segments: readonly AnnualSegment[],
  identities: ReadonlyMap<string, { nik: string | null; npwp: string | null }>,
): string {
  const lines = [ANNUAL_HEADER.map(quoteCsvCell).join(",")];
  const amount = (value: number | null) => (value === null ? "" : String(value));
  for (const segment of segments) {
    const identity = identities.get(segment.employeeId) ?? { nik: null, npwp: null };
    lines.push(
      [
        /^0\d+$/.test(segment.employeeNumber) ? `'${segment.employeeNumber}` : segment.employeeNumber,
        segment.fullName,
        asTaxText(identity.nik),
        asTaxText(identity.npwp),
        segment.ptkpStatus ?? "",
        segment.startPeriod,
        segment.endPeriod,
        String(segment.monthCount),
        String(segment.gross),
        String(segment.positionCost),
        String(segment.pensionContribution),
        String(segment.net),
        amount(segment.ptkp),
        amount(segment.pkp),
        amount(segment.annualTax),
        amount(segment.terWithheld),
        amount(segment.finalMasaTax),
        segment.closed ? "Y" : "N",
        annualSegmentNote(segment),
      ]
        .map((cell) => quoteCsvCell(cell))
        .join(","),
    );
  }
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

/** Rupiah travel as text, like every other payroll figure in this API. */
export function segmentToJson(segment: AnnualSegment) {
  const text = (value: number | null) => (value === null ? null : String(value));
  return {
    employeeId: segment.employeeId,
    employeeNumber: segment.employeeNumber,
    fullName: segment.fullName,
    index: segment.index,
    startPeriod: segment.startPeriod,
    endPeriod: segment.endPeriod,
    monthCount: segment.monthCount,
    closed: segment.closed,
    ptkpStatus: segment.ptkpStatus,
    lines: Object.fromEntries(A1_LINE_KEYS.map((key) => [key, String(segment.lines[key])])),
    gross: String(segment.gross),
    positionCost: String(segment.positionCost),
    pensionContribution: String(segment.pensionContribution),
    deductions: String(segment.deductions),
    net: String(segment.net),
    ptkp: text(segment.ptkp),
    pkp: text(segment.pkp),
    annualTax: text(segment.annualTax),
    terWithheld: text(segment.terWithheld),
    finalMasaTax: text(segment.finalMasaTax),
    flags: segment.flags,
    note: annualSegmentNote(segment),
  };
}
