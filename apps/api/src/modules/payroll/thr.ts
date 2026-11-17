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
 *
 * Pasal 3 ayat (3), owner decision 2026-11-17 (T5, section 2.1): an honorarium worker has no
 * monthly wage to read from a profile, so one month of wages is the average of what was actually
 * paid in the months before the THR. The paid months are handed in by the caller; when they do
 * not cover every month the rule asks for, only a figure human capital typed (THR_AVERAGE_WAGE)
 * stands in, and without it the row is blocked. Nothing here estimates a missing month.
 */

import {
  EMPTY_PERIOD_INPUTS,
  calculateEmployeePayroll,
  monthsOfService,
  roundUpRupiah,
  type CompensationProfile,
  type ComponentCode,
  type EmployeePayrollResult,
  type PayrollBlocker,
  type PayrollLine,
  type PayrollPolicy,
  type Rupiah,
} from "./engine.js";

/** The versioned THR policy (policy key THR), loaded as a policy row. */
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
  /**
   * Earning components that count as wages received by an honorarium worker (section 2.1 H4).
   * Absent on a version that predates the 2026-11-17 decision.
   */
  averageWageComponents?: readonly string[] | undefined;
};

/** One approved monthly result of the employment inside the window. */
export type ThrPaidMonth = {
  /** YYYY-MM, the month of the salary period. */
  month: string;
  /** The pay factor of that result; 1 for honorarium pay. */
  payFactor: number;
  earnings: ReadonlyArray<{ code: string; amount: Rupiah }>;
};

/** What the caller knows about the wages paid to one honorarium employment (section 2.1). */
export type ThrAverageWageSource = {
  /** YYYY-MM months the rule asks for: the window, from the month of TMT on. */
  requiredMonths: readonly string[];
  /** YYYY-MM months the system holds an approved salary period for. */
  coveredMonths: readonly string[];
  /** This employment's approved results inside the window. */
  paid: readonly ThrPaidMonth[];
  /** THR_AVERAGE_WAGE typed for this employment on the THR period, or null. */
  hcInput: number | null;
};

