// Plans one employment action against the existing history (spec §5–§7, §12).
// The planner is pure: it returns the rows to open, the fields to change, and
// the rows to void, or throws EmploymentDomainError. Infrastructure applies a
// plan in one transaction; it never re-derives business rules.

import { addDays, addMonths, daysBetween, isIsoDate, isWithin, rangesOverlap, type IsoDate } from "./dates.js";
import {
  END_REASONS,
  EmploymentDomainError,
  type ActionRecord,
  type ActionType,
  type DecisionDocumentRef,
  type EmploymentCategory,
  type EmploymentHistory,
  type EmploymentRecord,
  type EmploymentWarningCode,
  type EndReason,
  type PlacementRecord,
  type PositionRef,
  type RowChange,
  type RowTable,
  type StaffType,
  type TermRecord,
  type UnitRef,
} from "./model.js";
import { isFixedTerm, requiredDocument, type EmploymentPolicy } from "./policy.js";
import { activeActions, liveEmployments, livePlacements, liveTerms } from "./resolver.js";

export interface PlacementInput {
  kind: "PRIMARY" | "ADDITIONAL";
  unitRef: UnitRef;
  positionRef: PositionRef | null;
  jobTitleLabel: string;
}

interface CommonInput {
  reasonNote?: string | null;
  documents?: DecisionDocumentRef[];
  acknowledgedWarnings?: EmploymentWarningCode[];
}

export type ActionInput = CommonInput &
  (
    | {
        actionType: "HIRE";
        effectiveOn: IsoDate;
        category: EmploymentCategory;
        termEndOn: IsoDate | null;
        staffType: StaffType | null;
        contractReference?: string | null;
        placement: PlacementInput;
        legalEntityKey?: string | null;
      }
    | { actionType: "CONTRACT_EXTENSION"; effectiveOn: IsoDate; termEndOn: IsoDate; contractReference?: string | null }
    | {
        actionType: "CATEGORY_CHANGE";
        effectiveOn: IsoDate;
        category: EmploymentCategory;
        termEndOn: IsoDate | null;
        contractReference?: string | null;
      }
    | { actionType: "PLACEMENT"; effectiveOn: IsoDate; placement: PlacementInput }
    | { actionType: "PLACEMENT"; effectiveOn: IsoDate; endAdditionalPlacementId: string }
    | {
        actionType: "TRANSFER" | "PROMOTION" | "DEMOTION";
        effectiveOn: IsoDate;
        placement: Omit<PlacementInput, "kind">;
        reasonCode?: string | null;
        legalEntityKey?: string | null;
      }
    | { actionType: "TERMINATION"; lastDayOn: IsoDate; reasonCode: EndReason }
    | { actionType: "REVERSAL"; targetActionId: string; reasonCode: string }
  );

export interface PlanningContext {
  /** Asia/Jakarta business date. */
  today: IsoDate;
  /** Employee linked to the acting account, if any (self-action guard). */
  actorEmployeeId: string | null;
  /** Holder of `employment.correct`. */
  canCorrect: boolean;
  /** Preview skips "document required" and acknowledgement checks; record enforces them. */
  mode: "preview" | "record";
  newId: () => string;
  /** Infrastructure check that a unit/position reference exists on the date. */
  isReferenceValid?: (unitRef: UnitRef, positionRef: PositionRef | null, date: IsoDate) => boolean;
}

export interface PlacementSummary {
  unitRef: UnitRef;
  positionRef: PositionRef | null;
  jobTitleLabel: string;
}

export interface ActionSnapshot {
  category?: EmploymentCategory | null;
  termFrom?: IsoDate | null;
  termTo?: IsoDate | null;
  placement?: PlacementSummary | null;
  endedOn?: IsoDate | null;
  endReason?: EndReason | null;
}

export interface ActionPlan {
  actionId: string;
  actionType: ActionType;
  employeeId: string;
  employmentId: string;
  effectiveOn: IsoDate;
  reasonCode: string | null;
  reasonNote: string | null;
  reversesActionId: string | null;
  newEmployment: EmploymentRecord | null;
  newTerms: TermRecord[];
  newPlacements: PlacementRecord[];
  /** Persisted on the action; OPEN/SET/VOID in application order. */
  rowChanges: RowChange[];
  documentIds: string[];
  warnings: EmploymentWarningCode[];
  previousSnapshot: ActionSnapshot;
  newSnapshot: ActionSnapshot;
  /** Optimistic-concurrency token of the affected employment (null for HIRE). */
  expectedVersion: number | null;
}

