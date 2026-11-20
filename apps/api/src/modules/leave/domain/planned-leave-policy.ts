import {
  CalendarDurationError,
  calendarDaysBetween,
  inclusiveCalendarDurationDays,
} from "./calendar-duration.js";
import type { LeaveWorkflowPolicyKey } from "../../organization/workflow-keys.js";
import { getLeavePolicy, type LeavePolicyKey } from "./policy-catalog.js";

export const SUPPORTED_PLANNED_LEAVE_KEYS = [
  "employee_marriage",
  "child_marriage",
  "child_circumcision",
  "hajj",
  "unpaid",
] as const;

export type SupportedPlannedLeaveKey = (typeof SUPPORTED_PLANNED_LEAVE_KEYS)[number];

/**
 * ORG-004: setiap kebijakan cuti terencana wajib punya kunci workflow `leave.<key>` pada daftar
 * kanonik (`modules/organization/workflow-keys.ts`). Menambah kebijakan di sini tanpa menambah
 * kuncinya di sana akan menghasilkan baris rollout yang tidak pernah cocok dengan apa pun, jadi
 * penjaga waktu-kompilasi ini menggagalkan typecheck lebih dahulu.
 */
const _everyPlannedLeaveKeyIsAWorkflowKey: readonly LeaveWorkflowPolicyKey[] =
  SUPPORTED_PLANNED_LEAVE_KEYS;
void _everyPlannedLeaveKeyIsAWorkflowKey;

export interface PlannedLeaveRequestInput {
  policyKey: SupportedPlannedLeaveKey;
  submittedOn: string;
  startOn: string;
  endOn: string;
  workingDays: number;
  hasEvidence: boolean;
  priorApprovedHajjCount?: number;
}

export interface PlannedLeaveRequestValidation {
  policyKey: SupportedPlannedLeaveKey;
  policyName: string;
  workingDays: number;
  calendarDurationDays: number;
  noticeDays: number;
  minimumNoticeDays: number;
  evidenceRequirement: "none" | "required";
  hcHandling: "validate" | "approve";
  unpaid: boolean;
}

export class PlannedLeavePolicyError extends Error {
  constructor(
    readonly code:
      | "INVALID_DATE"
      | "END_BEFORE_START"
      | "INVALID_WORKING_DAYS"
      | "MINIMUM_NOTICE_NOT_MET"
      | "EVIDENCE_REQUIRED"
      | "DURATION_LIMIT_EXCEEDED"
      | "HAJJ_ALREADY_USED"
      | "UNSUPPORTED_POLICY_CONFIGURATION",
    message: string,
  ) {
    super(message);
    this.name = "PlannedLeavePolicyError";
  }
}

function durationLimit(policyKey: SupportedPlannedLeaveKey): number | null {
  switch (policyKey) {
    case "employee_marriage":
      return 3;
    case "child_marriage":
    case "child_circumcision":
      return 2;
    default:
      return null;
  }
}

function minimumNoticeDays(
  policyKey: SupportedPlannedLeaveKey,
  calendarDurationDays: number,
): number {
  if (policyKey === "unpaid") return calendarDurationDays > 3 ? 30 : 7;
  return 7;
}

function mapCalendarError(error: unknown): never {
  if (error instanceof CalendarDurationError) {
    throw new PlannedLeavePolicyError(error.code, error.message);
  }
  throw error;
}

export function validatePlannedLeaveRequest(
  input: PlannedLeaveRequestInput,
): PlannedLeaveRequestValidation {
  if (!Number.isFinite(input.workingDays) || input.workingDays <= 0) {
    throw new PlannedLeavePolicyError(
      "INVALID_WORKING_DAYS",
      "Rentang cuti harus memiliki sedikitnya satu hari kerja.",
    );
  }

  let calendarDurationDays: number;
  let noticeDays: number;
  try {
    calendarDurationDays = inclusiveCalendarDurationDays(input.startOn, input.endOn);
    noticeDays = calendarDaysBetween(input.submittedOn, input.startOn);
  } catch (error) {
    mapCalendarError(error);
  }

  const policy = getLeavePolicy(input.policyKey as LeavePolicyKey);
  if (
    policy.requestMode !== "individual" ||
    policy.lineHandling !== "approval" ||
    !["validate", "approve"].includes(policy.hcHandling)
  ) {
    throw new PlannedLeavePolicyError(
      "UNSUPPORTED_POLICY_CONFIGURATION",
      "Konfigurasi jenis cuti ini tidak sesuai dengan alur planned line approval.",
    );
  }

  const requiredNoticeDays = minimumNoticeDays(input.policyKey, calendarDurationDays);
  if (noticeDays < requiredNoticeDays) {
    throw new PlannedLeavePolicyError(
      "MINIMUM_NOTICE_NOT_MET",
      `${policy.name} harus diajukan minimal H-${requiredNoticeDays}.`,
    );
  }

  if (policy.evidenceRequirement === "required" && !input.hasEvidence) {
    throw new PlannedLeavePolicyError(
      "EVIDENCE_REQUIRED",
      `Dokumen pendukung wajib dilampirkan untuk ${policy.name}.`,
    );
  }

  const maxWorkingDays = durationLimit(input.policyKey);
  if (maxWorkingDays !== null && input.workingDays > maxWorkingDays) {
    throw new PlannedLeavePolicyError(
      "DURATION_LIMIT_EXCEEDED",
      `${policy.name} maksimal ${maxWorkingDays} hari kerja untuk satu hak dasar.`,
    );
  }

  if (input.policyKey === "hajj" && (input.priorApprovedHajjCount ?? 0) > 0) {
    throw new PlannedLeavePolicyError(
      "HAJJ_ALREADY_USED",
      "Hak Cuti Ibadah Haji Wajib hanya dapat digunakan satu kali selama bekerja di Yayasan.",
    );
  }

  return {
    policyKey: input.policyKey,
    policyName: policy.name,
    workingDays: input.workingDays,
    calendarDurationDays,
    noticeDays,
    minimumNoticeDays: requiredNoticeDays,
    evidenceRequirement: policy.evidenceRequirement as "none" | "required",
    hcHandling: policy.hcHandling as "validate" | "approve",
    unpaid: input.policyKey === "unpaid",
  };
}