export type ThrAverageWage = {
  /** Where the month of wages came from; NONE means the row is blocked. */
  source: "SYSTEM" | "HC_INPUT" | "NONE";
  /** First and last required month, YYYY-MM; null when no month is required. */
  windowStart: string | null;
  windowEnd: string | null;
  requiredMonths: number;
  /** Required months the system holds an approved salary period for. */
  coveredMonths: number;
  /** Covered months in which the employment was paid a counted wage. */
  monthsWithPay: number;
  /** Counted wages over the covered months. */
  systemTotal: Rupiah;
  /** systemTotal over every required month; null unless every one of them is covered. */
  systemAverage: Rupiah | null;
  /** systemTotal over the covered months only: a reference for the reviewer, never a basis. */
  partialAverage: Rupiah | null;
  /** The month of wages the THR was taken from; 0 when blocked. */
  monthlyWage: Rupiah;
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
  /**
   * Wages paid and the figure human capital typed. Read for an honorarium profile only; on a
   * salaried profile a typed figure is refused rather than ignored.
   */
  averageWage?: ThrAverageWageSource | undefined;
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

/** numerator / denominator rounded up to a whole number, as quotient and remainder. */
function divideRoundUp(numerator: number, denominator: number): number {
  const quotient = Math.floor(numerator / denominator);
  return numerator - quotient * denominator > 0 ? quotient + 1 : quotient;
}

/**
 * wage × months / fullServiceMonths, rounded up to a whole rupiah (DRAFT, like DIBAYAR). Integer
 * arithmetic throughout: wage × months is an exact integer well inside the safe range, and the
 * division is done as quotient and remainder, so no binary fraction can add or lose a rupiah.
 */
export function proportionalThr(wage: Rupiah, serviceMonths: number, fullServiceMonths: number): Rupiah {
  if (!Number.isSafeInteger(wage) || wage <= 0) return 0;
  if (serviceMonths >= fullServiceMonths) return wage;
  return divideRoundUp(wage * serviceMonths, fullServiceMonths);
}

/**
 * Section 2.1 H2: the months whose wages are averaged. The `windowLength` calendar months before
 * the month of the THR period, never earlier than the first WHOLE month of service: a TMT after
 * the first of a month leaves that month worked in part, and its smaller wage would otherwise be
 * divided as if a whole month had been worked, which understates the monthly wage every time (an
 * understated THR carries a 5% penalty, PP 36/2021 Pasal 62). The partial month is therefore left
 * out of the numerator and the divisor alike, so "bulan" means the same thing in both. A TMT on
 * the first of a month keeps that month, as before.
 *
 * Calendar arithmetic on the strings alone; months come back as YYYY-MM, oldest first.
 */
export function thrAverageWageMonths(thrPeriodMonth: string, serviceStartDate: string, windowLength: number): string[] {
  const period = /^(\d{4})-(\d{2})/.exec(thrPeriodMonth);
  const start = /^(\d{4})-(\d{2})-(\d{2})/.exec(serviceStartDate);
  if (!period || !start || !Number.isInteger(windowLength) || windowLength <= 0) return [];
  const periodIndex = Number(period[1]) * 12 + (Number(period[2]) - 1);
  const startIndex = Number(start[1]) * 12 + (Number(start[2]) - 1) + (Number(start[3]) > 1 ? 1 : 0);
  const months: string[] = [];
  for (let index = Math.max(periodIndex - windowLength, startIndex); index < periodIndex; index += 1) {
    months.push(`${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`);
  }
  return months;
}

/**
 * Section 2.1 H4-H6: the average monthly wage of an honorarium employment. Counted earnings of
 * the covered months, each through its month's pay factor, over every required month; rounded up
 * to a whole rupiah in integer arithmetic. A typed figure replaces it; a window the system does
 * not cover leaves no basis at all.
 */
export function averageMonthlyWage(source: ThrAverageWageSource, countedComponents: readonly string[]): ThrAverageWage {
  const required = [...new Set(source.requiredMonths)].sort();
  const covered = new Set(source.coveredMonths.filter((month) => required.includes(month)));
  const counted = new Set(countedComponents);
  const paidByMonth = new Map<string, number>();
  for (const result of source.paid) {
    if (!covered.has(result.month)) continue;
    const wages = result.earnings
      .filter((line) => counted.has(line.code))
      .reduce((total, line) => total + line.amount, 0);
    // The wage received, like the PPh21 gross: ROUNDUP after the factor, untouched without one.
    const received = result.payFactor === 1 ? wages : roundUpRupiah(wages * result.payFactor);
    paidByMonth.set(result.month, (paidByMonth.get(result.month) ?? 0) + received);
  }
  const systemTotal = [...paidByMonth.values()].reduce((total, amount) => total + amount, 0);
  const monthsWithPay = [...paidByMonth.values()].filter((amount) => amount > 0).length;
  const usable = Number.isSafeInteger(systemTotal) && systemTotal >= 0;
  const fullyCovered = required.length > 0 && covered.size === required.length && counted.size > 0;
  const systemAverage = fullyCovered && usable ? divideRoundUp(systemTotal, required.length) : null;
  const partialAverage = covered.size > 0 && usable ? divideRoundUp(systemTotal, covered.size) : null;

  const typed = source.hcInput;
  const typedValid = typed !== null && Number.isSafeInteger(typed) && typed > 0;
  return {
    source: typedValid ? "HC_INPUT" : systemAverage !== null ? "SYSTEM" : "NONE",
    windowStart: required[0] ?? null,
    windowEnd: required[required.length - 1] ?? null,
    requiredMonths: required.length,
    coveredMonths: covered.size,
    monthsWithPay,
    systemTotal,
    systemAverage,
    partialAverage,
    monthlyWage: typedValid ? typed : (systemAverage ?? 0),
  };
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
  /** One month of wages: the sum of the wage components, or the average wage of section 2.1. */
  monthlyWage: Rupiah;
  serviceMonths: number;
  /** Set for an honorarium profile: how its month of wages was arrived at. */
  averageWage?: ThrAverageWage;
};

/** THR for one employee whose eligibility the caller has already established. */
export function calculateEmployeeThr(input: ThrInput): ThrResult {
  const { profile, payDate, holidayDate, policy, thrPolicy, wageComponents, adjustment } = input;
  const blockers: PayrollBlocker[] = [];
  const serviceMonths = serviceStartBefore(profile.serviceStartDate, holidayDate)
    ? monthsOfService(profile.serviceStartDate, holidayDate)
    : 0;

  if (profile.category === "HONORARIUM") {
    // Per-attendance pay has no monthly wage to take one month of: Pasal 3 ayat (3) averages what
    // was actually paid instead (T5).
    return calculateHonorariumThr(input, serviceMonths);
  }

  if (input.averageWage && input.averageWage.hcInput !== null) {
    // Typed for someone whose wage is read from the profile: refused, never silently dropped.
    blockers.push({
      code: "INPUT_INVALID",
      message: "Input rata-rata upah THR hanya berlaku untuk honorer dan pekerja lepas; hapus input ini.",
    });
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
      // Always ends with "masa kerja N bulan": the THR slip prints it (payroll-thr.md T13).
      basis:
        serviceMonths >= thrPolicy.fullServiceMonths
          ? `upah ${monthlyWage}, masa kerja ${serviceMonths} bulan`
          : `upah ${monthlyWage} x ${serviceMonths}/${thrPolicy.fullServiceMonths}, masa kerja ${serviceMonths} bulan`,
    });
  }
  if (adjustment > 0) lines.push({ code: "ADJUST_EARN", category: "EARNING", amount: adjustment });
  if (adjustment < 0) lines.push({ code: "ADJUST_DEDUCT", category: "DEDUCTION", amount: -adjustment });

  return finish({ profile, lines, blockers, monthlyWage, serviceMonths });
}

