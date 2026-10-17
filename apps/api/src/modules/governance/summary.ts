import type { BoardAggregates, UnitDistributionRow } from "../board/aggregates.js";

// ORG-010 §4: HUB-IMPL-021 GovernanceSummaryV1 built from ORG-003 aggregates.
// Pure functions only; every label is a fixed string except unit names (§4.4).

export type Unit = "orang" | "unit" | "item" | "persen" | "rupiah" | "hari";

export interface TrendPoint { period: string; value: number | null }
export interface MetricTrend {
  points: TrendPoint[];
  change?: { value: number; unit: Unit; direction: "up" | "down" | "flat" };
}
export interface GovernanceMetric {
  key: string;
  label: string;
  value: number | null;
  unit?: Unit;
  tone?: "normal" | "attention";
  headline?: boolean;
  trend?: MetricTrend;
}
export type GovernanceChart =
  | {
    kind: "trend"; key: string; title: string; unit: Unit; dataAsOf: string; periods: string[];
    series: Array<{ key: string; label: string; mark: "line"; values: Array<number | null> }>;
  }
  | { kind: "ranking"; key: string; title: string; unit: Unit; dataAsOf: string; items: Array<{ label: string; value: number }> };
export interface GovernanceSummaryV1 {
  contractVersion: 1;
  applicationKey: string;
  title: string;
  dataAsOf: string;
  metrics: GovernanceMetric[];
  charts?: GovernanceChart[];
  attention?: Array<{ label: string; count: number; href: string }>;
  detailUrl: string;
}

export type EmploymentRolloutMode = "OFF" | "SHADOW" | "AUTHORITATIVE";

/** One non-voided row of `employments` (EMP-005 S1). Dates are ISO `YYYY-MM-DD`. */
export interface EmploymentSpan {
  startedOn: string | null;
  endedOn: string | null;
  endBasis: "RECORDED" | "UNKNOWN" | null;
  baseline: boolean;
}

export const RANKING_MAX_ITEMS = 8;
export const RANKING_MIN_UNIT_SIZE = 3;
export const TREND_MONTHS = 12;
export const TREND_MIN_POINTS = 6;
const FOLDED_LABEL = "Lainnya";
const BUSINESS_TIME_ZONE = "Asia/Jakarta";

/** D5: units under 3 active employees fold into "Lainnya"; of the rest, up to 7 largest plus
 * "Lainnya" when anything is folded, otherwise up to 8. Input is sorted by count desc, name asc. */
export function buildUnitRanking(rows: readonly UnitDistributionRow[]): Array<{ label: string; value: number }> {
  const sorted = [...rows]
    .filter((row) => row.employeeCount > 0)
    .sort((a, b) => b.employeeCount - a.employeeCount || a.unitName.localeCompare(b.unitName));
  const large = sorted.filter((row) => row.employeeCount >= RANKING_MIN_UNIT_SIZE);
  const small = sorted.filter((row) => row.employeeCount < RANKING_MIN_UNIT_SIZE);
  if (!small.length && large.length <= RANKING_MAX_ITEMS) {
    return large.map((row) => ({ label: row.unitName, value: row.employeeCount }));
  }
  const shown = large.slice(0, RANKING_MAX_ITEMS - 1);
  const folded = [...large.slice(RANKING_MAX_ITEMS - 1), ...small].reduce((sum, row) => sum + row.employeeCount, 0);
  return [...shown.map((row) => ({ label: row.unitName, value: row.employeeCount })), { label: FOLDED_LABEL, value: folded }];
}

function businessMonth(now: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit" })
    .formatToParts(now);
  return {
    year: Number(parts.find((part) => part.type === "year")!.value),
    month: Number(parts.find((part) => part.type === "month")!.value),
  };
}

