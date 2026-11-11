/** LEAVE-008 adds `postponement_proposed` (awaiting the requester) and `postponed` (replaced). */
export type LeaveRequestStatus =
  | "in_review"
  | "approved"
  | "rejected"
  | "cancelled"
  | "postponement_proposed"
  | "postponed";
export type LeaveApprovalStepStatus =
  | "waiting"
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "postponed";
export type LeaveLineHandling = "approval" | "notify" | "none";

export interface LeaveApprovalStepState {
  id: string;
  order: number;
  status: LeaveApprovalStepStatus;
}

export interface LeaveApprovalDecisionResult {
  requestStatus: LeaveRequestStatus;
  decidedStepStatus: "approved" | "rejected";
  nextPendingStepId: string | null;
}

export class LeaveWorkflowError extends Error {
  constructor(
    readonly code:
      | "REQUEST_NOT_REVIEWABLE"
      | "LEAVE_REQUEST_NOT_CANCELLABLE"
      | "STEP_NOT_PENDING"
      | "STEP_ORDER_INVALID"
      | "APPROVAL_STATE_INVALID"
      | "POSTPONEMENT_NOT_SUPPORTED"
      | "POSTPONEMENT_DATES_UNCHANGED"
      | "POSTPONEMENT_DATE_PASSED",
    message: string,
  ) {
    super(message);
    this.name = "LeaveWorkflowError";
  }
}

function sortedSteps(steps: readonly LeaveApprovalStepState[]) {
  const sorted = [...steps].sort((a, b) => a.order - b.order);
  const seen = new Set<number>();
  for (const step of sorted) {
    if (seen.has(step.order)) {
      throw new LeaveWorkflowError(
        "STEP_ORDER_INVALID",
        "Urutan approval tidak boleh duplikat.",
      );
    }
    seen.add(step.order);
  }
  return sorted;
}

function assertSequentialSnapshotState(steps: readonly LeaveApprovalStepState[]) {
  const pendingSteps = steps.filter((step) => step.status === "pending");
  if (pendingSteps.length !== 1) {
    throw new LeaveWorkflowError(
      "APPROVAL_STATE_INVALID",
      "Snapshot approval harus memiliki tepat satu tahap aktif selama pengajuan masih diproses.",
    );
  }

  const pending = pendingSteps[0]!;
  for (const step of steps) {
    if (step.order < pending.order && step.status !== "approved") {
      throw new LeaveWorkflowError(
        "APPROVAL_STATE_INVALID",
        "Tahap sebelum approver aktif harus sudah disetujui.",
      );
    }
    if (step.order > pending.order && step.status !== "waiting") {
      throw new LeaveWorkflowError(
        "APPROVAL_STATE_INVALID",
        "Tahap setelah approver aktif harus tetap menunggu.",
      );
    }
  }
}

export function decideLeaveApprovalStep(input: {
  requestStatus: LeaveRequestStatus;
  stepId: string;
  decision: "approve" | "reject";
  steps: readonly LeaveApprovalStepState[];
}): LeaveApprovalDecisionResult {
  if (input.requestStatus !== "in_review") {
    throw new LeaveWorkflowError(
      "REQUEST_NOT_REVIEWABLE",
      "Pengajuan tidak lagi dalam proses approval.",
    );
  }

  const steps = sortedSteps(input.steps);
  assertSequentialSnapshotState(steps);

  const current = steps.find((step) => step.id === input.stepId);
  if (!current || current.status !== "pending") {
    throw new LeaveWorkflowError(
      "STEP_NOT_PENDING",
      "Tahap approval ini bukan tahap aktif.",
    );
  }

  if (input.decision === "reject") {
    return {
      requestStatus: "rejected",
      decidedStepStatus: "rejected",
      nextPendingStepId: null,
    };
  }

  const next = steps.find(
    (step) => step.order > current.order && step.status === "waiting",
  );
  return {
    requestStatus: next ? "in_review" : "approved",
    decidedStepStatus: "approved",
    nextPendingStepId: next?.id ?? null,
  };
}

/**
 * LEAVE-010: the requester may withdraw line-approval leave (Cuti Tahunan, planned leave) for
 * as long as it awaits any decision. Approved leave is post-approval cancellation, which stays
 * with HC; special leave reports are withdrawn through HC.
 */
/**
 * LEAVE-008: the owner of the active line step may propose other dates instead of deciding.
 * Same state rules as a decision; the caller has already checked step ownership.
 */
export function assertLeaveStepPostponable(input: {
  requestStatus: LeaveRequestStatus;
  lineHandling: LeaveLineHandling;
  policySupported: boolean;
  stepId: string;
  steps: readonly LeaveApprovalStepState[];
}) {
  if (input.requestStatus !== "in_review") {
    throw new LeaveWorkflowError(
      "REQUEST_NOT_REVIEWABLE",
      "Pengajuan tidak lagi dalam proses approval.",
    );
  }
  if (input.lineHandling !== "approval" || !input.policySupported) {
    throw new LeaveWorkflowError(
      "POSTPONEMENT_NOT_SUPPORTED",
      "Jenis cuti ini tidak dapat diusulkan tanggal lain.",
    );
  }
  const steps = sortedSteps(input.steps);
  assertSequentialSnapshotState(steps);
  const current = steps.find((step) => step.id === input.stepId);
  if (!current || current.status !== "pending") {
    throw new LeaveWorkflowError(
      "STEP_NOT_PENDING",
      "Tahap approval ini bukan tahap aktif.",
    );
  }
  return {
    postponedStepId: current.id,
    cancelledStepIds: steps.filter((step) => step.status === "waiting").map((step) => step.id),
  };
}

/** LEAVE-008 D-04: proposed dates differ from the request and start after today (Jakarta). */
export function assertPostponementDates(input: {
  currentStartOn: string;
  currentEndOn: string;
  proposedStartOn: string;
  proposedEndOn: string;
  today: string;
}) {
  if (input.proposedStartOn === input.currentStartOn && input.proposedEndOn === input.currentEndOn) {
    throw new LeaveWorkflowError(
      "POSTPONEMENT_DATES_UNCHANGED",
      "Tanggal usulan sama dengan tanggal pengajuan. Setujui pengajuan bila tanggalnya dapat diterima.",
    );
  }
  assertPostponementStillAhead(input.proposedStartOn, input.today);
}

export function assertPostponementStillAhead(proposedStartOn: string, today: string) {
  if (proposedStartOn <= today) {
    throw new LeaveWorkflowError(
      "POSTPONEMENT_DATE_PASSED",
      "Tanggal mulai usulan harus setelah hari ini.",
    );
  }
}

export function canCancelLeaveRequest(request: { status: LeaveRequestStatus; lineHandling: LeaveLineHandling }) {
  return request.status === "in_review" && request.lineHandling === "approval";
}

export function assertLeaveRequestCancellable(request: { status: LeaveRequestStatus; lineHandling: LeaveLineHandling }) {
  if (canCancelLeaveRequest(request)) return;
  throw new LeaveWorkflowError(
    "LEAVE_REQUEST_NOT_CANCELLABLE",
    request.status === "postponement_proposed"
      ? "Penyetuju mengusulkan tanggal lain. Terima atau tolak usulan itu."
      : request.status !== "in_review"
        ? "Pengajuan ini sudah diputuskan atau dibatalkan, sehingga tidak dapat dibatalkan lagi."
        : "Laporan cuti khusus dibatalkan melalui Human Capital.",
  );
}
