import { describe, expect, it } from "vitest";

import {
  computeRoleSeatCheck,
  type RoleSeatHolder,
  type SeatHolderRow,
} from "../src/modules/auth/role-seat-check.js";
import type { OrganizationSnapshot } from "../src/modules/organization/domain.js";

/**
 * AUTH-015 (ADR-0007): a role follows its seats. The check reports, per role, who sits in each
 * linked seat and whether the role is in force for them, and which direct grants follow no seat.
 * The permission engine itself is exercised against PostgreSQL in auth011-postgres.integration.
 */

const AS_OF = "2026-11-04";
const SEAT = "position-staf-keuangan";
const OTHER_SEAT = "position-kasir";
const LINK = { positionKey: SEAT, reason: "Keputusan owner 2026-11-04", setAt: "2026-11-04T01:00:00.000Z" };

function snapshot(positions: Array<{ key: string; title: string; active?: boolean }> = [{ key: SEAT, title: "Staf Keuangan" }]): OrganizationSnapshot {
  return {
    changeSet: {
      id: "published", name: "Struktur", effectiveOn: "2026-10-01", status: "PUBLISHED",
      baseChangeSetId: null, validationReport: { valid: true, issues: [], checkedAt: "" },
      createdByAccountId: "actor", createdAt: "2026-09-01T00:00:00Z",
      validatedAt: "2026-09-20T00:00:00Z", publishedAt: "2026-09-20T00:00:00Z", revision: 0,
    },
    nodes: [{
      id: "node", stableKey: "node-keuangan", name: "Keuangan", nodeType: "UNIT", parentNodeKey: null,
      active: true, effectiveFrom: "2026-10-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null,
    }],
    jobProfiles: [],
    positions: positions.map((item, index) => ({
      id: `position-${index}`, stableKey: item.key, nodeKey: "node-keuangan", title: item.title,
      parentPositionKey: null, singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: item.active ?? true,
      effectiveFrom: "2026-10-01", effectiveTo: null, visualRankOffset: 0, holderSource: "EMPLOYEE",
    })),
    memberships: [],
    incumbencies: [],
    authorityBindings: [],
    reportingOverrides: [],
  } as OrganizationSnapshot;
}

const holder = (employeeId: string, name: string): RoleSeatHolder => ({ accountId: `acct-${employeeId}`, employeeId, name });
const seated = (employeeId: string, name: string, overrides: Partial<SeatHolderRow> = {}): SeatHolderRow => ({
  positionKey: SEAT, employeeId, name, kind: "PRIMARY", accountId: `acct-${employeeId}`,
  accountStatus: "active", employeeActive: true, ...overrides,
});

function check(overrides: Partial<Parameters<typeof computeRoleSeatCheck>[0]> = {}) {
  return computeRoleSeatCheck({
    roleKey: "finance_officer", roleName: "Staf Keuangan (Kasbon)", asOf: AS_OF, links: [LINK],
    snapshot: snapshot(),
    holders: [],
    seatHolders: [seated("emp-panji", "Panji")],
    ...overrides,
  });
}

describe("AUTH-015 a role follows its seats", () => {
  it("shows the seat holder as holding the role, with nothing to warn about", () => {
    const result = check();
    expect(result.seats).toMatchObject([{
      positionKey: SEAT, title: "Staf Keuangan", unitName: "Keuangan", status: "HELD",
      incumbents: [{ employeeId: "emp-panji", kind: "PRIMARY", roleEffective: true, notEffectiveReason: null, alsoDirect: false }],
    }]);
    expect(result.mismatches).toEqual([]);
  });

  it("says why the role is not in force yet for a seat holder", () => {
    const result = check({
      seatHolders: [
        seated("emp-panji", "Panji", { accountStatus: "invited" }),
        seated("emp-rina", "Rina", { accountId: null, accountStatus: null }),
        seated("emp-budi", "Budi", { employeeActive: false, kind: "ACTING" }),
      ],
    });
    expect(result.seats[0]!.incumbents.map((item) => [item.name, item.roleEffective, item.notEffectiveReason])).toEqual([
      ["Budi", false, "EMPLOYEE_NOT_ACTIVE"],
      ["Panji", false, "ACCOUNT_NOT_ACTIVE"],
      ["Rina", false, "NO_ACCOUNT"],
    ]);
    expect(result.mismatches).toContainEqual(expect.objectContaining({
      kind: "SEAT_HOLDER_NOT_EFFECTIVE", employeeId: "emp-panji", reason: "ACCOUNT_NOT_ACTIVE", positionKey: SEAT,
    }));
    expect(result.mismatches).toContainEqual(expect.objectContaining({
      kind: "SEAT_HOLDER_NOT_EFFECTIVE", employeeId: "emp-budi", incumbentKind: "ACTING", reason: "EMPLOYEE_NOT_ACTIVE",
    }));
  });

  it("flags a direct grant held by someone in none of the role's seats, and marks a seated one", () => {
    const result = check({ holders: [holder("emp-siti", "Siti"), holder("emp-panji", "Panji")] });
    expect(result.mismatches).toEqual([
      { kind: "DIRECT_HOLDER_NOT_SEATED", accountId: "acct-emp-siti", employeeId: "emp-siti", name: "Siti" },
    ]);
    expect(result.seats[0]!.incumbents[0]!.alsoDirect).toBe(true);
  });

  it("handles several seats for one role and reports each seat on its own", () => {
    const result = check({
      links: [LINK, { ...LINK, positionKey: OTHER_SEAT }],
      snapshot: snapshot([{ key: SEAT, title: "Staf Keuangan" }, { key: OTHER_SEAT, title: "Kasir" }]),
      holders: [holder("emp-rina", "Rina")],
      seatHolders: [seated("emp-panji", "Panji"), seated("emp-rina", "Rina", { positionKey: OTHER_SEAT })],
    });
    expect(result.seats.map((seat) => [seat.title, seat.status, seat.incumbents.map((item) => item.name)])).toEqual([
      ["Staf Keuangan", "HELD", ["Panji"]],
      ["Kasir", "HELD", ["Rina"]],
    ]);
    // Rina's direct grant is covered by a seat of the same role.
    expect(result.mismatches).toEqual([]);
  });

  it("reports a vacant seat, a seat gone from the structure, and a missing structure", () => {
    expect(check({ seatHolders: [] }).seats[0]!.status).toBe("SEAT_VACANT");
    expect(check({ snapshot: snapshot([{ key: SEAT, title: "Staf Keuangan", active: false }]) }).seats[0])
      .toMatchObject({ status: "SEAT_NOT_IN_STRUCTURE", title: null, incumbents: [] });
    expect(check({ snapshot: null }).seats[0]).toMatchObject({ status: "NO_PUBLISHED_STRUCTURE", incumbents: [] });
  });

  it("does not call a direct grant a discrepancy while the role follows no seat", () => {
    expect(check({ links: [], holders: [holder("emp-siti", "Siti")] }).mismatches).toEqual([]);
  });
});
