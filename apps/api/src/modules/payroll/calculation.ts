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
import { resolvePolicy, type PolicyProblem } from "./policy.js";
import { writeAudit } from "./store.js";

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
};

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
  const { rows } = await client.query<LoanRow>(
    `SELECT l.employee_id AS "employeeId",
            coalesce(sum(l.principal) - sum(coalesce(other.paid, 0)), 0)::text AS "outstanding",
            coalesce(sum(coalesce(mine.amount, 0)), 0)::text AS "deductionThisPeriod"
     FROM payroll_loans l
     LEFT JOIN LATERAL (
       SELECT sum(d.amount) AS paid FROM payroll_loan_deductions d
       WHERE d.loan_id = l.id AND d.period_id <> $1
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
  },
  actorAccountId: string,
  expectedVersion: number,
): Promise<CalculationOutcome> {
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

    const employments = await loadEmployments(client, period);
    const employmentIds = employments.map((row) => row.employmentId);
    const employeeIds = [...new Set(employments.map((row) => row.employeeId))];
    const loans = await loadLoans(client, period.id, employeeIds);
    // Switched off (no enabled PERFORMANCE_PERCENT version on the pay date):
    // not one review is read and every input stays exactly as it was.
    const performancePolicy = resolved.performancePercent;
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
              bank_account_number AS "bankAccountNumber", bank_account_name AS "bankAccountName"
       FROM payroll_compensation_profiles
       WHERE employment_id = ANY($1::uuid[])
         AND effective_from <= $2::date
         AND (effective_to IS NULL OR effective_to >= $2::date)
       ORDER BY employment_id, effective_from DESC`,
      [employmentIds, period.payDate],
    );
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
    const resultRows: Array<Record<string, unknown>> = [];
    const lineRows: Array<Record<string, unknown>> = [];

    for (const employment of employments) {
      const loan = loans.get(employment.employeeId) ?? { outstanding: 0, deduction: 0 };
      const employmentInputs: PeriodInputs = {
        ...inputsOf(inputsByEmployment.get(employment.employmentId) ?? []),
        // The loan instalment is not a period input anyone types: it comes from
        // the loan register, which finance owns (specification section 3.4).
        loanDeduction: loan.deduction,
        loanOutstanding: loan.outstanding,
      };
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

      // Someone without a usable profile still gets a result row, carrying the
      // blocker and nothing else. Leaving them out would hide them from the
      // period's blocker count and let an incomplete period be submitted.
      const calculated: EmployeePayrollResult | null = profile
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
        input_snapshot: performanceTrace
          ? { period_fingerprint: periodFingerprint, inputs: employmentInputs, performance_link: performanceTrace }
          : { period_fingerprint: periodFingerprint, inputs: employmentInputs },
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
        [period.id, JSON.stringify(resultRows), JSON.stringify(resolved.versionIds)],
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
      },
    });

    await client.query("COMMIT");
    return {
      employeeCount: totals.employeeCount,
      blockerCount,
      skipped,
      policyProblems: [],
      conflict: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
