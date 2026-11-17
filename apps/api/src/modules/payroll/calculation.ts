/**
 * PAY-003 calculation run: gathers one period's snapshot, calls the engine, and
 * stores the result as a fact.
 *
 * Nothing here decides an amount. The rules live in engine.ts and the values in
 * the policy versions; this module only resolves who is in the period, which
 * profile and policy version apply on the pay date, and what the inputs are.
 */

import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  calculateEmployeePayroll,
  EMPTY_PERIOD_INPUTS,
  summarizePeriod,
  type CompensationProfile,
  type EmployeePayrollResult,
  type EmploymentCategory,
  type PayrollBlocker,
  type PeriodInputs,
} from "./engine.js";
import {
  previousMonthStart,
  resolvePerformanceLink,
  type LinkedReview,
  type PerformanceLinkTrace,
} from "./performance-link.js";
import { syncEmployeeLoanDeductions } from "./employee-loan-link.js";
import {
  DEFAULT_PPH21_SETTINGS,
  parsePph21Settings,
  parsePph21TerPolicy,
  parseThrPolicy,
  resolvePolicy,
  type PolicyProblem,
  type ThrPolicyPayload,
} from "./policy.js";
import { needsAnnualCalculation, type Pph21SourceRow } from "./pph21.js";
import { findPph21AnnualPolicy, loadAnnualMonths } from "./pph21-annual-store.js";
import { employerPph21Lines } from "./pph21-employer.js";
import { loadPph21SourceRows } from "./reports.js";
import { bindReimbursementHandoffs } from "./reimbursement-link.js";
import { writeAudit } from "./store.js";
import {
  calculateEmployeeThr,
  thrAverageWageMonths,
  thrEligibility,
  type ThrAverageWage,
  type ThrAverageWageSource,
} from "./thr.js";
import { loadThrPaidWages, type ThrWageSourcePeriod } from "./thr-wage-source.js";
import type { ComponentCode } from "./engine.js";

/** The engine cannot be called without a profile, a category and a start date. */
const PROFILE_MISSING: PayrollBlocker = {
  code: "PROFILE_MISSING",
  message:
    "Profil kompensasi atau TMT belum tersedia untuk pegawai ini pada tanggal gajian.",
};

/** The employment has ended, but on a date nobody has resolved yet (EMP-005). */
const SERVICE_END_UNRESOLVED: PayrollBlocker = {
  code: "SERVICE_END_UNRESOLVED",
  message:
    "Kepegawaian sudah berakhir tetapi tanggal akhirnya belum diresolusi; selesaikan di EMP-005 sebelum periode dihitung.",
};

/**
 * EMP-005 categories mapped onto the pay bases the engine knows. MAGANG and
 * BELUM_DIKLASIFIKASIKAN are outside the v1 scope (specification section 1.1),
 * so they are left out of the population rather than blocking the period: there
 * would be no way to clear such a blocker from inside payroll.
 *
 * Contract staff come in two kinds (owner decision 2026-11-04): KONTRAK is paid a
 * salary like permanent staff, KONTRAK_HONORER per attendance and per teaching
 * hour. LEPAS is treated as an honorarium worker (`DRAFT`, agent default
 * 2026-10-27): daily workers are paid per attendance and per teaching hour.
 */
const CATEGORY_BY_TERM: Readonly<Record<string, EmploymentCategory>> = {
  TETAP: "PERMANENT",
  PERCOBAAN: "PROBATION",
  KONTRAK: "SALARIED_CONTRACT",
  KONTRAK_HONORER: "HONORARIUM",
  LEPAS: "HONORARIUM",
};

const PAYROLL_TERM_CATEGORIES = Object.keys(CATEGORY_BY_TERM);

/** The terms paid under section 5.1, which is where PERF lives. */
const PERFORMANCE_TERM_CATEGORIES = new Set(
  Object.entries(CATEGORY_BY_TERM)
    .filter(([, category]) => category !== "HONORARIUM")
    .map(([term]) => term),
);

type EmploymentRow = {
  employmentId: string;
  employeeId: string;
  serviceStartDate: string | null;
  serviceEndDate: string | null;
  termCategory: string | null;
  endBasis: string | null;
};

type ProfileRow = {
  id: string;
  employmentId: string;
  education: string | null;
  workPattern: string | null;
  unitRef: string | null;
  functionalPositionRef: string | null;
  structuralPositionRef: string | null;
  teachingHoursPerWeek: string | null;
  spouseCount: number;
  childCount: number;
  registeredDependants: number;
  specialQualificationTarget: string | null;
  annualPerformanceRate: string | null;
  monthlyPerformanceRate: string | null;
  bpjsSegment: string;
  bpjsActiveFrom: string | null;
  bpjsExtraFamilyOverride: number | null;
  bankAccountNumber: string | null;
  bankAccountName: string | null;
  ptkpStatus: string | null;
  pph21Excluded: boolean | null;
};

type InputRow = {
  employmentId: string;
  inputKey: string;
  value: string;
};

export type CalculationOutcome = {
  employeeCount: number;
  blockerCount: number;
  /** Employments the engine could not be called for at all, with the reason. */
  skipped: Array<{ employmentId: string; blocker: PayrollBlocker }>;
  policyProblems: PolicyProblem[];
  /** The period moved or left its working phase while this run was starting. */
  conflict: boolean;
  /**
   * PAY-003-THR T3: the pay date is later than the THR policy allows before the holiday, so
   * nothing was calculated. Carries the latest allowed pay date.
   */
  thrPayDateLate?: { latestPayDate: string };
  /** PAY-003-THR T4/T9: employments in the population with less than the minimum service. */
  notEligibleCount?: number;
};

/** ISO date minus whole days, as an ISO date; calendar arithmetic only, no clock. */
function isoDateMinusDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day - days));
  return date.toISOString().slice(0, 10);
}

/**
 * PAY-003-THR T4: the people a THR period pays. Active on the holiday, or ended at most the grace
 * days before it when their term is PKWTT; only the term categories the THR policy names. The term
 * is read on the earlier of the holiday and the end date, since an ended employment has no term
 * on the holiday itself.
 */
