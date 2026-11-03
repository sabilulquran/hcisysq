import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  enqueueFinalApprovalOversight,
  snapshotLeaveRolloutAuthorities,
} from "../src/modules/leave/organization-authority.js";
import {
  LEAVE_GOVERNANCE_CAPABILITY,
  OrganizationAuthorityResolver,
  type AccountEligibilityResult,
  type OrganizationSnapshot,
} from "../src/modules/organization/index.js";

// ORG-012: account-held Foundation Board seats as structural approvers. Synthetic data only.
const effectiveFrom = "2026-01-01";
const on = "2026-11-03";
const director = "employee-director";
const secretaryAccount = "account-secretary";
const chairAccount = "account-chair";

function seat(
  stableKey: string,
  holderSource: "EMPLOYEE" | "ACCOUNT",
  vacancyPolicy: "CLIMB_TO_PARENT" | "BLOCK" = "BLOCK",
  parentPositionKey: string | null = null,
) {
  return {
    id: `row-${stableKey}`, stableKey, nodeKey: "node-root", title: stableKey, parentPositionKey,
    singleIncumbent: true, vacancyPolicy, active: true, effectiveFrom, effectiveTo: null,
    visualRankOffset: 0, holderSource,
  };
}

function holder(id: string, positionKey: string, principal: { employeeId?: string; accountId?: string }) {
  return {
    id, positionKey, employeeId: principal.employeeId ?? null, accountId: principal.accountId ?? null,
    kind: "PRIMARY" as const, effectiveFrom, effectiveTo: null, reason: null,
  };
}

function binding(
  id: string,
  subjectKey: string,
  bindingType: "GOVERNANCE_APPROVER" | "OVERSIGHT_PARENT",
  targetPositionKey: string,
) {
  return {
    id, subjectKind: "POSITION" as const, subjectKey, bindingType, targetPositionKey,
    vacancyPolicy: "BLOCK" as const, effectiveFrom, effectiveTo: null,
  };
}

function structure(overrides: Partial<OrganizationSnapshot> = {}): OrganizationSnapshot {
  return {
    changeSet: {
      id: "change-set", name: "Synthetic", effectiveOn: effectiveFrom, status: "PUBLISHED",
      baseChangeSetId: null, validationReport: { valid: true, issues: [] }, createdByAccountId: "admin",
      createdAt: "2026-01-01T00:00:00.000Z", validatedAt: "2026-01-01T00:00:00.000Z",
      publishedAt: "2026-01-01T00:00:00.000Z",
    },
    nodes: [{
      id: "row-node-root", stableKey: "node-root", name: "Yayasan", nodeType: "governance",
      parentNodeKey: null, active: true, effectiveFrom, effectiveTo: null, visualRankOffset: 0,
      integrationCode: null,
    }],
    jobProfiles: [],
    positions: [
      seat("position-director", "EMPLOYEE"),
      seat("position-secretary", "ACCOUNT"),
      seat("position-chair", "ACCOUNT"),
    ],
    memberships: [{
      id: "membership-director", employeeId: director, nodeKey: "node-root", jobProfileKey: null,
      isPrimary: true, effectiveFrom, effectiveTo: null,
    }],
    incumbencies: [
      holder("director", "position-director", { employeeId: director }),
      holder("secretary", "position-secretary", { accountId: secretaryAccount }),
      holder("chair", "position-chair", { accountId: chairAccount }),
    ],
    authorityBindings: [
      binding("governance", "position-director", "GOVERNANCE_APPROVER", "position-secretary"),
      binding("oversight", "position-secretary", "OVERSIGHT_PARENT", "position-chair"),
    ],
    reportingOverrides: [],
    ...overrides,
  };
}

function resolver(
  snapshot: OrganizationSnapshot,
  accounts: Record<string, AccountEligibilityResult> = {},
  inactiveEmployees = new Set<string>(),
) {
  const capabilities: Array<string | null> = [];
  const subject = new OrganizationAuthorityResolver(
    { loadEffectiveSnapshot: async () => snapshot },
    {
      eligibilityValidator: {
        validate: async (employeeId) => inactiveEmployees.has(employeeId)
          ? { eligible: false, reason: "EMPLOYEE_NOT_ACTIVE" }
          : { eligible: true, reason: null },
        validateAccount: async (accountId, context) => {
          capabilities.push(context.requiredCapability);
          return accounts[accountId] ?? { kind: "ACCOUNT" };
        },
      },
    },
  );
  return { subject, capabilities };
}

