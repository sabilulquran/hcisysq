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
import { resolvePolicy, type PolicyProblem } from "./policy.js";
import { writeAudit } from "./store.js";

/**
 * The one blocker this module raises itself: the engine cannot be called at all
 * without a compensation profile, an employment category and a start date.
 */
const PROFILE_MISSING: PayrollBlocker = {
  code: "EDUCATION_NOT_MAPPED",
  message:
    "Profil kompensasi, kategori kepegawaian, atau TMT belum tersedia untuk pegawai ini pada tanggal gajian.",
};

/** EMP-005 employment categories mapped onto the three the engine knows. */
const CATEGORY_BY_TERM: Readonly<Record<string, EmploymentCategory>> = {
  TETAP: "PERMANENT",
  PERCOBAAN: "PROBATION",
  KONTRAK: "CONTRACT",
  KONTRAK_HONORER: "CONTRACT",
  LEPAS: "CONTRACT",
};

type EmploymentRow = {
  employmentId: string;
  employeeId: string;
  serviceStartDate: string | null;
  serviceEndDate: string | null;
  termCategory: string | null;
};

type ProfileRow = {
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
  /** Employments that could not be calculated at all, with the reason. */
  skipped: Array<{ employmentId: string; blocker: PayrollBlocker }>;
  policyProblems: PolicyProblem[];
};

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
            (SELECT t.category FROM employment_terms t
              WHERE t.employment_id = e.id
                AND t.voided_by_action_id IS NULL
                AND (t.effective_from IS NULL OR t.effective_from <= $4::date)
                AND (t.effective_to IS NULL OR t.effective_to >= $4::date)
              ORDER BY t.sequence DESC LIMIT 1) AS "termCategory"
     FROM employments e
     WHERE e.voided_by_action_id IS NULL
       AND coalesce(e.legal_entity_key, '00000000-0000-0000-0000-000000000000'::uuid)
           = coalesce($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       AND (e.started_on IS NULL OR e.started_on <= $3::date)
       AND (e.ended_on IS NULL OR e.ended_on >= $2::date)
     ORDER BY e.id`,
    [period.legalEntityKey, period.periodStart, period.periodEnd, period.payDate],
  );
  return rows;
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
): Promise<CalculationOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const policyRows = await client.query<{ id: string; policyKey: string; payload: unknown }>(
      `SELECT id, policy_key AS "policyKey", payload
       FROM payroll_policy_versions
       WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to >= $1::date)`,
      [period.payDate],
    );
    const resolved = resolvePolicy(policyRows.rows);
    if (!resolved.ok) {
      // Fail closed: without a policy for the pay date nothing may be calculated
      // (specification section 5.4, STATUTORY_POLICY_MISSING).
      await client.query("ROLLBACK");
      return { employeeCount: 0, blockerCount: 0, skipped: [], policyProblems: resolved.problems };
    }

    const employments = await loadEmployments(client, period);
    const employmentIds = employments.map((row) => row.employmentId);

    const profiles = await client.query<ProfileRow>(
      `SELECT DISTINCT ON (employment_id)
              employment_id AS "employmentId", education, work_pattern AS "workPattern",
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

    const inputs = await client.query<InputRow>(
      `SELECT employment_id AS "employmentId", input_key AS "inputKey", value
       FROM payroll_period_inputs WHERE period_id = $1`,
      [period.id],
    );
    const inputsByEmployment = new Map<string, InputRow[]>();
    for (const row of inputs.rows) {
      inputsByEmployment.set(row.employmentId, [...(inputsByEmployment.get(row.employmentId) ?? []), row]);
    }

    // The fingerprint the lifecycle compares against to notice a changed or
    // deleted input after this run.
    const fingerprint = await client.query<{ inputCount: number; lastInputRecordedAt: string | null }>(
      `SELECT count(*)::int AS "inputCount", max(recorded_at) AS "lastInputRecordedAt"
       FROM payroll_period_inputs WHERE period_id = $1`,
      [period.id],
    );
    const periodFingerprint = {
      input_count: fingerprint.rows[0]?.inputCount ?? 0,
      last_input_recorded_at: fingerprint.rows[0]?.lastInputRecordedAt ?? null,
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

    for (const employment of employments) {
      const employmentInputs = inputsOf(inputsByEmployment.get(employment.employmentId) ?? []);
      const profile = profileOf(employment, profileByEmployment.get(employment.employmentId));

      // Someone without a usable profile still gets a result row, carrying the
      // blocker and nothing else. Leaving them out would hide them from the
      // period's blocker count and let an incomplete period be submitted.
      const result: EmployeePayrollResult = profile
        ? calculateEmployeePayroll({
            profile,
            inputs: employmentInputs,
            payDate: period.payDate,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            policy: resolved.policy,
          })
        : {
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
      results.push(result);

      const previousRow = previousByEmployment.get(employment.employmentId);
      const resultId = randomUUID();
      await client.query(
        `INSERT INTO payroll_results(
           id, period_id, employment_id, revision, previous_result_id,
           gross, deductions, net, payable, employer_cost,
           pay_factor, pay_factor_reason, bpjs_base, extra_family_members,
           blockers, input_snapshot, policy_version_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17::jsonb)`,
        [
          resultId,
          period.id,
          employment.employmentId,
          (previousRow?.revision ?? 0) + 1,
          previousRow?.id ?? null,
          result.gross,
          result.deductions,
          result.net,
          result.payable,
          result.employerCost,
          result.payFactor,
          result.payFactorReason,
          result.bpjsBase,
          result.extraFamilyMembers,
          JSON.stringify(result.blockers),
          JSON.stringify({ period_fingerprint: periodFingerprint, inputs: employmentInputs }),
          JSON.stringify(resolved.versionIds),
        ],
      );

      for (const [index, line] of result.lines.entries()) {
        await client.query(
          `INSERT INTO payroll_result_lines(id, result_id, component_code, category, amount, basis, display_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [randomUUID(), resultId, line.code, line.category, line.amount, line.basis ?? null, (index + 1) * 10],
        );
      }
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
      },
    });

    await client.query("COMMIT");
    return {
      employeeCount: totals.employeeCount,
      blockerCount,
      skipped,
      policyProblems: [],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
