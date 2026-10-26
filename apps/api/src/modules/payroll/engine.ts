/**
 * PAY-003 v1 payroll calculation engine.
 *
 * Pure, deterministic functions over a resolved input snapshot and a resolved
 * policy version. The module must not import HTTP, database, storage, queue or
 * vendor SDK code (AGENTS.md section 4); payroll-engine-purity.test.ts enforces it.
 *
 * Specification: docs/domain/payroll-calculation-v1.md
 * Decision: docs/architecture/adr/0003-payroll-calculation-in-hcis.md
 */

export type Rupiah = number;

export const EARNING_CODES = [
  "BASIC",
  "TEACH_OVER",
  "PERF",
  "SPOUSE",
  "CHILD",
  "FUNC",
  "POS",
  "SPECIAL_QUAL",
  "BPJS_KES_ALLOW",
  "OVERTIME",
  "ARREARS",
  "PJ_MEDIA",
  "TRANSPORT",
  "TEACH_FEE",
  "OTHER_INCOME",
  "ADJUST_EARN",
] as const;

export const DEDUCTION_CODES = [
  "LOAN",
  "BPJS_KES",
  "BPJS_KES_EXTRA",
  "CHILD_EDU",
  "TEACH_SHORT",
  "ADJUST_DEDUCT",
] as const;

export const EMPLOYER_COST_CODES = ["PPH21_EMPLOYER"] as const;

export type ComponentCode =
  | (typeof EARNING_CODES)[number]
  | (typeof DEDUCTION_CODES)[number]
  | (typeof EMPLOYER_COST_CODES)[number];

export type ComponentCategory = "EARNING" | "DEDUCTION" | "EMPLOYER_COST";

export type EducationLevel = "SD" | "SMP" | "SLTA" | "D1_D2" | "D3_D4" | "S1" | "S2_S3";

export type EmploymentCategory = "PERMANENT" | "PROBATION" | "CONTRACT";

export type BpjsSegment = "PPU_YAYASAN" | "PBI" | "MANDIRI" | "BELUM_TERDAFTAR";

export type PayrollLine = {
  code: ComponentCode;
  category: ComponentCategory;
  amount: Rupiah;
  /**
   * Set when the amount is derived from something a reviewer needs to see. It
   * can carry a per-person figure, so it belongs on the slip and the review
   * screen but never in a log line or an audit payload (specification 8).
   */
  basis?: string;
};

export type PayrollBlockerCode =
  | "MKG_OUT_OF_SCALE"
  | "EDUCATION_NOT_MAPPED"
  | "SERVICE_NOT_STARTED"
  | "SERVICE_ALREADY_ENDED"
  | "UNIT_NOT_MAPPED"
  | "WORK_PATTERN_NOT_MAPPED"
  | "POSITION_NOT_MAPPED"
  | "INPUT_INVALID"
  | "SPECIAL_QUALIFICATION_NEGATIVE"
  | "PRORATION_FACTOR_INVALID"
  | "LEAVING_WITHOUT_PRORATION"
  | "NEGATIVE_NET"
  | "NEGATIVE_PAYABLE"
  | "LOAN_EXCEEDS_BALANCE"
  | "BANK_ACCOUNT_MISSING";

export type PayrollBlocker = { code: PayrollBlockerCode; message: string };

export type PayrollWarning = {
  code: "COMPONENT_VARIANCE" | "LARGE_MANUAL_INPUT";
  message: string;
};

/**
 * Versioned policy, already resolved for the period's pay date. The engine never
 * selects a version itself: callers resolve effective_from/effective_to first.
 * No statutory value is a constant here (specification section 10 item 9).
 */
