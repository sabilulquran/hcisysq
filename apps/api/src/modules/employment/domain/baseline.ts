// EMP-005 baseline ("data awal") from the current employee master (spec §4.2.1,
// §8.2). Pure: maps the owner-approved vocabulary, never invents a start,
// end, or contract date, and reports every uncertainty as an issue code.

import { isIsoDate, lastDayOfMonth, type IsoDate } from "./dates.js";
import type {
  EmploymentCategory,
  EmploymentHistory,
  EmploymentRecord,
  EndReason,
  PlacementRecord,
  RowChange,
  StaffType,
  TermRecord,
} from "./model.js";
import { isFixedTerm, type EmploymentPolicy } from "./policy.js";
import { resolveEmployment } from "./resolver.js";

export type BaselineIssueCode =
  | "BASELINE_EXCLUDED_BUMY"
  | "BASELINE_EXCLUDED_FOUNDATION_BOARD"
  | "BASELINE_NO_SOURCE_SNAPSHOT"
  | "BASELINE_START_UNKNOWN"
  | "BASELINE_END_UNKNOWN"
  | "BASELINE_END_PRECISION_ASSUMED"
  | "BASELINE_DATE_ORDER_INVALID"
  | "BASELINE_STATUS_CONFLICT"
  | "BASELINE_CATEGORY_MISSING"
  | "BASELINE_CATEGORY_UNMAPPED"
  | "BASELINE_CATEGORY_IS_STATUS"
  | "BASELINE_CATEGORY_CONFLICT_PKWT"
  | "BASELINE_CONTRACT_END_UNKNOWN"
  | "BASELINE_STAFF_TYPE_MISSING"
  | "BASELINE_PLACEMENT_MISSING"
  | "BASELINE_POSITION_MISSING"
  | "BASELINE_REMOVED_EMPLOYEE";

export interface BaselineSourceClassification {
  statusActive: string | null;
  employmentStatus: string | null;
  employmentType: string | null;
  endedOn: string | null;
}

/** The current master row plus its latest import source snapshot. */
export interface BaselineSource {
  employeeId: string;
  employeeStatus: "active" | "inactive" | "resigned";
  removed: boolean;
  startedOn: IsoDate | null;
  endedOn: IsoDate | null;
  employmentStatusText: string | null;
  employmentTypeText: string | null;
  legacyUnitId: string | null;
  legacyPositionId: string | null;
  positionName: string | null;
  functionalPosition: string | null;
  structuralPosition: string | null;
  sourceClassification: BaselineSourceClassification | null;
  sourceImportJobId: string | null;
  sourceSnapshotId: string | null;
}

export type BaselinePlan =
  | {
      outcome: "EXCLUDED";
      employeeId: string;
      exclusion: "BUMY" | "PENGURUS_YAYASAN";
      issues: BaselineIssueCode[];
    }
  | {
      outcome: "BASELINE";
      employeeId: string;
      issues: BaselineIssueCode[];
      employment: EmploymentRecord & { source: "BASELINE_FROM_MASTER" };
      term: TermRecord;
      placement: PlacementRecord | null;
      placementLabels: { functionalLabel: string | null; structuralLabel: string | null };
      action: {
        id: string;
        rowChanges: RowChange[];
        sourceImportJobId: string | null;
        sourceSnapshotId: string | null;
      };
    };

function key(value: string | null): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** D-02 mapping of STATUS KEPEGAWAIAN, accepted by the owner on 2026-10-16. */
const CATEGORY_BY_SOURCE: Readonly<Record<string, EmploymentCategory | "EXCLUDE_FOUNDATION_BOARD" | "IS_STATUS">> = {
  "pegawai tetap": "TETAP",
  "guru tetap": "TETAP",
  "guru/pegawai tetap": "TETAP",
  "pegawai kontrak": "KONTRAK",
  "pegawai kontrak honorer": "KONTRAK_HONORER",
  "calon pegawai tetap": "PERCOBAAN",
  "masa percobaan": "PERCOBAAN",
  "tenaga pengabdian": "MAGANG",
  magang: "MAGANG",
  "pegawai lepas": "LEPAS",
  "pengurus yayasan": "EXCLUDE_FOUNDATION_BOARD",
  "tidak aktif": "IS_STATUS",
};

