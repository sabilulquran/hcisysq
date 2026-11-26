import {
  ANNUAL_LEAVE_ENTITLEMENT_DAYS,
  ANNUAL_LEAVE_MINIMUM_NOTICE_DAYS,
  annualLeaveQuotaScheme,
  calculateAnnualLeaveYearView,
  type AnnualLeavePeriodKey,
  type AnnualLeaveQuarterKey,
  type AnnualLeaveQuotaScheme,
  type LeaveEntitlementGroup,
} from "./annual-leave-policy.js";

export interface AnnualLeaveRequestValidationInput {
  entitlementGroup: LeaveEntitlementGroup | null | undefined;
  employmentStartedOn: string;
  submittedOn: string;
  leaveStartOn: string;
  leaveEndOn: string;
  requestedWorkingDays: number;
  usedDaysByQuarter?: Partial<Record<AnnualLeaveQuarterKey, number>>;
  /** LEAVE-003 R2: ISO date the semester scheme starts applying, by leave date. */
  semesterEffectiveFrom?: string | null;
}

export interface AnnualLeaveRequestValidationResult {
  annualEntitlementDays: number;
  eligibleFrom: string;
  /** The scheme the leave **start** date falls under; it governs the whole request. */
  quotaScheme: AnnualLeaveQuotaScheme;
  periodKey: AnnualLeavePeriodKey;
  periodLimitDays: number;
  usedDaysBeforeRequest: number;
  availableDaysBeforeRequest: number;
  requestedWorkingDays: number;
  availableDaysAfterRequest: number;
  noticeDays: number;
  minimumNoticeDays: number;
}

export class AnnualLeaveRequestPolicyError extends Error {
  constructor(
    readonly code:
      | "INVALID_DATE"
      | "INVALID_WORKING_DAYS"
      | "END_BEFORE_START"
      | "MINIMUM_NOTICE_NOT_MET"
      | "NOT_YET_ELIGIBLE"
      | "CROSS_PERIOD_REQUEST_UNSUPPORTED"
      | "PERIOD_LIMIT_EXCEEDED"
      | "UNSUPPORTED_ENTITLEMENT_GROUP",
    message: string,
  ) {
    super(message);
    this.name = "AnnualLeaveRequestPolicyError";
  }
}

/**
 * OPS-PILOT-TT-001 (2026-11-26): the entitlement-group check used to surface as the policy
 * module's own `AnnualLeavePolicyError`, which no route maps, so the very first refusal a pilot
 * employee meets — an unclassified entitlement group — answered `500` instead of `409`. It is
 * raised here as a request-policy error, which every annual-leave route already maps to `409`,
 * and the empty group is told apart from the education group because only HC can fix the first.
 */
function assertRequesterEntitlementGroup(group: LeaveEntitlementGroup | null | undefined): void {
  if (group === "non_education") return;
  throw new AnnualLeaveRequestPolicyError(
    "UNSUPPORTED_ENTITLEMENT_GROUP",
    group
      ? "Cuti Tahunan individual hanya berlaku untuk kelompok tenaga non-pendidikan."
      : "Kelompok hak cuti Anda belum ditetapkan oleh Human Capital, sehingga Cuti Tahunan belum dapat diajukan. Hubungi Human Capital.",
  );
}

function dateValue(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AnnualLeaveRequestPolicyError("INVALID_DATE", `Tanggal tidak valid: ${value}`);
  }

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) {
    throw new AnnualLeaveRequestPolicyError("INVALID_DATE", `Tanggal tidak valid: ${value}`);
  }

  const roundTrip = new Date(timestamp).toISOString().slice(0, 10);
  if (roundTrip !== value) {
    throw new AnnualLeaveRequestPolicyError("INVALID_DATE", `Tanggal tidak valid: ${value}`);
  }

  return timestamp;
}

function calendarDaysBetween(from: string, to: string): number {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((dateValue(to) - dateValue(from)) / millisecondsPerDay);
}

/** What the employee is told when one request would straddle two quota periods. */
function crossPeriodMessage(scheme: AnnualLeaveQuotaScheme): string {
  return scheme === "SEMESTER"
    ? "Satu pengajuan Cuti Tahunan harus berada dalam satu semester. Tanggal yang melewati 30 Juni-1 Juli atau pergantian tahun diajukan terpisah."
    : "Satu pengajuan Cuti Tahunan harus berada dalam satu periode tiga bulan (Jan-Mar, Apr-Jun, Jul-Sep, Okt-Des). Tanggal setelah batas periode diajukan terpisah.";
}