export type PayrollPolicy = {
  /** Amount by zero-based MKG index; the last index is the highest MKG in the table. */
  salaryScale: Readonly<Partial<Record<EducationLevel, readonly Rupiah[]>>>;
  /** Multiplier per organization unit reference, e.g. Taman Tahfizh 0.5. */
  unitBasicMultipliers: Readonly<Record<string, number>>;
  /**
   * Every unit the policy knows, multiplier or not. A unit outside this list is
   * unmapped and blocks the period rather than falling back to 1 (section 5.4).
   */
  knownUnitRefs: readonly string[];
  /** Multiplier per work pattern, e.g. Half Day 0.6, Half Day II 0.65. */
  workPatternBasicMultipliers: Readonly<Record<string, number>>;
  teaching: {
    monthlyHourLimit: number;
    overRatePerHour: Rupiah;
    shortRatePerHour: Rupiah;
    weeksPerMonth: number;
  };
  performance: {
    defaultBase: Rupiah;
    /** Base per structural position reference, e.g. Kepala General Affair 150000. */
    baseByPosition: Readonly<Record<string, Rupiah>>;
    annualShare: number;
    monthlyShare: number;
    /**
     * Rates for someone below a year of service who has no appraisal yet
     * (section 10 item 3). Applied only when the profile carries neither rate.
     */
    unratedBelowOneYear: { annualRate: number; monthlyRate: number };
  };
  family: { spouseRate: number; childRate: number };
  functionalAllowance: {
    byPosition: Readonly<Record<string, Rupiah>>;
    concurrentStructuralFactor: number;
    excludedUnits: readonly string[];
    /** Positions the policy deliberately pays no functional allowance for. */
    positionsWithoutAllowance: readonly string[];
  };
  positionalAllowance: {
    byPosition: Readonly<Record<string, Rupiah>>;
    unitMultipliers: Readonly<Record<string, number>>;
    /** Positions the policy deliberately pays no positional allowance for. */
    positionsWithoutAllowance: readonly string[];
  };
  overtime: { monthlyHourDivisor: number };
  bpjsKesehatan: {
    contributionRate: number;
    extraFamilyRate: number;
    /** Regional minimum wage for the policy year. */
    floor: Rupiah;
    ceiling: Rupiah;
    /** Dependants already covered by the base contribution: spouse plus this many children. */
    coveredChildren: number;
    /** Component codes that count as a fixed allowance in the contribution base. */
    fixedAllowanceComponents: readonly ComponentCode[];
  };
  contract: { transportPerAttendance: Rupiah; teachingFeePerHour: Rupiah };
  earlyService: { months: number; netRate: number };
};

export type CompensationProfile = {
  employmentId: string;
  category: EmploymentCategory;
  education: EducationLevel | null;
  /** Start of service (TMT), ISO date in Asia/Jakarta. */
  serviceStartDate: string;
  /** End of service when the employment ends, ISO date in Asia/Jakarta. */
  serviceEndDate: string | null;
  spouseCount: number;
  childCount: number;
  /** Registered dependants, used to derive extra BPJS family members. */
  registeredDependants: number;
  /** Key into workPatternBasicMultipliers; null means full time, multiplier 1. */
  workPattern: string | null;
  unitRef: string | null;
  /** Null when the employee is not subject to the teaching-hour rule. */
  teachingHoursPerWeek: number | null;
  functionalPositionRef: string | null;
  structuralPositionRef: string | null;
  /** Target total for the special-qualification top-up; null when not applicable. */
  specialQualificationTarget: Rupiah | null;
  annualPerformanceRate: number | null;
  monthlyPerformanceRate: number | null;
  bpjs: {
    segment: BpjsSegment;
    activeFrom: string | null;
    /** Overrides the derived count; requires a reason upstream. */
    extraFamilyMembersOverride: number | null;
  };
  bankAccountNumber: string | null;
  bankAccountName: string | null;
};

export type PeriodInputs = {
  /** Approved overtime hours resolved from ATT-010 within the cutoff window. */
  overtimeHours: number;
  /** Attendance days that earn PKWT transport within the cutoff window. */
  contractAttendanceDays: number;
  contractTeachingHours: number;
  childEducationDeduction: Rupiah;
  loanDeduction: Rupiah;
  /** Remaining loan principal before this period's deduction. */
  loanOutstanding: Rupiah;
  arrears: Rupiah;
  pjMediaIncentive: Rupiah;
  otherIncome: Rupiah;
  /** Positive adds to pay, negative deducts. Requires a reason upstream. */
  adjustment: Rupiah;
  /**
   * Proration factor for joining or leaving mid-period, 0 < f <= 1. When set it
   * replaces the early-service rate; the two never compound (section 5.1).
   */
  prorationFactor: number | null;
  /** The employee is paid in full although service ends inside the period. */
  fullPayDespiteLeaving: boolean;
  /** Overrides the profile for this period only. */
  teachingHoursPerWeekOverride: number | null;
  annualPerformanceRateOverride: number | null;
  monthlyPerformanceRateOverride: number | null;
};

export type EmployeePayrollInput = {
  profile: CompensationProfile;
  inputs: PeriodInputs;
  /** Pay date of the period, ISO date in Asia/Jakarta. */
  payDate: string;
  /** First and last day of the period, ISO dates in Asia/Jakarta. */
  periodStart: string;
  periodEnd: string;
  policy: PayrollPolicy;
};