/**
 * Pasal 3 ayat (3): THR on the average wage actually paid (section 2.1). The figure human capital
 * typed wins when present; otherwise the system's average, and only when every required month is
 * covered by an approved salary period. Anything less blocks the row.
 */
function calculateHonorariumThr(input: ThrInput, serviceMonths: number): ThrResult {
  const { profile, thrPolicy, wageComponents, adjustment } = input;
  const blockers: PayrollBlocker[] = [];
  const source: ThrAverageWageSource = input.averageWage ?? {
    requiredMonths: [],
    coveredMonths: [],
    paid: [],
    hcInput: null,
  };
  const ruleComponents = thrPolicy.averageWageComponents ?? [];
  // A month paid on a salary basis counts its THR wage components (H4). Without the rule in the
  // policy nothing is counted, so a version that predates the decision yields no system average.
  const counted = ruleComponents.length > 0 ? [...ruleComponents, ...wageComponents] : [];
  const averageWage = averageMonthlyWage(source, counted);

  if (source.hcInput !== null && averageWage.source !== "HC_INPUT") {
    blockers.push({
      code: "INPUT_INVALID",
      message: "Input rata-rata upah THR harus rupiah bulat lebih dari nol.",
    });
  } else if (averageWage.source === "SYSTEM" && averageWage.monthsWithPay === 0) {
    // Section 2.1 H5: the months are all there and none of them paid this person. The average is
    // arithmetically Rp0, but paying Rp0 to somebody the rule says is entitled is a statutory
    // non-payment, so it is never done quietly: either the wage was paid outside HCIS (human
    // capital types it) or the person does not belong in this period.
    blockers.push({
      code: "THR_AVERAGE_WAGE_NO_PAID_MONTH",
      message:
        `Sistem tidak menemukan upah yang dibayar pada ${averageWage.requiredMonths} bulan yang diminta, sehingga rata-ratanya nol; isi input rata-rata upah THR pegawai ini atau periksa apakah upahnya dibayar di luar HCIS.`,
    });
  } else if (averageWage.source === "NONE") {
    blockers.push({
      code: "THR_AVERAGE_WAGE_INCOMPLETE",
      message:
        ruleComponents.length === 0
          ? "Kebijakan THR yang berlaku belum memuat komponen rata-rata upah; isi input rata-rata upah THR pegawai ini atau buka versi kebijakan baru."
          : averageWage.requiredMonths === 0
            ? "Belum ada bulan penggajian dalam masa kerja pegawai ini sebelum bulan THR; isi input rata-rata upah THR pegawai ini."
            : `Rata-rata upah belum lengkap: sistem mencakup ${averageWage.coveredMonths} dari ${averageWage.requiredMonths} bulan yang diminta; isi input rata-rata upah THR pegawai ini.`,
    });
  }
  if (!Number.isInteger(adjustment)) {
    blockers.push({ code: "INPUT_INVALID", message: "Penyesuaian gaji harus rupiah bulat." });
  }

  // A blocked row pays nothing: no THR line is written on a basis nobody established.
  const monthlyWage = blockers.length > 0 ? 0 : averageWage.monthlyWage;
  const amount = proportionalThr(monthlyWage, serviceMonths, thrPolicy.fullServiceMonths);
  const lines: PayrollLine[] = [];
  if (amount !== 0) {
    const origin = averageWage.source === "HC_INPUT" ? "input HC" : `sistem, ${averageWage.requiredMonths} bulan`;
    lines.push({
      code: "THR",
      category: "EARNING",
      amount,
      // Ends with "masa kerja N bulan" like the salaried line: the THR slip prints it (T13).
      basis:
        serviceMonths >= thrPolicy.fullServiceMonths
          ? `rata-rata upah ${monthlyWage} (${origin}), masa kerja ${serviceMonths} bulan`
          : `rata-rata upah ${monthlyWage} (${origin}) x ${serviceMonths}/${thrPolicy.fullServiceMonths}, masa kerja ${serviceMonths} bulan`,
    });
  }
  if (adjustment > 0) lines.push({ code: "ADJUST_EARN", category: "EARNING", amount: adjustment });
  if (adjustment < 0) lines.push({ code: "ADJUST_DEDUCT", category: "DEDUCTION", amount: -adjustment });

  return {
    ...finish({ profile, lines, blockers, monthlyWage, serviceMonths }),
    averageWage: { ...averageWage, monthlyWage },
  };
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