export function validateAnnualLeaveRequest(
  input: AnnualLeaveRequestValidationInput,
): AnnualLeaveRequestValidationResult {
  assertRequesterEntitlementGroup(input.entitlementGroup);

  if (!Number.isFinite(input.requestedWorkingDays) || input.requestedWorkingDays <= 0) {
    throw new AnnualLeaveRequestPolicyError(
      "INVALID_WORKING_DAYS",
      "Jumlah hari kerja yang diajukan harus lebih dari 0.",
    );
  }

  const rangeDays = calendarDaysBetween(input.leaveStartOn, input.leaveEndOn);
  if (rangeDays < 0) {
    throw new AnnualLeaveRequestPolicyError(
      "END_BEFORE_START",
      "Tanggal selesai cuti tidak boleh sebelum tanggal mulai.",
    );
  }

  const noticeDays = calendarDaysBetween(input.submittedOn, input.leaveStartOn);
  if (noticeDays < ANNUAL_LEAVE_MINIMUM_NOTICE_DAYS) {
    throw new AnnualLeaveRequestPolicyError(
      "MINIMUM_NOTICE_NOT_MET",
      `Cuti Tahunan harus diajukan minimal ${ANNUAL_LEAVE_MINIMUM_NOTICE_DAYS} hari sebelumnya.`,
    );
  }

  /**
   * LEAVE-003 R2: the start date picks the scheme, and that one scheme reads both ends of the
   * range. Deriving it per date would split a request whose range contains the effective date into
   * two different rules and refuse it as cross-period for a boundary nobody crossed.
   */
  const quotaScheme = annualLeaveQuotaScheme(
    input.leaveStartOn,
    input.semesterEffectiveFrom ?? null,
  );

  const usage =
    input.usedDaysByQuarter === undefined
      ? {}
      : { usedDaysByQuarter: input.usedDaysByQuarter };

  const startView = calculateAnnualLeaveYearView({
    employmentStartedOn: input.employmentStartedOn,
    referenceDate: input.leaveStartOn,
    quotaScheme,
    semesterEffectiveFrom: input.semesterEffectiveFrom ?? null,
    ...usage,
  });
  if (!startView.eligible) {
    throw new AnnualLeaveRequestPolicyError(
      "NOT_YET_ELIGIBLE",
      `Hak Cuti Tahunan dapat digunakan mulai ${startView.eligibleFrom}.`,
    );
  }

  const endView = calculateAnnualLeaveYearView({
    employmentStartedOn: input.employmentStartedOn,
    referenceDate: input.leaveEndOn,
    quotaScheme,
    semesterEffectiveFrom: input.semesterEffectiveFrom ?? null,
    ...usage,
  });
  if (
    startView.year !== endView.year ||
    startView.currentPeriodKey !== endView.currentPeriodKey
  ) {
    throw new AnnualLeaveRequestPolicyError(
      "CROSS_PERIOD_REQUEST_UNSUPPORTED",
      crossPeriodMessage(quotaScheme),
    );
  }

  const period = startView.periods.find(
    (candidate) => candidate.key === startView.currentPeriodKey,
  );
  if (!period) {
    throw new AnnualLeaveRequestPolicyError(
      "INVALID_DATE",
      "Periode Cuti Tahunan tidak ditemukan.",
    );
  }

  if (input.requestedWorkingDays > startView.availableNowDays) {
    throw new AnnualLeaveRequestPolicyError(
      "PERIOD_LIMIT_EXCEEDED",
      `Sisa kuota periode ${period.label} adalah ${startView.availableNowDays} hari kerja.`,
    );
  }

  return {
    annualEntitlementDays: ANNUAL_LEAVE_ENTITLEMENT_DAYS,
    eligibleFrom: startView.eligibleFrom,
    quotaScheme,
    periodKey: startView.currentPeriodKey,
    periodLimitDays: startView.currentPeriodLimitDays,
    usedDaysBeforeRequest: period.usedDays,
    availableDaysBeforeRequest: startView.availableNowDays,
    requestedWorkingDays: input.requestedWorkingDays,
    availableDaysAfterRequest:
      startView.availableNowDays - input.requestedWorkingDays,
    noticeDays,
    minimumNoticeDays: ANNUAL_LEAVE_MINIMUM_NOTICE_DAYS,
  };
}
