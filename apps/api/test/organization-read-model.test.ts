import { describe, expect, it, vi } from "vitest";

import type {
  AuthorityEligibilityResult,
  AuthorityEligibilityValidator,
  OrganizationSnapshot,
} from "../src/modules/organization/domain.js";
import {
  buildOrganizationPeopleView,
  computeOrganizationReadiness,
  explainPerson,
  RequestScopedEligibilityValidator,
  resolveWorkLocation,
  type OrganizationPersonEmployee,
} from "../src/modules/organization/read-model.js";

/**
 * ORG-008-2 read model: one row per active employee with the direct manager the ORG-004 resolver
 * computes, the reason behind it, and what is not ready yet. Synthetic data only.
 */

const ALWAYS_ELIGIBLE: AuthorityEligibilityValidator = {
  validate: async (): Promise<AuthorityEligibilityResult> => ({ eligible: true, reason: null }),
};

function employee(id: string, name: string, extra: Partial<OrganizationPersonEmployee> = {}): OrganizationPersonEmployee {
  return {
    id,
    employeeNumber: `SYN-${id.slice(-3)}`,
    fullName: name,
    legacyUnitId: null,
    legacyUnitName: null,
    legacyDirectManagerEmployeeId: null,
    legacyDirectManagerName: null,
    legacyUnitApproverEmployeeId: null,
    legacyUnitApproverName: null,
    ...extra,
  };
}

const SCHOOL = "node-school";
const CURRICULUM = "node-curriculum";
const HEAD = "position-head";
const VICE = "position-vice";

function node(stableKey: string, name: string, parentNodeKey: string | null) {
  return {
    id: `${stableKey}-id`, stableKey, name, nodeType: "UNIT", parentNodeKey, active: true,
    effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null,
  };
}

function position(stableKey: string, nodeKey: string, title: string, parentPositionKey: string | null) {
  return {
    id: `${stableKey}-id`, stableKey, nodeKey, title, parentPositionKey, singleIncumbent: true,
    vacancyPolicy: "CLIMB_TO_PARENT" as const, active: true, effectiveFrom: "2026-01-01",
    effectiveTo: null, visualRankOffset: 0, jobProfileKey: null, holderSource: "EMPLOYEE" as const,
  };
}

function membership(employeeId: string, nodeKey: string) {
  return {
    id: `${employeeId}-${nodeKey}`, nodeKey, employeeId, isPrimary: true, jobProfileKey: null,
    effectiveFrom: "2026-01-01", effectiveTo: null,
  };
}

function incumbency(positionKey: string, employeeId: string | null, kind: "PRIMARY" | "ACTING", overrides: Record<string, unknown> = {}) {
  return {
    id: `${positionKey}-${kind}`, positionKey, employeeId, accountId: null, kind,
    effectiveFrom: "2026-01-01", effectiveTo: null, reason: null, isPrimaryStructural: false,
    ...overrides,
  };
}

function binding(subjectKey: string, bindingType: "LEADER" | "UNIT_APPROVER", targetPositionKey: string) {
  return {
    id: `${subjectKey}-${bindingType}`, subjectKind: "NODE" as const, subjectKey, bindingType,
    targetPositionKey, vacancyPolicy: "CLIMB_TO_PARENT" as const,
    effectiveFrom: "2026-01-01", effectiveTo: null,
  };
}

/** SDIT with a Curriculum team under it; the team has no leader of its own. */
function snapshot(overrides: Partial<OrganizationSnapshot> = {}): OrganizationSnapshot {
  return {
    changeSet: {
      id: "change-set", name: "Struktur Sintetis", effectiveOn: "2026-01-01", status: "PUBLISHED",
      baseChangeSetId: null, validationReport: { valid: true, issues: [], checkedAt: "" },
      createdByAccountId: "actor", createdAt: "2026-01-01T00:00:00Z",
      validatedAt: "2026-01-01T00:00:00Z", publishedAt: "2026-01-01T00:00:00Z", revision: 0,
    },
    nodes: [node(SCHOOL, "SDIT", null), node(CURRICULUM, "Kurikulum", SCHOOL)],
    jobProfiles: [],
    positions: [position(HEAD, SCHOOL, "Kepala SDIT", null), position(VICE, CURRICULUM, "Wakil Kepala Kurikulum", HEAD)],
    memberships: [membership("employee-teacher", CURRICULUM)],
    incumbencies: [incumbency(HEAD, "employee-head", "PRIMARY")],
    authorityBindings: [binding(SCHOOL, "LEADER", HEAD), binding(SCHOOL, "UNIT_APPROVER", HEAD)],
    reportingOverrides: [],
    ...overrides,
  } as OrganizationSnapshot;
}

