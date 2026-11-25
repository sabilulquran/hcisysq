export const ANNUAL_LEAVE_ENTITLEMENT_DAYS = 12;
export const ANNUAL_LEAVE_ELIGIBILITY_MONTHS = 12;
export const ANNUAL_LEAVE_MINIMUM_NOTICE_DAYS = 7;

/** LEAVE-003-B: usage limit of one three-month period (the rule in force until LEAVE-003 R2 starts). */
export const ANNUAL_LEAVE_QUARTER_LIMIT_DAYS = 3;
/** LEAVE-003 R2: usage limit of one calendar semester (Jan-Jun, Jul-Dec). */
export const ANNUAL_LEAVE_SEMESTER_LIMIT_DAYS = 6;
/**
 * The quarter limit under its original name. Kept because the annual entitlement itself does not
 * change (12 working days a year, administered as 4x3 or 2x6); callers written before LEAVE-003 R2
 * mean the quarter limit when they say "the period limit".
 */
export const ANNUAL_LEAVE_PERIOD_LIMIT_DAYS = ANNUAL_LEAVE_QUARTER_LIMIT_DAYS;

export type LeaveEntitlementGroup = "education" | "non_education";

/**
 * LEAVE-003 R2 (2026-11-25): which quota scheme governs a leave date.
 *
 * `QUARTER` is the original rule: 3 working days in each of Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec.
 * `SEMESTER` is its successor: 6 working days in each of Jan-Jun and Jul-Dec. The annual right is
 * 12 working days under both.
 */
export type AnnualLeaveQuotaScheme = "QUARTER" | "SEMESTER";

export type AnnualLeaveQuarterKey = "JAN_MAR" | "APR_JUN" | "JUL_SEP" | "OCT_DEC";
export type AnnualLeaveSemesterKey = "JAN_JUN" | "JUL_DEC";
/** Every key a stored request may carry. Quarter keys stay readable forever (LEAVE-003 R2 §4). */
export type AnnualLeavePeriodKey = AnnualLeaveQuarterKey | AnnualLeaveSemesterKey;

export type AnnualLeavePeriodStatus =
  | "not_eligible"
  | "upcoming"
  | "current"
  | "closed";

export interface AnnualLeavePeriodView {
  key: AnnualLeavePeriodKey;
  label: string;
  allocationDays: number;
  usedDays: number;
  remainingDays: number;
  usableFrom: string | null;
  status: AnnualLeavePeriodStatus;
}

export interface AnnualLeaveYearView {
  annualEntitlementDays: number;
  eligibilityMonths: number;
  eligibleFrom: string;
  eligible: boolean;
  referenceDate: string;
  year: number;
  availableNowDays: number;
  quotaScheme: AnnualLeaveQuotaScheme;
  /** LEAVE-003 R2: the day the semester scheme starts applying, by leave date. */
  semesterEffectiveFrom: string | null;
  currentPeriodKey: AnnualLeavePeriodKey;
  currentPeriodLimitDays: number;
  eligiblePeriodAllocationDaysInYear: number;
  carryForwardEnabled: false;
  periods: AnnualLeavePeriodView[];
}

export interface AnnualLeaveYearInput {
  employmentStartedOn: string;
  referenceDate: string;
  /**
   * Usage is always accumulated per **quarter**, whichever scheme governs the request that used it:
   * a quarter never straddles a semester, so a semester's usage is the sum of its two quarters and
   * every working day is counted exactly once (LEAVE-003 R2 §3).
   */
  usedDaysByQuarter?: Partial<Record<AnnualLeaveQuarterKey, number>>;
  /** ISO date the semester scheme starts applying; `null`/absent keeps the quarter scheme. */
  semesterEffectiveFrom?: string | null;
  /**
   * Overrides the scheme derived from `referenceDate`. A request is governed by the scheme of its
   * **start** date, so both ends of its range must be read under that one scheme even when the
   * effective date falls inside the range.
   */
  quotaScheme?: AnnualLeaveQuotaScheme;
}

