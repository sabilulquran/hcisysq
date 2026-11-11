/**
 * PAY-003 payroll reporting (specification section 7).
 *
 * Two reports, deliberately separate:
 *
 *  - the payroll report: totals per unit and per component, read by finance and
 *    the director, with no bank account anywhere in it;
 *  - the transfer list: one row per recipient with the account to pay into, read
 *    by finance alone.
 *
 * Splitting them is the point. One report carrying both would hand account
 * numbers to everyone who may read a total.
 *
 * A third view, the variance against the previous period, is the review screen's
 * own: it compares component totals per employee so a reviewer sees what moved.
 *
 * The fourth is the PPh21 TER report per masa pajak. Its arithmetic lives in
 * pph21.ts, free of the database; this file only reads its rows and writes its CSV.
 */

import type { Pool } from "pg";

import { quoteCsvCell } from "../../lib/csv.js";
import type { Pph21Report, Pph21Row, Pph21SourceRow } from "./pph21.js";
import { parsePph21TerPolicy, type Pph21TerPolicy } from "./policy.js";
import { LATEST_RESULTS_OF_PERIOD } from "./store.js";

/**
 * The profile the figures were calculated from. Results written before migration
 * 0080 do not record it, so those fall back to the profile that was effective on
 * the pay date, which is what the calculation would have read.
 */
const RESULT_PROFILE = `
  LEFT JOIN LATERAL (
    SELECT candidate.*
    FROM payroll_compensation_profiles candidate
    WHERE (latest.compensation_profile_id IS NOT NULL AND candidate.id = latest.compensation_profile_id)
       OR (
         latest.compensation_profile_id IS NULL
         AND candidate.employment_id = latest.employment_id
         AND candidate.effective_from <= period.pay_date
         AND (candidate.effective_to IS NULL OR candidate.effective_to >= period.pay_date)
       )
    ORDER BY candidate.effective_from DESC
    LIMIT 1
  ) profile ON true
`;

/**
 * Rupiah as a YSQ document writes them: thousands separated with a dot. Used by
 * the payslip lines and anywhere else an amount is shown rather than summed.
 */
