import { describe, expect, it } from "vitest";

import {
  snapshotResolvedLeaveAuthorities,
} from "../src/modules/leave/domain/approval-chain.js";
import {
  decideLeaveApprovalStep,
} from "../src/modules/leave/domain/request-workflow.js";

describe("deployed Leave approval principal compatibility", () => {
  it("preserves an employee approval principal", () => {
    expect(snapshotResolvedLeaveAuthorities({
      requesterEmployeeId: "employee-requester",
      authorities: [{
        principalType: "EMPLOYEE",
        employeeId: "employee-approver",
        accountId: null,
        source: "DIRECT_MANAGER",
      }],
    })).toEqual([{
      employeeId: "employee-approver",
      sources: ["DIRECT_MANAGER"],
    }]);
  });

  it("preserves an account approval principal without converting it to an employee", () => {
    expect(snapshotResolvedLeaveAuthorities({
      requesterEmployeeId: "employee-requester",
      authorities: [{
        principalType: "ACCOUNT",
        employeeId: null,
        accountId: "account-governance",
        source: "GOVERNANCE_APPROVER",
      }],
    })).toEqual([{
      principalType: "ACCOUNT",
      employeeId: null,
      accountId: "account-governance",
      sources: ["GOVERNANCE_APPROVER"],
    }]);
  });

  it.each([
    {
      principalType: "ACCOUNT" as const,
      employeeId: null,
      accountId: null,
      label: "missing",
    },
    {
      principalType: "ACCOUNT" as const,
      employeeId: "employee-approver",
      accountId: "account-governance",
      label: "ambiguous",
    },
    {
      principalType: "EMPLOYEE" as const,
      employeeId: "employee-approver",
      accountId: "account-governance",
      label: "mismatched",
    },
  ])("fails closed for a $label approval principal", (principal) => {
    expect(() => snapshotResolvedLeaveAuthorities({
      requesterEmployeeId: "employee-requester",
      authorities: [{
        principalType: principal.principalType,
        employeeId: principal.employeeId,
        accountId: principal.accountId,
        source: "GOVERNANCE_APPROVER",
      }],
    })).toThrowError(expect.objectContaining({ code: "APPROVAL_CHAIN_EMPTY" }));
  });

  it("keeps an already-snapshotted step immutable when employee lifecycle changes later", () => {
    const storedSteps = [
      { id: "historic-step", order: 1, status: "pending" as const },
    ];
    const result = decideLeaveApprovalStep({
      requestStatus: "in_review",
      stepId: "historic-step",
      decision: "approve",
      steps: storedSteps,
    });

    expect(storedSteps).toEqual([
      { id: "historic-step", order: 1, status: "pending" },
    ]);
    expect(result.decidedStepStatus).toBe("approved");
    expect(result.requestStatus).toBe("approved");
  });
});
