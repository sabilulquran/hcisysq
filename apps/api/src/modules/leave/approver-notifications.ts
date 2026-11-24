// LEAVE-010: in-app notifications (NOTIF-004) for the line approver whose step is active, and
// LEAVE-010-F for the requester once the request is finally decided.
// Spec: docs/domain/workflows/leave-request.md "LEAVE-010".
//
// Written in the caller's transaction, next to the existing outbox intent. The text names the
// requester, the leave type, and the dates only — never the reason, evidence, or medical facts.

import type { Pool, PoolClient } from "pg";

import { notifyAccount, notifyEmployee } from "../notifications/service.js";
import { getLeavePolicy, type LeavePolicyKey } from "./domain/policy-catalog.js";

type QueryTarget = Pool | PoolClient;

export interface LeaveStepApprover {
  approverEmployeeId: string | null;
  approverAccountId: string | null;
}

interface RequestFacts {
  requesterName: string;
  policyKey: LeavePolicyKey;
  startOn: string;
  endOn: string;
  workingDays: number;
}

const APPROVALS_HREF = "/app/approvals";
const LEAVE_HREF = "/app/leave";

async function loadRequestFacts(db: QueryTarget, requestId: string): Promise<RequestFacts | null> {
  const result = await db.query<RequestFacts>(
    `SELECT requester.full_name AS "requesterName", request.policy_key AS "policyKey",
            request.start_on::text AS "startOn", request.end_on::text AS "endOn",
            request.working_days AS "workingDays"
       FROM leave_requests request
       JOIN employees requester ON requester.id = request.employee_id
      WHERE request.id = $1`,
    [requestId],
  );
  return result.rows[0] ?? null;
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Jakarta" })
    .format(new Date(`${value}T00:00:00+07:00`));
}

/** "Cuti Tahunan 2 Feb 2099–3 Feb 2099 (2 hari kerja)". */
export function describeLeave(facts: Pick<RequestFacts, "policyKey" | "startOn" | "endOn" | "workingDays">) {
  const range = facts.startOn === facts.endOn
    ? formatDay(facts.startOn)
    : `${formatDay(facts.startOn)}–${formatDay(facts.endOn)}`;
  return `${getLeavePolicy(facts.policyKey).name} ${range} (${facts.workingDays} hari kerja)`;
}

async function notifyApprover(
  db: QueryTarget,
  approver: LeaveStepApprover,
  input: { eventKey: string; title: string; body: string; metadata: Record<string, unknown> },
) {
  const notification = { ...input, category: "system" as const, href: APPROVALS_HREF };
  if (approver.approverAccountId) {
    const active = await db.query(
      `SELECT 1 FROM accounts WHERE id = $1 AND status = 'active'`,
      [approver.approverAccountId],
    );
    if (!active.rowCount) return false;
    await notifyAccount(db, { ...notification, recipientAccountId: approver.approverAccountId });
    return true;
  }
  // An approver without an active account (HCIS not yet live to them) gets no row; the
  // outbox intent and the Persetujuan inbox remain the source of truth.
  if (approver.approverEmployeeId) return notifyEmployee(db, approver.approverEmployeeId, notification);
  return false;
}

/** LEAVE-010-A/B: one notification per activated step (`event_key` carries the step id). */
export async function notifyApprovalRequested(
  db: QueryTarget,
  input: { requestId: string; stepId: string } & LeaveStepApprover,
) {
  const facts = await loadRequestFacts(db, input.requestId);
  if (!facts) return false;
  return notifyApprover(db, input, {
    eventKey: `leave.approval.requested.${input.stepId}`,
    title: "Pengajuan cuti menunggu persetujuan Anda",
    body: `${facts.requesterName} mengajukan ${describeLeave(facts)}.`,
    metadata: { leaveRequestId: input.requestId, stepId: input.stepId, policyKey: facts.policyKey },
  });
}

/**
 * LEAVE-010-F (2026-11-24): the requester learns the final decision, exactly once.
 *
 * `annual-leave-vertical-slice.md` has always said "requester receives final approved/rejected
 * intent", and the intent has always been written — to `leave_notification_outbox`, which nothing
 * reads. So every approver saw their step arrive while the person who asked for the leave saw
 * nothing at all and had to keep reopening Cuti & Izin. The outbox row stays: it is the
 * provider-agnostic intent, and this is the in-app delivery beside it.
 *
 * `event_key` carries the request id, so the unique index on (recipient, event_key) makes this
 * exactly one row per request however many times a decision path is replayed — and a request is
 * only ever decided once.
 */
export async function notifyRequesterDecision(
  db: QueryTarget,
  input: { requestId: string; requesterEmployeeId: string; decision: "approved" | "rejected" },
) {
  const facts = await loadRequestFacts(db, input.requestId);
  if (!facts) return false;
  const approved = input.decision === "approved";
  return notifyEmployee(db, input.requesterEmployeeId, {
    eventKey: `leave.request.decided.${input.requestId}`,
    category: "system",
    href: LEAVE_HREF,
    title: approved ? "Pengajuan cuti Anda disetujui" : "Pengajuan cuti Anda ditolak",
    // Catatan penolakan tidak ikut: ia ditulis untuk pemohon di layar Cuti & Izin, bukan untuk
    // ringkasan yang muncul di lonceng dan dapat terbaca orang lain dari balik bahu.
    body: approved
      ? `${describeLeave(facts)} sudah disetujui.`
      : `${describeLeave(facts)} tidak disetujui. Buka Cuti & Izin untuk melihat alasannya.`,
    metadata: { leaveRequestId: input.requestId, policyKey: facts.policyKey, decision: input.decision },
  });
}

/** LEAVE-010-C: the approver who was waiting on the request learns it is withdrawn. */
export async function notifyApprovalCancelled(
  db: QueryTarget,
  input: { requestId: string } & LeaveStepApprover,
) {
  const facts = await loadRequestFacts(db, input.requestId);
  if (!facts) return false;
  return notifyApprover(db, input, {
    eventKey: `leave.request.cancelled.${input.requestId}`,
    title: "Pengajuan cuti dibatalkan",
    body: `${facts.requesterName} membatalkan pengajuan ${describeLeave(facts)}. Tidak perlu tindakan lagi.`,
    metadata: { leaveRequestId: input.requestId, policyKey: facts.policyKey },
  });
}
