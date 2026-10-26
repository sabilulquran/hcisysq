import { describe, expect, it } from "vitest";

import { computeRoleSeatCheck, type RoleSeatHolder } from "../src/modules/auth/role-seat-check.js";
import type { OrganizationSnapshot } from "../src/modules/organization/domain.js";

/**
 * ORG-008-9: the Kepala HC role and the Kepala HC seat are compared, never synchronised. AUTH-011
 * forbids a position from granting administrative permission, so the check only reports.
 */

const AS_OF = "2026-10-27";
const SEAT = "position-kepala-hc";
const LINK = { positionKey: SEAT, reason: "SK Ketua Yayasan 12/2026", setAt: "2026-10-27T01:00:00.000Z" };

function snapshot(incumbencies: Array<{ employeeId: string; kind: "PRIMARY" | "ACTING"; effectiveTo?: string | null }>): OrganizationSnapshot {
  return {
    changeSet: {
      id: "published", name: "Struktur", effectiveOn: "2026-10-01", status: "PUBLISHED",
      baseChangeSetId: null, validationReport: { valid: true, issues: [], checkedAt: "" },
      createdByAccountId: "actor", createdAt: "2026-09-01T00:00:00Z",
      validatedAt: "2026-09-20T00:00:00Z", publishedAt: "2026-09-20T00:00:00Z", revision: 0,
    },
    nodes: [{
      id: "node", stableKey: "node-hc", name: "Human Capital", nodeType: "UNIT", parentNodeKey: null,
      active: true, effectiveFrom: "2026-10-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null,
    }],
    jobProfiles: [],
    positions: [{
      id: "position", stableKey: SEAT, nodeKey: "node-hc", title: "Kepala Human Capital",
      parentPositionKey: null, singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true,
      effectiveFrom: "2026-10-01", effectiveTo: null, visualRankOffset: 0, holderSource: "EMPLOYEE",
    }],
    memberships: [],
    incumbencies: incumbencies.map((item, index) => ({
      id: `incumbency-${index}`, positionKey: SEAT, employeeId: item.employeeId, accountId: null,
      kind: item.kind, isPrimaryStructural: false, effectiveFrom: "2026-10-01",
      effectiveTo: item.effectiveTo ?? null, reason: null,
    })),
    authorityBindings: [],
    reportingOverrides: [],
  } as OrganizationSnapshot;
}

const names = new Map([["emp-siti", "Siti"], ["emp-budi", "Budi"], ["emp-rina", "Rina"]]);
const holder = (employeeId: string, name: string): RoleSeatHolder => ({ accountId: `acct-${employeeId}`, employeeId, name });
const account = (employeeId: string, status = "active") => ({ accountId: `acct-${employeeId}`, employeeId, status });

function check(overrides: Partial<Parameters<typeof computeRoleSeatCheck>[0]> = {}) {
  return computeRoleSeatCheck({
    roleKey: "human_capital_lead", asOf: AS_OF, link: LINK,
    snapshot: snapshot([{ employeeId: "emp-siti", kind: "PRIMARY" }]),
    holders: [holder("emp-siti", "Siti")],
    employeeNames: names,
    accounts: [account("emp-siti")],
    ...overrides,
  });
}

describe("ORG-008-9 the Kepala HC role against the Kepala HC seat", () => {
  it("reports nothing when the seat holder is the one holding the role", () => {
    const result = check();
    expect(result.status).toBe("CHECKED");
    expect(result.seat).toMatchObject({ title: "Kepala Human Capital", unitName: "Human Capital" });
    expect(result.mismatches).toEqual([]);
  });

  it("warns when the role stayed with the previous seat holder", () => {
    const result = check({
      snapshot: snapshot([{ employeeId: "emp-budi", kind: "PRIMARY" }]),
      holders: [holder("emp-siti", "Siti")],
      accounts: [account("emp-budi")],
    });
    expect(result.mismatches).toEqual([
      { kind: "HOLDER_NOT_SEATED", accountId: "acct-emp-siti", employeeId: "emp-siti", name: "Siti" },
      { kind: "SEATED_WITHOUT_ROLE", employeeId: "emp-budi", name: "Budi", incumbentKind: "PRIMARY", reason: "NO_ROLE" },
    ]);
  });

  it("counts an acting holder (Plt) as a legitimate seat holder (owner decision 2026-10-27)", () => {
    const result = check({
      snapshot: snapshot([{ employeeId: "emp-rina", kind: "ACTING" }]),
      holders: [holder("emp-rina", "Rina")],
      accounts: [account("emp-rina")],
    });
    expect(result.status).toBe("CHECKED");
    expect(result.mismatches).toEqual([]);
  });

  it("says why a seat holder cannot hold the role yet", () => {
    const noAccount = check({ holders: [], accounts: [] });
    expect(noAccount.mismatches).toMatchObject([{ kind: "SEATED_WITHOUT_ROLE", reason: "NO_ACCOUNT" }]);
    const suspended = check({ holders: [], accounts: [account("emp-siti", "suspended")] });
    expect(suspended.mismatches).toMatchObject([{ kind: "SEATED_WITHOUT_ROLE", reason: "ACCOUNT_NOT_ACTIVE" }]);
  });

  it("ignores an incumbency that has already ended", () => {
    const result = check({
      snapshot: snapshot([{ employeeId: "emp-siti", kind: "PRIMARY", effectiveTo: "2026-10-26" }]),
    });
    expect(result.status).toBe("SEAT_VACANT");
    expect(result.mismatches).toEqual([
      { kind: "HOLDER_NOT_SEATED", accountId: "acct-emp-siti", employeeId: "emp-siti", name: "Siti" },
    ]);
  });

  it("does not compare without a seat or a structure, and says which is missing", () => {
    expect(check({ link: null })).toMatchObject({ status: "SEAT_NOT_SET", seat: null, mismatches: [] });
    expect(check({ snapshot: null })).toMatchObject({ status: "NO_PUBLISHED_STRUCTURE", mismatches: [] });
    expect(check({ link: { ...LINK, positionKey: "position-gone" } }))
      .toMatchObject({ status: "SEAT_NOT_IN_STRUCTURE", mismatches: [] });
  });
});
