// EMP-005 / EMP-006 / EMP-010 Package 1 S1: pure domain resolver and planner.
// Synthetic data only.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMPLOYMENT_POLICY as policy,
  EmploymentDomainError,
  applyPlan,
  planEmploymentAction,
  requiredDocument,
  resolveEmployment,
  type ActionInput,
  type DecisionDocumentRef,
  type EmploymentHistory,
  type PlanningContext,
} from "../src/modules/employment/domain/index.js";

const EMPLOYEE = "00000000-0000-4000-8000-000000000001";
const ACTOR_EMPLOYEE = "00000000-0000-4000-8000-000000000099";
const UNIT_A = { kind: "LEGACY_UNIT", id: "00000000-0000-4000-8000-0000000000a1" } as const;
const UNIT_B = { kind: "LEGACY_UNIT", id: "00000000-0000-4000-8000-0000000000b1" } as const;
const GURU = { kind: "LEGACY_POSITION", id: "00000000-0000-4000-8000-0000000000c1" } as const;
const WAKASEK = { kind: "LEGACY_POSITION", id: "00000000-0000-4000-8000-0000000000c2" } as const;

function emptyHistory(): EmploymentHistory {
  return { employeeId: EMPLOYEE, employments: [], terms: [], placements: [], actions: [] };
}

function context(overrides: Partial<PlanningContext> = {}): PlanningContext {
  let sequence = 0;
  return {
    today: "2027-06-01",
    actorEmployeeId: ACTOR_EMPLOYEE,
    canCorrect: false,
    mode: "record",
    newId: () => `id-${++sequence}-${Math.random().toString(16).slice(2, 8)}`,
    ...overrides,
  };
}

function pk(from: string, to: string, pkType: "PK_BARU" | "PK_PERPANJANGAN" = "PK_BARU", category = "KONTRAK" as const): DecisionDocumentRef {
  return { id: `pk-${from}`, kind: "PERJANJIAN_KERJA", pkType, skType: null, employeeId: EMPLOYEE, contractFrom: from, contractTo: to, category };
}

function sk(skType: DecisionDocumentRef["skType"]): DecisionDocumentRef {
  return { id: `sk-${skType}`, kind: "SURAT_KEPUTUSAN", pkType: null, skType, employeeId: null, contractFrom: null, contractTo: null, category: null };
}

let clock = 0;
function record(history: EmploymentHistory, input: ActionInput, ctx: PlanningContext = context()): EmploymentHistory {
  const plan = planEmploymentAction(history, input, policy, ctx);
  clock += 1;
  return applyPlan(history, plan, `2027-06-01T00:00:${String(clock).padStart(2, "0")}Z`);
}

/** Derived state without the concurrency token, which always moves forward. */
function stateOf(history: EmploymentHistory, date: string) {
  const resolved = resolveEmployment(history, date, policy);
  return { ...resolved, employment: resolved.employment ? { ...resolved.employment, version: 0 } : null };
}

