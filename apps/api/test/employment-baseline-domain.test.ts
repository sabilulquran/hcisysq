// EMP-005 Package 1 S2: baseline mapping (spec §4.2.1, §8.2) and the import
// change that keeps raw classification values. Synthetic data only.

import { describe, expect, it } from "vitest";

import { normalizeEmployeeImportRow } from "../src/modules/employees/domain/employee-import.js";
import {
  DEFAULT_EMPLOYMENT_POLICY as policy,
  applyPlan,
  checkConsistency,
  mapCategory,
  planBaseline,
  resolveEmployment,
  type BaselinePlan,
  type BaselineSource,
  type EmploymentHistory,
} from "../src/modules/employment/domain/index.js";

const CUTOFF = "2026-11-01";
let sequence = 0;
const newId = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;

function source(overrides: Partial<BaselineSource> = {}): BaselineSource {
  return {
    employeeId: "10000000-0000-4000-8000-000000000001",
    employeeStatus: "active",
    removed: false,
    startedOn: "2019-07-15",
    endedOn: null,
    employmentStatusText: "Pegawai Tetap",
    employmentTypeText: "Tenaga Pendidik",
    legacyUnitId: "20000000-0000-4000-8000-000000000001",
    legacyPositionId: "30000000-0000-4000-8000-000000000001",
    positionName: "Guru Kelas",
    functionalPosition: "Guru",
    structuralPosition: null,
    sourceClassification: {
      statusActive: "Aktif",
      employmentStatus: "Pegawai Tetap",
      employmentType: "Tenaga Pendidik",
      endedOn: null,
    },
    sourceImportJobId: null,
    sourceSnapshotId: null,
    ...overrides,
  };
}

function baseline(plan: BaselinePlan) {
  if (plan.outcome !== "BASELINE") throw new Error(`expected baseline, got ${plan.outcome}`);
  return plan;
}

function historyOf(plan: Extract<BaselinePlan, { outcome: "BASELINE" }>): EmploymentHistory {
  return {
    employeeId: plan.employeeId,
    employments: [plan.employment],
    terms: [plan.term],
    placements: plan.placement ? [plan.placement] : [],
    actions: [
      { id: plan.action.id, employmentId: plan.employment.id, actionType: "BASELINE", effectiveOn: null, state: "RECORDED", reversesActionId: null, recordedAt: "2026-11-01T00:00:00Z", rowChanges: plan.action.rowChanges },
    ],
  };
}

describe("D-02 status kepegawaian mapping", () => {
  it.each([
    ["Pegawai Tetap", "Aktif", "TETAP"],
    ["Pegawai Kontrak", "Aktif", "KONTRAK"],
    [null, "Aktif PKWT", "KONTRAK"],
    ["Pegawai Kontrak", "Aktif PKWT", "KONTRAK"],
    ["Calon Pegawai Tetap", "Aktif", "PERCOBAAN"],
    ["Tenaga Pengabdian", "Aktif", "MAGANG"],
    ["Pegawai Lepas", "Aktif", "LEPAS"],
    ["  pegawai   TETAP ", "Aktif", "TETAP"],
  ])("maps %s / %s to %s", (employmentStatus, statusActive, expected) => {
    expect(mapCategory(employmentStatus, statusActive)).toMatchObject({ category: expected, issue: null, excludeFoundationBoard: false });
  });

  it("never guesses: conflicts and stray values go to the SHADOW review list", () => {
    expect(mapCategory("Pegawai Tetap", "Aktif PKWT")).toMatchObject({ category: "BELUM_DIKLASIFIKASIKAN", issue: "BASELINE_CATEGORY_CONFLICT_PKWT" });
    expect(mapCategory("Tidak Aktif", "Tidak Aktif")).toMatchObject({ category: "BELUM_DIKLASIFIKASIKAN", issue: "BASELINE_CATEGORY_IS_STATUS" });
    expect(mapCategory("Status Lain", "Aktif")).toMatchObject({ category: "BELUM_DIKLASIFIKASIKAN", issue: "BASELINE_CATEGORY_UNMAPPED" });
    expect(mapCategory(null, "Aktif")).toMatchObject({ category: "BELUM_DIKLASIFIKASIKAN", issue: "BASELINE_CATEGORY_MISSING" });
  });
});