export type EmployeePayrollResult = {
  employmentId: string;
  lines: PayrollLine[];
  gross: Rupiah;
  deductions: Rupiah;
  net: Rupiah;
  payable: Rupiah;
  employerCost: Rupiah;
  /** The factor applied to the net amount: proration, early service, or 1. */
  payFactor: number;
  payFactorReason: "proration" | "early_service" | "none";
  bpjsBase: Rupiah;
  extraFamilyMembers: number;
  monthsOfService: number;
  yearsOfService: number;
  blockers: PayrollBlocker[];
};

export const EMPTY_PERIOD_INPUTS: Readonly<PeriodInputs> = Object.freeze({
  overtimeHours: 0,
  contractAttendanceDays: 0,
  contractTeachingHours: 0,
  childEducationDeduction: 0,
  loanDeduction: 0,
  loanOutstanding: 0,
  arrears: 0,
  pjMediaIncentive: 0,
  otherIncome: 0,
  adjustment: 0,
  prorationFactor: null,
  fullPayDespiteLeaving: false,
  teachingHoursPerWeekOverride: null,
  annualPerformanceRateOverride: null,
  monthlyPerformanceRateOverride: null,
});

/**
 * Binary floating point turns 0.07 * 100000 * 0.4 into 2800.0000000000005, and
 * rounding that up would invent a rupiah the spreadsheet never charged. Excel
 * keeps 15 significant digits before rounding; so do we, which is what the
 * parallel-run gate compares against (specification section 9.2).
 */
function clean(value: number): number {
  return Number.isFinite(value) ? Number(value.toPrecision(15)) : value;
}

/** Excel ROUNDUP with no digits: away from zero to a whole rupiah. */
export function roundUpRupiah(value: number): Rupiah {
  const exact = clean(value);
  return exact < 0 ? -Math.ceil(Math.abs(exact)) : Math.ceil(exact);
}

/** Excel ROUND with no digits: half away from zero. */
export function roundRupiah(value: number): Rupiah {
  const exact = clean(value);
  return exact < 0 ? -Math.round(Math.abs(exact)) : Math.round(exact);
}

