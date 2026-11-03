import { describe, expect, it } from "vitest";

import { describeLeave } from "../src/modules/leave/approver-notifications.js";
import {
  assertLeaveRequestCancellable,
  canCancelLeaveRequest,
  decideLeaveApprovalStep,
  LeaveWorkflowError,
} from "../src/modules/leave/domain/request-workflow.js";

describe("leave approval snapshot workflow", () => {
  it("activates the next snapshotted step without recomputing hierarchy", () => {
    const result = decideLeaveApprovalStep({
      requestStatus: "in_review",
      stepId: "step-1",
      decision: "approve",
      steps: [
        { id: "step-1", order: 1, status: "pending" },
        { id: "step-2", order: 2, status: "waiting" },
      ],
    });
    expect(result.requestStatus).toBe("in_review");
    expect(result.nextPendingStepId).toBe("step-2");
  });

  it("finalizes when the last pending step is approved", () => {
    const result = decideLeaveApprovalStep({
      requestStatus: "in_review",
      stepId: "step-2",
      decision: "approve",
      steps: [
        { id: "step-1", order: 1, status: "approved" },
        { id: "step-2", order: 2, status: "pending" },
      ],
    });
    expect(result.requestStatus).toBe("approved");
    expect(result.nextPendingStepId).toBeNull();
  });

  it("rejects from the active step", () => {
    const result = decideLeaveApprovalStep({
      requestStatus: "in_review",
      stepId: "step-1",
      decision: "reject",
      steps: [
        { id: "step-1", order: 1, status: "pending" },
        { id: "step-2", order: 2, status: "waiting" },
      ],
    });
    expect(result.requestStatus).toBe("rejected");
  });

  it("does not allow acting on a waiting step", () => {
    expect(() =>
      decideLeaveApprovalStep({
        requestStatus: "in_review",
        stepId: "step-2",
        decision: "approve",
        steps: [
          { id: "step-1", order: 1, status: "pending" },
          { id: "step-2", order: 2, status: "waiting" },
        ],
      }),
    ).toThrowError(LeaveWorkflowError);
  });

  it("fails closed when more than one approval step is active", () => {
    expect(() =>
      decideLeaveApprovalStep({
        requestStatus: "in_review",
        stepId: "step-1",
        decision: "approve",
        steps: [
          { id: "step-1", order: 1, status: "pending" },
          { id: "step-2", order: 2, status: "pending" },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "APPROVAL_STATE_INVALID" }));
  });

  it("fails closed when an earlier snapshotted step was not approved", () => {
    expect(() =>
      decideLeaveApprovalStep({
        requestStatus: "in_review",
        stepId: "step-2",
        decision: "approve",
        steps: [
          { id: "step-1", order: 1, status: "waiting" },
          { id: "step-2", order: 2, status: "pending" },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "APPROVAL_STATE_INVALID" }));
  });
});

describe("LEAVE-010 requester cancellation rule", () => {
  it("allows cancelling line-approval leave only while it awaits a decision", () => {
    expect(canCancelLeaveRequest({ status: "in_review", lineHandling: "approval" })).toBe(true);
    for (const status of ["approved", "rejected", "cancelled"] as const) {
      expect(canCancelLeaveRequest({ status, lineHandling: "approval" }), status).toBe(false);
      expect(() => assertLeaveRequestCancellable({ status, lineHandling: "approval" })).toThrow(/sudah diputuskan/);
    }
    // Special leave reports (line only notified) are withdrawn through HC.
    expect(canCancelLeaveRequest({ status: "in_review", lineHandling: "notify" })).toBe(false);
    expect(() => assertLeaveRequestCancellable({ status: "in_review", lineHandling: "notify" }))
      .toThrow(expect.objectContaining({ code: "LEAVE_REQUEST_NOT_CANCELLABLE" }));
  });

  it("describes the leave for an approver without the reason", () => {
    expect(describeLeave({ policyKey: "annual", startOn: "2099-02-02", endOn: "2099-02-03", workingDays: 2 }))
      .toMatch(/^Cuti Tahunan 2 Feb 2099.3 Feb 2099 \(2 hari kerja\)$/);
    expect(describeLeave({ policyKey: "unpaid", startOn: "2099-02-02", endOn: "2099-02-02", workingDays: 1 }))
      .toBe("Cuti Tanpa Gaji 2 Feb 2099 (1 hari kerja)");
  });
});