const people = [employee("employee-teacher", "Ahmad Sintetis"), employee("employee-head", "Hasan Sintetis")];

async function build(input: Partial<Parameters<typeof buildOrganizationPeopleView>[0]> = {}) {
  return buildOrganizationPeopleView({
    snapshot: snapshot(),
    employees: people,
    eligibility: ALWAYS_ELIGIBLE,
    asOf: "2026-10-24",
    ...input,
  });
}

describe("ORG-008-2 every active employee gets a row", () => {
  it("names the direct manager inherited from the parent unit and says so", async () => {
    const rows = await build();
    const teacher = rows.find((row) => row.employeeId === "employee-teacher")!;

    expect(teacher.unit).toMatchObject({ name: "Kurikulum", path: ["SDIT", "Kurikulum"] });
    expect(teacher.directManager).toMatchObject({ employeeId: "employee-head", positionTitle: "Kepala SDIT" });
    // The team has no leader of its own, so the resolver walked up to SDIT (gap M-3).
    expect(teacher.source).toBe("INHERITED_LEADER");
    expect(teacher.unitApprover).toMatchObject({ employeeId: "employee-head" });
    expect(teacher.issues).toEqual([]);
  });

  it("counts an employee who is in no unit at all, instead of leaving them invisible (gap P-3)", async () => {
    const rows = await build({ employees: [...people, employee("employee-floating", "Citra Sintetis")] });
    const floating = rows.find((row) => row.employeeId === "employee-floating")!;

    expect(floating.unit).toBeNull();
    expect(floating.directManager).toBeNull();
    expect(floating.issues.map((item) => item.code)).toContain("MEMBERSHIP_NOT_CONFIGURED");
  });

  it("reports a failure as the employee's problem instead of guessing a manager", async () => {
    const withoutLeader = snapshot({ authorityBindings: [] });
    const rows = await build({ snapshot: withoutLeader });
    const teacher = rows.find((row) => row.employeeId === "employee-teacher")!;

    expect(teacher.directManager).toBeNull();
    expect(teacher.source).toBeNull();
    expect(teacher.issues.some((item) => item.scope === "DIRECT_MANAGER")).toBe(true);
  });

  it("marks the manager as the unit's own leader when the unit has one", async () => {
    const own = snapshot({
      authorityBindings: [binding(CURRICULUM, "LEADER", VICE), binding(SCHOOL, "UNIT_APPROVER", HEAD)],
      incumbencies: [incumbency(HEAD, "employee-head", "PRIMARY"), incumbency(VICE, "employee-vice", "PRIMARY")],
    });
    const rows = await build({
      snapshot: own,
      employees: [...people, employee("employee-vice", "Yusuf Sintetis")],
    });

    expect(rows.find((row) => row.employeeId === "employee-teacher")?.source).toBe("MEMBERSHIP_LEADER");
  });

  it("says when the seat is filled by an acting holder", async () => {
    const acting = snapshot({
      incumbencies: [incumbency(HEAD, "employee-acting", "ACTING", { effectiveTo: "2026-12-31" })],
    });
    const rows = await build({
      snapshot: acting,
      employees: [...people, employee("employee-acting", "Plt Sintetis")],
    });
    const teacher = rows.find((row) => row.employeeId === "employee-teacher")!;

    expect(teacher.source).toBe("ACTING");
    expect(teacher.directManager).toMatchObject({ employeeId: "employee-acting", incumbentKind: "ACTING" });
  });

  it("says when the chain climbed past a vacant seat", async () => {
    const vacant = snapshot({
      authorityBindings: [binding(CURRICULUM, "LEADER", VICE), binding(SCHOOL, "UNIT_APPROVER", HEAD)],
      incumbencies: [incumbency(HEAD, "employee-head", "PRIMARY")],
    });
    const rows = await build({ snapshot: vacant });
    const teacher = rows.find((row) => row.employeeId === "employee-teacher")!;

    expect(teacher.sourceDetails).toContain("VACANCY_CLIMB");
    expect(teacher.directManager).toMatchObject({ positionTitle: "Kepala SDIT" });
  });

  it("follows a per-employee exception over the unit leader", async () => {
    const override = snapshot({
      reportingOverrides: [{
        id: "override-1", employeeId: "employee-teacher", managerPositionKey: null,
        managerEmployeeId: "employee-head", reason: "Guru ini melapor langsung ke kepala sekolah",
        effectiveFrom: "2026-01-01", effectiveTo: null,
      }],
    } as Partial<OrganizationSnapshot>);
    const rows = await build({ snapshot: override });

    expect(rows.find((row) => row.employeeId === "employee-teacher")?.source).toBe("OVERRIDE");
  });

  it("returns every employee even when no structure is published yet", async () => {
    const rows = await build({ snapshot: null });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.issues[0]?.code).toBe("NO_STRUCTURE");
  });
});

