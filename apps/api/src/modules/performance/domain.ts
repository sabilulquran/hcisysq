// PERF-001 Package 1 rules: rubric, scoring, predicate, state transitions. No database, no HTTP.
// Spec: docs/domain/performance-review.md.

export const CYCLE_KINDS = ["MONTHLY", "ANNUAL"] as const;
export type CycleKind = (typeof CYCLE_KINDS)[number];

export const CYCLE_STATUSES = ["DRAFT", "OPEN", "CLOSED", "CANCELLED"] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

export const REVIEW_STATUSES = [
  "SELF_ASSESSMENT", "MANAGER_REVIEW", "HC_VALIDATION", "FINALIZED", "UNRATED", "REMOVED",
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Reviews still being worked on while the cycle is OPEN. */
export const ACTIVE_REVIEW_STATUSES: readonly ReviewStatus[] = ["SELF_ASSESSMENT", "MANAGER_REVIEW", "HC_VALIDATION"];

/** D-04: the legacy 1-4 scale, kept so legacy grades and new predicates read the same. */
export const SCALE = { min: 1, max: 4 } as const;
export const SCALE_LABELS: Record<number, string> = { 4: "Sangat baik", 3: "Baik", 2: "Cukup", 1: "Kurang" };

export interface RubricIndicator {
  code: string;
  label: string;
  description: string;
  /** Percent; all indicators add up to exactly 100. */
  weight: number;
}

export interface RubricPredicate {
  code: string;
  label: string;
  /** Lowest final score (1.00-4.00, two decimals, inclusive) that earns this predicate. */
  minScore: number;
}

export interface Rubric {
  indicators: RubricIndicator[];
  predicates: RubricPredicate[];
}

export type Scores = Record<string, number>;

export class PerformancePolicyError extends Error {
  constructor(
    readonly code: "PERFORMANCE_RUBRIC_INVALID" | "PERFORMANCE_SCORES_INVALID" | "PERFORMANCE_PERIOD_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "PerformancePolicyError";
  }
}

/**
 * D-05/D-06 DRAFT: the default rubric of a new cycle. Legacy kept no seeded aspects, so the
 * indicators are a starting point HC edits while the cycle is DRAFT. The predicate boundaries are
 * the legacy grade bands A >= 3.5, B >= 2.5, C >= 1.5, D below. Opening the cycle freezes the copy.
 */
export const DEFAULT_RUBRIC: Rubric = {
  indicators: [
    { code: "TASK_RESULT", label: "Hasil kerja", description: "Mutu dan ketuntasan tugas pokok pada periode ini.", weight: 30 },
    { code: "DISCIPLINE", label: "Disiplin dan kehadiran", description: "Ketepatan waktu, kehadiran, dan kepatuhan pada aturan kerja.", weight: 20 },
    { code: "AKHLAK", label: "Akhlak dan adab", description: "Adab kepada santri, rekan, dan atasan; amanah dan kejujuran.", weight: 20 },
    { code: "TEAMWORK", label: "Kerja sama dan komunikasi", description: "Kesediaan membantu, koordinasi, dan cara menyampaikan informasi.", weight: 15 },
    { code: "INITIATIVE", label: "Inisiatif dan pengembangan diri", description: "Usulan perbaikan, belajar hal baru, dan tanggung jawab di luar tugas pokok.", weight: 15 },
  ],
  predicates: [
    { code: "A", label: "Sangat baik", minScore: 3.5 },
    { code: "B", label: "Baik", minScore: 2.5 },
    { code: "C", label: "Cukup", minScore: 1.5 },
    { code: "D", label: "Kurang", minScore: 1 },
  ],
};

const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

function hundredths(value: number): number | null {
  const scaled = Math.round(value * 100);
  return Number.isFinite(value) && Math.abs(scaled - value * 100) < 1e-6 ? scaled : null;
}

/** D-05: whole-percent weights adding up to 100; predicates cover 1.00..4.00 without gaps. */
export function validateRubric(rubric: Rubric): Rubric {
  const fail = (message: string): never => {
    throw new PerformancePolicyError("PERFORMANCE_RUBRIC_INVALID", message);
  };
  const { indicators, predicates } = rubric;
  if (indicators.length < 1 || indicators.length > 20) fail("Rubrik berisi 1 sampai 20 indikator.");
  const codes = new Set<string>();
  for (const indicator of indicators) {
    if (!CODE.test(indicator.code)) fail(`Kode indikator ${indicator.code} tidak valid.`);
    if (codes.has(indicator.code)) fail(`Kode indikator ${indicator.code} dipakai dua kali.`);
    codes.add(indicator.code);
    if (!Number.isInteger(indicator.weight) || indicator.weight < 1 || indicator.weight > 100) {
      fail(`Bobot ${indicator.label} harus bilangan bulat 1 sampai 100.`);
    }
  }
  if (indicators.reduce((sum, item) => sum + item.weight, 0) !== 100) fail("Jumlah bobot indikator harus tepat 100.");
  if (predicates.length < 2 || predicates.length > 6) fail("Predikat berjumlah 2 sampai 6.");
  const predicateCodes = new Set<string>();
  const bounds = new Set<number>();
  for (const predicate of predicates) {
    if (!CODE.test(predicate.code)) fail(`Kode predikat ${predicate.code} tidak valid.`);
    if (predicateCodes.has(predicate.code)) fail(`Kode predikat ${predicate.code} dipakai dua kali.`);
    predicateCodes.add(predicate.code);
    const bound = hundredths(predicate.minScore);
    if (bound === null || bound < SCALE.min * 100 || bound > SCALE.max * 100) {
      fail(`Batas bawah ${predicate.label} adalah angka ${SCALE.min} sampai ${SCALE.max} dengan paling banyak dua desimal.`);
    }
    if (bounds.has(bound!)) fail("Dua predikat tidak boleh memakai batas bawah yang sama.");
    bounds.add(bound!);
  }
  if (!bounds.has(SCALE.min * 100)) fail(`Satu predikat harus mulai dari ${SCALE.min} supaya setiap nilai mendapat predikat.`);
  return {
    indicators: indicators.map(({ code, label, description, weight }) => ({ code, label, description, weight })),
    // Highest boundary first, so predicateFor() takes the first match.
    predicates: [...predicates]
      .sort((a, b) => b.minScore - a.minScore)
      .map(({ code, label, minScore }) => ({ code, label, minScore })),
  };
}

/** Every indicator scored exactly once with a whole number on the scale; nothing extra. */
export function validateScores(rubric: Rubric, scores: Scores): Scores {
  const expected = rubric.indicators.map((item) => item.code);
  const given = Object.keys(scores);
  if (given.length !== expected.length || expected.some((code) => !Object.hasOwn(scores, code))) {
    throw new PerformancePolicyError("PERFORMANCE_SCORES_INVALID", "Setiap indikator harus dinilai tepat satu kali.");
  }
  for (const code of expected) {
    const value = scores[code];
    if (!Number.isInteger(value) || value! < SCALE.min || value! > SCALE.max) {
      throw new PerformancePolicyError(
        "PERFORMANCE_SCORES_INVALID",
        `Nilai setiap indikator adalah bilangan bulat ${SCALE.min} sampai ${SCALE.max}.`,
      );
    }
  }
  return Object.fromEntries(expected.map((code) => [code, scores[code]!]));
}

/**
 * D-05: the legacy weighted average, Σ(score × weight) / 100, between 1.00 and 4.00. Weights add
 * up to 100 and scores are integers, so the sum is an exact count of hundredths: no rounding.
 * Only the rater's scores count; the self-assessment is shown beside it (D-03).
 */
export function finalScore(rubric: Rubric, scores: Scores): number {
  const total = rubric.indicators.reduce((sum, indicator) => sum + indicator.weight * scores[indicator.code]!, 0);
  return total / 100;
}

export function predicateFor(rubric: Rubric, score: number): RubricPredicate {
  const sorted = [...rubric.predicates].sort((a, b) => b.minScore - a.minScore);
  return sorted.find((predicate) => score >= predicate.minScore) ?? sorted[sorted.length - 1]!;
}

/** True only for a real calendar date written `YYYY-MM-DD` (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * D-02 DRAFT: a MONTHLY cycle is one calendar month (the legacy period); an ANNUAL cycle is one
 * academic year, 1 July to 30 June. The self-assessment deadline comes first, inside or after the
 * period, and the rater's deadline on or after it.
 */
export function validateCyclePeriod(input: {
  kind: CycleKind; periodStart: string; periodEnd: string; selfDueOn: string; reviewDueOn: string;
}) {
  const fail = (message: string): never => {
    throw new PerformancePolicyError("PERFORMANCE_PERIOD_INVALID", message);
  };
  if (![input.periodStart, input.periodEnd, input.selfDueOn, input.reviewDueOn].every(isCalendarDate)) {
    fail("Tanggal periode tidak valid.");
  }
  if (input.kind === "ANNUAL") {
    const year = Number(input.periodStart.slice(0, 4));
    if (input.periodStart !== `${year}-07-01` || input.periodEnd !== `${year + 1}-06-30`) {
      fail("Periode tahunan adalah satu tahun ajaran: 1 Juli sampai 30 Juni.");
    }
  } else {
    const month = input.periodStart.slice(0, 7);
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    if (input.periodStart !== `${month}-01` || input.periodEnd !== last) {
      fail("Periode bulanan adalah satu bulan kalender penuh.");
    }
  }
  if (input.selfDueOn < input.periodStart) fail("Batas penilaian diri tidak boleh sebelum periode dimulai.");
  if (input.reviewDueOn < input.selfDueOn) fail("Batas penilaian atasan tidak boleh sebelum batas penilaian diri.");
}

/**
 * D-08 DRAFT: the rater scores once the employee submitted the self-assessment, or once its
 * deadline passed without one, so a silent employee cannot hold the cycle.
 */
export function canRaterReview(input: { status: ReviewStatus; selfDueOn: string; today: string }): boolean {
  if (input.status === "MANAGER_REVIEW") return true;
  return input.status === "SELF_ASSESSMENT" && input.today > input.selfDueOn;
}

/** D-10: closing the cycle. Reviews nobody finished stay without a predicate. */
export function statusOnClose(status: ReviewStatus): ReviewStatus {
  if (status === "SELF_ASSESSMENT" || status === "MANAGER_REVIEW") return "UNRATED";
  return status;
}
