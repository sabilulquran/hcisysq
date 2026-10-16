// EMP-005 / EMP-006 / EMP-010 domain model. Pure types: no database, HTTP,
// or storage dependency (AGENTS.md §4). Spec: docs/domain/employment-administration-package1.md.

import type { IsoDate } from "./dates.js";

export const EMPLOYMENT_CATEGORIES = [
  "TETAP",
  "KONTRAK",
  "KONTRAK_HONORER",
  "MAGANG",
  "PERCOBAAN",
  "LEPAS",
  "BELUM_DIKLASIFIKASIKAN",
] as const;
export type EmploymentCategory = (typeof EMPLOYMENT_CATEGORIES)[number];

export type StaffType = "PENDIDIK" | "KEPENDIDIKAN";

export const END_REASONS = [
  "RESIGN",
  "KONTRAK_BERAKHIR",
  "PENSIUN",
  "PEMBERHENTIAN",
  "MENINGGAL_DUNIA",
  "LAINNYA",
  "LAINNYA_DARI_MASTER",
] as const;
export type EndReason = (typeof END_REASONS)[number];

export type ActionType =
  | "BASELINE"
  | "HIRE"
  | "CONTRACT_EXTENSION"
  | "CATEGORY_CHANGE"
  | "PLACEMENT"
  | "TRANSFER"
  | "PROMOTION"
  | "DEMOTION"
  | "TERMINATION"
  | "REVERSAL";

export type DocumentKind = "PERJANJIAN_KERJA" | "SURAT_KEPUTUSAN";
export type PkType = "PK_BARU" | "PK_PERPANJANGAN";
export type SkType =
  | "SK_PENGANGKATAN"
  | "SK_MUTASI"
  | "SK_PROMOSI"
  | "SK_DEMOSI"
  | "SK_PEMBERHENTIAN"
  | "SK_PENEMPATAN"
  | "SK_LAINNYA";

export type UnitRef =
  | { kind: "ORG_NODE"; key: string }
  | { kind: "LEGACY_UNIT"; id: string };

export type PositionRef =
  | { kind: "ORG_POSITION"; key: string }
  | { kind: "LEGACY_POSITION"; id: string };

export interface EmploymentRecord {
  id: string;
  employeeId: string;
  legalEntityKey: string | null;
  staffType: StaffType | null;
  startedOn: IsoDate | null;
  startBasis: "RECORDED" | "UNKNOWN";
  serviceStartOn: IsoDate | null;
  endedOn: IsoDate | null;
  endBasis: "RECORDED" | "UNKNOWN" | null;
  endPrecision: "DAY" | "MONTH" | null;
  endReason: EndReason | null;
  voided: boolean;
  version: number;
}

export interface TermRecord {
  id: string;
  employmentId: string;
  sequence: number;
  category: EmploymentCategory;
  effectiveFrom: IsoDate | null;
  effectiveTo: IsoDate | null;
  contractReference: string | null;
  voided: boolean;
}

export interface PlacementRecord {
  id: string;
  employmentId: string;
  kind: "PRIMARY" | "ADDITIONAL";
  unitRef: UnitRef;
  positionRef: PositionRef | null;
  jobTitleLabel: string;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  effectiveFromBasis: "RECORDED" | "BASELINE_ASSUMED";
  voided: boolean;
}

/** One structured change made by an action; the source for exact reversal. */
export type RowTable = "EMPLOYMENT" | "TERM" | "PLACEMENT";

export type RowChange =
  | { op: "OPEN"; table: RowTable; id: string }
  | { op: "VOID"; table: RowTable; id: string }
  | {
      op: "SET";
      table: RowTable;
      id: string;
      previous: Record<string, string | null>;
      next: Record<string, string | null>;
    };

export interface ActionRecord {
  id: string;
  employmentId: string;
  actionType: ActionType;
  effectiveOn: IsoDate | null;
  state: "RECORDED" | "REVERSED";
  reversesActionId: string | null;
  /** ISO timestamp; orders actions that share an effective date. */
  recordedAt: string;
  rowChanges: RowChange[];
}

export interface EmploymentHistory {
  employeeId: string;
  employments: EmploymentRecord[];
  terms: TermRecord[];
  placements: PlacementRecord[];
  actions: ActionRecord[];
}

export interface DecisionDocumentRef {
  id: string;
  kind: DocumentKind;
  pkType: PkType | null;
  skType: SkType | null;
  /** Perjanjian Kerja only: the single employee it belongs to. */
  employeeId: string | null;
  contractFrom: IsoDate | null;
  contractTo: IsoDate | null;
  category: EmploymentCategory | null;
}

export type EmploymentFailureCode =
  | "EMPLOYMENT_FORBIDDEN"
  | "EMPLOYMENT_SELF_ACTION_FORBIDDEN"
  | "EMPLOYMENT_EFFECTIVE_DATE_REQUIRED"
  | "EMPLOYMENT_NOT_ACTIVE"
  | "EMPLOYMENT_ALREADY_ACTIVE"
  | "EMPLOYMENT_OVERLAP"
  | "EMPLOYMENT_ACTION_OUT_OF_ORDER"
  | "EMPLOYMENT_BACKDATE_NOT_ALLOWED"
  | "EMPLOYMENT_BACKDATE_REASON_REQUIRED"
  | "EMPLOYMENT_REFERENCE_INVALID"
  | "EMPLOYMENT_CROSS_ENTITY_UNSUPPORTED"
  | "EMPLOYMENT_TERM_END_REQUIRED"
  | "EMPLOYMENT_TERM_INVALID"
  | "EMPLOYMENT_REASON_REQUIRED"
  | "EMPLOYMENT_WARNINGS_NOT_ACKNOWLEDGED"
  | "EMPLOYMENT_ACTION_NOT_REVERSIBLE"
  | "EMPLOYMENT_BASELINE_MISSING"
  | "DECISION_DOCUMENT_REQUIRED"
  | "DECISION_DOCUMENT_KIND_INVALID"
  | "DECISION_DOCUMENT_EMPLOYEE_MISMATCH"
  | "PK_TERM_MISMATCH";

export type EmploymentWarningCode =
  | "BACKDATED"
  | "TERM_GAP"
  | "CONTRACT_DURATION_LONG"
  | "PROBATION_DURATION_LONG";

export class EmploymentDomainError extends Error {
  constructor(
    readonly code: EmploymentFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "EmploymentDomainError";
  }
}