describe("ORG-008-2 comparison with the legacy manager data", () => {
  it("classifies same, different, and unresolved without writing anything", async () => {
    const rows = await build({
      includeLegacy: true,
      employees: [
        employee("employee-teacher", "Ahmad Sintetis", {
          legacyDirectManagerEmployeeId: "employee-head", legacyDirectManagerName: "Hasan Sintetis",
        }),
        employee("employee-head", "Hasan Sintetis", {
          legacyDirectManagerEmployeeId: "employee-other", legacyDirectManagerName: "Orang Lain",
        }),
      ],
    });

    expect(rows.find((row) => row.employeeId === "employee-teacher")?.legacy?.comparison).toBe("SAME");
    // The head is in no unit here, so the structure cannot answer: that is reported, not guessed.
    expect(rows.find((row) => row.employeeId === "employee-head")?.legacy?.comparison).toBe("UNRESOLVED");
  });

  it("leaves legacy out entirely unless it was asked for", async () => {
    const rows = await build();
    expect(rows.every((row) => row.legacy === null)).toBe(true);
  });
});

describe("ORG-008-2 readiness counts", () => {
  it("counts employees without a unit, unresolved managers, and acting seats ending soon", async () => {
    const soon = snapshot({
      incumbencies: [
        incumbency(HEAD, "employee-head", "PRIMARY"),
        incumbency(VICE, "employee-vice", "ACTING", { effectiveTo: "2026-11-01" }),
      ],
    });
    const rows = await buildOrganizationPeopleView({
      snapshot: soon,
      employees: [...people, employee("employee-floating", "Citra Sintetis"), employee("employee-vice", "Yusuf Sintetis")],
      eligibility: ALWAYS_ELIGIBLE,
      asOf: "2026-10-24",
      includeLegacy: true,
    });
    const readiness = computeOrganizationReadiness({ rows, snapshot: soon, asOf: "2026-10-24" });

    expect(readiness.activeEmployees).toBe(4);
    // Citra is in no unit, and Yusuf only holds an acting seat, so neither has a home unit. Hasan
    // holds a position of his own, which does place him, so he is not counted.
    expect(readiness.withoutUnit).toBe(2);
    expect(readiness.actingEndingSoon).toEqual([
      expect.objectContaining({ positionTitle: "Wakil Kepala Kurikulum", endsOn: "2026-11-01" }),
    ]);
    expect(readiness.comparison).toMatchObject({ same: 0 });
  });

  it("counts a seat that requires an acting holder and has none", async () => {
    const blocked = snapshot({
      positions: [
        { ...position(HEAD, SCHOOL, "Kepala SDIT", null), vacancyPolicy: "REQUIRE_ACTING_OR_BLOCK" as const },
        position(VICE, CURRICULUM, "Wakil Kepala Kurikulum", HEAD),
      ],
      incumbencies: [],
    });
    const rows = await build({ snapshot: blocked });
    const readiness = computeOrganizationReadiness({ rows, snapshot: blocked, asOf: "2026-10-24" });

    expect(readiness.vacantRequiringActing).toBe(1);
    expect(readiness.unresolvedManager).toBe(2);
  });
});