async function loadThrEmployments(
  client: PoolClient,
  period: { legalEntityKey: string | null; holidayDate: string },
  thr: ThrPolicyPayload,
): Promise<EmploymentRow[]> {
  const { rows } = await client.query<EmploymentRow>(
    `SELECT e.id AS "employmentId",
            e.employee_id AS "employeeId",
            to_char(coalesce(e.service_start_on, e.started_on), 'YYYY-MM-DD') AS "serviceStartDate",
            to_char(e.ended_on, 'YYYY-MM-DD') AS "serviceEndDate",
            e.end_basis AS "endBasis",
            term.category AS "termCategory"
     FROM employments e
     JOIN LATERAL (
       SELECT t.category FROM employment_terms t
       WHERE t.employment_id = e.id
         AND t.voided_by_action_id IS NULL
         AND (t.effective_from IS NULL OR t.effective_from <= least($2::date, coalesce(e.ended_on, $2::date)))
         AND (t.effective_to IS NULL OR t.effective_to >= least($2::date, coalesce(e.ended_on, $2::date)))
       ORDER BY t.sequence DESC LIMIT 1
     ) term ON true
     WHERE e.voided_by_action_id IS NULL
       AND coalesce(e.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
           = coalesce($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND (e.started_on IS NULL OR e.started_on <= $2::date)
       AND term.category = ANY($3::text[])
       AND (
         e.ended_on IS NULL
         OR e.ended_on >= $2::date
         OR (term.category = ANY($4::text[]) AND e.ended_on >= $2::date - $5::int)
       )
     ORDER BY e.id`,
    [
      period.legalEntityKey,
      period.holidayDate,
      thr.eligibleTermCategories,
      thr.terminationGraceTermCategories,
      thr.terminationGraceDays,
    ],
  );
  return rows;
}

const WORKING_STATES = ["COLLECTING", "CALCULATED"];

const toNumber = (value: string | null): number | null => (value === null ? null : Number(value));

function profileOf(employment: EmploymentRow, profile: ProfileRow | undefined): CompensationProfile | null {
  if (!profile || employment.serviceStartDate === null) return null;
  const category = employment.termCategory ? CATEGORY_BY_TERM[employment.termCategory] : undefined;
  if (!category) return null;
  return {
    employmentId: employment.employmentId,
    category,
    education: (profile.education as CompensationProfile["education"]) ?? null,
    serviceStartDate: employment.serviceStartDate,
    serviceEndDate: employment.serviceEndDate,
    spouseCount: profile.spouseCount,
    childCount: profile.childCount,
    registeredDependants: profile.registeredDependants,
    workPattern: profile.workPattern,
    unitRef: profile.unitRef,
    teachingHoursPerWeek: toNumber(profile.teachingHoursPerWeek),
    functionalPositionRef: profile.functionalPositionRef,
    structuralPositionRef: profile.structuralPositionRef,
    specialQualificationTarget: toNumber(profile.specialQualificationTarget),
    annualPerformanceRate: toNumber(profile.annualPerformanceRate),
    monthlyPerformanceRate: toNumber(profile.monthlyPerformanceRate),
    bpjs: {
      segment: profile.bpjsSegment as CompensationProfile["bpjs"]["segment"],
      activeFrom: profile.bpjsActiveFrom,
      extraFamilyMembersOverride: profile.bpjsExtraFamilyOverride,
    },
    bankAccountNumber: profile.bankAccountNumber,
    bankAccountName: profile.bankAccountName,
  };
}

/** Turns the period's input rows for one employment into the engine's input shape. */
export function inputsOf(rows: readonly InputRow[]): PeriodInputs {
  const value = (key: string): number | null => {
    const row = rows.find((candidate) => candidate.inputKey === key);
    return row ? Number(row.value) : null;
  };
  return {
    ...EMPTY_PERIOD_INPUTS,
    overtimeHours: value("OVERTIME_HOURS") ?? 0,
    contractAttendanceDays: value("CONTRACT_ATTENDANCE_DAYS") ?? 0,
    contractTeachingHours: value("CONTRACT_TEACHING_HOURS") ?? 0,
    childEducationDeduction: value("CHILD_EDUCATION") ?? 0,
    arrears: value("ARREARS") ?? 0,
    pjMediaIncentive: value("PJ_MEDIA") ?? 0,
    otherIncome: value("OTHER_INCOME") ?? 0,
    adjustment: value("ADJUSTMENT") ?? 0,
    prorationFactor: value("PRORATION_FACTOR"),
    fullPayDespiteLeaving: value("FULL_PAY_DESPITE_LEAVING") === 1,
    teachingHoursPerWeekOverride: value("TEACHING_HOURS_PER_WEEK_OVERRIDE"),
    annualPerformanceRateOverride: value("ANNUAL_PERFORMANCE_OVERRIDE"),
    monthlyPerformanceRateOverride: value("MONTHLY_PERFORMANCE_OVERRIDE"),
  };
}

/**
 * The people this period pays. An employment whose end date is unknown stays in
 * the population on purpose: EMP-005 stores it with ended_on NULL, so dropping it
 * by date would pay a full month to someone who may already have left. It comes
 * back with SERVICE_END_UNRESOLVED instead.
 */
async function loadEmployments(client: PoolClient, period: {
  id: string;
  legalEntityKey: string | null;
  periodStart: string;
  periodEnd: string;
  payDate: string;
}): Promise<EmploymentRow[]> {
  const { rows } = await client.query<EmploymentRow>(
    `SELECT e.id AS "employmentId",
            e.employee_id AS "employeeId",
            to_char(coalesce(e.service_start_on, e.started_on), 'YYYY-MM-DD') AS "serviceStartDate",
            to_char(e.ended_on, 'YYYY-MM-DD') AS "serviceEndDate",
            e.end_basis AS "endBasis",
            term.category AS "termCategory"
     FROM employments e
     JOIN LATERAL (
       SELECT t.category FROM employment_terms t
       WHERE t.employment_id = e.id
         AND t.voided_by_action_id IS NULL
         AND (t.effective_from IS NULL OR t.effective_from <= $4::date)
         AND (t.effective_to IS NULL OR t.effective_to >= $4::date)
       ORDER BY t.sequence DESC LIMIT 1
     ) term ON true
     WHERE e.voided_by_action_id IS NULL
       AND coalesce(e.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
           = coalesce($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND (e.started_on IS NULL OR e.started_on <= $3::date)
       AND (e.ended_on IS NULL OR e.ended_on >= $2::date)
       -- Outside the v1 scope (specification section 1.1): an intern or an
       -- unclassified baseline row is not paid by this module at all.
       AND term.category = ANY($5::text[])
     ORDER BY e.id`,
    [period.legalEntityKey, period.periodStart, period.periodEnd, period.payDate, PAYROLL_TERM_CATEGORIES],
  );
  return rows;
}