const STAFF_TYPE_BY_SOURCE: Readonly<Record<string, StaffType>> = {
  "tenaga pendidik": "PENDIDIK",
  "tenaga kependidikan": "KEPENDIDIKAN",
};

export function mapStaffType(value: string | null): StaffType | null {
  return STAFF_TYPE_BY_SOURCE[key(value)] ?? null;
}

export function mapCategory(
  employmentStatus: string | null,
  statusActive: string | null,
): { category: EmploymentCategory; issue: BaselineIssueCode | null; excludeFoundationBoard: boolean } {
  const mapped = CATEGORY_BY_SOURCE[key(employmentStatus)];
  const pkwt = key(statusActive) === "aktif pkwt";
  if (mapped === "EXCLUDE_FOUNDATION_BOARD") return { category: "BELUM_DIKLASIFIKASIKAN", issue: null, excludeFoundationBoard: true };
  if (pkwt) {
    // D-02: "Aktif PKWT" → Pegawai Kontrak, unless the category column says otherwise.
    if (!employmentStatus || mapped === "KONTRAK") return { category: "KONTRAK", issue: null, excludeFoundationBoard: false };
    return { category: "BELUM_DIKLASIFIKASIKAN", issue: "BASELINE_CATEGORY_CONFLICT_PKWT", excludeFoundationBoard: false };
  }
  if (mapped === "IS_STATUS") return { category: "BELUM_DIKLASIFIKASIKAN", issue: "BASELINE_CATEGORY_IS_STATUS", excludeFoundationBoard: false };
  if (mapped) return { category: mapped, issue: null, excludeFoundationBoard: false };
  return {
    category: "BELUM_DIKLASIFIKASIKAN",
    issue: employmentStatus ? "BASELINE_CATEGORY_UNMAPPED" : "BASELINE_CATEGORY_MISSING",
    excludeFoundationBoard: false,
  };
}

function resolveEnd(
  source: BaselineSource,
  issues: BaselineIssueCode[],
): Pick<EmploymentRecord, "endedOn" | "endBasis" | "endPrecision" | "endReason"> {
  const open = { endedOn: null, endBasis: null, endPrecision: null, endReason: null } as const;
  if (source.employeeStatus === "active") {
    if (source.endedOn) issues.push("BASELINE_STATUS_CONFLICT");
    return open;
  }
  const endReason: EndReason = source.employeeStatus === "resigned" ? "RESIGN" : "LAINNYA_DARI_MASTER";
  if (!source.endedOn || !isIsoDate(source.endedOn)) {
    issues.push("BASELINE_END_UNKNOWN");
    return { endedOn: null, endBasis: "UNKNOWN", endPrecision: null, endReason };
  }
  const raw = source.sourceClassification?.endedOn ?? null;
  const [year, month] = source.endedOn.split("-").map(Number) as [number, number];
  let endedOn: IsoDate;
  let endPrecision: "DAY" | "MONTH";
  if (raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    endedOn = source.endedOn;
    endPrecision = "DAY";
  } else {
    // The column is "TAHUN KELUAR (TTTT-BB)": month precision, last day of that month.
    endedOn = lastDayOfMonth(year, month);
    endPrecision = "MONTH";
    if (raw === null) issues.push("BASELINE_END_PRECISION_ASSUMED");
  }
  if (source.startedOn && endedOn < source.startedOn) {
    issues.push("BASELINE_DATE_ORDER_INVALID");
    return { endedOn: null, endBasis: "UNKNOWN", endPrecision: null, endReason };
  }
  return { endedOn, endBasis: "RECORDED", endPrecision, endReason };
}