function expectFailure(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EmploymentDomainError);
    expect((error as EmploymentDomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

const hireContract = (effectiveOn = "2027-07-01", termEndOn = "2028-06-30"): ActionInput => ({
  actionType: "HIRE",
  effectiveOn,
  category: "KONTRAK",
  termEndOn,
  staffType: "PENDIDIK",
  placement: { kind: "PRIMARY", unitRef: UNIT_A, positionRef: GURU, jobTitleLabel: "Guru Kelas" },
  documents: [pk(effectiveOn, termEndOn)],
});

describe("EMP-005 hire and derived state", () => {
  it("derives AKAN_MULAI before the start date and AKTIF from it (EMP-005-B)", () => {
    const history = record(emptyHistory(), hireContract());
    expect(resolveEmployment(history, "2027-06-30", policy).state).toBe("AKAN_MULAI");
    const active = resolveEmployment(history, "2027-07-01", policy);
    expect(active.state).toBe("AKTIF");
    expect(active.term?.category).toBe("KONTRAK");
    expect(active.primaryPlacement?.jobTitleLabel).toBe("Guru Kelas");
    expect(active.projection).toMatchObject({ status: "active", startedOn: "2027-07-01", legacyUnitId: UNIT_A.id, legacyPositionId: GURU.id });
  });

  it("requires a Perjanjian Kerja for a contract hire and an SK Pengangkatan for a permanent hire (D-08)", () => {
    const withoutDocument = { ...hireContract(), documents: [] };
    expectFailure(() => planEmploymentAction(emptyHistory(), withoutDocument, policy, context()), "DECISION_DOCUMENT_REQUIRED");
    // Preview tells HC what is missing without failing.
    expect(planEmploymentAction(emptyHistory(), withoutDocument, policy, context({ mode: "preview" })).newTerms).toHaveLength(1);

    const permanentWithPk: ActionInput = { ...hireContract(), category: "TETAP", termEndOn: null };
    expectFailure(() => planEmploymentAction(emptyHistory(), permanentWithPk, policy, context()), "DECISION_DOCUMENT_KIND_INVALID");
    const permanent: ActionInput = { ...permanentWithPk, documents: [sk("SK_PENGANGKATAN")] };
    expect(planEmploymentAction(emptyHistory(), permanent, policy, context()).newTerms[0]?.effectiveTo).toBeNull();
  });

  it("rejects a PK whose period or category differs from the term (PK_TERM_MISMATCH)", () => {
    const input = { ...hireContract(), documents: [pk("2027-07-01", "2028-12-31")] };
    expectFailure(() => planEmploymentAction(emptyHistory(), input, policy, context()), "PK_TERM_MISMATCH");
  });

  it("rejects a PK that belongs to another employee", () => {
    const other = { ...pk("2027-07-01", "2028-06-30"), employeeId: "someone-else" };
    expectFailure(
      () => planEmploymentAction(emptyHistory(), { ...hireContract(), documents: [other] }, policy, context()),
      "DECISION_DOCUMENT_EMPLOYEE_MISMATCH",
    );
  });

  it("requires an end date for every fixed-term category including Lepas and Honorer, and none for Tetap (D-03)", () => {
    for (const category of ["KONTRAK", "KONTRAK_HONORER", "MAGANG", "PERCOBAAN", "LEPAS"] as const) {
      expectFailure(
        () => planEmploymentAction(emptyHistory(), { ...hireContract(), category, termEndOn: null }, policy, context({ mode: "preview" })),
        "EMPLOYMENT_TERM_END_REQUIRED",
      );
    }
    expectFailure(
      () => planEmploymentAction(emptyHistory(), { ...hireContract(), category: "TETAP" }, policy, context({ mode: "preview" })),
      "EMPLOYMENT_TERM_INVALID",
    );
  });

  it("refuses a second overlapping employment and a self-action", () => {
    const history = record(emptyHistory(), hireContract());
    expectFailure(() => planEmploymentAction(history, hireContract("2027-09-01"), policy, context()), "EMPLOYMENT_ALREADY_ACTIVE");
    expectFailure(
      () => planEmploymentAction(emptyHistory(), hireContract(), policy, context({ actorEmployeeId: EMPLOYEE })),
      "EMPLOYMENT_SELF_ACTION_FORBIDDEN",
    );
  });

  it("refuses actions on an employee without any history (baseline missing)", () => {
    expectFailure(
      () => planEmploymentAction(emptyHistory(), { actionType: "TERMINATION", lastDayOn: "2027-07-31", reasonCode: "RESIGN" }, policy, context()),
      "EMPLOYMENT_BASELINE_MISSING",
    );
  });
});

describe("EMP-005 contract extension, category change, termination", () => {
  const hired = () => record(emptyHistory(), hireContract());

  it("extends without touching the previous term and keeps masa kerja (EMP-005-A, D-05)", () => {
    const history = record(hired(), {
      actionType: "CONTRACT_EXTENSION",
      effectiveOn: "2028-07-01",
      termEndOn: "2029-06-30",
      documents: [pk("2028-07-01", "2029-06-30", "PK_PERPANJANGAN")],
    });
    expect(history.terms.map((term) => [term.sequence, term.effectiveFrom, term.effectiveTo])).toEqual([
      [1, "2027-07-01", "2028-06-30"],
      [2, "2028-07-01", "2029-06-30"],
    ]);
    expect(history.employments).toHaveLength(1);
    expect(resolveEmployment(history, "2028-08-01", policy).employment?.serviceStartOn).toBe("2027-07-01");
  });

  it("requires a PK Perpanjangan, not an SK, for an extension", () => {
    expectFailure(
      () =>
        planEmploymentAction(
          hired(),
          { actionType: "CONTRACT_EXTENSION", effectiveOn: "2028-07-01", termEndOn: "2029-06-30", documents: [sk("SK_MUTASI")] },
          policy,
          context(),
        ),
      "DECISION_DOCUMENT_KIND_INVALID",
    );
  });

  it("warns on a gap between contracts and requires acknowledgement (D-04 warnings only)", () => {
    const input: ActionInput = {
      actionType: "CONTRACT_EXTENSION",
      effectiveOn: "2028-08-01",
      termEndOn: "2029-07-31",
      documents: [pk("2028-08-01", "2029-07-31", "PK_PERPANJANGAN")],
    };
    expect(planEmploymentAction(hired(), input, policy, context({ mode: "preview" })).warnings).toEqual(["TERM_GAP"]);
    // The expired contract is flagged, never auto-terminated (EMP-005-D).
    const between = resolveEmployment(hired(), "2028-07-15", policy);
    expect(between.state).toBe("AKTIF");
    expect(between.flags).toContain("KONTRAK_LEWAT_TANPA_TINDAK_LANJUT");
  });

  it("refuses an extension that is not acknowledged, and records it once acknowledged", () => {
    const input: ActionInput = {
      actionType: "CONTRACT_EXTENSION",
      effectiveOn: "2028-08-01",
      termEndOn: "2029-07-31",
      documents: [pk("2028-08-01", "2029-07-31", "PK_PERPANJANGAN")],
    };
    expectFailure(() => planEmploymentAction(hired(), input, policy, context()), "EMPLOYMENT_WARNINGS_NOT_ACKNOWLEDGED");
    expect(planEmploymentAction(hired(), { ...input, acknowledgedWarnings: ["TERM_GAP"] }, policy, context()).warnings).toEqual(["TERM_GAP"]);
  });

  it("flags a contract ending within the reminder window (D-11)", () => {
    expect(resolveEmployment(hired(), "2028-05-15", policy).flags).toContain("KONTRAK_SEGERA_BERAKHIR");
    expect(resolveEmployment(hired(), "2028-03-01", policy).flags).not.toContain("KONTRAK_SEGERA_BERAKHIR");
  });

  it("changes Percobaan to Tetap with an SK Pengangkatan, closing the probation on the day before", () => {
    const probation = record(emptyHistory(), {
      ...hireContract("2027-07-01", "2027-09-30"),
      category: "PERCOBAAN",
      documents: [pk("2027-07-01", "2027-09-30", "PK_BARU", "PERCOBAAN" as never)],
    });
    const permanent = record(probation, {
      actionType: "CATEGORY_CHANGE",
      effectiveOn: "2027-10-01",
      category: "TETAP",
      termEndOn: null,
      documents: [sk("SK_PENGANGKATAN")],
    });
    expect(permanent.terms.map((term) => [term.category, term.effectiveFrom, term.effectiveTo])).toEqual([
      ["PERCOBAAN", "2027-07-01", "2027-09-30"],
      ["TETAP", "2027-10-01", null],
    ]);
  });

  it("warns when probation exceeds the policy length", () => {
    const plan = planEmploymentAction(
      emptyHistory(),
      { ...hireContract("2027-07-01", "2027-12-31"), category: "PERCOBAAN", documents: [] },
      policy,
      context({ mode: "preview" }),
    );
    expect(plan.warnings).toContain("PROBATION_DURATION_LONG");
  });

  it("terminates on the last working day and closes term and placement (EMP-005-A, §7.1)", () => {
    const history = record(hired(), {
      actionType: "TERMINATION",
      lastDayOn: "2027-12-31",
      reasonCode: "PEMBERHENTIAN",
      documents: [sk("SK_PEMBERHENTIAN")],
    });
    expect(resolveEmployment(history, "2027-12-31", policy).state).toBe("AKTIF");
    const after = resolveEmployment(history, "2028-01-01", policy);
    expect(after.state).toBe("BERAKHIR");
    expect(after.projection.status).toBe("inactive");
    expect(history.terms[0]?.effectiveTo).toBe("2027-12-31");
    expect(history.placements[0]?.effectiveTo).toBe("2027-12-31");
  });

  it("projects resign as resigned and does not require an SK for resign (D-08)", () => {
    const history = record(hired(), { actionType: "TERMINATION", lastDayOn: "2027-12-31", reasonCode: "RESIGN" });
    expect(resolveEmployment(history, "2028-02-01", policy).projection.status).toBe("resigned");
    expectFailure(
      () => planEmploymentAction(hired(), { actionType: "TERMINATION", lastDayOn: "2027-12-31", reasonCode: "PENSIUN" }, policy, context()),
      "DECISION_DOCUMENT_REQUIRED",
    );
  });

  it("rejects out-of-order actions instead of re-cutting history (§7.3)", () => {
    const extended = record(hired(), {
      actionType: "CONTRACT_EXTENSION",
      effectiveOn: "2028-07-01",
      termEndOn: "2029-06-30",
      documents: [pk("2028-07-01", "2029-06-30", "PK_PERPANJANGAN")],
    });
    expectFailure(
      () => planEmploymentAction(extended, { actionType: "TERMINATION", lastDayOn: "2028-01-31", reasonCode: "RESIGN" }, policy, context()),
      "EMPLOYMENT_ACTION_OUT_OF_ORDER",
    );
  });

  it("limits backdating to the window unless the actor may correct, and requires a reason (D-13)", () => {
    const history = record(emptyHistory(), hireContract("2027-01-01", "2027-12-31"), context({ today: "2027-01-01" }));
    const old: ActionInput = {
      actionType: "TRANSFER",
      effectiveOn: "2027-03-01",
      placement: { unitRef: UNIT_B, positionRef: GURU, jobTitleLabel: "Guru Kelas" },
      documents: [sk("SK_MUTASI")],
      reasonNote: "SK terlambat diterima HC",
      acknowledgedWarnings: ["BACKDATED"],
    };
    expectFailure(() => planEmploymentAction(history, old, policy, context()), "EMPLOYMENT_BACKDATE_NOT_ALLOWED");
    expect(planEmploymentAction(history, old, policy, context({ canCorrect: true })).warnings).toEqual(["BACKDATED"]);
    expectFailure(
      () => planEmploymentAction(history, { ...old, reasonNote: null }, policy, context({ canCorrect: true })),
      "EMPLOYMENT_BACKDATE_REASON_REQUIRED",
    );
  });
});

describe("EMP-006 placement and career movement", () => {
  const hired = () => record(emptyHistory(), hireContract());

  it("promotes by closing the primary placement the day before and opening a new one (EMP-006-A)", () => {
    const history = record(hired(), {
      actionType: "PROMOTION",
      effectiveOn: "2027-10-01",
      placement: { unitRef: UNIT_A, positionRef: WAKASEK, jobTitleLabel: "Wakasek Kurikulum" },
      documents: [sk("SK_PROMOSI")],
    });
    expect(history.placements.map((placement) => [placement.jobTitleLabel, placement.effectiveFrom, placement.effectiveTo])).toEqual([
      ["Guru Kelas", "2027-07-01", "2027-09-30"],
      ["Wakasek Kurikulum", "2027-10-01", null],
    ]);
    expect(resolveEmployment(history, "2027-09-30", policy).primaryPlacement?.jobTitleLabel).toBe("Guru Kelas");
    expect(resolveEmployment(history, "2027-10-01", policy).primaryPlacement?.jobTitleLabel).toBe("Wakasek Kurikulum");
  });

  it("requires the matching SK type and a reason code for demotion", () => {
    const base: ActionInput = {
      actionType: "DEMOTION",
      effectiveOn: "2027-10-01",
      placement: { unitRef: UNIT_A, positionRef: WAKASEK, jobTitleLabel: "Staf" },
      documents: [sk("SK_DEMOSI")],
    };
    expectFailure(() => planEmploymentAction(hired(), base, policy, context()), "EMPLOYMENT_REASON_REQUIRED");
    expectFailure(
      () => planEmploymentAction(hired(), { ...base, reasonCode: "KINERJA", documents: [sk("SK_PROMOSI")] }, policy, context()),
      "DECISION_DOCUMENT_KIND_INVALID",
    );
  });

  it("allows one primary placement per date and additional placements alongside it (EMP-006-B, D-06)", () => {
    expectFailure(
      () =>
        planEmploymentAction(
          hired(),
          { actionType: "PLACEMENT", effectiveOn: "2027-08-01", placement: { kind: "PRIMARY", unitRef: UNIT_B, positionRef: GURU, jobTitleLabel: "Guru" } },
          policy,
          context(),
        ),
      "EMPLOYMENT_OVERLAP",
    );
    const additional = record(hired(), {
      actionType: "PLACEMENT",
      effectiveOn: "2027-08-01",
      placement: { kind: "ADDITIONAL", unitRef: UNIT_B, positionRef: WAKASEK, jobTitleLabel: "Koordinator Tahfidz" },
    });
    const resolved = resolveEmployment(additional, "2027-08-15", policy);
    expect(resolved.additionalPlacements.map((placement) => placement.jobTitleLabel)).toEqual(["Koordinator Tahfidz"]);
    expectFailure(
      () =>
        planEmploymentAction(
          additional,
          { actionType: "PLACEMENT", effectiveOn: "2027-09-01", placement: { kind: "ADDITIONAL", unitRef: UNIT_B, positionRef: WAKASEK, jobTitleLabel: "Duplikat" } },
          policy,
          context(),
        ),
      "EMPLOYMENT_OVERLAP",
    );
  });

  it("rejects a move to the same unit and position, an invalid reference, and a cross-entity move", () => {
    const same: ActionInput = {
      actionType: "TRANSFER",
      effectiveOn: "2027-10-01",
      placement: { unitRef: UNIT_A, positionRef: GURU, jobTitleLabel: "Guru Kelas" },
      documents: [sk("SK_MUTASI")],
    };
    expectFailure(() => planEmploymentAction(hired(), same, policy, context()), "EMPLOYMENT_REFERENCE_INVALID");
    const moved = { ...same, placement: { ...same.placement, unitRef: UNIT_B } } as ActionInput;
    expectFailure(
      () => planEmploymentAction(hired(), moved, policy, context({ isReferenceValid: () => false })),
      "EMPLOYMENT_REFERENCE_INVALID",
    );
    expectFailure(
      () => planEmploymentAction(hired(), { ...moved, legalEntityKey: "other-entity" } as ActionInput, policy, context()),
      "EMPLOYMENT_CROSS_ENTITY_UNSUPPORTED",
    );
  });
});

describe("Reversal restores the previous state exactly (EMP-006-E)", () => {
  it("reverses the latest action and keeps both actions visible", () => {
    const hired = record(emptyHistory(), hireContract());
    const promoted = record(hired, {
      actionType: "PROMOTION",
      effectiveOn: "2027-10-01",
      placement: { unitRef: UNIT_A, positionRef: WAKASEK, jobTitleLabel: "Wakasek Kurikulum" },
      documents: [sk("SK_PROMOSI")],
    });
    const promotion = promoted.actions.at(-1)!;
    const reversed = record(promoted, { actionType: "REVERSAL", targetActionId: promotion.id, reasonCode: "SALAH_INPUT" }, context({ canCorrect: true }));

    const placements = reversed.placements.filter((placement) => !placement.voided);
    expect(placements.map((placement) => [placement.jobTitleLabel, placement.effectiveTo])).toEqual([["Guru Kelas", null]]);
    expect(stateOf(reversed, "2027-11-01")).toEqual(stateOf(hired, "2027-11-01"));
    expect(reversed.actions.map((action) => [action.actionType, action.state])).toEqual([
      ["HIRE", "RECORDED"],
      ["PROMOTION", "REVERSED"],
      ["REVERSAL", "RECORDED"],
    ]);
  });

  it("only reverses the latest action, never twice, and needs employment.correct", () => {
    const hired = record(emptyHistory(), hireContract());
    const promoted = record(hired, {
      actionType: "PROMOTION",
      effectiveOn: "2027-10-01",
      placement: { unitRef: UNIT_A, positionRef: WAKASEK, jobTitleLabel: "Wakasek Kurikulum" },
      documents: [sk("SK_PROMOSI")],
    });
    const hire = promoted.actions[0]!;
    const promotion = promoted.actions[1]!;
    expectFailure(
      () => planEmploymentAction(promoted, { actionType: "REVERSAL", targetActionId: promotion.id, reasonCode: "X" }, policy, context()),
      "EMPLOYMENT_FORBIDDEN",
    );
    expectFailure(
      () => planEmploymentAction(promoted, { actionType: "REVERSAL", targetActionId: hire.id, reasonCode: "X" }, policy, context({ canCorrect: true })),
      "EMPLOYMENT_ACTION_NOT_REVERSIBLE",
    );
    const reversed = record(promoted, { actionType: "REVERSAL", targetActionId: promotion.id, reasonCode: "X" }, context({ canCorrect: true }));
    expectFailure(
      () => planEmploymentAction(reversed, { actionType: "REVERSAL", targetActionId: promotion.id, reasonCode: "X" }, policy, context({ canCorrect: true })),
      "EMPLOYMENT_ACTION_NOT_REVERSIBLE",
    );
  });

  it("reversing a hire voids the employment so the employee has no derived data again", () => {
    const hired = record(emptyHistory(), hireContract());
    const reversed = record(hired, { actionType: "REVERSAL", targetActionId: hired.actions[0]!.id, reasonCode: "SALAH_PEGAWAI" }, context({ canCorrect: true }));
    expect(resolveEmployment(reversed, "2027-08-01", policy).state).toBe("TANPA_DATA");
  });

  it("reversing a termination re-opens the employment exactly", () => {
    const hired = record(emptyHistory(), hireContract());
    const ended = record(hired, { actionType: "TERMINATION", lastDayOn: "2027-12-31", reasonCode: "RESIGN" });
    const reversed = record(ended, { actionType: "REVERSAL", targetActionId: ended.actions.at(-1)!.id, reasonCode: "BATAL_RESIGN" }, context({ canCorrect: true }));
    expect(stateOf(reversed, "2028-02-01")).toEqual(stateOf(hired, "2028-02-01"));
    expect(reversed.employments[0]!.version).toBeGreaterThan(hired.employments[0]!.version);
  });
});

describe("Reversal safety (review of #113)", () => {
  const promote = (history: EmploymentHistory, effectiveOn: string, title: string) =>
    record(history, {
      actionType: "PROMOTION",
      effectiveOn,
      placement: { unitRef: UNIT_A, positionRef: title === "Wakasek Kurikulum" ? WAKASEK : GURU, jobTitleLabel: title },
      documents: [sk("SK_PROMOSI")],
    });

  it("refuses to reverse a SET whose field was changed afterwards, instead of overwriting it (item 1)", () => {
    const promoted = promote(record(emptyHistory(), hireContract()), "2027-10-01", "Wakasek Kurikulum");
    const promotion = promoted.actions.at(-1)!;
    // Simulate a later change of the same field (e.g. a backdated correction recorded afterwards).
    const tampered: EmploymentHistory = {
      ...promoted,
      placements: promoted.placements.map((placement) =>
        placement.jobTitleLabel === "Guru Kelas" ? { ...placement, effectiveTo: "2027-09-15" } : placement,
      ),
    };
    expectFailure(
      () => planEmploymentAction(tampered, { actionType: "REVERSAL", targetActionId: promotion.id, reasonCode: "X" }, policy, context({ canCorrect: true })),
      "EMPLOYMENT_ACTION_NOT_REVERSIBLE",
    );
  });

  it("orders the reversal stack by recording time, not effective date (item 1)", () => {
    const hired = record(emptyHistory(), hireContract());
    const promoted = promote(hired, "2027-10-01", "Wakasek Kurikulum");
    // An action recorded later but effective earlier (backdated) is the one on top of the stack.
    const promotion = promoted.actions.at(-1)!;
    const backdated: EmploymentHistory = {
      ...promoted,
      actions: [
        ...promoted.actions,
        { id: "backdated", employmentId: promotion.employmentId, actionType: "PLACEMENT", effectiveOn: "2027-08-01", state: "RECORDED", reversesActionId: null, recordedAt: "2099-01-01T00:00:00Z", rowChanges: [] },
      ],
    };
    expectFailure(
      () => planEmploymentAction(backdated, { actionType: "REVERSAL", targetActionId: promotion.id, reasonCode: "X" }, policy, context({ canCorrect: true })),
      "EMPLOYMENT_ACTION_NOT_REVERSIBLE",
    );
  });

  it("refuses to reverse a termination once the employee was rehired (item 2)", () => {
    const hired = record(emptyHistory(), hireContract("2027-07-01", "2028-06-30"));
    const ended = record(hired, { actionType: "TERMINATION", lastDayOn: "2027-12-31", reasonCode: "RESIGN" });
    const termination = ended.actions.at(-1)!;
    const rehired = record(ended, hireContract("2028-03-01", "2029-02-28"));
    expect(rehired.employments.filter((employment) => !employment.voided)).toHaveLength(2);
    expectFailure(
      () => planEmploymentAction(rehired, { actionType: "REVERSAL", targetActionId: termination.id, reasonCode: "BATAL_RESIGN" }, policy, context({ canCorrect: true })),
      "EMPLOYMENT_ACTION_NOT_REVERSIBLE",
    );
  });

  it("derives AKAN_MULAI from the earliest future employment regardless of array order (item 6)", () => {
    const base = record(emptyHistory(), hireContract("2028-01-01", "2028-12-31"));
    const first = base.employments[0]!;
    const later = { ...first, id: "later", startedOn: "2029-06-01", serviceStartOn: "2029-06-01" };
    const shuffled: EmploymentHistory = { ...base, employments: [later, first] };
    const resolved = resolveEmployment(shuffled, "2027-08-01", policy);
    expect(resolved.state).toBe("AKAN_MULAI");
    expect(resolved.employment?.startedOn).toBe("2028-01-01");
  });
});

describe("Baseline-shaped history", () => {
  it("treats an unknown start as active and an unknown end as ended, never active", () => {
    const history: EmploymentHistory = {
      employeeId: EMPLOYEE,
      employments: [
        {
          id: "e1", employeeId: EMPLOYEE, legalEntityKey: null, staffType: null, startedOn: null, startBasis: "UNKNOWN",
          serviceStartOn: null, endedOn: null, endBasis: null, endPrecision: null, endReason: null, voided: false, version: 0,
        },
      ],
      terms: [],
      placements: [],
      actions: [],
    };
    const active = resolveEmployment(history, "2027-01-01", policy);
    expect(active.state).toBe("AKTIF");
    expect(active.flags).toEqual(expect.arrayContaining(["TANGGAL_MULAI_TIDAK_DIKETAHUI", "TANPA_PENEMPATAN"]));

    const ended = { ...history, employments: [{ ...history.employments[0]!, endBasis: "UNKNOWN" as const, endReason: "LAINNYA_DARI_MASTER" as const }] };
    const resolved = resolveEmployment(ended, "2027-01-01", policy);
    expect(resolved.state).toBe("BERAKHIR");
    expect(resolved.projection.status).toBe("inactive");
    expect(resolved.flags).toContain("TANGGAL_AKHIR_TIDAK_DIKETAHUI");
    expectFailure(() => planEmploymentAction(ended, hireContract(), policy, context()), "EMPLOYMENT_OVERLAP");
  });

  it("does not let a career move cut before a baseline placement start", () => {
    const history: EmploymentHistory = {
      employeeId: EMPLOYEE,
      employments: [
        {
          id: "e1", employeeId: EMPLOYEE, legalEntityKey: null, staffType: "PENDIDIK", startedOn: "2020-01-01", startBasis: "RECORDED",
          serviceStartOn: "2020-01-01", endedOn: null, endBasis: null, endPrecision: null, endReason: null, voided: false, version: 0,
        },
      ],
      terms: [{ id: "t1", employmentId: "e1", sequence: 1, category: "TETAP", effectiveFrom: "2020-01-01", effectiveTo: null, contractReference: null, voided: false }],
      placements: [
        {
          id: "p1", employmentId: "e1", kind: "PRIMARY", unitRef: UNIT_A, positionRef: GURU, jobTitleLabel: "Guru",
          effectiveFrom: "2027-06-01", effectiveTo: null, effectiveFromBasis: "BASELINE_ASSUMED", voided: false,
        },
      ],
      actions: [{ id: "a1", employmentId: "e1", actionType: "BASELINE", effectiveOn: null, state: "RECORDED", reversesActionId: null, recordedAt: "2027-06-01T00:00:00Z", rowChanges: [] }],
    };
    expectFailure(
      () =>
        planEmploymentAction(
          history,
          {
            actionType: "TRANSFER",
            effectiveOn: "2027-05-15",
            placement: { unitRef: UNIT_B, positionRef: GURU, jobTitleLabel: "Guru" },
            documents: [sk("SK_MUTASI")],
            reasonNote: "mundur",
            acknowledgedWarnings: ["BACKDATED"],
          },
          policy,
          context(),
        ),
      "EMPLOYMENT_NOT_ACTIVE",
    );
    expectFailure(
      () =>
        planEmploymentAction(
          history,
          { actionType: "REVERSAL", targetActionId: "a1", reasonCode: "X" },
          policy,
          context({ canCorrect: true }),
        ),
      "EMPLOYMENT_ACTION_NOT_REVERSIBLE",
    );
  });
});

describe("Document requirement table (D-08)", () => {
  it("maps actions to PK or SK", () => {
    expect(requiredDocument(policy, "CONTRACT_EXTENSION", {})).toEqual({ kind: "PERJANJIAN_KERJA", pkTypes: ["PK_PERPANJANGAN"] });
    expect(requiredDocument(policy, "TRANSFER", {})?.skTypes).toEqual(["SK_MUTASI"]);
    expect(requiredDocument(policy, "TERMINATION", { terminationReason: "MENINGGAL_DUNIA" })).toBeNull();
    expect(requiredDocument(policy, "PLACEMENT", {})).toBeNull();
  });
});

describe("ORG-011 classification on a placement", () => {
  it("carries the code onto the placement it opens", () => {
    const history = record(emptyHistory(), {
      ...hireContract(),
      placement: {
        kind: "PRIMARY", unitRef: UNIT_A, positionRef: GURU,
        jobTitleLabel: "Guru Kelas", jobClassificationCode: "FUNC_GURU",
      },
    });
    expect(history.placements[0]?.jobClassificationCode).toBe("FUNC_GURU");
  });

  it("leaves it null when the action says nothing, so the seat decides", () => {
    // Null is not "no allowance": it means this placement states nothing and the seat's own
    // classification applies. The resolver reads the seat in that case.
    const history = record(emptyHistory(), hireContract());
    expect(history.placements[0]?.jobClassificationCode).toBeNull();
  });

  it("keeps each placement's own code when a career move opens a new one", () => {
    const history = record(record(emptyHistory(), {
      ...hireContract(),
      placement: {
        kind: "PRIMARY", unitRef: UNIT_A, positionRef: GURU,
        jobTitleLabel: "Guru Kelas", jobClassificationCode: "FUNC_GURU",
      },
    }), {
      actionType: "PROMOTION",
      effectiveOn: "2027-09-01",
      placement: {
        unitRef: UNIT_B, positionRef: GURU,
        jobTitleLabel: "Kepala Unit", jobClassificationCode: "STRUCT_KEPALA",
      },
      documents: [sk("SK_PROMOSI")],
    });
    const codes = history.placements.map((placement) => placement.jobClassificationCode);
    expect(codes).toContain("FUNC_GURU");
    expect(codes).toContain("STRUCT_KEPALA");
  });
});