const directorLeave = {
  requesterEmployeeId: director,
  effectiveDate: on,
  workflowKey: "leave.annual",
  accountCapability: LEAVE_GOVERNANCE_CAPABILITY,
};

describe("ORG-012 organ account approver", () => {
  it("resolves Director leave to the Secretary account and tells the Chair account (ORG-012-A, ORG-012-G)", async () => {
    const { subject, capabilities } = resolver(structure());
    const line = await subject.resolveLineAuthorities(directorLeave);
    expect(line.governanceApplied).toBe(true);
    expect(line.authorities).toEqual([expect.objectContaining({
      employeeId: null, accountId: secretaryAccount, source: "GOVERNANCE_APPROVER", positionKey: "position-secretary",
    })]);
    expect(capabilities).toEqual([LEAVE_GOVERNANCE_CAPABILITY]);

    const oversight = await subject.resolveOversightAbove({
      approverEmployeeId: null, approverPositionKey: "position-secretary",
      effectiveDate: on, workflowKey: "leave.annual", allowAccountRecipient: true,
    });
    expect(oversight).toMatchObject({ employeeId: null, accountId: chairAccount, source: "OVERSIGHT_PARENT" });
    // The oversight recipient needs no approval capability.
    expect(capabilities.at(-1)).toBeNull();
  });

  it("keeps failing closed for callers that do not opt in (ORG-012-F)", async () => {
    const { subject } = resolver(structure());
    await expect(subject.resolveLineAuthorities({ ...directorLeave, accountCapability: undefined }))
      .rejects.toMatchObject({ code: "INVALID_AUTHORITY_PRINCIPAL" });
    await expect(subject.resolveOversightAbove({
      approverEmployeeId: null, approverPositionKey: "position-secretary", effectiveDate: on,
    })).rejects.toMatchObject({ code: "INVALID_AUTHORITY_PRINCIPAL" });
  });

  it("never lets a seat alone grant authority: a missing capability follows the vacancy policy (ORG-012-B)", async () => {
    const { subject } = resolver(structure(), {
      [secretaryAccount]: { kind: "INELIGIBLE", reason: "CAPABILITY_MISSING" },
    });
    await expect(subject.resolveLineAuthorities(directorLeave))
      .rejects.toMatchObject({ code: "AUTHORITY_INELIGIBLE" });
  });

  it("climbs past an inactive account when the seat allows it", async () => {
    const snapshot = structure({
      positions: [
        seat("position-director", "EMPLOYEE"),
        seat("position-secretary", "ACCOUNT", "CLIMB_TO_PARENT", "position-chair"),
        seat("position-chair", "ACCOUNT"),
      ],
      authorityBindings: [{
        ...binding("governance", "position-director", "GOVERNANCE_APPROVER", "position-secretary"),
        vacancyPolicy: "CLIMB_TO_PARENT",
      }],
    });
    const { subject } = resolver(snapshot, {
      [secretaryAccount]: { kind: "INELIGIBLE", reason: "ACCOUNT_NOT_ACTIVE" },
    });
    const line = await subject.resolveLineAuthorities(directorLeave);
    expect(line.authorities).toEqual([expect.objectContaining({ accountId: chairAccount })]);
  });

  it("routes an employee account in an account-held seat to its employee principal (ORG-012-C)", async () => {
    const { subject } = resolver(structure(), {
      [secretaryAccount]: { kind: "EMPLOYEE", employeeId: "employee-salaried-secretary" },
    });
    const line = await subject.resolveLineAuthorities(directorLeave);
    expect(line.authorities).toEqual([expect.objectContaining({
      employeeId: "employee-salaried-secretary", source: "GOVERNANCE_APPROVER",
    })]);
    expect(line.authorities[0]?.accountId).toBeUndefined();
  });

  it("does not let an inactive salaried member slip through as an account principal", async () => {
    const { subject } = resolver(structure(), {
      [secretaryAccount]: { kind: "EMPLOYEE", employeeId: "employee-resigned" },
    }, new Set(["employee-resigned"]));
    await expect(subject.resolveLineAuthorities(directorLeave))
      .rejects.toMatchObject({ code: "AUTHORITY_INELIGIBLE" });
  });

  it("refuses self-resolution through a linked employee account", async () => {
    const { subject } = resolver(structure(), {
      [secretaryAccount]: { kind: "EMPLOYEE", employeeId: director },
    });
    await expect(subject.resolveLineAuthorities(directorLeave))
      .rejects.toMatchObject({ code: "AUTHORITY_SELF_RESOLUTION" });
  });

  it("refuses an organ account that shares an e-mail with an active employee", async () => {
    const { subject } = resolver(structure(), {
      [secretaryAccount]: { kind: "CONFLICT", reason: "ACCOUNT_PERSON_IS_EMPLOYEE" },
    });
    await expect(subject.resolveLineAuthorities(directorLeave))
      .rejects.toMatchObject({ code: "AUTHORITY_NOT_CONFIGURED" });
  });

  it("fails closed on mismatched seat and holder shapes", async () => {
    const accountInEmployeeSeat = structure({
      positions: [seat("position-director", "EMPLOYEE"), seat("position-secretary", "EMPLOYEE")],
    });
    await expect(resolver(accountInEmployeeSeat).subject.resolveLineAuthorities(directorLeave))
      .rejects.toMatchObject({ code: "INVALID_AUTHORITY_PRINCIPAL" });

    const employeeInAccountSeat = structure({
      incumbencies: [
        holder("director", "position-director", { employeeId: director }),
        holder("secretary", "position-secretary", { employeeId: "employee-secretary" }),
      ],
    });
    await expect(resolver(employeeInAccountSeat).subject.resolveLineAuthorities(directorLeave))
      .rejects.toMatchObject({ code: "INVALID_AUTHORITY_PRINCIPAL" });

    await expect(resolver(structure(), { [secretaryAccount]: { kind: "INVALID" } }).subject
      .resolveLineAuthorities(directorLeave))
      .rejects.toMatchObject({ code: "INVALID_AUTHORITY_PRINCIPAL" });
  });
});