/**
 * Plans the baseline for one employee. `cutoff` is the baseline date: the
 * placement is recorded as "sejak data awal" from that date because its real
 * start is unknown (spec §8.2 step 3).
 */
export function planBaseline(
  source: BaselineSource,
  cutoff: IsoDate,
  policy: EmploymentPolicy,
  newId: () => string,
): BaselinePlan {
  const issues: BaselineIssueCode[] = [];
  const classification = source.sourceClassification;
  if (!classification) issues.push("BASELINE_NO_SOURCE_SNAPSHOT");
  if (source.removed) issues.push("BASELINE_REMOVED_EMPLOYEE");

  if (key(classification?.statusActive ?? null) === "aktif bumy") {
    return { outcome: "EXCLUDED", employeeId: source.employeeId, exclusion: "BUMY", issues: ["BASELINE_EXCLUDED_BUMY", ...issues] };
  }
  const employmentStatus = classification?.employmentStatus ?? source.employmentStatusText;
  const category = mapCategory(employmentStatus, classification?.statusActive ?? null);
  if (category.excludeFoundationBoard) {
    return {
      outcome: "EXCLUDED",
      employeeId: source.employeeId,
      exclusion: "PENGURUS_YAYASAN",
      issues: ["BASELINE_EXCLUDED_FOUNDATION_BOARD", ...issues],
    };
  }
  if (category.issue) issues.push(category.issue);

  const staffType = mapStaffType(classification?.employmentType ?? source.employmentTypeText);
  if (!staffType) issues.push("BASELINE_STAFF_TYPE_MISSING");

  const startedOn = source.startedOn && isIsoDate(source.startedOn) ? source.startedOn : null;
  if (!startedOn) issues.push("BASELINE_START_UNKNOWN");
  const end = resolveEnd({ ...source, startedOn }, issues);

  const employment: EmploymentRecord & { source: "BASELINE_FROM_MASTER" } = {
    id: newId(),
    employeeId: source.employeeId,
    legalEntityKey: null,
    staffType,
    startedOn,
    startBasis: startedOn ? "RECORDED" : "UNKNOWN",
    serviceStartOn: startedOn,
    ...end,
    voided: false,
    version: 0,
    source: "BASELINE_FROM_MASTER",
  };

  const term: TermRecord = {
    id: newId(),
    employmentId: employment.id,
    sequence: 1,
    category: category.category,
    effectiveFrom: startedOn,
    effectiveTo: end.endBasis === "RECORDED" ? end.endedOn : null,
    contractReference: null,
    voided: false,
  };
  if (end.endBasis === null && isFixedTerm(policy, term.category)) issues.push("BASELINE_CONTRACT_END_UNKNOWN");

  let placement: PlacementRecord | null = null;
  if (end.endBasis === null) {
    if (!source.legacyUnitId) {
      issues.push("BASELINE_PLACEMENT_MISSING");
    } else {
      const label = source.positionName?.trim() || source.structuralPosition?.trim() || source.functionalPosition?.trim() || null;
      if (!source.positionName?.trim()) issues.push("BASELINE_POSITION_MISSING");
      placement = {
        id: newId(),
        employmentId: employment.id,
        kind: "PRIMARY",
        unitRef: { kind: "LEGACY_UNIT", id: source.legacyUnitId },
        // ORG-011: a baseline states only what the employee master recorded, and the master
        // never held a classification. Human Capital assigns one later, deliberately.
        jobClassificationCode: null,
        positionRef: source.legacyPositionId ? { kind: "LEGACY_POSITION", id: source.legacyPositionId } : null,
        jobTitleLabel: label ?? "Jabatan belum diisi",
        effectiveFrom: startedOn && startedOn > cutoff ? startedOn : cutoff,
        effectiveTo: null,
        effectiveFromBasis: "BASELINE_ASSUMED",
        voided: false,
      };
    }
  }

  const rowChanges: RowChange[] = [
    { op: "OPEN", table: "EMPLOYMENT", id: employment.id },
    { op: "OPEN", table: "TERM", id: term.id },
    ...(placement ? [{ op: "OPEN" as const, table: "PLACEMENT" as const, id: placement.id }] : []),
  ];

  return {
    outcome: "BASELINE",
    employeeId: source.employeeId,
    issues,
    employment,
    term,
    placement,
    placementLabels: {
      functionalLabel: source.functionalPosition?.trim() || null,
      structuralLabel: source.structuralPosition?.trim() || null,
    },
    action: {
      id: newId(),
      rowChanges,
      sourceImportJobId: source.sourceImportJobId,
      sourceSnapshotId: source.sourceSnapshotId,
    },
  };
}

