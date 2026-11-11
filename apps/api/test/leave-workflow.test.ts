import { describe, expect, it } from "vitest";

import { describeLeave } from "../src/modules/leave/approver-notifications.js";
import {
  assertLeaveRequestCancellable,
  assertLeaveStepPostponable,
  assertPostponementDates,
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

describe("LEAVE-008 postponement rules", () => {
  const steps = [
    { id: "step-1", order: 1, status: "approved" as const },
    { id: "step-2", order: 2, status: "pending" as const },
    { id: "step-3", order: 3, status: "waiting" as const },
  ];

  it("lets only the active line step propose, and closes the later steps", () => {
    expect(assertLeaveStepPostponable({
      requestStatus: "in_review", lineHandling: "approval", policySupported: true, stepId: "step-2", steps,
    })).toEqual({ postponedStepId: "step-2", cancelledStepIds: ["step-3"] });
    expect(() => assertLeaveStepPostponable({
      requestStatus: "in_review", lineHandling: "approval", policySupported: true, stepId: "step-3", steps,
    })).toThrow(expect.objectContaining({ code: "STEP_NOT_PENDING" }));
    for (const requestStatus of ["approved", "rejected", "cancelled", "postponement_proposed", "postponed"] as const) {
      expect(() => assertLeaveStepPostponable({
        requestStatus, lineHandling: "approval", policySupported: true, stepId: "step-2", steps,
      }), requestStatus).toThrow(expect.objectContaining({ code: "REQUEST_NOT_REVIEWABLE" }));
    }
    expect(() => assertLeaveStepPostponable({
      requestStatus: "in_review", lineHandling: "notify", policySupported: true, stepId: "step-2", steps,
    })).toThrow(expect.objectContaining({ code: "POSTPONEMENT_NOT_SUPPORTED" }));
    expect(() => assertLeaveStepPostponable({
      requestStatus: "in_review", lineHandling: "approval", policySupported: false, stepId: "step-2", steps,
    })).toThrow(expect.objectContaining({ code: "POSTPONEMENT_NOT_SUPPORTED" }));
  });

  it("requires different dates that start after today", () => {
    const base = { currentStartOn: "2099-02-02", currentEndOn: "2099-02-03", today: "2099-01-05" };
    expect(() => assertPostponementDates({ ...base, proposedStartOn: "2099-02-09", proposedEndOn: "2099-02-10" })).not.toThrow();
    expect(() => assertPostponementDates({ ...base, proposedStartOn: "2099-02-02", proposedEndOn: "2099-02-03" }))
      .toThrow(expect.objectContaining({ code: "POSTPONEMENT_DATES_UNCHANGED" }));
    expect(() => assertPostponementDates({ ...base, proposedStartOn: "2099-01-05", proposedEndOn: "2099-01-06" }))
      .toThrow(expect.objectContaining({ code: "POSTPONEMENT_DATE_PASSED" }));
    // Only the end moves: still a different proposal.
    expect(() => assertPostponementDates({ ...base, proposedStartOn: "2099-02-02", proposedEndOn: "2099-02-02" })).not.toThrow();
  });

  it("points a requester with an open proposal to the proposal instead of cancelling", () => {
    expect(canCancelLeaveRequest({ status: "postponement_proposed", lineHandling: "approval" })).toBe(false);
    expect(() => assertLeaveRequestCancellable({ status: "postponement_proposed", lineHandling: "approval" }))
      .toThrow(/Terima atau tolak usulan/);
  });
});