type LoanRow = { employeeId: string; outstanding: string; deductionThisPeriod: string };

/**
 * Loan balances and this period's instalment. The outstanding figure deliberately
 * excludes this period's own deduction, because that is what the engine checks
 * the deduction against (specification section 3.4).
 */
async function loadLoans(
  client: PoolClient,
  periodId: string,
  employeeIds: readonly string[],
): Promise<Map<string, { outstanding: number; deduction: number }>> {
  // A kasbon mirrored from LOAN-001 (employee_loan_id) takes its balance from
  // LOAN-001 itself, which also counts cash and transfer repayments; only the
  // payment this very period wrote (none while it is being worked on) is left
  // out, as the period's own deduction is what the balance is checked against.
  const { rows } = await client.query<LoanRow>(
    `SELECT l.employee_id AS "employeeId",
            coalesce(sum(l.principal) - sum(coalesce(other.paid, 0)), 0)::text AS "outstanding",
            coalesce(sum(coalesce(mine.amount, 0)), 0)::text AS "deductionThisPeriod"
     FROM payroll_loans l
     LEFT JOIN employee_loans el ON el.id = l.employee_loan_id
     LEFT JOIN LATERAL (
       SELECT CASE
         WHEN l.employee_loan_id IS NULL THEN (
           SELECT sum(d.amount) FROM payroll_loan_deductions d
           WHERE d.loan_id = l.id AND d.period_id <> $1)
         ELSE el.paid_total - coalesce((
           SELECT sum(p.amount) FROM employee_loan_payments p
           WHERE p.loan_id = el.id AND p.status = 'ACTIVE' AND p.source_payroll_period_id = $1), 0)
       END AS paid
     ) other ON true
     LEFT JOIN LATERAL (
       SELECT sum(d.amount) AS amount FROM payroll_loan_deductions d
       WHERE d.loan_id = l.id AND d.period_id = $1
     ) mine ON true
     WHERE l.employee_id = ANY($2::uuid[]) AND l.closed_at IS NULL
     GROUP BY l.employee_id`,
    [periodId, employeeIds],
  );
  return new Map(
    rows.map((row) => [
      row.employeeId,
      { outstanding: Number(row.outstanding), deduction: Number(row.deductionThisPeriod) },
    ]),
  );
}

type ReviewRow = LinkedReview & { employeeId: string };

/**
 * The finalized PERF-001 reviews this period reads (performance-review.md
 * section 11, payroll-calculation-v1.md section 5.5). Only FINALIZED reviews
 * from CLOSED cycles: UNRATED, REMOVED, and anything in a cycle still open are
 * never read. A cycle counts as closed for this pay date when it was closed on
 * or before the pay date (Asia/Jakarta), so recalculating an earlier period
 * after a later close does not reach forward.
 *
 * - %bulanan: the MONTHLY cycle of the month before the period month.
 * - %tahunan: the ANNUAL cycle with the latest period that was closed by the
 *   pay date. Only that cycle is read; an employee without a finalized review
 *   in it falls back to the profile, not to an older cycle.
 */
async function loadLinkedReviews(
  client: PoolClient,
  period: { periodStart: string; payDate: string },
  employeeIds: readonly string[],
): Promise<{ monthly: Map<string, LinkedReview>; annual: Map<string, LinkedReview> }> {
  const monthly = new Map<string, LinkedReview>();
  const annual = new Map<string, LinkedReview>();
  if (employeeIds.length === 0) return { monthly, annual };

  const { rows } = await client.query<ReviewRow>(
    `WITH closed AS (
       SELECT c.id, c.kind, c.period_start
       FROM performance_cycles c
       WHERE c.status = 'CLOSED'
         AND c.closed_at IS NOT NULL
         AND (c.closed_at AT TIME ZONE 'Asia/Jakarta')::date <= $2::date
     ),
     chosen AS (
       (SELECT id FROM closed WHERE kind = 'MONTHLY' AND period_start = $1::date)
       UNION ALL
       (SELECT id FROM closed WHERE kind = 'ANNUAL' ORDER BY period_start DESC LIMIT 1)
     )
     SELECT r.employee_id AS "employeeId", r.id AS "reviewId", c.id AS "cycleId",
            c.kind AS "cycleKind", to_char(c.period_start, 'YYYY-MM-DD') AS "cyclePeriodStart",
            r.predicate_code AS "predicateCode"
     FROM performance_reviews r
     JOIN performance_cycles c ON c.id = r.cycle_id
     WHERE r.cycle_id IN (SELECT id FROM chosen)
       AND r.status = 'FINALIZED'
       AND r.predicate_code IS NOT NULL
       AND r.employee_id = ANY($3::uuid[])`,
    [previousMonthStart(period.periodStart), period.payDate, employeeIds],
  );
  for (const row of rows) {
    const { employeeId, ...review } = row;
    (review.cycleKind === "MONTHLY" ? monthly : annual).set(employeeId, review);
  }
  return { monthly, annual };
}

/**
 * Runs the period and replaces its results with a new revision each time, so a
 * recalculation never mixes old and new rows and the earlier revision stays
 * readable (specification section 6).
 */