function parseJakartaDate(iso: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * Whole months of service from TMT to the pay date, both read as Asia/Jakarta
 * calendar dates. A pay date before TMT yields 0, never a negative term.
 */
export function monthsOfService(serviceStartDate: string, payDate: string): number {
  const start = parseJakartaDate(serviceStartDate);
  const end = parseJakartaDate(payDate);
  if (!start || !end) return 0;
  let months = (end.year - start.year) * 12 + (end.month - start.month);
  if (end.day < start.day) months -= 1;
  return months > 0 ? months : 0;
}

/** MKG: whole years of service at the pay date (specification section 5.1). */
export function yearsOfService(serviceStartDate: string, payDate: string): number {
  return Math.floor(monthsOfService(serviceStartDate, payDate) / 12);
}

/**
 * Extra BPJS family members, derived rather than typed: dependants beyond the
 * spouse and the children the base contribution already covers (section 3.3).
 */
export function deriveExtraFamilyMembers(
  profile: CompensationProfile,
  policy: PayrollPolicy,
): number {
  if (profile.bpjs.extraFamilyMembersOverride !== null) {
    return Math.max(0, profile.bpjs.extraFamilyMembersOverride);
  }
  const covered = profile.spouseCount + Math.min(profile.childCount, policy.bpjsKesehatan.coveredChildren);
  return Math.max(0, profile.registeredDependants - covered);
}

function basicMultiplier(profile: CompensationProfile, policy: PayrollPolicy): number {
  const unitMultiplier = profile.unitRef ? policy.unitBasicMultipliers[profile.unitRef] : undefined;
  const patternMultiplier = profile.workPattern
    ? policy.workPatternBasicMultipliers[profile.workPattern]
    : undefined;
  return (unitMultiplier ?? 1) * (patternMultiplier ?? 1);
}

export type BasicSalaryResolution =
  | { ok: true; amount: Rupiah; scaleAmount: Rupiah; multiplier: number }
  | { ok: false; blocker: PayrollBlocker };

export function resolveBasicSalary(
  profile: CompensationProfile,
  policy: PayrollPolicy,
  payDate: string,
): BasicSalaryResolution {
  if (!profile.education) {
    return {
      ok: false,
      blocker: {
        code: "EDUCATION_NOT_MAPPED",
        message: "Pendidikan terakhir belum terisi pada profil kompensasi.",
      },
    };
  }
  const scale = policy.salaryScale[profile.education];
  if (!scale || scale.length === 0) {
    return {
      ok: false,
      blocker: {
        code: "EDUCATION_NOT_MAPPED",
        message: `Skala gaji untuk pendidikan ${profile.education} tidak ada pada kebijakan periode ini.`,
      },
    };
  }
  const mkg = yearsOfService(profile.serviceStartDate, payDate);
  const scaleAmount = scale[mkg];
  if (scaleAmount === undefined) {
    return {
      ok: false,
      blocker: {
        code: "MKG_OUT_OF_SCALE",
        message: `MKG ${mkg} berada di luar tabel skala gaji (maksimum ${scale.length - 1}).`,
      },
    };
  }
  const multiplier = basicMultiplier(profile, policy);
  return { ok: true, amount: roundUpRupiah(scaleAmount * multiplier), scaleAmount, multiplier };
}

function performanceAllowance(
  profile: CompensationProfile,
  inputs: PeriodInputs,
  policy: PayrollPolicy,
  months: number,
): Rupiah {
  let annualRate = inputs.annualPerformanceRateOverride ?? profile.annualPerformanceRate;
  let monthlyRate = inputs.monthlyPerformanceRateOverride ?? profile.monthlyPerformanceRate;
  if (annualRate === null && monthlyRate === null) {
    // Below a year of service there is no annual appraisal cycle yet, so the
    // policy default applies rather than a silent zero (section 10 item 3).
    if (months >= 12) return 0;
    annualRate = policy.performance.unratedBelowOneYear.annualRate;
    monthlyRate = policy.performance.unratedBelowOneYear.monthlyRate;
  }
  const base =
    (profile.structuralPositionRef
      ? policy.performance.baseByPosition[profile.structuralPositionRef]
      : undefined) ?? policy.performance.defaultBase;
  const annual = (annualRate ?? 0) * base * policy.performance.annualShare;
  const monthly = (monthlyRate ?? 0) * base * policy.performance.monthlyShare;
  return roundUpRupiah(annual + monthly);
}

/** Null when the employee is not subject to the teaching-hour rule at all. */
function teachingHoursPerMonth(
  profile: CompensationProfile,
  inputs: PeriodInputs,
  policy: PayrollPolicy,
): number | null {
  const perWeek = inputs.teachingHoursPerWeekOverride ?? profile.teachingHoursPerWeek;
  if (perWeek === null || perWeek <= 0) return null;
  return perWeek * policy.teaching.weeksPerMonth;
}

type AllowanceResolution = { amount: Rupiah; blocker?: PayrollBlocker };

function functionalAllowance(
  profile: CompensationProfile,
  policy: PayrollPolicy,
): AllowanceResolution {
  const ref = profile.functionalPositionRef;
  if (!ref) return { amount: 0 };
  if (profile.unitRef && policy.functionalAllowance.excludedUnits.includes(profile.unitRef)) {
    return { amount: 0 };
  }
  const base = policy.functionalAllowance.byPosition[ref];
  if (base === undefined) {
    if (policy.functionalAllowance.positionsWithoutAllowance.includes(ref)) return { amount: 0 };
    return {
      amount: 0,
      blocker: {
        code: "POSITION_NOT_MAPPED",
        message: `Jabatan fungsional ${ref} tidak terpetakan ke tabel tunjangan.`,
      },
    };
  }
  const factor = profile.structuralPositionRef ? policy.functionalAllowance.concurrentStructuralFactor : 1;
  return { amount: roundUpRupiah(base * factor) };
}

function positionalAllowance(
  profile: CompensationProfile,
  policy: PayrollPolicy,
): AllowanceResolution {
  const ref = profile.structuralPositionRef;
  if (!ref) return { amount: 0 };
  const base = policy.positionalAllowance.byPosition[ref];
  if (base === undefined) {
    if (policy.positionalAllowance.positionsWithoutAllowance.includes(ref)) return { amount: 0 };
    return {
      amount: 0,
      blocker: {
        code: "POSITION_NOT_MAPPED",
        message: `Jabatan struktural ${ref} tidak terpetakan ke tabel tunjangan.`,
      },
    };
  }
  const multiplier = profile.unitRef
    ? policy.positionalAllowance.unitMultipliers[profile.unitRef] ?? 1
    : 1;
  return { amount: roundUpRupiah(base * multiplier) };
}

/**
 * A unit or work pattern the policy does not know must block the period: falling
 * back to a multiplier of 1 would quietly overpay someone on a half-day pattern
 * or in a half-rate unit (specification section 5.4).
 */
function mappingBlockers(profile: CompensationProfile, policy: PayrollPolicy): PayrollBlocker[] {
  const blockers: PayrollBlocker[] = [];
  if (profile.unitRef && !policy.knownUnitRefs.includes(profile.unitRef)) {
    blockers.push({
      code: "UNIT_NOT_MAPPED",
      message: `Unit ${profile.unitRef} tidak terpetakan ke kebijakan payroll.`,
    });
  }
  if (profile.workPattern && policy.workPatternBasicMultipliers[profile.workPattern] === undefined) {
    blockers.push({
      code: "WORK_PATTERN_NOT_MAPPED",
      message: `Pola kerja ${profile.workPattern} tidak terpetakan ke kebijakan payroll.`,
    });
  }
  return blockers;
}

/**
 * BPJS Kesehatan contribution base: basic salary plus the components the policy
 * marks as fixed allowances, clamped to the regional minimum wage and the ceiling.
 */
export function bpjsContributionBase(lines: readonly PayrollLine[], policy: PayrollPolicy): Rupiah {
  // BASIC is part of the base by regulation, whether or not a policy row happens
  // to list it among the fixed allowances (specification section 5.1).
  const marked = new Set<ComponentCode>([...policy.bpjsKesehatan.fixedAllowanceComponents, "BASIC"]);
  const raw = lines
    .filter((line) => line.category === "EARNING" && marked.has(line.code))
    .reduce((total, line) => total + line.amount, 0);
  if (raw < policy.bpjsKesehatan.floor) return policy.bpjsKesehatan.floor;
  if (raw > policy.bpjsKesehatan.ceiling) return policy.bpjsKesehatan.ceiling;
  return raw;
}

function bpjsIsActive(profile: CompensationProfile, payDate: string): boolean {
  if (profile.bpjs.segment !== "PPU_YAYASAN") return false;
  if (!profile.bpjs.activeFrom) return false;
  return profile.bpjs.activeFrom <= payDate;
}

/**
 * A zero line is dropped, because a slip should not list what was not paid. The
 * teaching components are the exception: when the hour rule applies, a zero is a
 * real result and must stay visible, so callers pass renderZero (section 5.1).
 */
function pushLine(lines: PayrollLine[], line: PayrollLine, renderZero = false): void {
  if (line.amount !== 0 || renderZero) lines.push(line);
}

function computePermanent(input: EmployeePayrollInput): EmployeePayrollResult {
  const { profile, inputs, policy, payDate } = input;
  const lines: PayrollLine[] = [];
  const blockers: PayrollBlocker[] = [];

  blockers.push(...mappingBlockers(profile, policy));

  const basic = resolveBasicSalary(profile, policy, payDate);
  if (!basic.ok) blockers.push(basic.blocker);
  const basicAmount = basic.ok ? basic.amount : 0;
  pushLine(lines, {
    code: "BASIC",
    category: "EARNING",
    amount: basicAmount,
    ...(basic.ok && basic.multiplier !== 1
      ? { basis: `skala ${basic.scaleAmount} x ${basic.multiplier}` }
      : {}),
  });

  const monthlyHours = teachingHoursPerMonth(profile, inputs, policy);
  let teachOver = 0;
  let teachShort = 0;
  if (monthlyHours !== null) {
    const limit = policy.teaching.monthlyHourLimit;
    teachOver = Math.max(0, monthlyHours - limit) * policy.teaching.overRatePerHour;
    teachShort = Math.max(0, limit - monthlyHours) * policy.teaching.shortRatePerHour;
  }
  pushLine(
    lines,
    { code: "TEACH_OVER", category: "EARNING", amount: roundUpRupiah(teachOver) },
    monthlyHours !== null,
  );

  pushLine(lines, {
    code: "PERF",
    category: "EARNING",
    amount: performanceAllowance(profile, inputs, policy, monthsOfService(profile.serviceStartDate, payDate)),
  });
  pushLine(lines, {
    code: "SPOUSE",
    category: "EARNING",
    amount: roundUpRupiah(basicAmount * profile.spouseCount * policy.family.spouseRate),
  });
  pushLine(lines, {
    code: "CHILD",
    category: "EARNING",
    amount: roundUpRupiah(basicAmount * profile.childCount * policy.family.childRate),
  });
  const functional = functionalAllowance(profile, policy);
  if (functional.blocker) blockers.push(functional.blocker);
  pushLine(lines, { code: "FUNC", category: "EARNING", amount: functional.amount });

  const positional = positionalAllowance(profile, policy);
  if (positional.blocker) blockers.push(positional.blocker);
  pushLine(lines, { code: "POS", category: "EARNING", amount: positional.amount });

  if (profile.specialQualificationTarget !== null) {
    const covered = lines
      .filter((line) => line.category === "EARNING")
      .reduce((total, line) => total + line.amount, 0);
    const topUp = profile.specialQualificationTarget - covered;
    // D1: the shortfall becomes an explicit salary adjustment. A positive
    // adjustment, or one too small to absorb it, leaves the employee overpaid,
    // so only a deduction that covers the whole shortfall clears the blocker.
    const absorbed = inputs.adjustment < 0 && Math.abs(inputs.adjustment) >= Math.abs(topUp);
    if (topUp < 0 && !absorbed) {
      blockers.push({
        code: "SPECIAL_QUALIFICATION_NEGATIVE",
        message:
          "Target kualifikasi khusus lebih rendah dari komponen yang sudah dihitung; tetapkan penyesuaian gaji sebesar selisihnya dengan alasan.",
      });
    }
    pushLine(lines, {
      code: "SPECIAL_QUAL",
      category: "EARNING",
      amount: Math.max(0, roundUpRupiah(topUp)),
      basis: `target ${profile.specialQualificationTarget}`,
    });
  }

  pushLine(lines, {
    code: "OVERTIME",
    category: "EARNING",
    amount: roundUpRupiah((basicAmount / policy.overtime.monthlyHourDivisor) * inputs.overtimeHours),
    ...(inputs.overtimeHours > 0 ? { basis: `${inputs.overtimeHours} jam` } : {}),
  });

  const bpjsActive = bpjsIsActive(profile, payDate);
  const extraFamilyMembers = deriveExtraFamilyMembers(profile, policy);
  const bpjsBase = bpjsActive ? bpjsContributionBase(lines, policy) : 0;
  const bpjsContribution = bpjsActive
    ? roundRupiah(bpjsBase * policy.bpjsKesehatan.contributionRate)
    : 0;
  const bpjsExtra = bpjsActive
    ? roundRupiah(bpjsBase * policy.bpjsKesehatan.extraFamilyRate * extraFamilyMembers)
    : 0;

  pushLine(lines, { code: "BPJS_KES_ALLOW", category: "EARNING", amount: bpjsContribution });
  pushLine(lines, { code: "ARREARS", category: "EARNING", amount: inputs.arrears });
  pushLine(lines, { code: "PJ_MEDIA", category: "EARNING", amount: inputs.pjMediaIncentive });
  pushLine(lines, { code: "OTHER_INCOME", category: "EARNING", amount: inputs.otherIncome });
  if (inputs.adjustment > 0) {
    pushLine(lines, { code: "ADJUST_EARN", category: "EARNING", amount: inputs.adjustment });
  }

  pushLine(lines, { code: "LOAN", category: "DEDUCTION", amount: inputs.loanDeduction });
  pushLine(lines, { code: "BPJS_KES", category: "DEDUCTION", amount: bpjsContribution });
  pushLine(lines, { code: "BPJS_KES_EXTRA", category: "DEDUCTION", amount: bpjsExtra });
  pushLine(lines, { code: "CHILD_EDU", category: "DEDUCTION", amount: inputs.childEducationDeduction });
  pushLine(
    lines,
    { code: "TEACH_SHORT", category: "DEDUCTION", amount: roundUpRupiah(teachShort) },
    monthlyHours !== null,
  );
  if (inputs.adjustment < 0) {
    pushLine(lines, { code: "ADJUST_DEDUCT", category: "DEDUCTION", amount: -inputs.adjustment });
  }

  return finalize({ input, lines, blockers, bpjsBase, extraFamilyMembers, payFactorApplies: true });
}

function computeContract(input: EmployeePayrollInput): EmployeePayrollResult {
  const { inputs, policy } = input;
  const lines: PayrollLine[] = [];

  pushLine(lines, {
    code: "TRANSPORT",
    category: "EARNING",
    amount: roundUpRupiah(inputs.contractAttendanceDays * policy.contract.transportPerAttendance),
    ...(inputs.contractAttendanceDays > 0 ? { basis: `${inputs.contractAttendanceDays} kehadiran` } : {}),
  });
  pushLine(lines, {
    code: "TEACH_FEE",
    category: "EARNING",
    amount: roundUpRupiah(inputs.contractTeachingHours * policy.contract.teachingFeePerHour),
    ...(inputs.contractTeachingHours > 0 ? { basis: `${inputs.contractTeachingHours} jam` } : {}),
  });
  pushLine(lines, { code: "OTHER_INCOME", category: "EARNING", amount: inputs.otherIncome });
  pushLine(lines, { code: "PJ_MEDIA", category: "EARNING", amount: inputs.pjMediaIncentive });
  if (inputs.adjustment > 0) {
    pushLine(lines, { code: "ADJUST_EARN", category: "EARNING", amount: inputs.adjustment });
  }

  pushLine(lines, { code: "LOAN", category: "DEDUCTION", amount: inputs.loanDeduction });
  pushLine(lines, { code: "CHILD_EDU", category: "DEDUCTION", amount: inputs.childEducationDeduction });
  if (inputs.adjustment < 0) {
    pushLine(lines, { code: "ADJUST_DEDUCT", category: "DEDUCTION", amount: -inputs.adjustment });
  }

  // PKWT pay already follows real attendance and real teaching hours, so neither
  // the early-service rate nor proration may cut it a second time (section 5.2).
  return finalize({
    input,
    lines,
    blockers: [],
    bpjsBase: 0,
    extraFamilyMembers: 0,
    payFactorApplies: false,
  });
}

/**
 * Proration and the early-service rate are mutually exclusive: proration replaces
 * it rather than compounding with it (specification section 5.1). Neither applies
 * to a PKWT employee, whose pay already follows real attendance and real teaching
 * hours, so payFactorApplies turns both off at once (section 5.2).
 */
function resolvePayFactor(
  input: EmployeePayrollInput,
  months: number,
  payFactorApplies: boolean,
): { factor: number; reason: EmployeePayrollResult["payFactorReason"] } {
  const { inputs, policy } = input;
  if (!payFactorApplies) return { factor: 1, reason: "none" };
  if (inputs.prorationFactor !== null) {
    return { factor: inputs.prorationFactor, reason: "proration" };
  }
  if (months < policy.earlyService.months) {
    return { factor: policy.earlyService.netRate, reason: "early_service" };
  }
  return { factor: 1, reason: "none" };
}

function finalize(args: {
  input: EmployeePayrollInput;
  lines: PayrollLine[];
  blockers: PayrollBlocker[];
  bpjsBase: Rupiah;
  extraFamilyMembers: number;
  payFactorApplies: boolean;
}): EmployeePayrollResult {
  const { input, lines, blockers, bpjsBase, extraFamilyMembers, payFactorApplies } = args;
  const { profile, inputs, payDate, periodStart, periodEnd } = input;

  const gross = lines
    .filter((line) => line.category === "EARNING")
    .reduce((total, line) => total + line.amount, 0);
  const deductions = lines
    .filter((line) => line.category === "DEDUCTION")
    .reduce((total, line) => total + line.amount, 0);
  const employerCost = lines
    .filter((line) => line.category === "EMPLOYER_COST")
    .reduce((total, line) => total + line.amount, 0);
  const net = gross - deductions;

  const months = monthsOfService(profile.serviceStartDate, payDate);
  const { factor, reason } = resolvePayFactor(input, months, payFactorApplies);
  const payable = factor === 1 ? net : roundUpRupiah(net * factor);

  for (const [name, value] of [
    ["jam lembur", inputs.overtimeHours],
    ["kehadiran PKWT", inputs.contractAttendanceDays],
    ["jam mengajar PKWT", inputs.contractTeachingHours],
    ["potongan pendidikan anak", inputs.childEducationDeduction],
    ["potongan kasbon", inputs.loanDeduction],
    ["sisa kasbon", inputs.loanOutstanding],
    ["rapel", inputs.arrears],
    ["insentif Pj. Media", inputs.pjMediaIncentive],
    ["pemasukan lain", inputs.otherIncome],
  ] as const) {
    if (value < 0 || !Number.isFinite(value)) {
      blockers.push({ code: "INPUT_INVALID", message: `Input ${name} bernilai tidak sah (${value}).` });
    }
  }
  if (!Number.isInteger(inputs.adjustment)) {
    blockers.push({ code: "INPUT_INVALID", message: "Penyesuaian gaji harus rupiah bulat." });
  }
  if (profile.serviceEndDate !== null && profile.serviceEndDate < periodStart) {
    blockers.push({
      code: "SERVICE_ALREADY_ENDED",
      message: "Masa kerja berakhir sebelum periode dimulai; pegawai tidak boleh masuk periode ini.",
    });
  }
  if (profile.serviceStartDate > payDate) {
    blockers.push({
      code: "SERVICE_NOT_STARTED",
      message: "TMT berada setelah tanggal gajian; pegawai belum mulai bekerja pada periode ini.",
    });
  }
  if (inputs.prorationFactor !== null && !(inputs.prorationFactor > 0 && inputs.prorationFactor <= 1)) {
    blockers.push({
      code: "PRORATION_FACTOR_INVALID",
      message: "Faktor prorata harus berada pada rentang 0 < f <= 1.",
    });
  }
  const leavesInsidePeriod =
    profile.serviceEndDate !== null &&
    profile.serviceEndDate >= periodStart &&
    profile.serviceEndDate < periodEnd;
  if (leavesInsidePeriod && inputs.prorationFactor === null && !inputs.fullPayDespiteLeaving) {
    blockers.push({
      code: "LEAVING_WITHOUT_PRORATION",
      message:
        "Pegawai berhenti di tengah periode tanpa faktor prorata; tetapkan prorata atau nyatakan dibayar penuh.",
    });
  }
  if (inputs.loanDeduction > inputs.loanOutstanding) {
    blockers.push({ code: "LOAN_EXCEEDS_BALANCE", message: "Potongan kasbon melebihi sisa pinjaman." });
  }
  if (net < 0) {
    blockers.push({ code: "NEGATIVE_NET", message: "Netto bernilai negatif." });
  }
  if (payable < 0) {
    blockers.push({ code: "NEGATIVE_PAYABLE", message: "Nilai dibayar bernilai negatif." });
  }
  if (payable > 0 && (!profile.bankAccountNumber || !profile.bankAccountName)) {
    blockers.push({
      code: "BANK_ACCOUNT_MISSING",
      message: "Rekening atau nama pemilik rekening belum terisi.",
    });
  }

  return {
    employmentId: profile.employmentId,
    lines,
    gross,
    deductions,
    net,
    payable,
    employerCost,
    payFactor: factor,
    payFactorReason: reason,
    bpjsBase,
    extraFamilyMembers,
    monthsOfService: months,
    yearsOfService: Math.floor(months / 12),
    blockers,
  };
}

/** Calculates one employee's payroll for one period. */
export function calculateEmployeePayroll(input: EmployeePayrollInput): EmployeePayrollResult {
  return input.profile.category === "CONTRACT" ? computeContract(input) : computePermanent(input);
}

export type PeriodTotals = {
  employeeCount: number;
  gross: Rupiah;
  deductions: Rupiah;
  net: Rupiah;
  payable: Rupiah;
  employerCost: Rupiah;
  blockerCount: number;
};

/** Aggregate totals only: no per-person amount belongs in an audit payload (section 8). */
export function summarizePeriod(results: readonly EmployeePayrollResult[]): PeriodTotals {
  return results.reduce<PeriodTotals>(
    (totals, result) => ({
      employeeCount: totals.employeeCount + 1,
      gross: totals.gross + result.gross,
      deductions: totals.deductions + result.deductions,
      net: totals.net + result.net,
      payable: totals.payable + result.payable,
      employerCost: totals.employerCost + result.employerCost,
      blockerCount: totals.blockerCount + result.blockers.length,
    }),
    { employeeCount: 0, gross: 0, deductions: 0, net: 0, payable: 0, employerCost: 0, blockerCount: 0 },
  );
}

export type VarianceThreshold = { relative: number; absolute: Rupiah; manualInput: Rupiah };

/**
 * Component variance against the previous period. A warning needs both a relative
 * and an absolute gap so small components stay quiet (specification section 10 item 6).
 */
export function detectComponentVariance(
  current: readonly PayrollLine[],
  previous: readonly PayrollLine[],
  threshold: VarianceThreshold,
): PayrollWarning[] {
  const totalsByCode = (lines: readonly PayrollLine[]) => {
    const totals = new Map<ComponentCode, Rupiah>();
    for (const line of lines) {
      totals.set(line.code, (totals.get(line.code) ?? 0) + line.amount);
    }
    return totals;
  };
  const currentByCode = totalsByCode(current);
  const previousByCode = totalsByCode(previous);

  const warnings: PayrollWarning[] = [];
  for (const code of new Set([...currentByCode.keys(), ...previousByCode.keys()])) {
    const now = currentByCode.get(code) ?? 0;
    const before = previousByCode.get(code) ?? 0;
    const delta = Math.abs(now - before);
    if (delta <= threshold.absolute) continue;
    const relative = before === 0 ? Number.POSITIVE_INFINITY : delta / Math.abs(before);
    if (relative <= threshold.relative) continue;
    warnings.push({
      code: "COMPONENT_VARIANCE",
      message: `Komponen ${code} berubah dari ${before} menjadi ${now}.`,
    });
  }
  return warnings;
}
