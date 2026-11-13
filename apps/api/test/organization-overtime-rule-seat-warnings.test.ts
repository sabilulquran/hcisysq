import { describe, expect, it } from "vitest";

import type { OrganizationPosition, OrganizationSnapshot } from "../src/modules/organization/domain.js";
import { overtimeRuleSeatWarnings } from "../src/modules/organization/overtime-rule-seat-warnings.js";

const UNIT_A = "00000000-0000-4000-8000-0000000000a1";
const UNIT_B = "00000000-0000-4000-8000-0000000000b1";
const DIREKTUR = "00000000-0000-4000-8000-0000000000d1";
const STAFF = "00000000-0000-4000-8000-0000000000d2";

function seat(stableKey: string, title: string, overrides: Partial<OrganizationPosition> = {}): OrganizationPosition {
  return {
    id: `${stableKey.slice(0, -2)}ff`, stableKey, nodeKey: UNIT_A, title, parentPositionKey: null,
    singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true,
    visualRankOffset: 0, effectiveFrom: "2026-01-01", effectiveTo: null, ...overrides,
  };
}

function snapshot(id: string, positions: OrganizationPosition[]): OrganizationSnapshot {
  return {
    changeSet: {
      id, name: "Synthetic", effectiveOn: "2026-12-01", status: "DRAFT", baseChangeSetId: null,
      validationReport: {}, createdByAccountId: "00000000-0000-4000-8000-000000000020",
      createdAt: "2026-11-01T00:00:00.000Z", validatedAt: null, publishedAt: null,
    },
    nodes: [
      { id: "n1", stableKey: UNIT_A, name: "Yayasan", nodeType: "UNIT", parentNodeKey: null, active: true,
        effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null },
      { id: "n2", stableKey: UNIT_B, name: "Bidang Pendidikan", nodeType: "UNIT", parentNodeKey: UNIT_A, active: true,
        effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null },
    ],
    jobProfiles: [], positions, memberships: [], incumbencies: [], authorityBindings: [], reportingOverrides: [],
  };
}

const rule = { id: "rule-1", positionKey: DIREKTUR, targetLabel: "Direktur · Yayasan", reasonLabel: "Direktur — tidak menerima upah lembur" };
const base = snapshot("base", [seat(DIREKTUR, "Direktur"), seat(STAFF, "Staf")]);

describe("ORG-008-12 overtime rule seat warnings (O-8)", () => {
  it("says nothing when the rule's seat is untouched, even if other seats change", () => {
    const after = snapshot("draft", [seat(DIREKTUR, "Direktur"), seat(STAFF, "Staf", { nodeKey: UNIT_B })]);
    expect(overtimeRuleSeatWarnings([rule], base, after)).toEqual([]);
  });

  it("warns when the seat is removed, switched off, ended before the date, or moved", () => {
    expect(overtimeRuleSeatWarnings([rule], base, snapshot("d", [seat(STAFF, "Staf")]))[0])
      .toMatchObject({ change: "REMOVED", positionTitle: "Direktur", beforeUnitName: "Yayasan", afterUnitName: null });
    expect(overtimeRuleSeatWarnings([rule], base, snapshot("d", [seat(DIREKTUR, "Direktur", { active: false })]))[0]?.change)
      .toBe("DEACTIVATED");
    expect(overtimeRuleSeatWarnings([rule], base, snapshot("d", [seat(DIREKTUR, "Direktur", { effectiveTo: "2026-11-30" })]))[0]?.change)
      .toBe("DEACTIVATED");
    expect(overtimeRuleSeatWarnings([rule], base, snapshot("d", [seat(DIREKTUR, "Direktur Utama", { nodeKey: UNIT_B })]))[0])
      .toMatchObject({ change: "MOVED", positionTitle: "Direktur Utama", beforeUnitName: "Yayasan", afterUnitName: "Bidang Pendidikan", ruleId: "rule-1" });
  });

  it("does not blame the change for a seat that was not in force in its base, nor warn without a base", () => {
    const inactiveBase = snapshot("base", [seat(DIREKTUR, "Direktur", { active: false })]);
    expect(overtimeRuleSeatWarnings([rule], inactiveBase, snapshot("d", []))).toEqual([]);
    expect(overtimeRuleSeatWarnings([rule], null, snapshot("d", []))).toEqual([]);
  });

  it("a rename alone is not a warning: the rule follows the stable key", () => {
    const after = snapshot("d", [seat(DIREKTUR, "Direktur Eksekutif"), seat(STAFF, "Staf")]);
    expect(overtimeRuleSeatWarnings([rule], base, after)).toEqual([]);
  });
});