describe("ORG-012 Leave snapshot and oversight", () => {
  it("stores an account principal step and keeps its seat in the resolution context", () => {
    const snapshot = snapshotLeaveRolloutAuthorities({
      mode: "STRUCTURE",
      authoritativeSource: "STRUCTURE",
      authorities: [{
        employeeId: null, accountId: secretaryAccount, source: "GOVERNANCE_APPROVER",
        path: ["position-director", "position-secretary"], incumbentKind: "PRIMARY",
        positionKey: "position-secretary",
      }],
    }, { requesterEmployeeId: director, policyChain: "LINE_AND_UNIT" });
    expect(snapshot.approvalChain).toEqual([{
      principalType: "ACCOUNT", employeeId: null, accountId: secretaryAccount, sources: ["GOVERNANCE_APPROVER"],
    }]);
    expect(snapshot.context.authorities).toEqual([expect.objectContaining({
      employeeId: null, accountId: secretaryAccount, positionKey: "position-secretary",
    })]);
  });

  it("anchors oversight on the account approver's seat and targets the Chair account (ORG-012-4)", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("{authorityResolution,mode}")) return { rows: [{ mode: "STRUCTURE" }], rowCount: 1 };
      if (sql.includes("FROM leave_request_approval_steps")) {
        return { rows: [{ employeeId: null, positionKey: "position-secretary" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const resolveOversightAbove = vi.fn(async () => ({
      employeeId: null, accountId: chairAccount, source: "OVERSIGHT_PARENT" as const,
      path: ["position-secretary", "position-chair"], incumbentKind: "PRIMARY" as const,
      positionKey: "position-chair",
    }));
    await enqueueFinalApprovalOversight(
      { query } as unknown as PoolClient,
      { requestId: "leave-request", workflowKey: "leave.annual", effectiveDate: on },
      { resolver: { resolveOversightAbove } },
    );
    expect(resolveOversightAbove).toHaveBeenCalledWith(expect.objectContaining({
      approverEmployeeId: null, approverPositionKey: "position-secretary", allowAccountRecipient: true,
    }));
    const insert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO leave_notification_outbox"));
    expect(insert?.[1]?.[2]).toBe(chairAccount);
    expect(insert?.[1]?.[4]).toBe("account");
  });
});