export type ConsistencyIssueCode =
  | BaselineIssueCode
  | "BASELINE_NOT_LOADED"
  | "HISTORY_DIFFERS_FROM_MASTER"
  | "ACTIVE_WITHOUT_PLACEMENT"
  | "CONTRACT_EXPIRED_WITHOUT_FOLLOW_UP"
  // EMP-006 S6: the two records of the same working life disagree.
  | "STRUCTURE_SEAT_WITHOUT_PLACEMENT"
  | "PLACEMENT_WITHOUT_STRUCTURE_SEAT";

export interface ConsistencyFinding {
  employeeId: string;
  codes: ConsistencyIssueCode[];
  /** Master fields that differ from the derived history (names only). */
  differingFields: string[];
}

/**
 * Consistency of one employee for the SHADOW review (spec §8.3, §13.6). With no
 * history yet, the would-be baseline issues are reported. With history, the
 * derived state is compared with the current master columns.
 */
export function checkConsistency(
  source: BaselineSource,
  history: EmploymentHistory | null,
  date: IsoDate,
  policy: EmploymentPolicy,
): ConsistencyFinding {
  const preview = planBaseline(source, date, policy, () => "preview");
  const hasHistory = history !== null && history.employments.some((employment) => !employment.voided);
  if (!hasHistory) {
    const codes: ConsistencyIssueCode[] = [...preview.issues];
    if (preview.outcome === "BASELINE") codes.unshift("BASELINE_NOT_LOADED");
    return { employeeId: source.employeeId, codes, differingFields: [] };
  }

  const codes: ConsistencyIssueCode[] = preview.outcome === "EXCLUDED" ? [...preview.issues] : [];
  const resolved = resolveEmployment(history, date, policy);
  const differingFields: string[] = [];
  if (resolved.projection.status !== null && resolved.projection.status !== source.employeeStatus) differingFields.push("status");
  if (resolved.employment && resolved.employment.startedOn !== source.startedOn) differingFields.push("startedOn");
  if (resolved.state === "AKTIF") {
    if (resolved.projection.legacyUnitId !== source.legacyUnitId) differingFields.push("organizationalUnitId");
    if (resolved.projection.legacyPositionId !== source.legacyPositionId) differingFields.push("positionId");
    const expected = mapCategory(source.sourceClassification?.employmentStatus ?? source.employmentStatusText, source.sourceClassification?.statusActive ?? null);
    if (resolved.projection.category !== null && !expected.issue && resolved.projection.category !== expected.category) {
      differingFields.push("employmentStatus");
    }
    if (resolved.flags.includes("TANPA_PENEMPATAN")) codes.push("ACTIVE_WITHOUT_PLACEMENT");
    if (resolved.flags.includes("KONTRAK_LEWAT_TANPA_TINDAK_LANJUT")) codes.push("CONTRACT_EXPIRED_WITHOUT_FOLLOW_UP");
  }
  if (differingFields.length > 0) codes.push("HISTORY_DIFFERS_FROM_MASTER");
  return { employeeId: source.employeeId, codes, differingFields };
}