interface IsoDateParts {
  year: number;
  month: number;
  day: number;
}

interface PeriodDefinition {
  key: AnnualLeavePeriodKey;
  label: string;
  startMonth: number;
  endMonth: number;
}

const QUARTERS: readonly PeriodDefinition[] = [
  { key: "JAN_MAR", label: "Januari-Maret", startMonth: 1, endMonth: 3 },
  { key: "APR_JUN", label: "April-Juni", startMonth: 4, endMonth: 6 },
  { key: "JUL_SEP", label: "Juli-September", startMonth: 7, endMonth: 9 },
  { key: "OCT_DEC", label: "Oktober-Desember", startMonth: 10, endMonth: 12 },
];

const SEMESTERS: readonly PeriodDefinition[] = [
  { key: "JAN_JUN", label: "Januari-Juni", startMonth: 1, endMonth: 6 },
  { key: "JUL_DEC", label: "Juli-Desember", startMonth: 7, endMonth: 12 },
];

export const ANNUAL_LEAVE_QUARTER_KEYS = QUARTERS.map(
  (period) => period.key as AnnualLeaveQuarterKey,
);
export const ANNUAL_LEAVE_SEMESTER_KEYS = SEMESTERS.map(
  (period) => period.key as AnnualLeaveSemesterKey,
);
export const ANNUAL_LEAVE_PERIOD_KEYS: readonly AnnualLeavePeriodKey[] = [
  ...ANNUAL_LEAVE_QUARTER_KEYS,
  ...ANNUAL_LEAVE_SEMESTER_KEYS,
];

const QUARTERS_IN_SEMESTER: Record<AnnualLeaveSemesterKey, readonly AnnualLeaveQuarterKey[]> = {
  JAN_JUN: ["JAN_MAR", "APR_JUN"],
  JUL_DEC: ["JUL_SEP", "OCT_DEC"],
};

export class AnnualLeavePolicyError extends Error {
  constructor(
    readonly code:
      | "INVALID_DATE"
      | "INVALID_USAGE"
      | "UNSUPPORTED_ENTITLEMENT_GROUP",
    message: string,
  ) {
    super(message);
    this.name = "AnnualLeavePolicyError";
  }
}

