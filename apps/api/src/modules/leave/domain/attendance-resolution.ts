import {
  annualLeaveEligibilityDate,
  annualLeavePeriodForDate,
  annualLeavePeriodLimitDays,
  annualLeaveQuotaScheme,
  type AnnualLeavePeriodKey,
  type AnnualLeaveQuotaScheme,
  type LeaveEntitlementGroup,
} from "./annual-leave-policy.js";

export type AdministrationStatus =
  | "validated"
  | "partially_validated"
  | "not_validated";

export interface AdministrationDayResult {
  administrationStatus: AdministrationStatus;
  validatedDates: string[];
  unresolvedDates: string[];
}

export interface AnnualConversionOffer {
  available: boolean;
  /** LEAVE-003 R2: the scheme governing the dates being converted. */
  quotaScheme: AnnualLeaveQuotaScheme;
  periodKey: AnnualLeavePeriodKey | null;
  periodLimitDays: number;
  usedDays: number;
  remainingDays: number;
  requestedDays: number;
  reason: string | null;
}

export class AttendanceResolutionPolicyError extends Error {
  constructor(
    readonly code:
      | "INVALID_WORKING_DATES"
      | "INVALID_VALIDATED_DATE"
      | "PARTIAL_VALIDATION_REQUIRES_MIXED_DATES",
    message: string,
  ) {
    super(message);
    this.name = "AttendanceResolutionPolicyError";
  }
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function assertIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AttendanceResolutionPolicyError(
      "INVALID_WORKING_DATES",
      `Tanggal tidak valid: ${value}`,
    );
  }
}

export function classifyAdministrationDays(input: {
  workingDates: readonly string[];
  action: "validate_all" | "validate_partial" | "not_validated";
  validatedDates?: readonly string[];
}): AdministrationDayResult {
  const workingDates = uniqueSorted(input.workingDates);
  if (workingDates.length === 0) {
    throw new AttendanceResolutionPolicyError(
      "INVALID_WORKING_DATES",
      "Pengajuan tidak memiliki hari kerja yang dapat divalidasi.",
    );
  }
  workingDates.forEach(assertIsoDate);
  const workingSet = new Set(workingDates);

  if (input.action === "validate_all") {
    return {
      administrationStatus: "validated",
      validatedDates: workingDates,
      unresolvedDates: [],
    };
  }

  if (input.action === "not_validated") {
    return {
      administrationStatus: "not_validated",
      validatedDates: [],
      unresolvedDates: workingDates,
    };
  }

  const validatedDates = uniqueSorted(input.validatedDates ?? []);
  for (const date of validatedDates) {
    assertIsoDate(date);
    if (!workingSet.has(date)) {
      throw new AttendanceResolutionPolicyError(
        "INVALID_VALIDATED_DATE",
        "Tanggal tervalidasi harus termasuk hari kerja pada pengajuan.",
      );
    }
  }

  if (validatedDates.length === 0 || validatedDates.length === workingDates.length) {
    throw new AttendanceResolutionPolicyError(
      "PARTIAL_VALIDATION_REQUIRES_MIXED_DATES",
      "Validasi sebagian harus menyisakan minimal satu tanggal tervalidasi dan satu tanggal belum terselesaikan.",
    );
  }

  const validatedSet = new Set(validatedDates);
  return {
    administrationStatus: "partially_validated",
    validatedDates,
    unresolvedDates: workingDates.filter((date) => !validatedSet.has(date)),
  };
}

/**
 * The quota period a date to be converted falls in, read under the scheme in force on that date
 * (LEAVE-003 R2). Before the semester scheme starts this is the three-month bucket, exactly as
 * before.
 */
export function annualPeriodKeyForDate(
  value: string,
  semesterEffectiveFrom: string | null = null,
): AnnualLeavePeriodKey {
  assertIsoDate(value);
  return annualLeavePeriodForDate(
    value,
    annualLeaveQuotaScheme(value, semesterEffectiveFrom),
  );
}

export function evaluateAnnualConversionOffer(input: {
  entitlementGroup: LeaveEntitlementGroup | null;
  employmentStartedOn: string | null;
  unresolvedDates: readonly string[];
  usedDaysInPeriod: number;
  /** LEAVE-003 R2: ISO date the semester scheme starts applying, by leave date. */
  semesterEffectiveFrom?: string | null;
}): AnnualConversionOffer {
  const unresolvedDates = uniqueSorted(input.unresolvedDates);
  const requestedDays = unresolvedDates.length;
  const semesterEffectiveFrom = input.semesterEffectiveFrom ?? null;
  const firstDate = unresolvedDates[0];
  // The earliest date decides the scheme, the same way a request's start date does.
  const quotaScheme = firstDate
    ? annualLeaveQuotaScheme(firstDate, semesterEffectiveFrom)
    : "QUARTER";
  const periodLimitDays = annualLeavePeriodLimitDays(quotaScheme);

  if (input.entitlementGroup !== "non_education") {
    return {
      available: false,
      quotaScheme,
      periodKey: null,
      periodLimitDays,
      usedDays: input.usedDaysInPeriod,
      remainingDays: 0,
      requestedDays,
      reason: "Konversi Cuti Tahunan hanya tersedia untuk tenaga non-pendidikan.",
    };
  }
  if (!input.employmentStartedOn || !firstDate) {
    return {
      available: false,
      quotaScheme,
      periodKey: null,
      periodLimitDays,
      usedDays: input.usedDaysInPeriod,
      remainingDays: 0,
      requestedDays,
      reason: "Data masa kerja atau tanggal penyelesaian belum lengkap.",
    };
  }

  const periodKeys = new Set(
    unresolvedDates.map((date) => annualLeavePeriodForDate(date, quotaScheme)),
  );
  const years = new Set(unresolvedDates.map((date) => date.slice(0, 4)));
  if (periodKeys.size !== 1 || years.size !== 1) {
    return {
      available: false,
      quotaScheme,
      periodKey: null,
      periodLimitDays,
      usedDays: input.usedDaysInPeriod,
      remainingDays: 0,
      requestedDays,
      reason: "Tanggal yang perlu diselesaikan harus berada dalam satu periode Cuti Tahunan.",
    };
  }

  const periodKey = annualLeavePeriodForDate(firstDate, quotaScheme);
  const remainingDays = Math.max(0, periodLimitDays - input.usedDaysInPeriod);
  const eligibleFrom = annualLeaveEligibilityDate(input.employmentStartedOn);
  if (unresolvedDates.some((date) => date < eligibleFrom)) {
    return {
      available: false,
      quotaScheme,
      periodKey,
      periodLimitDays,
      usedDays: input.usedDaysInPeriod,
      remainingDays,
      requestedDays,
      reason: "Pada tanggal tersebut pegawai belum genap 12 bulan bekerja.",
    };
  }

  if (requestedDays > remainingDays) {
    return {
      available: false,
      quotaScheme,
      periodKey,
      periodLimitDays,
      usedDays: input.usedDaysInPeriod,
      remainingDays,
      requestedDays,
      reason: "Kuota periode Cuti Tahunan tidak cukup untuk seluruh tanggal yang perlu diselesaikan.",
    };
  }

  return {
    available: true,
    quotaScheme,
    periodKey,
    periodLimitDays,
    usedDays: input.usedDaysInPeriod,
    remainingDays,
    requestedDays,
    reason: null,
  };
}