describe("Baseline plan (EMP-005-E, EMP-005-K)", () => {
  it("creates employment, term, and a primary placement 'sejak data awal' for a permanent teacher", () => {
    const plan = baseline(planBaseline(source(), CUTOFF, policy, newId));
    expect(plan.issues).toEqual([]);
    expect(plan.employment).toMatchObject({ startedOn: "2019-07-15", startBasis: "RECORDED", serviceStartOn: "2019-07-15", staffType: "PENDIDIK", endBasis: null });
    expect(plan.term).toMatchObject({ sequence: 1, category: "TETAP", effectiveFrom: "2019-07-15", effectiveTo: null });
    // The placement start is the baseline cutoff, never the TMT (spec §8.2 step 3).
    expect(plan.placement).toMatchObject({ kind: "PRIMARY", effectiveFrom: CUTOFF, effectiveFromBasis: "BASELINE_ASSUMED", jobTitleLabel: "Guru Kelas" });
    const resolved = resolveEmployment(historyOf(plan), "2026-11-02", policy);
    expect(resolved.state).toBe("AKTIF");
    expect(resolved.projection).toMatchObject({ status: "active", category: "TETAP", startedOn: "2019-07-15" });
  });

  it("excludes BUMY staff and Pengurus Yayasan without creating employment (D-02)", () => {
    const bumy = planBaseline(source({ sourceClassification: { ...source().sourceClassification!, statusActive: "Aktif BUMY" } }), CUTOFF, policy, newId);
    expect(bumy).toMatchObject({ outcome: "EXCLUDED", exclusion: "BUMY", issues: ["BASELINE_EXCLUDED_BUMY"] });
    const board = planBaseline(
      source({ employmentStatusText: "Pengurus Yayasan", sourceClassification: { ...source().sourceClassification!, employmentStatus: "Pengurus Yayasan" } }),
      CUTOFF,
      policy,
      newId,
    );
    expect(board).toMatchObject({ outcome: "EXCLUDED", exclusion: "PENGURUS_YAYASAN" });
  });

  it("never invents a contract end date for an active contract employee", () => {
    const plan = baseline(
      planBaseline(source({ employmentStatusText: null, sourceClassification: { ...source().sourceClassification!, statusActive: "Aktif PKWT", employmentStatus: null } }), CUTOFF, policy, newId),
    );
    expect(plan.term).toMatchObject({ category: "KONTRAK", effectiveTo: null });
    expect(plan.issues).toContain("BASELINE_CONTRACT_END_UNKNOWN");
  });

  it("keeps an unknown start date unknown", () => {
    const plan = baseline(planBaseline(source({ startedOn: null }), CUTOFF, policy, newId));
    expect(plan.employment).toMatchObject({ startedOn: null, startBasis: "UNKNOWN" });
    expect(plan.term.effectiveFrom).toBeNull();
    expect(plan.issues).toContain("BASELINE_START_UNKNOWN");
  });

  it("ends a resigned employee on the last day of the TAHUN KELUAR month with month precision", () => {
    const plan = baseline(
      planBaseline(
        source({ employeeStatus: "resigned", endedOn: "2024-03-01", sourceClassification: { ...source().sourceClassification!, statusActive: "Tidak Aktif", endedOn: "2024-03" } }),
        CUTOFF,
        policy,
        newId,
      ),
    );
    expect(plan.employment).toMatchObject({ endedOn: "2024-03-31", endBasis: "RECORDED", endPrecision: "MONTH", endReason: "RESIGN" });
    expect(plan.term.effectiveTo).toBe("2024-03-31");
    expect(plan.placement).toBeNull();
    const resolved = resolveEmployment(historyOf(plan), CUTOFF, policy);
    expect(resolved).toMatchObject({ state: "BERAKHIR", projection: { status: "resigned" } });
  });

  it("keeps a full exit date with day precision", () => {
    const plan = baseline(
      planBaseline(
        source({ employeeStatus: "inactive", endedOn: "2024-03-15", sourceClassification: { ...source().sourceClassification!, statusActive: "Tidak Aktif", endedOn: "2024-03-15" } }),
        CUTOFF,
        policy,
        newId,
      ),
    );
    expect(plan.employment).toMatchObject({ endedOn: "2024-03-15", endPrecision: "DAY", endReason: "LAINNYA_DARI_MASTER" });
  });

  it("marks an ended employee without exit date as ended with unknown end, never active", () => {
    const plan = baseline(planBaseline(source({ employeeStatus: "inactive" }), CUTOFF, policy, newId));
    expect(plan.employment).toMatchObject({ endedOn: null, endBasis: "UNKNOWN" });
    expect(plan.issues).toContain("BASELINE_END_UNKNOWN");
    expect(resolveEmployment(historyOf(plan), CUTOFF, policy).state).toBe("BERAKHIR");
  });

  it("flags status conflicts, missing placement, missing staff type, and missing snapshot", () => {
    const plan = baseline(
      planBaseline(
        source({ endedOn: "2025-01-01", legacyUnitId: null, employmentTypeText: "#", sourceClassification: null }),
        CUTOFF,
        policy,
        newId,
      ),
    );
    expect(plan.issues).toEqual(
      expect.arrayContaining(["BASELINE_NO_SOURCE_SNAPSHOT", "BASELINE_STATUS_CONFLICT", "BASELINE_STAFF_TYPE_MISSING", "BASELINE_PLACEMENT_MISSING"]),
    );
    expect(plan.employment.endBasis).toBeNull();
    expect(plan.placement).toBeNull();
  });

  it("produces a history that later actions can build on", () => {
    const plan = baseline(planBaseline(source(), CUTOFF, policy, newId));
    const history = historyOf(plan);
    expect(applyPlan(history, {
      actionId: "noop", actionType: "PLACEMENT", employeeId: plan.employeeId, employmentId: plan.employment.id, effectiveOn: CUTOFF,
      reasonCode: null, reasonNote: null, reversesActionId: null, newEmployment: null, newTerms: [], newPlacements: [], rowChanges: [],
      documentIds: [], warnings: [], previousSnapshot: {}, newSnapshot: {}, expectedVersion: 0,
    }, "2026-11-01T00:00:01Z").employments[0]?.version).toBe(1);
  });
});