describe("ORG-008-2 explanation steps", () => {
  it("returns codes and parameters, never a finished sentence", async () => {
    const rows = await build();
    const steps = explainPerson(rows.find((row) => row.employeeId === "employee-teacher")!);

    expect(steps.map((step) => step.code)).toEqual([
      "MEMBER_OF_UNIT", "LEADER_INHERITED_FROM_PARENT", "RESULT_DIRECT_MANAGER", "RESULT_UNIT_APPROVER",
    ]);
    expect(steps[0]?.params).toMatchObject({ employee: "Ahmad Sintetis" });
    // No Indonesian or English prose in the payload: the web app composes it.
    for (const step of steps) {
      for (const value of Object.values(step.params)) {
        expect(value ?? "").not.toMatch(/\s(adalah|is)\s/);
      }
    }
  });

  it("explains an unresolved employee with the resolver code, not an invented manager", async () => {
    const rows = await build({ snapshot: snapshot({ authorityBindings: [] }) });
    const steps = explainPerson(rows.find((row) => row.employeeId === "employee-teacher")!);

    expect(steps[steps.length - 1]?.code).toBe("RESULT_UNRESOLVED");
  });
});

describe("ORG-008-2 performance target (spec 4.8)", () => {
  it("asks the database about each distinct approver once, not once per employee", async () => {
    // 500 synthetic employees in one unit, the shape the target is written for.
    const many = Array.from({ length: 500 }, (_, index) =>
      employee(`employee-${String(index).padStart(3, "0")}`, `Pegawai Sintetis ${index}`));
    const withMembers = snapshot({
      memberships: many.map((item) => membership(item.id, CURRICULUM)),
      incumbencies: [incumbency(HEAD, "employee-head", "PRIMARY")],
    });
    const inner = { validate: vi.fn(async () => ({ eligible: true, reason: null })) };
    const eligibility = new RequestScopedEligibilityValidator(inner as unknown as AuthorityEligibilityValidator);

    const started = Date.now();
    const rows = await buildOrganizationPeopleView({
      snapshot: withMembers,
      employees: [...many, employee("employee-head", "Hasan Sintetis")],
      eligibility,
      asOf: "2026-10-24",
    });
    const elapsed = Date.now() - started;

    expect(rows).toHaveLength(501);
    expect(rows.filter((row) => row.directManager !== null)).toHaveLength(500);
    // Without memoisation this is four lookups per employee; the only distinct approver is the head.
    expect(eligibility.lookupCount).toBe(1);
    expect(inner.validate).toHaveBeenCalledTimes(1);
    // A loose ceiling: this guards against an accidental per-row await of something expensive.
    // The real number on Mi8VPS is measured in the synthetic UAT, not here.
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe("ORG-005-1 where a person works", () => {
  const nodes = [
    { id: "n1", stableKey: "school", name: "SDIT", nodeType: "SCHOOL", parentNodeKey: null, active: true,
      effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null, workLocationId: "loc-sdit" },
    { id: "n2", stableKey: "grade", name: "Kelas 1", nodeType: "UNIT", parentNodeKey: "school", active: true,
      effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null, workLocationId: null },
    { id: "n3", stableKey: "office", name: "Kantor", nodeType: "UNIT", parentNodeKey: null, active: true,
      effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null },
  ];
  const snapshot = { nodes } as unknown as Parameters<typeof resolveWorkLocation>[0];
  const names = new Map([["loc-sdit", "Kampus SDIT"]]);

  it("uses the unit's own location", () => {
    expect(resolveWorkLocation(snapshot, "school", "2026-10-27", names))
      .toEqual({ id: "loc-sdit", name: "Kampus SDIT", inheritedFromNodeKey: null });
  });

  it("inherits the nearest ancestor's location and says from where", () => {
    expect(resolveWorkLocation(snapshot, "grade", "2026-10-27", names))
      .toEqual({ id: "loc-sdit", name: "Kampus SDIT", inheritedFromNodeKey: "school" });
  });

  it("answers null when nothing up the branch names a location, never a guess", () => {
    expect(resolveWorkLocation(snapshot, "office", "2026-10-27", names)).toBeNull();
  });
});
