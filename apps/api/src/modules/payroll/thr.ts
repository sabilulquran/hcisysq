/**
 * PAY-003 THR (Tunjangan Hari Raya) calculation, specification docs/domain/payroll-thr.md.
 *
 * Pure and deterministic like engine.ts: a resolved profile, policy and THR policy come in, one
 * employee's THR result goes out. No database, clock, request or vendor code (AGENTS.md section 4;
 * payroll-engine-purity.test.ts checks this module too).
 *
 * Permenaker 6/2016: one month of wages after twelve continuous months of service, and
 * months/12 of it after at least one month. "Wages" are basic salary plus fixed allowances; which
 * catalog components count is a flag on the component catalog (payroll_components.is_thr_wage),
 * passed in as wageComponents, never a list kept here.
 */

import {
  EMPTY_PERIOD_INPUTS,
  calculateEmployeePayroll,
  monthsOfService,
  type CompensationProfile,
  type ComponentCode,
  type EmployeePayrollResult,
  type PayrollBlocker,
  type PayrollLine,
  type PayrollPolicy,
  type Rupiah,
} from "./engine.js";

/** The versioned THR policy (policy key THR), DRAFT values loaded as a policy row. */
export type ThrPolicy = {
  /** Service at or beyond this many months earns one full month of wages. */
  fullServiceMonths: number;
  /** Below this many months there is no THR at all. */
  minimumServiceMonths: number;
  /** THR is paid at the latest this many days before the holiday. */
  paymentDeadlineDaysBeforeHoliday: number;
  /** A permanent employment that ended at most this many days before the holiday still earns THR. */
  terminationGraceDays: number;
  /** EMP-005 term categories the grace above applies to (PKWTT). */
  terminationGraceTermCategories: readonly string[];
  /** EMP-005 term categories that receive THR at all. */
  eligibleTermCategories: readonly string[];
};

export type ThrInput = {
  profile: CompensationProfile;
  /** The THR period's pay date: wages are read as they stand on it. */
  payDate: string;
  /** The holiday the THR is for: service is counted up to it. */
  holidayDate: string;
  policy: PayrollPolicy;
  thrPolicy: ThrPolicy;
  /** Catalog components flagged is_thr_wage. */
  wageComponents: readonly ComponentCode[];
  /** Optional authorised adjustment, positive or negative whole rupiah. */
  adjustment: Rupiah;
};

export type ThrEligibility =
  | { eligible: true; serviceMonths: number }
  | { eligible: false; serviceMonths: number; reason: "SERVICE_TOO_SHORT" };

/** Whole months of service at the holiday, and whether they reach the minimum. */
export function thrEligibility(serviceStartDate: string, holidayDate: string, thrPolicy: ThrPolicy): ThrEligibility {
  const serviceMonths = serviceStartDate > holidayDate ? 0 : monthsOfService(serviceStartDate, holidayDate);
  if (serviceMonths < thrPolicy.minimumServiceMonths) {
    return { eligible: false, serviceMonths, reason: "SERVICE_TOO_SHORT" };
  }
  return { eligible: true, serviceMonths };
}

/**
 * wage × months / fullServiceMonths, rounded up to a whole rupiah (DRAFT, like DIBAYAR). Integer
 * arithmetic throughout: wage × months is an exact integer well inside the safe range, and the
 * division is done as quotient and remainder, so no binary fraction can add or lose a rupiah.
 */
export function proportionalThr(wage: Rupiah, serviceMonths: number, fullServiceMonths: number): Rupiah {
  if (!Number.isSafeInteger(wage) || wage <= 0) return 0;
  if (serviceMonths >= fullServiceMonths) return wage;
  const numerator = wage * serviceMonths;
  const quotient = Math.floor(numerator / fullServiceMonths);
  return numerator - quotient * fullServiceMonths > 0 ? quotient + 1 : quotient;
}

/** Mapping problems the regular calculation already names; the rest of its blockers are about a month's pay. */
const CARRIED_BLOCKERS: ReadonlySet<PayrollBlocker["code"]> = new Set([
  "MKG_OUT_OF_SCALE",
  "EDUCATION_NOT_MAPPED",
  "UNIT_NOT_MAPPED",
  "WORK_PATTERN_NOT_MAPPED",
  "POSITION_NOT_MAPPED",
  "SPECIAL_QUALIFICATION_NEGATIVE",
  "INPUT_INVALID",
]);

