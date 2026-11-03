// LEAVE-009 critical periods (masa kritis). Pure rules only; storage and HTTP live in
// ../critical-period-routes.ts. Spec: docs/domain/leave-critical-periods.md §3.

export const CRITICAL_PERIOD_MAX_DAYS = 120;

/** D-02: leave types with line approval that receive the extra HC review step. */
export const CRITICAL_REVIEW_POLICY_KEYS = [
  "annual",
  "employee_marriage",
  "child_marriage",
  "child_circumcision",
  "hajj",
] as const;

/** D-02: Cuti Tanpa Gaji is already decided by HC, so its match is only recorded. */
export const CRITICAL_PERIOD_RECORD_ONLY_POLICY_KEYS = ["unpaid"] as const;

export type CriticalPeriodTreatment = "review" | "record" | "none";

export interface CriticalPeriodRecord {
  id: string;
  label: string;
  startOn: string;
  endOn: string;
  unitId: string | null;
  unitName: string | null;
  isActive: boolean;
}

export interface CriticalPeriodSnapshotItem {
  id: string;
  label: string;
  startOn: string;
  endOn: string;
  scope: "organization" | "unit";
  unitId: string | null;
  unitName: string | null;
}

export class CriticalPeriodError extends Error {
  constructor(
    readonly code:
      | "CRITICAL_PERIOD_DATE_INVALID"
      | "CRITICAL_PERIOD_RANGE_INVALID"
      | "CRITICAL_PERIOD_TOO_LONG",
    message: string,
  ) {
    super(message);
    this.name = "CriticalPeriodError";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(value: string): number {
  if (!ISO_DATE.test(value)) {
    throw new CriticalPeriodError("CRITICAL_PERIOD_DATE_INVALID", "Tanggal masa kritis tidak valid.");
  }
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new CriticalPeriodError("CRITICAL_PERIOD_DATE_INVALID", "Tanggal masa kritis tidak valid.");
  }
  return time / 86_400_000;
}

/** D-09: end on or after start, at most 120 calendar days inclusive. */
export function assertCriticalPeriodRange(startOn: string, endOn: string): void {
  const start = dayNumber(startOn);
  const end = dayNumber(endOn);
  if (end < start) {
    throw new CriticalPeriodError(
      "CRITICAL_PERIOD_RANGE_INVALID",
      "Tanggal selesai masa kritis tidak boleh sebelum tanggal mulai.",
    );
  }
  if (end - start + 1 > CRITICAL_PERIOD_MAX_DAYS) {
    throw new CriticalPeriodError(
      "CRITICAL_PERIOD_TOO_LONG",
      `Satu masa kritis paling panjang ${CRITICAL_PERIOD_MAX_DAYS} hari.`,
    );
  }
}

export function criticalPeriodTreatment(policyKey: string): CriticalPeriodTreatment {
  if ((CRITICAL_REVIEW_POLICY_KEYS as readonly string[]).includes(policyKey)) return "review";
  if ((CRITICAL_PERIOD_RECORD_ONLY_POLICY_KEYS as readonly string[]).includes(policyKey)) return "record";
  return "none";
}

/**
 * D-03 + D-04: an active period applies when it covers the whole foundation or the
 * requester's unit, and shares at least one calendar day with the leave (inclusive).
 */
export function matchCriticalPeriods(
  periods: readonly CriticalPeriodRecord[],
  input: { unitId: string | null; startOn: string; endOn: string },
): CriticalPeriodSnapshotItem[] {
  return periods
    .filter((period) =>
      period.isActive
      && (period.unitId === null || period.unitId === input.unitId)
      && period.startOn <= input.endOn
      && period.endOn >= input.startOn)
    .sort((a, b) => a.startOn.localeCompare(b.startOn) || a.id.localeCompare(b.id))
    .map((period) => ({
      id: period.id,
      label: period.label,
      startOn: period.startOn,
      endOn: period.endOn,
      scope: period.unitId === null ? "organization" : "unit",
      unitId: period.unitId,
      unitName: period.unitName,
    }));
}