describe("Consistency report (spec §8.3)", () => {
  it("reports baseline not loaded with would-be issues", () => {
    const finding = checkConsistency(source({ startedOn: null }), null, CUTOFF, policy);
    expect(finding.codes).toEqual(["BASELINE_NOT_LOADED", "BASELINE_START_UNKNOWN"]);
  });

  it("reports master columns that differ from the derived history", () => {
    const plan = baseline(planBaseline(source(), CUTOFF, policy, newId));
    const changedMaster = source({ legacyUnitId: "20000000-0000-4000-8000-000000000099", employmentStatusText: "Pegawai Kontrak", sourceClassification: { ...source().sourceClassification!, employmentStatus: "Pegawai Kontrak" } });
    const finding = checkConsistency(changedMaster, historyOf(plan), "2026-11-02", policy);
    expect(finding.codes).toContain("HISTORY_DIFFERS_FROM_MASTER");
    expect(finding.differingFields).toEqual(["organizationalUnitId", "employmentStatus"]);
    expect(checkConsistency(source(), historyOf(plan), "2026-11-02", policy).codes).toEqual([]);
  });
});

describe("EMP-004 import keeps raw classification values", () => {
  it("stores STATUS AKTIF exactly, so Aktif BUMY and Aktif PKWT stay distinguishable", () => {
    const row = normalizeEmployeeImportRow(3, {
      NIP: "SYN-0001",
      NAMA: "Pegawai Sintetis",
      "STATUS AKTIF": "Aktif BUMY",
      "STATUS KEPEGAWAIAN": "Pegawai Kontrak",
      "JENIS KEPEGAWAIAN": "Tenaga Kependidikan",
      "TAHUN KELUAR (TTTT-BB)": "-",
    });
    expect(row.candidate?.status).toBe("active");
    expect(row.candidate?.sourceClassification).toEqual({
      statusActive: "Aktif BUMY",
      employmentStatus: "Pegawai Kontrak",
      employmentType: "Tenaga Kependidikan",
      endedOn: "-",
    });
  });

  it("records an exit date cell from Excel as an ISO date string", () => {
    const row = normalizeEmployeeImportRow(4, {
      NIP: "SYN-0002",
      NAMA: "Pegawai Sintetis Dua",
      "STATUS AKTIF": "Tidak Aktif",
      "TAHUN KELUAR (TTTT-BB)": new Date(2024, 2, 15),
    });
    expect(row.candidate?.sourceClassification?.endedOn).toBe("2024-03-15");
  });
});