export async function calculatePeriod(
  pool: Pool,
  period: {
    id: string;
    legalEntityKey: string | null;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    /** PAY-003-THR: absent means a monthly period. */
    kind?: "REGULAR" | "THR";
    holidayDate?: string | null;
  },
  actorAccountId: string,
  expectedVersion: number,
  /** Feature switches read from configuration by the caller; all default off. */
  options: { employeeLoanDeduction?: boolean; reimbursementHandoff?: boolean } = {},
): Promise<CalculationOutcome> {
  const isThr = period.kind === "THR";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the period for the whole run. Without this, a calculation that started
    // while the period was COLLECTING could commit a new revision into a period
    // that has since been submitted or approved, and approval is supposed to lock
    // the results (ADR-0003 decision 4).
    const locked = await client.query<{ state: string; version: number }>(
      "SELECT state, version FROM payroll_periods WHERE id = $1 FOR UPDATE",
      [period.id],
    );
    const current = locked.rows[0];
    if (!current || current.version !== expectedVersion || !WORKING_STATES.includes(current.state)) {
      await client.query("ROLLBACK");
      return { employeeCount: 0, blockerCount: 0, skipped: [], policyProblems: [], conflict: true };
    }

    const policyRows = await client.query<{ id: string; policyKey: string; payload: unknown }>(
      `SELECT id, policy_key AS "policyKey", payload
       FROM payroll_policy_versions
       WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to >= $1::date)
       -- Held until the results commit, so an in-place correction of a loaded
       -- version (PAY-003-MIG section 5.4) waits for this run and then sees it.
       FOR SHARE`,
      [period.payDate],
    );
    const resolved = resolvePolicy(policyRows.rows);
    if (!resolved.ok) {
      // Fail closed: without a policy for the pay date nothing may be calculated
      // (specification section 5.4, STATUTORY_POLICY_MISSING).
      await client.query("ROLLBACK");
      return {
        employeeCount: 0,
        blockerCount: 0,
        skipped: [],
        policyProblems: resolved.problems,
        conflict: false,
      };
    }

    // PAY-003-THR: the THR policy, the payment deadline and the wage components, read only for a
    // THR period. A monthly period never needs the THR policy to exist.
    let thrPolicy: ThrPolicyPayload | null = null;
    let wageComponents: ComponentCode[] = [];
    if (isThr) {
      const thr = parseThrPolicy(policyRows.rows);
      if (!thr.ok || !period.holidayDate) {
        await client.query("ROLLBACK");
        return {
          employeeCount: 0,
          blockerCount: 0,
          skipped: [],
          policyProblems: thr.ok
            ? [{ policyKey: "THR", code: "INVALID", message: "Periode THR tidak memiliki tanggal hari raya." }]
            : [thr.problem],
          conflict: false,
        };
      }
      const latestPayDate = isoDateMinusDays(period.holidayDate, thr.policy.paymentDeadlineDaysBeforeHoliday);
      if (period.payDate > latestPayDate) {
        await client.query("ROLLBACK");
        return {
          employeeCount: 0,
          blockerCount: 0,
          skipped: [],
          policyProblems: [],
          conflict: false,
          thrPayDateLate: { latestPayDate },
        };
      }
      thrPolicy = thr.policy;
      resolved.versionIds.push(thr.versionId);
      const wage = await client.query<{ code: ComponentCode }>(
        "SELECT code FROM payroll_components WHERE is_thr_wage ORDER BY display_order",
      );
      wageComponents = wage.rows.map((row) => row.code);
    }

    const employments = isThr && thrPolicy && period.holidayDate
      ? await loadThrEmployments(client, { legalEntityKey: period.legalEntityKey, holidayDate: period.holidayDate }, thrPolicy)
      : await loadEmployments(client, period);
    const employmentIds = employments.map((row) => row.employmentId);
    const employeeIds = [...new Set(employments.map((row) => row.employeeId))];
    // LOAN-001 Package 2: propose this month's instalments before the loans are
    // read, so the engine sees them like any other kasbon deduction.
    // PAY-003-THR T8: THR carries no kasbon or loan instalment, so a THR period
    // proposes none and reads none; the register belongs to the monthly periods.
    const loanLink = isThr
      ? { proposed: 0, mirrored: 0 }
      : await syncEmployeeLoanDeductions(
          client,
          { id: period.id, periodMonth: period.periodStart },
          employeeIds,
          actorAccountId,
          options.employeeLoanDeduction === true,
        );
    const loans = isThr
      ? new Map<string, { outstanding: number; deduction: number }>()
      : await loadLoans(client, period.id, employeeIds);
    // REIMB-001 section 9: reimbursements handed to this month, per employee. A THR period
    // binds none: reimbursements are paid with the monthly salary (payroll-thr.md T8).
    const reimbursements = isThr
      ? new Map<string, number>()
      : await bindReimbursementHandoffs(
          client,
          { id: period.id, periodMonth: period.periodStart },
          employeeIds,
          options.reimbursementHandoff === true,
        );
    // Paid once per person: with two employments in one period, the first
    // carries it (employments are ordered by id).
    const reimbursedEmployees = new Set<string>();
    // Switched off (no enabled PERFORMANCE_PERCENT version on the pay date):
    // not one review is read and every input stays exactly as it was.
    // PAY-003-THR T6: a THR period takes the wage from the profile only, so the
    // PERF-001 link (a monthly appraisal override) is not applied to it.
    const performancePolicy = isThr ? null : resolved.performancePercent;
    const linkedReviews = performancePolicy ? await loadLinkedReviews(client, period, employeeIds) : null;
    let performanceLinkedCount = 0;

    const profiles = await client.query<ProfileRow>(
      `SELECT DISTINCT ON (employment_id)
              id, employment_id AS "employmentId", education, work_pattern AS "workPattern",
              unit_ref AS "unitRef", functional_position_ref AS "functionalPositionRef",
              structural_position_ref AS "structuralPositionRef",
              teaching_hours_per_week AS "teachingHoursPerWeek",
              spouse_count AS "spouseCount", child_count AS "childCount",
              registered_dependants AS "registeredDependants",
              special_qualification_target AS "specialQualificationTarget",
              annual_performance_rate AS "annualPerformanceRate",
              monthly_performance_rate AS "monthlyPerformanceRate",
              bpjs_segment AS "bpjsSegment",
              to_char(bpjs_active_from, 'YYYY-MM-DD') AS "bpjsActiveFrom",
              bpjs_extra_family_override AS "bpjsExtraFamilyOverride",
              bank_account_number AS "bankAccountNumber", bank_account_name AS "bankAccountName",
              ptkp_status AS "ptkpStatus", pph21_report_excluded AS "pph21Excluded"
       FROM payroll_compensation_profiles
       WHERE employment_id = ANY($1::uuid[])
         AND effective_from <= $2::date
         AND (effective_to IS NULL OR effective_to >= $2::date)
       ORDER BY employment_id, effective_from DESC`,
      [employmentIds, period.payDate],
    );
    // PAY-003-THR T6: someone who left within the grace days has no profile on the pay date, so
    // their wage is read from the profile in force on their last day.
    if (isThr) {
      const covered = new Set(profiles.rows.map((row) => row.employmentId));
      const ended = employments.filter(
        (row) => !covered.has(row.employmentId) && row.serviceEndDate !== null && row.serviceEndDate < period.payDate,
      );
      for (const employment of ended) {
        const last = await client.query<ProfileRow>(
          `SELECT id, employment_id AS "employmentId", education, work_pattern AS "workPattern",
                  unit_ref AS "unitRef", functional_position_ref AS "functionalPositionRef",
                  structural_position_ref AS "structuralPositionRef",
                  teaching_hours_per_week AS "teachingHoursPerWeek",
                  spouse_count AS "spouseCount", child_count AS "childCount",
                  registered_dependants AS "registeredDependants",
                  special_qualification_target AS "specialQualificationTarget",
                  annual_performance_rate AS "annualPerformanceRate",
                  monthly_performance_rate AS "monthlyPerformanceRate",
                  bpjs_segment AS "bpjsSegment",
                  to_char(bpjs_active_from, 'YYYY-MM-DD') AS "bpjsActiveFrom",
                  bpjs_extra_family_override AS "bpjsExtraFamilyOverride",
                  bank_account_number AS "bankAccountNumber", bank_account_name AS "bankAccountName"
           FROM payroll_compensation_profiles
           WHERE employment_id = $1
             AND effective_from <= $2::date
             AND (effective_to IS NULL OR effective_to >= $2::date)
           ORDER BY effective_from DESC LIMIT 1`,
          [employment.employmentId, employment.serviceEndDate],
        );
        if (last.rows[0]) profiles.rows.push(last.rows[0]);
      }
    }
    const profileByEmployment = new Map(profiles.rows.map((row) => [row.employmentId, row]));

    const inputs = await client.query<InputRow & { recordedAt: Date }>(
      `SELECT employment_id AS "employmentId", input_key AS "inputKey", value,
              recorded_at AS "recordedAt"
       FROM payroll_period_inputs WHERE period_id = $1`,
      [period.id],
    );
    const inputsByEmployment = new Map<string, InputRow[]>();
    for (const row of inputs.rows) {
      inputsByEmployment.set(row.employmentId, [...(inputsByEmployment.get(row.employmentId) ?? []), row]);
    }

    // PAY-003-THR T5 (payroll-thr.md section 2.1): an honorarium worker's month of wages is the
    // average of what the approved salary periods before the THR month actually paid, or the
    // figure human capital typed for this THR period. Read once for the whole period.
    const thrWageSources = new Map<string, { source: ThrAverageWageSource; periods: ThrWageSourcePeriod[] }>();
    if (isThr && thrPolicy) {
      const typedAverage = (employmentId: string): number | null => {
        const row = (inputsByEmployment.get(employmentId) ?? []).find(
          (candidate) => candidate.inputKey === "THR_AVERAGE_WAGE",
        );
        return row ? Number(row.value) : null;
      };
      const honorarium = employments.filter(
        (row) =>
          row.serviceStartDate !== null &&
          row.termCategory !== null &&
          CATEGORY_BY_TERM[row.termCategory] === "HONORARIUM",
      );
      const honorariumIds = new Set(honorarium.map((row) => row.employmentId));
      const paidWages =
        honorarium.length > 0
          ? await loadThrPaidWages(client, {
              legalEntityKey: period.legalEntityKey,
              payDate: period.payDate,
              windowLength: thrPolicy.fullServiceMonths,
              employmentIds: [...honorariumIds],
            })
          : { periods: [], paidByEmployment: new Map() };
      for (const employment of honorarium) {
        const requiredMonths = thrAverageWageMonths(
          period.payDate,
          employment.serviceStartDate!,
          thrPolicy.fullServiceMonths,
        );
        const periods = paidWages.periods.filter((source) => requiredMonths.includes(source.month));
        thrWageSources.set(employment.employmentId, {
          source: {
            requiredMonths,
            coveredMonths: periods.map((source) => source.month),
            paid: paidWages.paidByEmployment.get(employment.employmentId) ?? [],
            hcInput: typedAverage(employment.employmentId),
          },
          periods,
        });
      }
      // A figure typed for someone paid a salary is handed to the engine too, which refuses it
      // (INPUT_INVALID) instead of letting it sit unused on the period.
      for (const employment of employments) {
        if (honorariumIds.has(employment.employmentId)) continue;
        const hcInput = typedAverage(employment.employmentId);
        if (hcInput !== null) {
          thrWageSources.set(employment.employmentId, {
            source: { requiredMonths: [], coveredMonths: [], paid: [], hcInput },
            periods: [],
          });
        }
      }
    }
    const thrAverageCounts = { rows: 0, hcInput: 0, incomplete: 0 };

    // The fingerprint the lifecycle compares against to notice a changed or
    // deleted input after this run. It is derived from the very rows that were
    // calculated, not from a second query: another statement would see a newer
    // snapshot and could fingerprint an input this run never used.
    const lastRecordedAt = inputs.rows.reduce<Date | null>(
      (latest, row) => (latest === null || row.recordedAt > latest ? row.recordedAt : latest),
      null,
    );
    const periodFingerprint = {
      input_count: inputs.rows.length,
      last_input_recorded_at: lastRecordedAt === null ? null : lastRecordedAt.toISOString(),
    };

    const previous = await client.query<{ employmentId: string; id: string; revision: number }>(
      `SELECT DISTINCT ON (employment_id)
              employment_id AS "employmentId", id, revision
       FROM payroll_results WHERE period_id = $1
       ORDER BY employment_id, revision DESC`,
      [period.id],
    );
    const previousByEmployment = new Map(previous.rows.map((row) => [row.employmentId, row]));

    const results: EmployeePayrollResult[] = [];
    const skipped: CalculationOutcome["skipped"] = [];
    let notEligibleCount = 0;
    const resultRows: Array<Record<string, unknown>> = [];
    const lineRows: Array<Record<string, unknown>> = [];
    const pph21Sources: Pph21SourceRow[] = [];
    const resultByEmployment = new Map<
      string,
      { result: EmployeePayrollResult; row: Record<string, unknown>; resultId: string }
    >();

    // PPh21 switches (section 7.5). Read from the same policy rows as the rest of
    // the run; an unreadable row or a borne tax without a TER table fails closed,
    // like any other statutory policy missing for the pay date (section 5.4).
    const settingsRow = policyRows.rows.find((row) => row.policyKey === "PPH21_SETTINGS");
    const parsedSettings = settingsRow ? parsePph21Settings(settingsRow.payload) : null;
    const terRow = policyRows.rows.find((row) => row.policyKey === "PPH21_TER");
    const parsedTer = terRow ? parsePph21TerPolicy(terRow.payload) : null;
    const pph21Problems: PolicyProblem[] = [];
    if (parsedSettings && !parsedSettings.ok) {
      pph21Problems.push({ policyKey: "PPH21_SETTINGS", code: "INVALID", message: `Isi kebijakan PPH21_SETTINGS tidak sesuai bentuk: ${parsedSettings.message}.` });
    }
    const pph21Settings = parsedSettings?.ok ? parsedSettings.settings : DEFAULT_PPH21_SETTINGS;
    if (pph21Settings.employerBorne && !parsedTer?.ok) {
      pph21Problems.push({
        policyKey: "PPH21_TER",
        code: parsedTer ? "INVALID" : "MISSING",
        message: "PPh21 ditanggung yayasan aktif, tetapi tabel PPH21_TER tidak tersedia atau tidak valid untuk tanggal gajian ini.",
      });
    }
    if (pph21Problems.length > 0) {
      await client.query("ROLLBACK");
      return { employeeCount: 0, blockerCount: 0, skipped: [], policyProblems: pph21Problems, conflict: false };
    }
    const terPolicy = parsedTer?.ok ? parsedTer.policy : null;
    // Whether each person keeps an employment with this employer past the period:
    // ending one of two is not a final masa pajak (section 7.2).
    const continuingEmployees = new Set(
      pph21Settings.employerBorne
        ? (
            await client.query<{ employeeId: string }>(
              `SELECT DISTINCT e.employee_id AS "employeeId" FROM employments e
               WHERE e.employee_id = ANY($1::uuid[])
                 AND e.voided_by_action_id IS NULL
                 AND coalesce(e.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
                     = coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
                 AND (e.ended_on IS NULL OR e.ended_on > $3::date)`,
              [employeeIds, period.legalEntityKey, period.periodEnd],
            )
          ).rows.map((row) => row.employeeId)
        : [],
    );

    for (const employment of employments) {
      const loan = loans.get(employment.employeeId) ?? { outstanding: 0, deduction: 0 };
      const employmentInputs: PeriodInputs = {
        ...inputsOf(inputsByEmployment.get(employment.employmentId) ?? []),
        // The loan instalment is not a period input anyone types: it comes from
        // the loan register, which finance owns (specification section 3.4).
        loanDeduction: loan.deduction,
        loanOutstanding: loan.outstanding,
      };
      const reimbursement = reimbursements.get(employment.employeeId) ?? 0;
      if (reimbursement > 0 && !reimbursedEmployees.has(employment.employeeId)) {
        // Absent unless there is something to pay, so a period without a
        // handoff stores exactly the snapshot it stored before.
        employmentInputs.reimbursement = reimbursement;
        reimbursedEmployees.add(employment.employeeId);
      }
      let performanceTrace: PerformanceLinkTrace | null = null;
      const linkBlockers: PayrollBlocker[] = [];
      // Only the pay bases that earn PERF read a review. Honorarium staff
      // (KONTRAK_HONORER, LEPAS) have no performance allowance (section 5.2),
      // so a review of theirs must neither change nor block anything.
      const earnsPerformance = employment.termCategory !== null && PERFORMANCE_TERM_CATEGORIES.has(employment.termCategory);
      if (performancePolicy && linkedReviews && earnsPerformance) {
        const linked = resolvePerformanceLink({
          policy: performancePolicy,
          monthly: linkedReviews.monthly.get(employment.employeeId) ?? null,
          annual: linkedReviews.annual.get(employment.employeeId) ?? null,
        });
        employmentInputs.annualPerformanceRateFromReview = linked.annualRate;
        employmentInputs.monthlyPerformanceRateFromReview = linked.monthlyRate;
        performanceTrace = linked.trace;
        linkBlockers.push(...linked.blockers);
        if (linked.trace.monthly || linked.trace.annual) performanceLinkedCount += 1;
      }
      const profile = profileOf(employment, profileByEmployment.get(employment.employmentId));
      const unresolvedEnd = employment.endBasis === "UNKNOWN";

      // T4/T9: below the minimum service there is no THR to pay, which is not a blocker anyone
      // could clear; the employment is counted and left out of the results.
      if (isThr && thrPolicy && period.holidayDate && employment.serviceStartDate !== null) {
        const eligibility = thrEligibility(employment.serviceStartDate, period.holidayDate, thrPolicy);
        if (!eligibility.eligible) {
          notEligibleCount += 1;
          continue;
        }
      }

      // Someone without a usable profile still gets a result row, carrying the
      // blocker and nothing else. Leaving them out would hide them from the
      // period's blocker count and let an incomplete period be submitted.
      const thrWageSource = thrWageSources.get(employment.employmentId);
      const thrResult = profile && isThr && thrPolicy && period.holidayDate
        ? calculateEmployeeThr({
            profile,
            payDate:
              employment.serviceEndDate !== null && employment.serviceEndDate < period.payDate
                ? employment.serviceEndDate
                : period.payDate,
            holidayDate: period.holidayDate,
            policy: resolved.policy,
            thrPolicy,
            wageComponents,
            adjustment: employmentInputs.adjustment,
            averageWage: thrWageSource?.source,
          })
        : null;
      // Section 2.1 H10: how the month of wages was arrived at is stored with the result, with
      // the salary periods it read, so the figure can be explained and the approval can tell
      // whether one of them has been reopened since.
      const thrAverageWage: (ThrAverageWage & { hcInput: number | null; periods: ThrWageSourcePeriod[] }) | null =
        thrResult?.averageWage && thrWageSource
          ? { ...thrResult.averageWage, hcInput: thrWageSource.source.hcInput, periods: thrWageSource.periods }
          : null;
      if (thrAverageWage) {
        thrAverageCounts.rows += 1;
        if (thrAverageWage.source === "HC_INPUT") thrAverageCounts.hcInput += 1;
        if (thrAverageWage.source === "NONE") thrAverageCounts.incomplete += 1;
      }
      const calculated: EmployeePayrollResult | null = thrResult
        ? thrResult
        : profile
        ? calculateEmployeePayroll({
            profile,
            inputs: employmentInputs,
            payDate: period.payDate,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            policy: resolved.policy,
          })
        : null;
      const result: EmployeePayrollResult = calculated ?? {
            employmentId: employment.employmentId,
            lines: [],
            gross: 0,
            deductions: 0,
            net: 0,
            payable: 0,
            employerCost: 0,
            payFactor: 1,
            payFactorReason: "none",
            bpjsBase: 0,
            extraFamilyMembers: 0,
            monthsOfService: 0,
        yearsOfService: 0,
        blockers: [PROFILE_MISSING],
      };
      if (!profile) skipped.push({ employmentId: employment.employmentId, blocker: PROFILE_MISSING });
      if (unresolvedEnd) result.blockers.push(SERVICE_END_UNRESOLVED);
      result.blockers.push(...linkBlockers);
      results.push(result);

      const previousRow = previousByEmployment.get(employment.employmentId);
      const resultId = randomUUID();
      resultRows.push({
        id: resultId,
        employment_id: employment.employmentId,
        // Which profile row the figures came from, so a past period can be
        // explained even after the profile moves on (migration 0080).
        compensation_profile_id: profileByEmployment.get(employment.employmentId)?.id ?? null,
        revision: (previousRow?.revision ?? 0) + 1,
        previous_result_id: previousRow?.id ?? null,
        gross: result.gross,
        deductions: result.deductions,
        net: result.net,
        payable: result.payable,
        employer_cost: result.employerCost,
        pay_factor: result.payFactor,
        pay_factor_reason: result.payFactorReason,
        bpjs_base: result.bpjsBase,
        extra_family_members: result.extraFamilyMembers,
        blockers: result.blockers,
        // Which review, cycle and predicate the performance rates came from, so
        // the figure can be audited again later (performance-review.md
        // section 11 item 5). Absent while the link is switched off, so a
        // switched-off period stores exactly what it stored before.
        // Each trace is present only when there is one, so a period with neither stores exactly
        // what it stored before the links were built. They are spread rather than branched: a row
        // that ever carries both must keep both, since the THR approval guard keys on
        // thr_average_wage and would silently stop guarding if a branch dropped it.
        input_snapshot: {
          period_fingerprint: periodFingerprint,
          inputs: employmentInputs,
          ...(performanceTrace ? { performance_link: performanceTrace } : {}),
          ...(thrAverageWage ? { thr_average_wage: thrAverageWage } : {}),
        },
      });

      for (const [index, line] of result.lines.entries()) {
        lineRows.push({
          id: randomUUID(),
          result_id: resultId,
          component_code: line.code,
          category: line.category,
          amount: line.amount,
          basis: line.basis ?? null,
          display_order: (index + 1) * 10,
        });
      }

      const usedProfile = profileByEmployment.get(employment.employmentId);
      pph21Sources.push({
        employmentId: employment.employmentId,
        employeeId: employment.employeeId,
        employeeNumber: "",
        fullName: "",
        ptkpStatus: usedProfile?.ptkpStatus ?? null,
        excluded: usedProfile?.pph21Excluded ?? false,
        exclusionReason: null,
        payFactor: result.payFactor,
        blockerCount: result.blockers.length,
        serviceEndDate: employment.serviceEndDate,
        hasContinuingEmployment: continuingEmployees.has(employment.employeeId),
        termCategory: employment.termCategory,
        earnings: result.lines.filter((line) => line.category === "EARNING").map((line) => ({ code: line.code, amount: line.amount })),
        deductions: result.lines.filter((line) => line.category === "DEDUCTION").map((line) => ({ code: line.code, amount: line.amount })),
        attendanceDays: employmentInputs.contractAttendanceDays,
      });
      resultByEmployment.set(employment.employmentId, { result, row: resultRows[resultRows.length - 1]!, resultId });
    }

    // PAY-003 section 7.5 (P6): PPh21 borne by the yayasan. Off unless the
    // PPH21_SETTINGS in force says so, and then written as one EMPLOYER_COST
    // line per person; off, not one figure changes.
    const pph21VersionIds: string[] = [];
    if (pph21Settings.employerBorne && terPolicy) {
      const year = Number(period.periodStart.slice(0, 4));
      const reportPeriod = { periodMonth: period.periodStart, periodStart: period.periodStart, periodEnd: period.periodEnd };
      // Only people whose service ends inside this period, or everyone in
      // December, settle the year; nobody else needs the earlier months read.
      const settling = pph21Sources.filter((source) =>
        needsAnnualCalculation(reportPeriod, [source.serviceEndDate], source.hasContinuingEmployment),
      );
      let annual: Parameters<typeof employerPph21Lines>[0]["annual"] = null;
      // PAY-003-THR: the annual settlement stays with the monthly period of the month.
      if (settling.length > 0 && !isThr) {
        const annualPolicy = await findPph21AnnualPolicy(client, year);
        if (annualPolicy.ok) {
          const earlier = await loadAnnualMonths(client, year, annualPolicy.policy, {
            beforeMonth: period.periodStart.slice(0, 7),
          });
          // An earlier month of the year that is not final (never approved, or
          // reopened) or had no TER table leaves the year incomplete: the line
          // stays on TER and says so, rather than settling on missing months.
          if (earlier.pendingPeriods.length === 0 && earlier.periodsWithoutTer.length === 0) {
            const settlingIds = new Set(settling.map((source) => source.employeeId));
            annual = {
              policy: annualPolicy.policy,
              priorMonths: earlier.months.filter((month) => settlingIds.has(month.employeeId)),
            };
            pph21VersionIds.push(annualPolicy.versionId);
          }
        }
      }
      // PAY-003-THR T10: THR shares the masa pajak with the salary of its month, so its borne PPh21
      // is the increment: TER on the month's salary and THR together, less TER on the salary alone
      // (the salary period's own line). The annual settlement stays with the salary period (DRAFT).
      const thrEmployerLines = async (): Promise<Map<string, { amount: number; basis: string }>> => {
        const salaryPeriods = await client.query<{ id: string }>(
          `SELECT other.id FROM payroll_periods other
           WHERE other.period_kind = 'REGULAR'
             AND other.period_month = $1::date
             AND coalesce(other.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
                 = coalesce($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
          [period.periodStart, period.legalEntityKey],
        );
        const salaryRows: Pph21SourceRow[] = [];
        for (const salary of salaryPeriods.rows) {
          for (const row of await loadPph21SourceRows(client, salary.id)) salaryRows.push({ ...row, periodKind: "REGULAR" });
        }
        const thrRows: Pph21SourceRow[] = pph21Sources.map((source) => ({ ...source, periodKind: "THR" }));
        const employeeOf = new Map([...salaryRows, ...thrRows].map((row) => [row.employmentId, row.employeeId]));
        const perEmployee = (lines: Map<string, { amount: number }>) => {
          const totals = new Map<string, number>();
          for (const [employmentId, line] of lines) {
            const employeeId = employeeOf.get(employmentId);
            if (employeeId) totals.set(employeeId, (totals.get(employeeId) ?? 0) + line.amount);
          }
          return totals;
        };
        const base = { period: reportPeriod, terPolicy, settings: pph21Settings, annual: null };
        const withThr = perEmployee(employerPph21Lines({ ...base, rows: [...salaryRows, ...thrRows] }));
        const salaryOnly = perEmployee(employerPph21Lines({ ...base, rows: salaryRows }));
        const increments = new Map<string, { amount: number; basis: string }>();
        const placed = new Set<string>();
        for (const source of thrRows) {
          if (placed.has(source.employeeId) || !resultByEmployment.has(source.employmentId)) continue;
          placed.add(source.employeeId);
          const amount = (withThr.get(source.employeeId) ?? 0) - (salaryOnly.get(source.employeeId) ?? 0);
          if (amount !== 0) {
            increments.set(source.employmentId, { amount, basis: "TER gaji + THR bulan ini dikurangi TER gaji" });
          }
        }
        return increments;
      };
      const employerLines = isThr
        ? await thrEmployerLines()
        : employerPph21Lines({
            period: reportPeriod,
            terPolicy,
            settings: pph21Settings,
            rows: pph21Sources,
            annual,
          });
      // The results record every policy row the line was computed from (ADR-0003).
      if (settingsRow) pph21VersionIds.push(settingsRow.id);
      if (terRow) pph21VersionIds.push(terRow.id);
      for (const [employmentId, line] of employerLines) {
        const target = resultByEmployment.get(employmentId);
        if (!target) continue;
        target.result.employerCost += line.amount;
        target.row.employer_cost = target.result.employerCost;
        lineRows.push({
          id: randomUUID(),
          result_id: target.resultId,
          component_code: "PPH21_EMPLOYER",
          category: "EMPLOYER_COST",
          amount: line.amount,
          basis: line.basis,
          display_order: 3000,
        });
      }
    }

    // Two statements rather than one per employee and one per line: a few hundred
    // employees would otherwise mean thousands of round trips inside one
    // transaction, on a phone.
    if (resultRows.length > 0) {
      await client.query(
        `INSERT INTO payroll_results(
           id, period_id, employment_id, revision, previous_result_id,
           gross, deductions, net, payable, employer_cost,
           pay_factor, pay_factor_reason, bpjs_base, extra_family_members,
           blockers, input_snapshot, policy_version_ids, compensation_profile_id)
         SELECT r.id, $1, r.employment_id, r.revision, r.previous_result_id,
                r.gross, r.deductions, r.net, r.payable, r.employer_cost,
                r.pay_factor, r.pay_factor_reason, r.bpjs_base, r.extra_family_members,
                r.blockers, r.input_snapshot, $3::jsonb, r.compensation_profile_id
         FROM jsonb_to_recordset($2::jsonb) AS r(
           id uuid, employment_id uuid, revision integer, previous_result_id uuid,
           gross bigint, deductions bigint, net bigint, payable bigint, employer_cost bigint,
           pay_factor numeric, pay_factor_reason text, bpjs_base bigint, extra_family_members integer,
           blockers jsonb, input_snapshot jsonb, compensation_profile_id uuid)`,
        [period.id, JSON.stringify(resultRows), JSON.stringify([...resolved.versionIds, ...pph21VersionIds])],
      );
    }

    if (lineRows.length > 0) {
      await client.query(
        `INSERT INTO payroll_result_lines(id, result_id, component_code, category, amount, basis, display_order)
         SELECT l.id, l.result_id, l.component_code, l.category, l.amount, l.basis, l.display_order
         FROM jsonb_to_recordset($1::jsonb) AS l(
           id uuid, result_id uuid, component_code text, category text,
           amount bigint, basis text, display_order integer)`,
        [JSON.stringify(lineRows)],
      );
    }

    const totals = summarizePeriod(results);
    const blockerCount = totals.blockerCount;

    // Aggregates only: the audit payload never carries a per-person amount
    // (specification section 8).
    await writeAudit(client, {
      actorAccountId,
      action: "payroll.period.calculated",
      periodId: period.id,
      payload: {
        employee_count: totals.employeeCount,
        skipped_count: skipped.length,
        blocker_count: blockerCount,
        gross_total: totals.gross,
        payable_total: totals.payable,
        employer_cost_total: totals.employerCost,
        policy_version_count: resolved.versionIds.length,
        // Counts only: which predicate anyone received stays in the result row.
        ...(performancePolicy ? { performance_link_enabled: true, performance_linked_count: performanceLinkedCount } : {}),
        ...(options.employeeLoanDeduction === true && !isThr
          ? { employee_loan_deduction_enabled: true, employee_loan_proposed_count: loanLink.proposed }
          : {}),
        ...(options.reimbursementHandoff === true
          ? { reimbursement_handoff_enabled: true, reimbursement_employee_count: reimbursedEmployees.size }
          : {}),
        ...(isThr ? { period_kind: "THR", not_eligible_count: notEligibleCount } : {}),
        // Counts only (payroll-thr.md section 6): how many rows rest on an average wage, how many
        // of those on a figure human capital typed, and how many are blocked for want of either.
        ...(isThr && thrAverageCounts.rows > 0
          ? {
              thr_average_wage_count: thrAverageCounts.rows,
              thr_average_wage_hc_input_count: thrAverageCounts.hcInput,
              thr_average_wage_incomplete_count: thrAverageCounts.incomplete,
            }
          : {}),
      },
    });

    await client.query("COMMIT");
    return {
      employeeCount: totals.employeeCount,
      blockerCount,
      skipped,
      policyProblems: [],
      conflict: false,
      ...(isThr ? { notEligibleCount } : {}),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
