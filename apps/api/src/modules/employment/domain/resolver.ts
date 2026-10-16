// Derives current employment state from effective-dated records for any date
// (spec §6.2, §7.2). Nothing here writes "current" as a separate truth; the
// `employees` columns are a projection of this result (spec §8.4).

import { addDays, isWithin, type IsoDate } from "./dates.js";
import type {
  ActionRecord,
  EmploymentCategory,
  EmploymentHistory,
  EmploymentRecord,
  PlacementRecord,
  TermRecord,
} from "./model.js";
import { isFixedTerm, type EmploymentPolicy } from "./policy.js";

export type DerivedEmploymentState = "AKTIF" | "AKAN_MULAI" | "BERAKHIR" | "TANPA_DATA";

export type DerivedFlag =
  | "KONTRAK_SEGERA_BERAKHIR"
  | "KONTRAK_LEWAT_TANPA_TINDAK_LANJUT"
  | "TANPA_PENEMPATAN"
  | "TANGGAL_MULAI_TIDAK_DIKETAHUI"
  | "TANGGAL_AKHIR_TIDAK_DIKETAHUI";

export interface EmployeeStatusProjection {
  /** Value for `employees.status`; null means "do not touch" (no history yet). */
  status: "active" | "inactive" | "resigned" | null;
  category: EmploymentCategory | null;
  startedOn: IsoDate | null;
  endedOn: IsoDate | null;
  legacyUnitId: string | null;
  legacyPositionId: string | null;
  jobTitleLabel: string | null;
}

export interface ResolvedEmployment {
  date: IsoDate;
  state: DerivedEmploymentState;
  employment: EmploymentRecord | null;
  term: TermRecord | null;
  primaryPlacement: PlacementRecord | null;
  additionalPlacements: PlacementRecord[];
  flags: DerivedFlag[];
  projection: EmployeeStatusProjection;
}

function employmentCovers(employment: EmploymentRecord, date: IsoDate): boolean {
  if (employment.endBasis === "UNKNOWN") return false;
  return isWithin(date, employment.startedOn, employment.endedOn);
}

function latestEmployment(employments: EmploymentRecord[]): EmploymentRecord | null {
  // Ordered by start date; unknown start sorts first.
  const sorted = [...employments].sort((a, b) => (a.startedOn ?? "").localeCompare(b.startedOn ?? ""));
  return sorted.at(-1) ?? null;
}

export function liveEmployments(history: EmploymentHistory): EmploymentRecord[] {
  return history.employments.filter((employment) => !employment.voided);
}

export function liveTerms(history: EmploymentHistory, employmentId: string): TermRecord[] {
  return history.terms
    .filter((term) => !term.voided && term.employmentId === employmentId)
    .sort((a, b) => a.sequence - b.sequence);
}

export function livePlacements(history: EmploymentHistory, employmentId: string): PlacementRecord[] {
  return history.placements
    .filter((placement) => !placement.voided && placement.employmentId === employmentId)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

/** RECORDED, non-reversal actions in effective order (stack order for reversal). */
export function activeActions(history: EmploymentHistory, employmentId: string): ActionRecord[] {
  return history.actions
    .filter((action) => action.employmentId === employmentId && action.state === "RECORDED" && action.actionType !== "REVERSAL")
    .sort((a, b) => {
      const byDate = (a.effectiveOn ?? "").localeCompare(b.effectiveOn ?? "");
      return byDate !== 0 ? byDate : a.recordedAt.localeCompare(b.recordedAt);
    });
}

export function resolveEmployment(
  history: EmploymentHistory,
  date: IsoDate,
  policy: EmploymentPolicy,
): ResolvedEmployment {
  const employments = liveEmployments(history);
  const emptyProjection: EmployeeStatusProjection = {
    status: null,
    category: null,
    startedOn: null,
    endedOn: null,
    legacyUnitId: null,
    legacyPositionId: null,
    jobTitleLabel: null,
  };

  if (employments.length === 0) {
    return {
      date,
      state: "TANPA_DATA",
      employment: null,
      term: null,
      primaryPlacement: null,
      additionalPlacements: [],
      flags: [],
      projection: emptyProjection,
    };
  }

  const current = employments.find((employment) => employmentCovers(employment, date)) ?? null;
  if (!current) {
    // Earliest future employment, independent of array order (review of #113, item 6).
    const future = employments
      .filter((employment) => employment.startedOn !== null && employment.startedOn > date && employment.endBasis !== "UNKNOWN")
      .sort((a, b) => (a.startedOn as string).localeCompare(b.startedOn as string))[0];
    const latest = latestEmployment(employments) as EmploymentRecord;
    const ended = future ?? latest;
    const state: DerivedEmploymentState = future ? "AKAN_MULAI" : "BERAKHIR";
    const flags: DerivedFlag[] = [];
    if (!future && latest.endBasis === "UNKNOWN") flags.push("TANGGAL_AKHIR_TIDAK_DIKETAHUI");
    return {
      date,
      state,
      employment: ended,
      term: null,
      primaryPlacement: null,
      additionalPlacements: [],
      flags,
      projection: {
        ...emptyProjection,
        status: state === "BERAKHIR" && latest.endReason === "RESIGN" ? "resigned" : "inactive",
        startedOn: ended.startedOn,
        endedOn: ended.endedOn,
        category: liveTerms(history, ended.id).at(-1)?.category ?? null,
      },
    };
  }

  const terms = liveTerms(history, current.id);
  const term = terms.find((candidate) => isWithin(date, candidate.effectiveFrom, candidate.effectiveTo)) ?? null;
  const placements = livePlacements(history, current.id).filter((placement) =>
    isWithin(date, placement.effectiveFrom, placement.effectiveTo),
  );
  const primaryPlacement = placements.find((placement) => placement.kind === "PRIMARY") ?? null;
  const additionalPlacements = placements.filter((placement) => placement.kind === "ADDITIONAL");

  const flags: DerivedFlag[] = [];
  if (current.startBasis === "UNKNOWN") flags.push("TANGGAL_MULAI_TIDAK_DIKETAHUI");
  if (!primaryPlacement) flags.push("TANPA_PENEMPATAN");

  const lastTerm = terms.at(-1) ?? null;
  if (term && term.effectiveTo !== null && isFixedTerm(policy, term.category)) {
    const hasFollowUp = terms.some((candidate) => candidate.sequence > term.sequence);
    if (!hasFollowUp && term.effectiveTo <= addDays(date, policy.contractReminderDays)) {
      flags.push("KONTRAK_SEGERA_BERAKHIR");
    }
  }
  if (!term && lastTerm && lastTerm.effectiveTo !== null && lastTerm.effectiveTo < date && isFixedTerm(policy, lastTerm.category)) {
    flags.push("KONTRAK_LEWAT_TANPA_TINDAK_LANJUT");
  }

  const unitRef = primaryPlacement?.unitRef ?? null;
  const positionRef = primaryPlacement?.positionRef ?? null;
  return {
    date,
    state: "AKTIF",
    employment: current,
    term,
    primaryPlacement,
    additionalPlacements,
    flags,
    projection: {
      status: "active",
      // An expired, unfollowed contract keeps showing its last category.
      category: term?.category ?? lastTerm?.category ?? null,
      startedOn: current.startedOn,
      endedOn: current.endedOn,
      legacyUnitId: unitRef?.kind === "LEGACY_UNIT" ? unitRef.id : null,
      legacyPositionId: positionRef?.kind === "LEGACY_POSITION" ? positionRef.id : null,
      jobTitleLabel: primaryPlacement?.jobTitleLabel ?? null,
    },
  };
}