type ActionGroup = "TERM" | "PLACEMENT" | "ALL";

function groupOf(actionType: ActionType): ActionGroup {
  switch (actionType) {
    case "CONTRACT_EXTENSION":
    case "CATEGORY_CHANGE":
      return "TERM";
    case "PLACEMENT":
    case "TRANSFER":
    case "PROMOTION":
    case "DEMOTION":
      return "PLACEMENT";
    default:
      return "ALL";
  }
}

function fail(code: ConstructorParameters<typeof EmploymentDomainError>[0], message: string): never {
  throw new EmploymentDomainError(code, message);
}

function covers(employment: EmploymentRecord, date: IsoDate): boolean {
  return employment.endBasis !== "UNKNOWN" && isWithin(date, employment.startedOn, employment.endedOn);
}

function placementSummary(placement: PlacementRecord | null | undefined): PlacementSummary | null {
  if (!placement) return null;
  return { unitRef: placement.unitRef, positionRef: placement.positionRef, jobTitleLabel: placement.jobTitleLabel };
}

function sameRef(a: UnitRef | PositionRef | null, b: UnitRef | PositionRef | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

class PlanBuilder {
  readonly rowChanges: RowChange[] = [];
  readonly newTerms: TermRecord[] = [];
  readonly newPlacements: PlacementRecord[] = [];
  newEmployment: EmploymentRecord | null = null;
  readonly warnings: EmploymentWarningCode[] = [];

  warn(code: EmploymentWarningCode) {
    if (!this.warnings.includes(code)) this.warnings.push(code);
  }

  open(table: RowTable, id: string) {
    this.rowChanges.push({ op: "OPEN", table, id });
  }

  set(table: RowTable, id: string, previous: Record<string, string | null>, next: Record<string, string | null>) {
    this.rowChanges.push({ op: "SET", table, id, previous, next });
  }

  /** Close a term/placement on `lastDay`; fails closed if that would cut before its start. */
  close(table: "TERM" | "PLACEMENT", record: { id: string; effectiveFrom: IsoDate | null; effectiveTo: IsoDate | null }, lastDay: IsoDate) {
    if (record.effectiveFrom !== null && lastDay < record.effectiveFrom) {
      fail(
        "EMPLOYMENT_ACTION_OUT_OF_ORDER",
        "Sudah ada data yang berlaku setelah tanggal ini. Batalkan tindakan tersebut lebih dulu.",
      );
    }
    if (record.effectiveTo !== null && record.effectiveTo <= lastDay) return;
    this.set(table, record.id, { effectiveTo: record.effectiveTo }, { effectiveTo: lastDay });
  }
}

function validateTermEnd(policy: EmploymentPolicy, category: EmploymentCategory, from: IsoDate, termEndOn: IsoDate | null) {
  if (category === "BELUM_DIKLASIFIKASIKAN") {
    fail("EMPLOYMENT_TERM_INVALID", "Pilih status kepegawaian yang berlaku.");
  }
  if (isFixedTerm(policy, category)) {
    if (termEndOn === null || !isIsoDate(termEndOn)) {
      fail("EMPLOYMENT_TERM_END_REQUIRED", "Status kepegawaian ini wajib memiliki tanggal akhir kontrak.");
    }
    if (termEndOn < from) fail("EMPLOYMENT_TERM_INVALID", "Tanggal akhir kontrak sebelum tanggal mulai.");
  } else if (termEndOn !== null) {
    fail("EMPLOYMENT_TERM_INVALID", "Pegawai tetap tidak memiliki tanggal akhir kontrak.");
  }
}

function addDurationWarnings(
  builder: PlanBuilder,
  policy: EmploymentPolicy,
  previousTerms: TermRecord[],
  category: EmploymentCategory,
  from: IsoDate,
  to: IsoDate | null,
) {
  if (to === null || !isFixedTerm(policy, category)) return;
  if (category === "PERCOBAAN" && to >= addMonths(from, policy.probationWarningMonths)) {
    builder.warn("PROBATION_DURATION_LONG");
  }
  // Continuous fixed-term chain ending with the new term.
  let chainStart = from;
  for (const term of [...previousTerms].reverse()) {
    if (!isFixedTerm(policy, term.category) || term.effectiveFrom === null || term.effectiveTo === null) break;
    if (addDays(term.effectiveTo, 1) < chainStart) break;
    chainStart = term.effectiveFrom < chainStart ? term.effectiveFrom : chainStart;
  }
  if (to >= addMonths(chainStart, policy.contractWarningMonths)) builder.warn("CONTRACT_DURATION_LONG");
}

function validateDocuments(
  plan: { actionType: ActionType; employeeId: string; category?: EmploymentCategory; terminationReason?: EndReason; term?: { from: IsoDate; to: IsoDate | null; category: EmploymentCategory } },
  documents: DecisionDocumentRef[],
  policy: EmploymentPolicy,
  mode: PlanningContext["mode"],
) {
  const requirementContext: { category?: EmploymentCategory; terminationReason?: EndReason } = {};
  if (plan.category !== undefined) requirementContext.category = plan.category;
  if (plan.terminationReason !== undefined) requirementContext.terminationReason = plan.terminationReason;
  const requirement = requiredDocument(policy, plan.actionType, requirementContext);

  for (const document of documents) {
    if (document.kind === "PERJANJIAN_KERJA" && document.employeeId !== plan.employeeId) {
      fail("DECISION_DOCUMENT_EMPLOYEE_MISMATCH", "Perjanjian Kerja ini milik pegawai lain.");
    }
  }
  if (!requirement) return;

  const matching = documents.filter((document) => {
    if (document.kind !== requirement.kind) return false;
    if (requirement.pkTypes && (!document.pkType || !requirement.pkTypes.includes(document.pkType))) return false;
    if (requirement.skTypes && (!document.skType || !requirement.skTypes.includes(document.skType))) return false;
    return true;
  });
  if (documents.length > 0 && matching.length === 0) {
    fail(
      "DECISION_DOCUMENT_KIND_INVALID",
      "Jenis dokumen tidak sesuai. Perpanjangan kontrak memakai Perjanjian Kerja; mutasi/promosi/demosi/pengangkatan/pemberhentian memakai SK.",
    );
  }
  if (matching.length === 0) {
    if (mode === "record") fail("DECISION_DOCUMENT_REQUIRED", "Tindakan ini membutuhkan dokumen dasar (Perjanjian Kerja atau SK).");
    return;
  }
  if (requirement.kind === "PERJANJIAN_KERJA" && plan.term) {
    const term = plan.term;
    const pkMatches = matching.some(
      (document) => document.contractFrom === term.from && document.contractTo === term.to && document.category === term.category,
    );
    if (!pkMatches) fail("PK_TERM_MISMATCH", "Masa kontrak tidak sama dengan yang tertulis di Perjanjian Kerja.");
  }
}

function checkOrdering(history: EmploymentHistory, employmentId: string, actionType: ActionType, date: IsoDate) {
  const group = groupOf(actionType);
  for (const action of activeActions(history, employmentId)) {
    if (action.effectiveOn === null) continue;
    const later = action.effectiveOn > date;
    const sameDayConflict =
      action.effectiveOn === date && (group === "ALL" || groupOf(action.actionType) === "ALL" || groupOf(action.actionType) === group);
    if (later || sameDayConflict) {
      fail(
        "EMPLOYMENT_ACTION_OUT_OF_ORDER",
        "Sudah ada tindakan lain pada atau setelah tanggal ini. Batalkan tindakan tersebut lebih dulu.",
      );
    }
  }
}

function checkReference(context: PlanningContext, unitRef: UnitRef, positionRef: PositionRef | null, date: IsoDate) {
  if (context.isReferenceValid && !context.isReferenceValid(unitRef, positionRef, date)) {
    fail("EMPLOYMENT_REFERENCE_INVALID", "Unit atau jabatan tujuan tidak ditemukan pada struktur yang berlaku.");
  }
}

function requireCurrentEmployment(history: EmploymentHistory, date: IsoDate): EmploymentRecord {
  const employments = liveEmployments(history);
  if (employments.length === 0) {
    fail("EMPLOYMENT_BASELINE_MISSING", "Data awal kepegawaian pegawai ini belum tersedia.");
  }
  const current = employments.find((employment) => covers(employment, date));
  if (!current) fail("EMPLOYMENT_NOT_ACTIVE", "Hubungan kerja pegawai tidak aktif pada tanggal tersebut.");
  return current;
}

function effectiveDateOf(input: ActionInput, context: PlanningContext): IsoDate {
  if (input.actionType === "REVERSAL") return context.today;
  const date = input.actionType === "TERMINATION" ? input.lastDayOn : input.effectiveOn;
  if (!isIsoDate(date)) fail("EMPLOYMENT_EFFECTIVE_DATE_REQUIRED", "Tanggal berlaku wajib diisi.");
  return date;
}

export function planEmploymentAction(
  history: EmploymentHistory,
  input: ActionInput,
  policy: EmploymentPolicy,
  context: PlanningContext,
): ActionPlan {
  if (context.actorEmployeeId !== null && context.actorEmployeeId === history.employeeId) {
    fail("EMPLOYMENT_SELF_ACTION_FORBIDDEN", "Tindakan kepegawaian untuk diri sendiri harus dicatat oleh petugas lain.");
  }
  if (input.actionType === "REVERSAL") return planReversal(history, input, context);

  const date = effectiveDateOf(input, context);
  const builder = new PlanBuilder();
  const reasonNote = input.reasonNote?.trim() ? input.reasonNote.trim() : null;
  const reasonCode = "reasonCode" in input && input.reasonCode ? input.reasonCode : null;

  if (date < context.today) {
    if (daysBetween(date, context.today) > policy.backdatingWindowDays && !context.canCorrect) {
      fail("EMPLOYMENT_BACKDATE_NOT_ALLOWED", "Tanggal terlalu jauh ke belakang; butuh kewenangan koreksi.");
    }
    if (!reasonNote && !reasonCode) {
      fail("EMPLOYMENT_BACKDATE_REASON_REQUIRED", "Tindakan yang berlaku mundur wajib disertai alasan.");
    }
    builder.warn("BACKDATED");
  }

  let employment: EmploymentRecord;
  let previousSnapshot: ActionSnapshot = {};
  let newSnapshot: ActionSnapshot = {};
  const documentContext: Parameters<typeof validateDocuments>[0] = { actionType: input.actionType, employeeId: history.employeeId };

  switch (input.actionType) {
    case "HIRE": {
      const employments = liveEmployments(history);
      if (employments.some((existing) => existing.endBasis === "UNKNOWN")) {
        fail("EMPLOYMENT_OVERLAP", "Tanggal akhir hubungan kerja sebelumnya belum diketahui; lengkapi dulu.");
      }
      if (employments.some((existing) => covers(existing, date))) {
        fail("EMPLOYMENT_ALREADY_ACTIVE", "Pegawai masih memiliki hubungan kerja aktif.");
      }
      if (employments.some((existing) => rangesOverlap(existing.startedOn, existing.endedOn, date, null))) {
        fail("EMPLOYMENT_OVERLAP", "Periode bertabrakan dengan data yang sudah ada.");
      }
      if (input.legalEntityKey) {
        fail("EMPLOYMENT_CROSS_ENTITY_UNSUPPORTED", "Badan hukum lain belum didukung.");
      }
      if (input.placement.kind !== "PRIMARY") {
        fail("EMPLOYMENT_TERM_INVALID", "Hubungan kerja baru dimulai dengan penempatan utama.");
      }
      validateTermEnd(policy, input.category, date, input.termEndOn);
      checkReference(context, input.placement.unitRef, input.placement.positionRef, date);

      employment = {
        id: context.newId(),
        employeeId: history.employeeId,
        legalEntityKey: null,
        staffType: input.staffType,
        startedOn: date,
        startBasis: "RECORDED",
        serviceStartOn: date,
        endedOn: null,
        endBasis: null,
        endPrecision: null,
        endReason: null,
        voided: false,
        version: 0,
      };
      builder.newEmployment = employment;
      builder.open("EMPLOYMENT", employment.id);
      const term = newTerm(context, employment.id, 1, input.category, date, input.termEndOn, input.contractReference ?? null);
      builder.newTerms.push(term);
      builder.open("TERM", term.id);
      const placement = newPlacement(context, employment.id, input.placement, date);
      builder.newPlacements.push(placement);
      builder.open("PLACEMENT", placement.id);
      addDurationWarnings(builder, policy, [], input.category, date, input.termEndOn);
      documentContext.category = input.category;
      documentContext.term = { from: date, to: input.termEndOn, category: input.category };
      newSnapshot = { category: input.category, termFrom: date, termTo: input.termEndOn, placement: placementSummary(placement) };
      break;
    }

    case "CONTRACT_EXTENSION": {
      employment = requireCurrentEmployment(history, date);
      checkOrdering(history, employment.id, input.actionType, date);
      const terms = liveTerms(history, employment.id);
      const last = terms.at(-1);
      if (!last || !isFixedTerm(policy, last.category)) {
        fail("EMPLOYMENT_TERM_INVALID", "Perpanjangan hanya untuk status kontrak; gunakan Ubah status kepegawaian.");
      }
      if (last.effectiveTo === null || date <= last.effectiveTo) {
        builder.close("TERM", last, addDays(date, -1));
      } else if (addDays(last.effectiveTo, 1) < date) {
        builder.warn("TERM_GAP");
      }
      validateTermEnd(policy, last.category, date, input.termEndOn);
      const term = newTerm(context, employment.id, last.sequence + 1, last.category, date, input.termEndOn, input.contractReference ?? null);
      builder.newTerms.push(term);
      builder.open("TERM", term.id);
      addDurationWarnings(builder, policy, terms, last.category, date, input.termEndOn);
      documentContext.category = last.category;
      documentContext.term = { from: date, to: input.termEndOn, category: last.category };
      previousSnapshot = { category: last.category, termFrom: last.effectiveFrom, termTo: last.effectiveTo };
      newSnapshot = { category: last.category, termFrom: date, termTo: input.termEndOn };
      break;
    }

    case "CATEGORY_CHANGE": {
      employment = requireCurrentEmployment(history, date);
      checkOrdering(history, employment.id, input.actionType, date);
      const terms = liveTerms(history, employment.id);
      const last = terms.at(-1);
      if (last && last.category === input.category) {
        fail("EMPLOYMENT_TERM_INVALID", "Status kepegawaian baru sama dengan yang berlaku.");
      }
      validateTermEnd(policy, input.category, date, input.termEndOn);
      if (last) {
        if (last.effectiveTo === null || date <= last.effectiveTo) {
          builder.close("TERM", last, addDays(date, -1));
        } else if (addDays(last.effectiveTo, 1) < date) {
          builder.warn("TERM_GAP");
        }
      }
      const term = newTerm(context, employment.id, (last?.sequence ?? 0) + 1, input.category, date, input.termEndOn, input.contractReference ?? null);
      builder.newTerms.push(term);
      builder.open("TERM", term.id);
      addDurationWarnings(builder, policy, terms, input.category, date, input.termEndOn);
      documentContext.category = input.category;
      documentContext.term = { from: date, to: input.termEndOn, category: input.category };
      previousSnapshot = { category: last?.category ?? null, termFrom: last?.effectiveFrom ?? null, termTo: last?.effectiveTo ?? null };
      newSnapshot = { category: input.category, termFrom: date, termTo: input.termEndOn };
      break;
    }

    case "PLACEMENT": {
      employment = requireCurrentEmployment(history, date);
      checkOrdering(history, employment.id, input.actionType, date);
      const placements = livePlacements(history, employment.id);
      if ("endAdditionalPlacementId" in input) {
        const target = placements.find((placement) => placement.id === input.endAdditionalPlacementId);
        if (!target || target.kind !== "ADDITIONAL" || !isWithin(addDays(date, -1), target.effectiveFrom, target.effectiveTo)) {
          fail("EMPLOYMENT_REFERENCE_INVALID", "Tugas tambahan yang dipilih tidak aktif pada tanggal tersebut.");
        }
        builder.close("PLACEMENT", target, addDays(date, -1));
        previousSnapshot = { placement: placementSummary(target) };
        newSnapshot = { placement: null };
        break;
      }
      const requested = input.placement;
      checkReference(context, requested.unitRef, requested.positionRef, date);
      const clashes = placements.filter((placement) => {
        if (!rangesOverlap(placement.effectiveFrom, placement.effectiveTo, date, null)) return false;
        if (requested.kind === "PRIMARY") return placement.kind === "PRIMARY";
        return placement.kind === "ADDITIONAL" && requested.positionRef !== null && sameRef(placement.positionRef, requested.positionRef);
      });
      if (clashes.length > 0) {
        fail(
          "EMPLOYMENT_OVERLAP",
          requested.kind === "PRIMARY"
            ? "Pegawai sudah memiliki penempatan utama; gunakan Mutasi, Promosi, atau Demosi."
            : "Tugas tambahan pada jabatan ini sudah tercatat.",
        );
      }
      const placement = newPlacement(context, employment.id, requested, date);
      builder.newPlacements.push(placement);
      builder.open("PLACEMENT", placement.id);
      newSnapshot = { placement: placementSummary(placement) };
      break;
    }

    case "TRANSFER":
    case "PROMOTION":
    case "DEMOTION": {
      employment = requireCurrentEmployment(history, date);
      if (input.legalEntityKey !== undefined && input.legalEntityKey !== null && input.legalEntityKey !== employment.legalEntityKey) {
        fail("EMPLOYMENT_CROSS_ENTITY_UNSUPPORTED", "Perpindahan antar badan hukum belum didukung.");
      }
      if (input.actionType === "DEMOTION" && !reasonCode) {
        fail("EMPLOYMENT_REASON_REQUIRED", "Demosi wajib disertai kode alasan.");
      }
      checkOrdering(history, employment.id, input.actionType, date);
      const current = livePlacements(history, employment.id).find(
        (placement) => placement.kind === "PRIMARY" && isWithin(date, placement.effectiveFrom, placement.effectiveTo),
      );
      if (!current) {
        fail("EMPLOYMENT_NOT_ACTIVE", "Tidak ada penempatan utama aktif; gunakan Penempatan.");
      }
      if (sameRef(current.unitRef, input.placement.unitRef) && sameRef(current.positionRef, input.placement.positionRef)) {
        fail("EMPLOYMENT_REFERENCE_INVALID", "Unit dan jabatan tujuan sama dengan penempatan saat ini.");
      }
      checkReference(context, input.placement.unitRef, input.placement.positionRef, date);
      builder.close("PLACEMENT", current, addDays(date, -1));
      const placement = newPlacement(context, employment.id, { ...input.placement, kind: "PRIMARY" }, date);
      builder.newPlacements.push(placement);
      builder.open("PLACEMENT", placement.id);
      previousSnapshot = { placement: placementSummary(current) };
      newSnapshot = { placement: placementSummary(placement) };
      break;
    }

    case "TERMINATION": {
      if (!(END_REASONS as readonly string[]).includes(input.reasonCode) || input.reasonCode === "LAINNYA_DARI_MASTER") {
        fail("EMPLOYMENT_REASON_REQUIRED", "Pilih alasan berakhirnya hubungan kerja.");
      }
      employment = requireCurrentEmployment(history, date);
      checkOrdering(history, employment.id, input.actionType, date);
      for (const term of liveTerms(history, employment.id)) {
        if (isWithin(date, term.effectiveFrom, term.effectiveTo)) builder.close("TERM", term, date);
      }
      for (const placement of livePlacements(history, employment.id)) {
        if (isWithin(date, placement.effectiveFrom, placement.effectiveTo)) builder.close("PLACEMENT", placement, date);
      }
      builder.set(
        "EMPLOYMENT",
        employment.id,
        { endedOn: employment.endedOn, endReason: employment.endReason, endBasis: employment.endBasis, endPrecision: employment.endPrecision },
        { endedOn: date, endReason: input.reasonCode, endBasis: "RECORDED", endPrecision: "DAY" },
      );
      documentContext.terminationReason = input.reasonCode;
      previousSnapshot = { endedOn: employment.endedOn };
      newSnapshot = { endedOn: date, endReason: input.reasonCode };
      break;
    }
  }

  const documents = input.documents ?? [];
  validateDocuments(documentContext, documents, policy, context.mode);

  const acknowledged = input.acknowledgedWarnings ?? [];
  if (context.mode === "record" && builder.warnings.some((warning) => !acknowledged.includes(warning))) {
    fail("EMPLOYMENT_WARNINGS_NOT_ACKNOWLEDGED", "Periksa dan centang peringatan sebelum menyimpan.");
  }

  return {
    actionId: context.newId(),
    actionType: input.actionType,
    employeeId: history.employeeId,
    employmentId: employment.id,
    effectiveOn: date,
    reasonCode,
    reasonNote,
    reversesActionId: null,
    newEmployment: builder.newEmployment,
    newTerms: builder.newTerms,
    newPlacements: builder.newPlacements,
    rowChanges: builder.rowChanges,
    documentIds: documents.map((document) => document.id),
    warnings: builder.warnings,
    previousSnapshot,
    newSnapshot,
    expectedVersion: builder.newEmployment ? null : employment.version,
  };
}

function newTerm(
  context: PlanningContext,
  employmentId: string,
  sequence: number,
  category: EmploymentCategory,
  from: IsoDate,
  to: IsoDate | null,
  contractReference: string | null,
): TermRecord {
  return { id: context.newId(), employmentId, sequence, category, effectiveFrom: from, effectiveTo: to, contractReference, voided: false };
}

function newPlacement(context: PlanningContext, employmentId: string, input: PlacementInput, from: IsoDate): PlacementRecord {
  if (!input.jobTitleLabel.trim()) fail("EMPLOYMENT_REFERENCE_INVALID", "Label jabatan wajib diisi.");
  return {
    id: context.newId(),
    employmentId,
    kind: input.kind,
    unitRef: input.unitRef,
    positionRef: input.positionRef,
    jobTitleLabel: input.jobTitleLabel.trim(),
    effectiveFrom: from,
    effectiveTo: null,
    effectiveFromBasis: "RECORDED",
    voided: false,
  };
}

/**
 * Reverses the latest recorded action of an employment exactly: rows it opened
 * are voided and fields it set return to their previous values (spec §6.1).
 */
function planReversal(
  history: EmploymentHistory,
  input: Extract<ActionInput, { actionType: "REVERSAL" }>,
  context: PlanningContext,
): ActionPlan {
  if (!context.canCorrect) fail("EMPLOYMENT_FORBIDDEN", "Pembatalan tindakan membutuhkan kewenangan koreksi.");
  if (!input.reasonCode?.trim()) fail("EMPLOYMENT_REASON_REQUIRED", "Pembatalan wajib disertai alasan.");

  const target = history.actions.find((action) => action.id === input.targetActionId);
  if (!target) fail("EMPLOYMENT_ACTION_NOT_REVERSIBLE", "Tindakan tidak ditemukan.");
  if (target.state !== "RECORDED" || target.actionType === "REVERSAL" || target.actionType === "BASELINE") {
    fail("EMPLOYMENT_ACTION_NOT_REVERSIBLE", "Tindakan ini tidak dapat dibatalkan.");
  }
  // Stack discipline by recording order, not effective date: a later-recorded
  // (even backdated) action must be reversed first (review of #113, item 1).
  const stack = history.actions
    .filter((action) => action.employmentId === target.employmentId && action.state === "RECORDED" && action.actionType !== "REVERSAL")
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  if (stack.at(-1)?.id !== target.id) {
    fail("EMPLOYMENT_ACTION_NOT_REVERSIBLE", "Hanya tindakan terakhir yang dapat dibatalkan; batalkan tindakan sesudahnya lebih dulu.");
  }

  const rowChanges: RowChange[] = [];
  for (const change of [...target.rowChanges].reverse()) {
    const row = findRow(history, change.table, change.id);
    if (!row || row.voided) {
      fail("EMPLOYMENT_ACTION_NOT_REVERSIBLE", "Data tindakan ini sudah berubah; tindakan tidak dapat dibatalkan.");
    }
    if (change.op === "OPEN") {
      rowChanges.push({ op: "VOID", table: change.table, id: change.id });
    } else if (change.op === "SET") {
      // Never overwrite a value another action changed after this one.
      for (const [field, value] of Object.entries(change.next)) {
        if ((row as unknown as Record<string, unknown>)[field] !== value) {
          fail("EMPLOYMENT_ACTION_NOT_REVERSIBLE", "Data tindakan ini sudah diubah oleh tindakan lain; tindakan tidak dapat dibatalkan.");
        }
      }
      rowChanges.push({ op: "SET", table: change.table, id: change.id, previous: change.next, next: change.previous });
    }
  }
  assertReversalKeepsEmploymentsApart(history, target.employmentId, rowChanges);

  const employment = history.employments.find((candidate) => candidate.id === target.employmentId);
  return {
    actionId: context.newId(),
    actionType: "REVERSAL",
    employeeId: history.employeeId,
    employmentId: target.employmentId,
    effectiveOn: context.today,
    reasonCode: input.reasonCode.trim(),
    reasonNote: input.reasonNote?.trim() ? input.reasonNote.trim() : null,
    reversesActionId: target.id,
    newEmployment: null,
    newTerms: [],
    newPlacements: [],
    rowChanges,
    documentIds: [],
    warnings: [],
    previousSnapshot: {},
    newSnapshot: {},
    expectedVersion: employment?.version ?? null,
  };
}

function findRow(history: EmploymentHistory, table: RowTable, id: string): { voided: boolean } | undefined {
  if (table === "EMPLOYMENT") return history.employments.find((row) => row.id === id);
  if (table === "TERM") return history.terms.find((row) => row.id === id);
  return history.placements.find((row) => row.id === id);
}

/**
 * Re-opening an ended employment (reversing a termination) must not overlap
 * another employment of the same employee, e.g. a later rehire (review of
 * #113, item 2). Fails in the domain instead of at the exclusion constraint.
 */
function assertReversalKeepsEmploymentsApart(history: EmploymentHistory, employmentId: string, changes: RowChange[]) {
  const employment = history.employments.find((row) => row.id === employmentId);
  if (!employment) return;
  const restored = { ...employment } as EmploymentRecord;
  for (const change of changes) {
    if (change.op === "SET" && change.table === "EMPLOYMENT" && change.id === employmentId) Object.assign(restored, change.next);
    if (change.op === "VOID" && change.table === "EMPLOYMENT" && change.id === employmentId) return;
  }
  const others = liveEmployments(history).filter((row) => row.id !== employmentId && row.legalEntityKey === restored.legalEntityKey);
  const clash = others.some((other) =>
    other.endBasis === "UNKNOWN" || restored.endBasis === "UNKNOWN"
      ? false
      : rangesOverlap(restored.startedOn, restored.endedOn, other.startedOn, other.endedOn),
  );
  if (clash) {
    fail("EMPLOYMENT_ACTION_NOT_REVERSIBLE", "Pegawai sudah memiliki hubungan kerja lain pada periode tersebut; pengakhiran tidak dapat dibatalkan.");
  }
}

/**
 * Applies a plan to an in-memory history. Used by tests and by previews that
 * need the post-action state; infrastructure applies the same plan in SQL.
 */
export function applyPlan(history: EmploymentHistory, plan: ActionPlan, recordedAt: string): EmploymentHistory {
  const next: EmploymentHistory = {
    employeeId: history.employeeId,
    employments: history.employments.map((row) => ({ ...row })),
    terms: history.terms.map((row) => ({ ...row })),
    placements: history.placements.map((row) => ({ ...row })),
    actions: history.actions.map((row) => ({ ...row })),
  };
  if (plan.newEmployment) next.employments.push({ ...plan.newEmployment });
  next.terms.push(...plan.newTerms.map((row) => ({ ...row })));
  next.placements.push(...plan.newPlacements.map((row) => ({ ...row })));

  const rowsOf = (table: RowTable): Array<{ id: string; voided: boolean } & Record<string, unknown>> =>
    (table === "EMPLOYMENT" ? next.employments : table === "TERM" ? next.terms : next.placements) as unknown as Array<
      { id: string; voided: boolean } & Record<string, unknown>
    >;

  for (const change of plan.rowChanges) {
    if (change.op === "OPEN") continue;
    const row = rowsOf(change.table).find((candidate) => candidate.id === change.id);
    if (!row) throw new Error(`applyPlan: missing ${change.table} ${change.id}`);
    if (change.op === "VOID") row.voided = true;
    else Object.assign(row, change.next);
  }

  if (!plan.newEmployment) {
    for (const employment of next.employments) {
      if (employment.id === plan.employmentId) employment.version += 1;
    }
  }

  if (plan.reversesActionId) {
    const target = next.actions.find((action) => action.id === plan.reversesActionId);
    if (target) target.state = "REVERSED";
  }
  const record: ActionRecord = {
    id: plan.actionId,
    employmentId: plan.employmentId,
    actionType: plan.actionType,
    effectiveOn: plan.effectiveOn,
    state: "RECORDED",
    reversesActionId: plan.reversesActionId,
    recordedAt,
    rowChanges: plan.rowChanges,
  };
  next.actions.push(record);
  return next;
}