function shiftMonth(year: number, month: number, delta: number): string {
  const index = year * 12 + (month - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** D6: the last `count` completed months, oldest first; the current month is never included. */
export function completedMonths(now: Date, count = TREND_MONTHS): string[] {
  const { year, month } = businessMonth(now);
  return Array.from({ length: count }, (_, index) => shiftMonth(year, month, index - count));
}

export function monthEnd(period: string): string {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(day).padStart(2, "0")}`;
}

/** Active headcount at a month end, or null when an unknown date could change it (§4.3). */
export function headcountAt(spans: readonly EmploymentSpan[], monthEndDate: string): number | null {
  const earliestBaselineStart = spans
    .filter((span) => span.baseline && span.startedOn && span.endBasis === null)
    .map((span) => span.startedOn as string)
    .sort()[0];
  if (earliestBaselineStart && monthEndDate < earliestBaselineStart) return null;

  let count = 0;
  for (const span of spans) {
    if (span.endBasis === "RECORDED" && span.endedOn && span.endedOn <= monthEndDate) continue;
    if (span.startedOn === null) return null;
    if (span.startedOn > monthEndDate) continue;
    if (span.endBasis === "UNKNOWN") return null;
    count += 1;
  }
  return count;
}

/** ORG-010-G: only in AUTHORITATIVE mode, with at least 6 known points. */
export function buildHeadcountTrend(
  spans: readonly EmploymentSpan[], mode: EmploymentRolloutMode | null, now: Date,
): { periods: string[]; values: Array<number | null>; trend: MetricTrend } | null {
  if (mode !== "AUTHORITATIVE") return null;
  const periods = completedMonths(now);
  const values = periods.map((period) => headcountAt(spans, monthEnd(period)));
  if (values.filter((value) => value !== null).length < TREND_MIN_POINTS) return null;

  const trend: MetricTrend = { points: periods.map((period, index) => ({ period, value: values[index] ?? null })) };
  const last = values[values.length - 1];
  const { year, month } = businessMonth(now);
  const yearEarlier = headcountAt(spans, monthEnd(shiftMonth(year, month, -1 - TREND_MONTHS)));
  if (last !== null && last !== undefined && yearEarlier !== null) {
    const difference = last - yearEarlier;
    // No `good`: more or fewer staff is not good or bad on its own.
    trend.change = {
      value: Math.abs(difference),
      unit: "orang",
      direction: difference > 0 ? "up" : difference < 0 ? "down" : "flat",
    };
  }
  return { periods, values, trend };
}

function attentionTone(value: number): Pick<GovernanceMetric, "tone"> {
  return value > 0 ? { tone: "attention" } : {};
}

export function buildGovernanceSummary(input: {
  aggregates: BoardAggregates;
  employmentMode: EmploymentRolloutMode | null;
  employmentSpans: readonly EmploymentSpan[];
  applicationKey: string;
  publicOrigin: string;
  now: Date;
}): GovernanceSummaryV1 {
  const { aggregates, now } = input;
  const dataAsOf = now.toISOString();
  const detailUrl = new URL("/board", input.publicOrigin).href;
  const headcount = buildHeadcountTrend(input.employmentSpans, input.employmentMode, now);

  const activeEmployees: GovernanceMetric = {
    key: "active_employees", label: "Pegawai aktif", value: aggregates.employees.active, unit: "orang", headline: true,
  };
  if (headcount) activeEmployees.trend = headcount.trend;
  const metrics: GovernanceMetric[] = [
    activeEmployees,
    { key: "started_this_year", label: "Pegawai masuk tahun ini", value: aggregates.movements.startedThisYear, unit: "orang" },
    { key: "ended_this_year", label: "Pegawai keluar tahun ini", value: aggregates.movements.endedThisYear, unit: "orang" },
    {
      key: "without_direct_manager", label: "Pegawai aktif tanpa atasan langsung",
      value: aggregates.approvalReadiness.withoutDirectManager, unit: "orang",
      ...attentionTone(aggregates.approvalReadiness.withoutDirectManager),
    },
    {
      key: "units_without_approver", label: "Unit tanpa penyetuju cuti",
      value: aggregates.approvalReadiness.unitsWithoutApprover, unit: "unit",
      ...attentionTone(aggregates.approvalReadiness.unitsWithoutApprover),
    },
    { key: "leave_in_review", label: "Pengajuan cuti dalam proses", value: aggregates.workflow.leaveInReview, unit: "item" },
  ];

  const charts: GovernanceChart[] = [];
  if (headcount) {
    charts.push({
      kind: "trend", key: "active_headcount_monthly", title: "Pegawai aktif per bulan", unit: "orang", dataAsOf,
      periods: headcount.periods,
      series: [{ key: "active_employees", label: "Pegawai aktif", mark: "line", values: headcount.values }],
    });
  }
  const ranking = buildUnitRanking(aggregates.unitDistribution);
  if (ranking.length) {
    charts.push({ kind: "ranking", key: "active_headcount_by_unit", title: "Pegawai aktif per unit", unit: "orang", dataAsOf, items: ranking });
  }

  const attention = [
    { label: "Unit tanpa penyetuju cuti", count: aggregates.approvalReadiness.unitsWithoutApprover },
    { label: "Validasi HC menunggu", count: aggregates.workflow.hcValidationPending },
    { label: "Kasus presensi belum selesai", count: aggregates.workflow.attendanceResolutionOpen },
  ].filter((item) => item.count > 0).map((item) => ({ ...item, href: detailUrl }));

  return {
    contractVersion: 1,
    applicationKey: input.applicationKey,
    title: "SDM",
    dataAsOf,
    metrics,
    ...(charts.length ? { charts } : {}),
    ...(attention.length ? { attention } : {}),
    detailUrl,
  };
}