export function formatRupiah(amount: string | number): string {
  const value = typeof amount === "number" ? amount : Number(amount);
  const sign = value < 0 ? "-" : "";
  const digits = Math.abs(Math.trunc(value)).toString();
  return `${sign}Rp${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

export type PeriodReport = {
  totals: {
    employeeCount: number;
    gross: string;
    deductions: string;
    net: string;
    payable: string;
    employerCost: string;
    blockerCount: number;
  };
  byUnit: Array<{ unitRef: string | null; employeeCount: number; payable: string }>;
  byComponent: Array<{ componentCode: string; category: string; employeeCount: number; amount: string }>;
};

export async function buildPeriodReport(pool: Pool, periodId: string): Promise<PeriodReport> {
  const totals = await pool.query<PeriodReport["totals"]>(
    `SELECT count(*)::int AS "employeeCount",
            coalesce(sum(latest.gross), 0)::text AS gross,
            coalesce(sum(latest.deductions), 0)::text AS deductions,
            coalesce(sum(latest.net), 0)::text AS net,
            coalesce(sum(latest.payable), 0)::text AS payable,
            coalesce(sum(latest.employer_cost), 0)::text AS "employerCost",
            coalesce(sum(jsonb_array_length(latest.blockers)), 0)::int AS "blockerCount"
     FROM (${LATEST_RESULTS_OF_PERIOD}) latest`,
    [periodId],
  );

  // The unit comes from the profile the result was calculated from, not from
  // today's profile, so a report of a past period keeps reading as it was paid.
  const byUnit = await pool.query<PeriodReport["byUnit"][number]>(
    `SELECT profile.unit_ref AS "unitRef",
            count(*)::int AS "employeeCount",
            coalesce(sum(latest.payable), 0)::text AS payable
     FROM (${LATEST_RESULTS_OF_PERIOD}) latest
     JOIN payroll_periods period ON period.id = latest.period_id
     ${RESULT_PROFILE}
     GROUP BY profile.unit_ref
     ORDER BY profile.unit_ref NULLS FIRST`,
    [periodId],
  );

  const byComponent = await pool.query<PeriodReport["byComponent"][number]>(
    `SELECT l.component_code AS "componentCode",
            l.category,
            count(*)::int AS "employeeCount",
            coalesce(sum(l.amount), 0)::text AS amount
     FROM (${LATEST_RESULTS_OF_PERIOD}) latest
     JOIN payroll_result_lines l ON l.result_id = latest.id
     JOIN payroll_components c ON c.code = l.component_code
     GROUP BY l.component_code, l.category, c.display_order
     ORDER BY c.display_order`,
    [periodId],
  );

  return {
    totals: totals.rows[0] ?? {
      employeeCount: 0,
      gross: "0",
      deductions: "0",
      net: "0",
      payable: "0",
      employerCost: "0",
      blockerCount: 0,
    },
    byUnit: byUnit.rows,
    byComponent: byComponent.rows,
  };
}

export type TransferRow = {
  employeeNumber: string;
  fullName: string;
  unitRef: string | null;
  payable: string;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  paymentConfirmedAt: string | null;
};

/**
 * The transfer list. A payable of zero is not a transfer, so it is left out; a
 * negative one is not either, but it must not vanish silently, so it stays on the
 * list for finance to see and settle against the next period.
 */
export async function buildTransferList(pool: Pool, periodId: string): Promise<TransferRow[]> {
  const { rows } = await pool.query<TransferRow>(
    `SELECT emp.employee_number AS "employeeNumber",
            emp.full_name AS "fullName",
            profile.unit_ref AS "unitRef",
            latest.payable::text AS payable,
            profile.bank_name AS "bankName",
            profile.bank_account_number AS "bankAccountNumber",
            profile.bank_account_name AS "bankAccountName",
            to_char(period.payment_confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              AS "paymentConfirmedAt"
     FROM (${LATEST_RESULTS_OF_PERIOD}) latest
     JOIN employments e ON e.id = latest.employment_id
     JOIN employees emp ON emp.id = e.employee_id
     JOIN payroll_periods period ON period.id = latest.period_id
     ${RESULT_PROFILE}
     WHERE latest.payable <> 0
     ORDER BY emp.employee_number`,
    [periodId],
  );
  return rows;
}

const TRANSFER_HEADER = [
  "NIP",
  "Nama",
  "Unit",
  "Nominal dibayar",
  "Bank",
  "Nomor rekening",
  "Nama pemilik rekening",
  "Konfirmasi bayar",
];

/** Excel on Windows reads a UTF-8 file as the system codepage unless it sees this. */
const UTF8_BOM = "﻿";

/**
 * CSV for the finance transfer list (specification section 10 item 7). RFC 4180
 * line endings and a byte order mark, so a name with a diacritic survives the
 * trip into a spreadsheet.
 */
export function transferListToCsv(rows: readonly TransferRow[]): string {
  const lines = [TRANSFER_HEADER.map(quoteCsvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [
        // An account number is an identifier, not a quantity: a spreadsheet that
        // reads it as a number drops its leading zeros, so it is forced to text.
        asText(row.employeeNumber),
        row.fullName,
        row.unitRef ?? "",
        row.payable,
        row.bankName ?? "",
        asText(row.bankAccountNumber ?? ""),
        row.bankAccountName ?? "",
        row.paymentConfirmedAt ?? "",
      ]
        .map((cell) => quoteCsvCell(String(cell)))
        .join(","),
    );
  }
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

function asText(value: string): string {
  return /^0\d+$/.test(value) ? `'${value}` : value;
}

export type VarianceRow = {
  employmentId: string;
  componentCode: string | null;
  previousAmount: string;
  currentAmount: string;
  delta: string;
  kind: "COMPONENT" | "NEW_EMPLOYEE" | "LEAVING_EMPLOYEE" | "LARGE_MANUAL_INPUT";
};

export type VarianceThreshold = { relative: number; absolute: number; manualInput: number };

/**
 * What moved since the previous period, per employee and component. A component
 * has to clear both an absolute and a relative gap to be reported, so a small
 * component does not fill the screen (specification section 10 item 6).
 *
 * Someone who appears or disappears between the two periods is reported once,
 * with the whole amount rather than one component's share, and regardless of the
 * thresholds: a new or departing employee is a fact a reviewer must see.
 *
 * A large manual input is the third trigger the specification names, and it is
 * read from the inputs rather than from the result, since that is where someone
 * typed it.
 */
export async function buildVariance(
  pool: Pool,
  periodId: string,
  previousPeriodId: string,
  threshold: VarianceThreshold,
): Promise<VarianceRow[]> {
  const { rows } = await pool.query<VarianceRow>(
    `WITH current_latest AS (${LATEST_RESULTS_OF_PERIOD}),
          previous_latest AS (
            SELECT DISTINCT ON (r.employment_id) r.*
            FROM payroll_results r
            WHERE r.period_id = $2
              AND r.calculated_at = (SELECT max(x.calculated_at) FROM payroll_results x WHERE x.period_id = $2)
            ORDER BY r.employment_id, r.revision DESC
          ),
          whole_employee AS (
            SELECT coalesce(c.employment_id, p.employment_id) AS employment_id,
                   coalesce(p.payable, 0) AS previous_amount,
                   coalesce(c.payable, 0) AS current_amount,
                   CASE WHEN p.employment_id IS NULL THEN 'NEW_EMPLOYEE' ELSE 'LEAVING_EMPLOYEE' END AS kind
            FROM current_latest c
            FULL OUTER JOIN previous_latest p ON p.employment_id = c.employment_id
            WHERE c.employment_id IS NULL OR p.employment_id IS NULL
          ),
          current_lines AS (
            SELECT c.employment_id, l.component_code, sum(l.amount) AS amount
            FROM current_latest c JOIN payroll_result_lines l ON l.result_id = c.id
            WHERE NOT EXISTS (SELECT 1 FROM whole_employee w WHERE w.employment_id = c.employment_id)
            GROUP BY c.employment_id, l.component_code
          ),
          previous_lines AS (
            SELECT p.employment_id, l.component_code, sum(l.amount) AS amount
            FROM previous_latest p JOIN payroll_result_lines l ON l.result_id = p.id
            WHERE NOT EXISTS (SELECT 1 FROM whole_employee w WHERE w.employment_id = p.employment_id)
            GROUP BY p.employment_id, l.component_code
          ),
          component_delta AS (
            SELECT coalesce(c.employment_id, p.employment_id) AS employment_id,
                   coalesce(c.component_code, p.component_code) AS component_code,
                   coalesce(p.amount, 0) AS previous_amount,
                   coalesce(c.amount, 0) AS current_amount
            FROM current_lines c
            FULL OUTER JOIN previous_lines p
              ON p.employment_id = c.employment_id AND p.component_code = c.component_code
          )
     SELECT employment_id AS "employmentId",
            component_code AS "componentCode",
            previous_amount::text AS "previousAmount",
            current_amount::text AS "currentAmount",
            (current_amount - previous_amount)::text AS delta,
            'COMPONENT' AS kind
     FROM component_delta
     WHERE abs(current_amount - previous_amount) > $3
       -- Multiplied rather than divided, because a previous amount of zero is the
       -- ordinary case for a component that has just appeared.
       AND abs(current_amount - previous_amount)::numeric > $4 * abs(previous_amount)
     UNION ALL
     SELECT employment_id AS "employmentId",
            NULL AS "componentCode",
            previous_amount::text AS "previousAmount",
            current_amount::text AS "currentAmount",
            (current_amount - previous_amount)::text AS delta,
            kind
     FROM whole_employee
     ORDER BY "employmentId", "componentCode" NULLS FIRST`,
    [periodId, previousPeriodId, threshold.absolute, threshold.relative],
  );

  const manualInputs = await pool.query<VarianceRow>(
    `SELECT i.employment_id AS "employmentId",
            i.input_key AS "componentCode",
            '0' AS "previousAmount",
            i.value::text AS "currentAmount",
            i.value::text AS delta,
            'LARGE_MANUAL_INPUT' AS kind
     FROM payroll_period_inputs i
     WHERE i.period_id = $1
       AND i.origin = 'MANUAL'
       AND abs(i.value) > $2
     ORDER BY i.employment_id, i.input_key`,
    [periodId, threshold.manualInput],
  );

  return [...rows, ...manualInputs.rows];
}

/**
 * The period immediately before this one, for the same legal entity. Only a
 * period whose figures are settled is worth comparing against: an earlier period
 * still being worked on would produce a comparison that changes under the
 * reviewer (specification section 6).
 */
export async function previousPeriodId(pool: Pool, periodId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT prev.id
     FROM payroll_periods current_period
     JOIN payroll_periods prev
       ON coalesce(prev.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(current_period.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
      AND prev.period_month < current_period.period_month
     WHERE current_period.id = $1
       AND prev.state = ANY(ARRAY['APPROVED', 'PAYMENT_CONFIRMED', 'PUBLISHED', 'REOPEN_REQUESTED'])
     ORDER BY prev.period_month DESC
     LIMIT 1`,
    [periodId],
  );
  return rows[0]?.id ?? null;
}

/**
 * The rows the PPh21 TER report is built from (specification section 5.3): the
 * latest result of each employment, its earning lines, and the PTKP status and
 * reporting exclusion of the profile the result was calculated from. Reading the
 * profile of the calculation, like the unit above, keeps a past masa pajak
 * reading as it was paid; a correction to either goes through a recalculation.
 *
 * Each row also names the person (so two employments are taxed as one gross),
 * the term category on the pay date, and whether the person keeps an employment
 * with the same employer past the period (so ending one of two is not a final
 * masa pajak).
 */
export async function loadPph21SourceRows(pool: Pool, periodId: string): Promise<Pph21SourceRow[]> {
  const { rows } = await pool.query<Omit<Pph21SourceRow, "payFactor" | "earnings"> & {
    payFactor: string;
    earnings: Array<{ code: string; amount: string | number }>;
  }>(
    `SELECT latest.employment_id AS "employmentId",
            emp.id AS "employeeId",
            emp.employee_number AS "employeeNumber",
            emp.full_name AS "fullName",
            profile.ptkp_status AS "ptkpStatus",
            coalesce(profile.pph21_report_excluded, false) AS excluded,
            profile.pph21_report_exclusion_reason AS "exclusionReason",
            latest.pay_factor::text AS "payFactor",
            jsonb_array_length(latest.blockers)::int AS "blockerCount",
            to_char(e.ended_on, 'YYYY-MM-DD') AS "serviceEndDate",
            EXISTS (
              SELECT 1 FROM employments other
              WHERE other.employee_id = e.employee_id
                AND other.voided_by_action_id IS NULL
                AND coalesce(other.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
                    = coalesce(e.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
                AND (other.ended_on IS NULL OR other.ended_on > period.period_end)
            ) AS "hasContinuingEmployment",
            (
              SELECT t.category FROM employment_terms t
              WHERE t.employment_id = e.id
                AND t.voided_by_action_id IS NULL
                AND (t.effective_from IS NULL OR t.effective_from <= period.pay_date)
                AND (t.effective_to IS NULL OR t.effective_to >= period.pay_date)
              ORDER BY t.sequence DESC LIMIT 1
            ) AS "termCategory",
            coalesce((
              SELECT jsonb_agg(jsonb_build_object('code', l.component_code, 'amount', l.amount::text))
              FROM payroll_result_lines l
              WHERE l.result_id = latest.id AND l.category = 'EARNING'
            ), '[]'::jsonb) AS earnings
     FROM (${LATEST_RESULTS_OF_PERIOD}) latest
     JOIN employments e ON e.id = latest.employment_id
     JOIN employees emp ON emp.id = e.employee_id
     JOIN payroll_periods period ON period.id = latest.period_id
     ${RESULT_PROFILE}
     ORDER BY emp.employee_number, latest.employment_id`,
    [periodId],
  );
  return rows.map((row) => ({
    ...row,
    payFactor: Number(row.payFactor),
    earnings: row.earnings.map((line) => ({ code: line.code, amount: Number(line.amount) })),
  }));
}

export type Pph21PolicyLookup =
  | { ok: true; versionId: string; effectiveFrom: string; policy: Pph21TerPolicy }
  | { ok: false; code: "PPH21_TER_POLICY_MISSING" | "PPH21_TER_POLICY_INVALID"; message: string };

/** The PPH21_TER version in force on the pay date, checked against its schema. */
export async function findPph21Policy(pool: Pool, payDate: string): Promise<Pph21PolicyLookup> {
  const { rows } = await pool.query<{ id: string; effectiveFrom: string; payload: unknown }>(
    `SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom", payload
     FROM payroll_policy_versions
     WHERE policy_key = 'PPH21_TER'
       AND effective_from <= $1::date
       AND (effective_to IS NULL OR effective_to >= $1::date)
     ORDER BY effective_from DESC
     LIMIT 1`,
    [payDate],
  );
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      code: "PPH21_TER_POLICY_MISSING",
      message: `Kebijakan PPH21_TER belum berlaku pada tanggal gajian ${payDate}; muat tabel TER yang sudah diverifikasi lebih dulu.`,
    };
  }
  const parsed = parsePph21TerPolicy(row.payload);
  if (!parsed.ok) {
    return {
      ok: false,
      code: "PPH21_TER_POLICY_INVALID",
      message: `Isi kebijakan PPH21_TER yang berlaku tidak sesuai bentuk yang dibutuhkan: ${parsed.message}.`,
    };
  }
  return { ok: true, versionId: row.id, effectiveFrom: row.effectiveFrom, policy: parsed.policy };
}

const PPH21_HEADER = [
  "NIP",
  "Nama",
  "Status PTKP",
  "Kategori TER",
  "Penghasilan bruto",
  "Tarif",
  "PPh21",
  "Kode objek",
  "Dilaporkan",
  "Catatan",
];

/** A TER rate as a person reads it in an Indonesian spreadsheet: 2,5%. */
export function formatTerRate(rate: number): string {
  const percent = Number((rate * 100).toPrecision(12));
  return `${String(percent).replace(".", ",")}%`;
}

/** What a flag means, in the words the CSV and the screen both use. */
export function pph21RowNote(row: Pph21Row): string {
  const notes: string[] = [];
  if (row.flags.includes("EXCLUDED")) {
    notes.push(`Dikecualikan dari pelaporan: ${row.exclusionReason ?? "tanpa alasan"}`);
  }
  if (row.flags.includes("PTKP_MISSING")) {
    notes.push("Status PTKP kosong atau tidak terpetakan di kebijakan; PPh21 belum dapat dihitung");
  }
  if (row.flags.includes("PTKP_CONFLICT")) {
    notes.push("Status PTKP berbeda antar-employment pegawai ini; PPh21 belum dapat dihitung");
  }
  if (row.flags.includes("ANNUAL_CALCULATION_REQUIRED")) {
    notes.push("Masa pajak terakhir: PPh21 final memakai perhitungan tahunan Pasal 17 (di luar v1); angka TER ini bukan angka final");
  }
  if (row.flags.includes("NON_PERMANENT_TERMS")) {
    notes.push("Pegawai kontrak honorer/lepas: dilaporkan dengan TER bulanan 21-100-01 (DRAFT), menunggu konfirmasi aturan pegawai tidak tetap");
  }
  if (row.employmentIds.length > 1) {
    notes.push(`Bruto gabungan ${row.employmentIds.length} employment`);
  }
  return notes.join("; ");
}

/**
 * CSV for the PPh21 TER report: UTF-8 with a byte order mark and CRLF, like the
 * transfer list, so a name with a diacritic and an NIP with a leading zero both
 * survive the trip into a spreadsheet. No NIK or NPWP: HCIS does not store them
 * for payroll, and the tax office's own form is filled from this sheet.
 */
export function pph21ReportToCsv(report: Pph21Report): string {
  const lines = [PPH21_HEADER.map(quoteCsvCell).join(",")];
  for (const row of report.rows) {
    lines.push(
      [
        asText(row.employeeNumber),
        row.fullName,
        row.ptkpStatus ?? "",
        row.terCategory ?? "",
        String(row.gross),
        row.rate === null ? "" : formatTerRate(row.rate),
        row.tax === null ? "" : String(row.tax),
        report.objectCode,
        row.flags.includes("EXCLUDED") ? "N" : "Y",
        pph21RowNote(row),
      ]
        .map((cell) => quoteCsvCell(cell))
        .join(","),
    );
  }
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}