function parseIsoDate(value: string): IsoDateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new AnnualLeavePolicyError("INVALID_DATE", `Tanggal tidak valid: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new AnnualLeavePolicyError("INVALID_DATE", `Tanggal tidak valid: ${value}`);
  }

  return { year, month, day };
}

function formatIsoDate(parts: IsoDateParts): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonthsClamped(parts: IsoDateParts, months: number): IsoDateParts {
  const zeroBasedTargetMonth = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(zeroBasedTargetMonth / 12);
  const month = (zeroBasedTargetMonth % 12) + 1;
  const day = Math.min(parts.day, daysInMonth(year, month));
  return { year, month, day };
}

function compareDates(a: IsoDateParts, b: IsoDateParts): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

function maxDate(a: IsoDateParts, b: IsoDateParts): IsoDateParts {
  return compareDates(a, b) >= 0 ? a : b;
}

function periodStart(year: number, period: PeriodDefinition): IsoDateParts {
  return { year, month: period.startMonth, day: 1 };
}

function periodEnd(year: number, period: PeriodDefinition): IsoDateParts {
  return {
    year,
    month: period.endMonth,
    day: daysInMonth(year, period.endMonth),
  };
}

function periodsOf(scheme: AnnualLeaveQuotaScheme): readonly PeriodDefinition[] {
  return scheme === "SEMESTER" ? SEMESTERS : QUARTERS;
}

function definitionForMonth(
  month: number,
  scheme: AnnualLeaveQuotaScheme,
): PeriodDefinition {
  const period = periodsOf(scheme).find(
    (candidate) => month >= candidate.startMonth && month <= candidate.endMonth,
  );
  if (!period) {
    throw new AnnualLeavePolicyError("INVALID_DATE", `Bulan tidak valid: ${month}`);
  }
  return period;
}

function validateUsedDays(value: number, key: AnnualLeaveQuarterKey): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new AnnualLeavePolicyError(
      "INVALID_USAGE",
      `Pemakaian cuti periode ${key} tidak valid.`,
    );
  }
  return value;
}

/** The usage limit of one period under `scheme`. */
export function annualLeavePeriodLimitDays(scheme: AnnualLeaveQuotaScheme): number {
  return scheme === "SEMESTER"
    ? ANNUAL_LEAVE_SEMESTER_LIMIT_DAYS
    : ANNUAL_LEAVE_QUARTER_LIMIT_DAYS;
}

/**
 * LEAVE-003 R2: which scheme governs `leaveDate`.
 *
 * The rule follows the **leave date**, not the submission date, so a request already waiting for a
 * decision keeps the rule its dates were read under.
 */
export function annualLeaveQuotaScheme(
  leaveDate: string,
  semesterEffectiveFrom: string | null | undefined,
): AnnualLeaveQuotaScheme {
  parseIsoDate(leaveDate);
  if (!semesterEffectiveFrom) return "QUARTER";
  parseIsoDate(semesterEffectiveFrom);
  // Both are validated ISO calendar dates, so comparing them as text is comparing them as dates.
  return leaveDate >= semesterEffectiveFrom ? "SEMESTER" : "QUARTER";
}

/** The three-month bucket a leave date belongs to. Usage is always accumulated in these. */
export function annualLeaveQuarterForDate(value: string): AnnualLeaveQuarterKey {
  const parts = parseIsoDate(value);
  return definitionForMonth(parts.month, "QUARTER").key as AnnualLeaveQuarterKey;
}

/** The quota period a leave date belongs to under `scheme`. */
export function annualLeavePeriodForDate(
  value: string,
  scheme: AnnualLeaveQuotaScheme,
): AnnualLeavePeriodKey {
  const parts = parseIsoDate(value);
  return definitionForMonth(parts.month, scheme).key;
}

/** Human label of a period key, for messages and screens. */
export function annualLeavePeriodLabel(key: AnnualLeavePeriodKey): string {
  const period = [...QUARTERS, ...SEMESTERS].find((candidate) => candidate.key === key);
  if (!period) {
    throw new AnnualLeavePolicyError("INVALID_DATE", `Periode cuti tidak dikenal: ${key}`);
  }
  return period.label;
}

/** The calendar months a period spans, 1-based and inclusive. */
export function annualLeavePeriodMonthRange(
  key: AnnualLeavePeriodKey,
): { startMonth: number; endMonth: number } {
  const period = [...QUARTERS, ...SEMESTERS].find((candidate) => candidate.key === key);
  if (!period) {
    throw new AnnualLeavePolicyError("INVALID_DATE", `Periode cuti tidak dikenal: ${key}`);
  }
  return { startMonth: period.startMonth, endMonth: period.endMonth };
}

/** The quarters a period covers: itself for a quarter, both halves for a semester. */
export function annualLeaveQuartersInPeriod(
  key: AnnualLeavePeriodKey,
): readonly AnnualLeaveQuarterKey[] {
  return key in QUARTERS_IN_SEMESTER
    ? QUARTERS_IN_SEMESTER[key as AnnualLeaveSemesterKey]
    : [key as AnnualLeaveQuarterKey];
}

/**
 * Days already used inside a period. Reading a semester as the sum of its two quarters is what
 * reconciles requests recorded under the old rule with the new one: each day is counted once, and
 * nothing has to be rewritten in the database.
 */
export function annualLeaveUsedDaysInPeriod(
  usedDaysByQuarter: Partial<Record<AnnualLeaveQuarterKey, number>> | undefined,
  key: AnnualLeavePeriodKey,
): number {
  return annualLeaveQuartersInPeriod(key).reduce(
    (total, quarter) => total + validateUsedDays(usedDaysByQuarter?.[quarter] ?? 0, quarter),
    0,
  );
}

export function annualLeaveEligibilityDate(employmentStartedOn: string): string {
  const startedOn = parseIsoDate(employmentStartedOn);
  return formatIsoDate(addMonthsClamped(startedOn, ANNUAL_LEAVE_ELIGIBILITY_MONTHS));
}

export function calculateAnnualLeaveYearView(
  input: AnnualLeaveYearInput,
): AnnualLeaveYearView {
  const startedOn = parseIsoDate(input.employmentStartedOn);
  const referenceDate = parseIsoDate(input.referenceDate);
  const eligibleFrom = addMonthsClamped(startedOn, ANNUAL_LEAVE_ELIGIBILITY_MONTHS);
  const semesterEffectiveFrom = input.semesterEffectiveFrom ?? null;
  const scheme =
    input.quotaScheme ??
    annualLeaveQuotaScheme(input.referenceDate, semesterEffectiveFrom);
  const allocationDays = annualLeavePeriodLimitDays(scheme);
  const currentPeriod = definitionForMonth(referenceDate.month, scheme);

  const periods = periodsOf(scheme).map<AnnualLeavePeriodView>((period) => {
    const start = periodStart(referenceDate.year, period);
    const end = periodEnd(referenceDate.year, period);
    const canEverUsePeriod = compareDates(eligibleFrom, end) <= 0;
    const usableFrom = canEverUsePeriod ? maxDate(start, eligibleFrom) : null;
    const usedDays = annualLeaveUsedDaysInPeriod(input.usedDaysByQuarter, period.key);
    const remainingDays = Math.max(0, allocationDays - usedDays);

    let status: AnnualLeavePeriodStatus;
    if (!usableFrom) {
      status = "not_eligible";
    } else if (compareDates(referenceDate, usableFrom) < 0) {
      status = "upcoming";
    } else if (compareDates(referenceDate, end) > 0) {
      status = "closed";
    } else {
      status = "current";
    }

    return {
      key: period.key,
      label: period.label,
      allocationDays,
      usedDays,
      remainingDays,
      usableFrom: usableFrom ? formatIsoDate(usableFrom) : null,
      status,
    };
  });

  const currentPeriodView = periods.find((period) => period.key === currentPeriod.key);
  if (!currentPeriodView) {
    throw new AnnualLeavePolicyError("INVALID_DATE", "Periode cuti tidak ditemukan.");
  }

  const eligible = compareDates(referenceDate, eligibleFrom) >= 0;
  const availableNowDays =
    currentPeriodView.status === "current" ? currentPeriodView.remainingDays : 0;
  const eligiblePeriodAllocationDaysInYear = periods.reduce(
    (total, period) => total + (period.usableFrom ? period.allocationDays : 0),
    0,
  );

  return {
    annualEntitlementDays: ANNUAL_LEAVE_ENTITLEMENT_DAYS,
    eligibilityMonths: ANNUAL_LEAVE_ELIGIBILITY_MONTHS,
    eligibleFrom: formatIsoDate(eligibleFrom),
    eligible,
    referenceDate: formatIsoDate(referenceDate),
    year: referenceDate.year,
    availableNowDays,
    quotaScheme: scheme,
    semesterEffectiveFrom,
    currentPeriodKey: currentPeriod.key,
    currentPeriodLimitDays: allocationDays,
    eligiblePeriodAllocationDaysInYear,
    carryForwardEnabled: false,
    periods,
  };
}

export function assertAnnualLeaveEntitlementGroup(
  group: LeaveEntitlementGroup | null | undefined,
): asserts group is "non_education" {
  if (group !== "non_education") {
    throw new AnnualLeavePolicyError(
      "UNSUPPORTED_ENTITLEMENT_GROUP",
      "Cuti Tahunan individual hanya berlaku untuk kelompok tenaga non-pendidikan.",
    );
  }
}