export type ThrResult = EmployeePayrollResult & {
  /** One month of wages: the sum of the wage components. */
  monthlyWage: Rupiah;
  serviceMonths: number;
};

/** THR for one employee whose eligibility the caller has already established. */
export function calculateEmployeeThr(input: ThrInput): ThrResult {
  const { profile, payDate, holidayDate, policy, thrPolicy, wageComponents, adjustment } = input;
  const blockers: PayrollBlocker[] = [];
  const serviceMonths = serviceStartBefore(profile.serviceStartDate, holidayDate)
    ? monthsOfService(profile.serviceStartDate, holidayDate)
    : 0;

  if (profile.category === "HONORARIUM") {
    // Per-attendance pay has no monthly wage to take one month of; Permenaker 6/2016 averages the
    // last twelve months for it, which v1 does not do (DRAFT). Listing honorarium terms as eligible
    // therefore blocks rather than paying a guess.
    blockers.push({
      code: "THR_WAGE_BASIS_UNSUPPORTED",
      message: "Upah THR untuk pegawai honorer (dibayar per kehadiran/jam) belum diatur di v1.",
    });
    return finish({ profile, lines: [], blockers, monthlyWage: 0, serviceMonths });
  }

  // One month as the regular engine would pay it, with no period input: the wage is what the
  // profile and the policy say, not what a month's overtime or deductions made of it. The
  // adjustment travels along only so that a special-qualification shortfall it covers clears its
  // blocker the same way it does on a regular period.
  const month = calculateEmployeePayroll({
    profile,
    inputs: { ...EMPTY_PERIOD_INPUTS, adjustment },
    payDate,
    periodStart: payDate,
    periodEnd: payDate,
    policy,
  });
  for (const blocker of month.blockers) {
    if (CARRIED_BLOCKERS.has(blocker.code)) blockers.push(blocker);
  }

  const wageSet = new Set(wageComponents);
  const monthlyWage = month.lines
    .filter((line) => line.category === "EARNING" && wageSet.has(line.code))
    .reduce((total, line) => total + line.amount, 0);

  const amount = proportionalThr(monthlyWage, serviceMonths, thrPolicy.fullServiceMonths);
  const lines: PayrollLine[] = [];
  if (amount !== 0) {
    lines.push({
      code: "THR",
      category: "EARNING",
      amount,
      basis:
        serviceMonths >= thrPolicy.fullServiceMonths
          ? `upah ${monthlyWage}, masa kerja ${serviceMonths} bulan`
          : `upah ${monthlyWage} x ${serviceMonths}/${thrPolicy.fullServiceMonths}`,
    });
  }
  if (adjustment > 0) lines.push({ code: "ADJUST_EARN", category: "EARNING", amount: adjustment });
  if (adjustment < 0) lines.push({ code: "ADJUST_DEDUCT", category: "DEDUCTION", amount: -adjustment });

  return finish({ profile, lines, blockers, monthlyWage, serviceMonths });
}

function serviceStartBefore(serviceStartDate: string, holidayDate: string): boolean {
  return serviceStartDate <= holidayDate;
}

function finish(args: {
  profile: CompensationProfile;
  lines: PayrollLine[];
  blockers: PayrollBlocker[];
  monthlyWage: Rupiah;
  serviceMonths: number;
}): ThrResult {
  const { profile, lines, blockers, monthlyWage, serviceMonths } = args;
  const gross = lines.filter((line) => line.category === "EARNING").reduce((total, line) => total + line.amount, 0);
  const deductions = lines
    .filter((line) => line.category === "DEDUCTION")
    .reduce((total, line) => total + line.amount, 0);
  const net = gross - deductions;
  if (net < 0) blockers.push({ code: "NEGATIVE_NET", message: "Netto bernilai negatif." });
  if (net > 0 && (!profile.bankAccountNumber || !profile.bankAccountName)) {
    blockers.push({ code: "BANK_ACCOUNT_MISSING", message: "Rekening atau nama pemilik rekening belum terisi." });
  }
  return {
    employmentId: profile.employmentId,
    lines,
    gross,
    deductions,
    net,
    // The proportional rule replaces both pay factors: neither proration nor the early-service
    // rate applies to THR (specification payroll-thr.md T6).
    payable: net,
    employerCost: 0,
    payFactor: 1,
    payFactorReason: "none",
    bpjsBase: 0,
    extraFamilyMembers: 0,
    monthsOfService: serviceMonths,
    yearsOfService: Math.floor(serviceMonths / 12),
    blockers,
    monthlyWage,
    serviceMonths,
  };
}
