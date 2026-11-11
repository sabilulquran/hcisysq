// LEAVE-008: the active line approver proposes other dates; the requester accepts (a replacement
// request is submitted with a fresh APR-001 snapshot) or declines.
// Spec: docs/domain/leave-postponement.md.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePrincipalFromCookie } from "../auth/authorization.js";
import {
  AUTH_COOKIE_NAME,
  AuthError,
  AuthService,
  readCookie,
  type AuthPrincipal,
} from "../auth/service.js";
import { notifyAccount, notifyEmployee } from "../notifications/service.js";
import { describeLeave } from "./approver-notifications.js";
import { AnnualLeaveRequestPolicyError } from "./domain/annual-leave-request.js";
import { LeaveApprovalConfigurationError } from "./domain/approval-chain.js";
import { PlannedLeavePolicyError, SUPPORTED_PLANNED_LEAVE_KEYS, type SupportedPlannedLeaveKey } from "./domain/planned-leave-policy.js";
import { getLeavePolicy, type LeavePolicyKey } from "./domain/policy-catalog.js";
import {
  assertLeaveStepPostponable,
  assertPostponementDates,
  assertPostponementStillAhead,
  LeaveWorkflowError,
  type LeaveApprovalStepState,
  type LeaveLineHandling,
  type LeaveRequestStatus,
} from "./domain/request-workflow.js";
import { WorkingCalendarError } from "./domain/working-calendar.js";
import {
  addEvent,
  assertGovernanceApprovalCapability,
  buildAnnualPreview,
  EmployeeLeaveError,
  enqueueNotification,
  insertAnnualRequest,
  jakartaToday,
  loadEmployeeContext,
  type EmployeeContextRow,
} from "./employee-routes.js";
import { LeaveOrganizationAuthorityError, governanceActorIsRequester } from "./organization-authority.js";
import { buildPlannedPreview, insertPlannedRequest, PlannedLeaveRouteError } from "./planned-leave-routes.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stepParamSchema = z.object({ stepId: z.string().uuid() });
const proposalParamSchema = z.object({ proposalId: z.string().uuid() });
const datesSchema = z.object({ startOn: isoDate, endOn: isoDate });
const postponeSchema = datesSchema.extend({
  note: z.string().trim().min(5).max(1000),
});
const acceptSchema = z.object({ idempotencyKey: z.string().uuid() });
const declineSchema = z.object({
  reason: z.string().trim().max(500).nullable().optional().transform((value) => value || null),
});

const INVALID = {
  code: "INVALID_LEAVE_POSTPONEMENT",
  message: "Usulan tanggal tidak valid. Isi tanggal mulai, tanggal selesai, dan catatan minimal 5 karakter.",
};

interface StepRow {
  id: string;
  requestId: string;
  requesterEmployeeId: string;
  approverEmployeeId: string | null;
  approverAccountId: string | null;
  status: LeaveApprovalStepState["status"];
  requestStatus: LeaveRequestStatus;
  lineHandling: LeaveLineHandling;
  policyKey: string;
  startOn: string;
  endOn: string;
  submittedOn: string;
}

interface ProposalRow {
  id: string;
  status: "proposed" | "accepted" | "declined";
  requestId: string;
  requestStatus: LeaveRequestStatus;
  policyKey: string;
  reason: string | null;
  submittedOn: string;
  proposedStartOn: string;
  proposedEndOn: string;
  proposedByAccountId: string | null;
  proposedByEmployeeId: string | null;
  replacementRequestId: string | null;
}

function isPlannedKey(policyKey: string): policyKey is SupportedPlannedLeaveKey {
  return (SUPPORTED_PLANNED_LEAVE_KEYS as readonly string[]).includes(policyKey);
}

function policySupported(policyKey: string) {
  return policyKey === "annual" || isPlannedKey(policyKey);
}

function leaveHref(policyKey: string) {
  return policyKey === "annual" ? "/app/leave" : "/app/leave/planned";
}

function mapKnownError(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (error instanceof EmployeeLeaveError || error instanceof PlannedLeaveRouteError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  if (
    error instanceof AnnualLeaveRequestPolicyError
    || error instanceof PlannedLeavePolicyError
    || error instanceof LeaveApprovalConfigurationError
    || error instanceof LeaveOrganizationAuthorityError
    || error instanceof WorkingCalendarError
    || error instanceof LeaveWorkflowError
  ) {
    return { statusCode: 409, code: error.code, message: error.message };
  }
  const pgCode = (error as { code?: unknown }).code;
  // A decision on the same request in flight: the transaction was rolled back, a retry sees the result.
  if (pgCode === "40P01" || pgCode === "55P03") {
    return {
      statusCode: 409,
      code: "LEAVE_REQUEST_BUSY",
      message: "Pengajuan ini sedang diproses. Muat ulang halaman, lalu coba lagi.",
    };
  }
  if (pgCode === "23514" && /overlaps/.test(String((error as { message?: unknown }).message))) {
    return {
      statusCode: 409,
      code: "LEAVE_REQUEST_OVERLAP",
      message: "Tanggal usulan bertabrakan dengan cuti lain yang masih aktif.",
    };
  }
  if (pgCode === "23505") {
    return {
      statusCode: 409,
      code: "LEAVE_REQUEST_CONFLICT",
      message: "Pengajuan bertabrakan dengan pengajuan aktif lain. Muat ulang halaman.",
    };
  }
  return null;
}

async function sendKnownError(reply: FastifyReply, error: unknown) {
  const known = mapKnownError(error);
  if (!known) throw error;
  reply.header("Cache-Control", "no-store");
  return reply.status(known.statusCode).send({ code: known.code, message: known.message });
}

/** The requester's leave context, loaded by employee id because the approver is acting. */
async function loadRequesterContext(db: Pool | PoolClient, employeeId: string): Promise<EmployeeContextRow> {
  const result = await db.query<EmployeeContextRow>(
    `SELECT
      e.id,
      e.employee_number AS "employeeNumber",
      e.full_name AS "fullName",
      e.status,
      e.started_on::text AS "startedOn",
      e.leave_entitlement_group AS "leaveEntitlementGroup",
      u.id AS "unitId",
      u.name AS "unitName",
      p.name AS "positionName",
      e.direct_manager_employee_id AS "directManagerEmployeeId",
      u.leave_approver_employee_id AS "unitApproverEmployeeId"
    FROM employees e
    LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
    LEFT JOIN positions p ON p.id = e.position_id
    WHERE e.id = $1 AND e.removed_at IS NULL`,
    [employeeId],
  );
  const requester = result.rows[0];
  if (!requester || requester.status !== "active") {
    throw new EmployeeLeaveError(409, "REQUESTER_NOT_ACTIVE", "Pemohon tidak lagi tercatat sebagai pegawai aktif.");
  }
  return requester;
}

async function evidenceCount(db: Pool | PoolClient, requestId: string) {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM leave_request_evidence WHERE leave_request_id = $1`,
    [requestId],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * D-05: the proposed dates must not overlap another active leave of the requester (the trigger
 * of migration 0012 would refuse the replacement anyway, after the original stopped holding).
 */
async function assertNoOtherActiveLeave(
  db: Pool | PoolClient,
  input: { employeeId: string; excludeRequestId: string; startOn: string; endOn: string },
) {
  const overlap = await db.query(
    `SELECT 1 FROM leave_requests
      WHERE employee_id = $1 AND id <> $2
        AND status IN ('in_review', 'approved')
        AND start_on <= $4::date AND end_on >= $3::date
      LIMIT 1`,
    [input.employeeId, input.excludeRequestId, input.startOn, input.endOn],
  );
  if (overlap.rowCount) {
    throw new EmployeeLeaveError(
      409,
      "LEAVE_REQUEST_OVERLAP",
      "Tanggal usulan bertabrakan dengan cuti lain pegawai yang masih aktif.",
    );
  }
}

/** D-04/D-05/D-06: the proposal must be a request the employee could have submitted. */
async function evaluateProposal(
  db: Pool | PoolClient,
  step: StepRow,
  dates: { startOn: string; endOn: string },
) {
  assertPostponementDates({
    currentStartOn: step.startOn,
    currentEndOn: step.endOn,
    proposedStartOn: dates.startOn,
    proposedEndOn: dates.endOn,
    today: jakartaToday(),
  });
  const requester = await loadRequesterContext(db, step.requesterEmployeeId);
  await assertNoOtherActiveLeave(db, {
    employeeId: step.requesterEmployeeId,
    excludeRequestId: step.requestId,
    startOn: dates.startOn,
    endOn: dates.endOn,
  });
  if (step.policyKey === "annual") {
    const preview = await buildAnnualPreview(db, requester, dates, step.submittedOn, step.requestId);
    return {
      workingDays: preview.validation.requestedWorkingDays,
      workingDates: preview.calculation.workingDates,
      nonWorkingDates: preview.calculation.nonWorkingDates,
      criticalPeriods: preview.criticalPeriods,
      criticalReviewRequired: preview.criticalPeriods.length > 0,
    };
  }
  if (!isPlannedKey(step.policyKey)) {
    throw new LeaveWorkflowError("POSTPONEMENT_NOT_SUPPORTED", "Jenis cuti ini tidak dapat diusulkan tanggal lain.");
  }
  const preview = await buildPlannedPreview(
    db,
    requester,
    {
      policyKey: step.policyKey,
      ...dates,
      hasEvidence: (await evidenceCount(db, step.requestId)) > 0,
    },
    step.submittedOn,
  );
  return {
    workingDays: preview.calculation.workingDays,
    workingDates: preview.calculation.workingDates,
    nonWorkingDates: preview.calculation.nonWorkingDates,
    criticalPeriods: preview.criticalPeriods,
    criticalReviewRequired: preview.criticalReviewRequired,
  };
}

export async function registerLeavePostponementRoutes(app: FastifyInstance, pool: Pool, config: ApiConfig) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for leave postponement routes");
  }
  const encryptionKey = config.AUTH_ENCRYPTION_KEY;
  const auth = new AuthService(pool, encryptionKey, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production");

  async function authenticateEmployee(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    try {
      return await requirePrincipalFromCookie(auth, request.headers.cookie, "EMPLOYEE");
    } catch (error) {
      if (error instanceof AuthError) {
        reply.header("Cache-Control", "no-store");
        await reply.status(error.statusCode).send({ code: error.code, message: error.message });
        return null;
      }
      throw error;
    }
  }

  async function authenticateApprovalPrincipal(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    try {
      const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
      if (!session || !["EMPLOYEE", "FOUNDATION_BOARD"].includes(session.principal.principalType)) {
        throw new AuthError(403, "FORBIDDEN", "Akun ini tidak memiliki akses approval.");
      }
      return session.principal;
    } catch (error) {
      if (error instanceof AuthError) {
        reply.header("Cache-Control", "no-store");
        await reply.status(error.statusCode).send({ code: error.code, message: error.message });
        return null;
      }
      throw error;
    }
  }

  /** Same ownership rules as a decision on the step (APR-001-F, ORG-013). */
  async function loadOwnedStep(db: Pool | PoolClient, principal: AuthPrincipal, stepId: string, lock: boolean) {
    const actor = principal.principalType === "EMPLOYEE" ? await loadEmployeeContext(db, principal.id) : null;
    const result = await db.query<StepRow>(
      `SELECT
        s.id,
        s.leave_request_id AS "requestId",
        r.employee_id AS "requesterEmployeeId",
        s.approver_employee_id AS "approverEmployeeId",
        s.approver_account_id AS "approverAccountId",
        s.status,
        r.status AS "requestStatus",
        r.line_handling AS "lineHandling",
        r.policy_key AS "policyKey",
        r.start_on::text AS "startOn",
        r.end_on::text AS "endOn",
        -- D-06: a replacement keeps the notice date of the request it replaced.
        coalesce(
          r.validation_summary ->> 'noticeReferenceOn',
          (r.submitted_at AT TIME ZONE 'Asia/Jakarta')::date::text
        ) AS "submittedOn"
      FROM leave_request_approval_steps s
      JOIN leave_requests r ON r.id = s.leave_request_id
      WHERE s.id = $1
      ${lock ? "FOR UPDATE OF s, r" : ""}`,
      [stepId],
    );
    const step = result.rows[0];
    if (!step) throw new EmployeeLeaveError(404, "APPROVAL_STEP_NOT_FOUND", "Tahap approval tidak ditemukan.");
    const ownsStep = actor ? step.approverEmployeeId === actor.id : step.approverAccountId === principal.id;
    if (!ownsStep) {
      throw new EmployeeLeaveError(403, "APPROVAL_FORBIDDEN", "Tahap approval ini bukan milik akun Anda.");
    }
    if (!actor) {
      await assertGovernanceApprovalCapability(db, principal.id);
      if (await governanceActorIsRequester(db, principal.id, step.requesterEmployeeId)) {
        throw new EmployeeLeaveError(403, "APPROVAL_SELF_FORBIDDEN", "Pengajuan ini tidak dapat diputuskan oleh pemohon sendiri.");
      }
    }
    const steps = await db.query<LeaveApprovalStepState>(
      `SELECT id, step_order AS "order", status FROM leave_request_approval_steps
        WHERE leave_request_id = $1 ORDER BY step_order ASC`,
      [step.requestId],
    );
    const plan = assertLeaveStepPostponable({
      requestStatus: step.requestStatus,
      lineHandling: step.lineHandling,
      policySupported: policySupported(step.policyKey),
      stepId: step.id,
      steps: steps.rows,
    });
    return { actor, step, plan };
  }

  app.post("/leave/approvals/:stepId/postponement/preview", async (request, reply) => {
    const principal = await authenticateApprovalPrincipal(request, reply);
    if (!principal) return;
    const params = stepParamSchema.safeParse(request.params);
    const body = datesSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send(INVALID);
    try {
      const { step } = await loadOwnedStep(pool, principal, params.data.stepId, false);
      const evaluation = await evaluateProposal(pool, step, body.data);
      reply.header("Cache-Control", "no-store");
      return reply.send({
        stepId: step.id,
        requestId: step.requestId,
        policyKey: step.policyKey,
        currentStartOn: step.startOn,
        currentEndOn: step.endOn,
        proposedStartOn: body.data.startOn,
        proposedEndOn: body.data.endOn,
        ...evaluation,
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/leave/approvals/:stepId/postpone", async (request, reply) => {
    const principal = await authenticateApprovalPrincipal(request, reply);
    if (!principal) return;
    const params = stepParamSchema.safeParse(request.params);
    const body = postponeSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send(INVALID);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { actor, step, plan } = await loadOwnedStep(client, principal, params.data.stepId, true);
      const dates = { startOn: body.data.startOn, endOn: body.data.endOn };
      const evaluation = await evaluateProposal(client, step, dates);
      const proposalId = randomUUID();

      await client.query(
        `UPDATE leave_request_approval_steps
            SET status = 'postponed', acted_by_account_id = $2, acted_at = now(), decision_note = $3
          WHERE id = $1`,
        [plan.postponedStepId, principal.id, body.data.note],
      );
      await client.query(
        `UPDATE leave_request_approval_steps SET status = 'cancelled'
          WHERE leave_request_id = $1 AND status = 'waiting'`,
        [step.requestId],
      );
      await client.query(
        `UPDATE leave_request_hc_tasks SET status = 'cancelled', updated_at = now()
          WHERE leave_request_id = $1 AND status = 'waiting'`,
        [step.requestId],
      );
      await client.query(
        `UPDATE leave_request_critical_reviews SET status = 'cancelled', updated_at = now()
          WHERE leave_request_id = $1 AND status = 'waiting'`,
        [step.requestId],
      );
      await client.query(
        `UPDATE leave_requests SET status = 'postponement_proposed', updated_at = now() WHERE id = $1`,
        [step.requestId],
      );
      await client.query(
        `INSERT INTO leave_postponement_proposals (
          id, leave_request_id, approval_step_id, proposed_by_account_id, proposed_by_employee_id,
          proposed_start_on, proposed_end_on, proposed_working_days, note
        ) VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9)`,
        [
          proposalId,
          step.requestId,
          step.id,
          principal.id,
          actor?.id ?? null,
          dates.startOn,
          dates.endOn,
          evaluation.workingDays,
          body.data.note,
        ],
      );
      await addEvent(client, step.requestId, principal.id, "leave.postponement.proposed", {
        proposalId,
        stepId: step.id,
        policyKey: step.policyKey,
        originalStartOn: step.startOn,
        originalEndOn: step.endOn,
        proposedStartOn: dates.startOn,
        proposedEndOn: dates.endOn,
        proposedWorkingDays: evaluation.workingDays,
        cancelledStepIds: plan.cancelledStepIds,
      });
      await enqueueNotification(client, step.requestId, "leave.postponement.proposed", "employee", step.requesterEmployeeId);
      const proposerName = actor?.fullName ?? "Penyetuju Pengurus Yayasan";
      const proposed = describeLeave({
        policyKey: step.policyKey as LeavePolicyKey,
        startOn: dates.startOn,
        endOn: dates.endOn,
        workingDays: evaluation.workingDays,
      });
      await notifyEmployee(client, step.requesterEmployeeId, {
        eventKey: `leave.postponement.proposed.${proposalId}`,
        category: "system",
        title: "Penyetuju mengusulkan tanggal lain",
        body: `${proposerName} mengusulkan ${proposed} sebagai ganti pengajuan Anda. Buka halaman cuti untuk menerima atau menolak.`,
        href: leaveHref(step.policyKey),
        metadata: { leaveRequestId: step.requestId, proposalId, policyKey: step.policyKey },
      });

      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.send({
        requestId: step.requestId,
        requestStatus: "postponement_proposed",
        stepStatus: "postponed",
        proposalId,
        proposedStartOn: dates.startOn,
        proposedEndOn: dates.endOn,
        proposedWorkingDays: evaluation.workingDays,
        criticalReviewRequired: evaluation.criticalReviewRequired,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });

  async function lockOwnProposal(client: PoolClient, employeeId: string, proposalId: string) {
    const result = await client.query<ProposalRow>(
      `SELECT
        p.id,
        p.status,
        r.id AS "requestId",
        r.status AS "requestStatus",
        r.policy_key AS "policyKey",
        r.reason,
        coalesce(
          r.validation_summary ->> 'noticeReferenceOn',
          (r.submitted_at AT TIME ZONE 'Asia/Jakarta')::date::text
        ) AS "submittedOn",
        p.proposed_start_on::text AS "proposedStartOn",
        p.proposed_end_on::text AS "proposedEndOn",
        p.proposed_by_account_id AS "proposedByAccountId",
        p.proposed_by_employee_id AS "proposedByEmployeeId",
        p.replacement_request_id AS "replacementRequestId"
      FROM leave_postponement_proposals p
      JOIN leave_requests r ON r.id = p.leave_request_id
      WHERE p.id = $1 AND r.employee_id = $2
      FOR UPDATE OF p, r`,
      [proposalId, employeeId],
    );
    const proposal = result.rows[0];
    if (!proposal) throw new EmployeeLeaveError(404, "POSTPONEMENT_NOT_FOUND", "Usulan tanggal tidak ditemukan.");
    return proposal;
  }

  function assertOpen(proposal: ProposalRow) {
    if (proposal.status !== "proposed" || proposal.requestStatus !== "postponement_proposed") {
      throw new EmployeeLeaveError(409, "POSTPONEMENT_NOT_OPEN", "Usulan ini sudah dijawab atau tidak lagi berlaku.");
    }
  }

  /** The proposer learns the answer: in-app (active account only) and an outbox intent. */
  async function notifyProposer(
    client: PoolClient,
    proposal: ProposalRow,
    input: { eventType: string; title: string; body: string },
  ) {
    const notification = {
      eventKey: `${input.eventType}.${proposal.id}`,
      category: "system" as const,
      title: input.title,
      body: input.body,
      href: "/app/approvals",
      metadata: { leaveRequestId: proposal.requestId, proposalId: proposal.id, policyKey: proposal.policyKey },
    };
    if (proposal.proposedByEmployeeId) {
      await enqueueNotification(client, proposal.requestId, input.eventType, "employee", proposal.proposedByEmployeeId);
      await notifyEmployee(client, proposal.proposedByEmployeeId, notification);
    } else if (proposal.proposedByAccountId) {
      await enqueueNotification(client, proposal.requestId, input.eventType, "account", proposal.proposedByAccountId);
      const active = await client.query(`SELECT 1 FROM accounts WHERE id = $1 AND status = 'active'`, [proposal.proposedByAccountId]);
      if (active.rowCount) await notifyAccount(client, { ...notification, recipientAccountId: proposal.proposedByAccountId });
    }
  }

  app.post("/leave/me/postponements/:proposalId/accept", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const params = proposalParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(404).send({ code: "POSTPONEMENT_NOT_FOUND", message: "Usulan tanggal tidak ditemukan." });
    }
    const body = acceptSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(INVALID);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Locked like a submission, so quota checks serialize with the employee's other requests.
      const employee = await loadEmployeeContext(client, principal.id, true);
      const proposal = await lockOwnProposal(client, employee.id, params.data.proposalId);
      if (proposal.status === "accepted") {
        await client.query("COMMIT");
        reply.header("Cache-Control", "no-store");
        return reply.send({
          proposalId: proposal.id,
          status: "accepted",
          requestId: proposal.requestId,
          replacementRequestId: proposal.replacementRequestId,
          idempotentReplay: true,
        });
      }
      assertOpen(proposal);
      assertPostponementStillAhead(proposal.proposedStartOn, jakartaToday());
      const reused = await client.query(
        `SELECT 1 FROM leave_requests WHERE employee_id = $1 AND idempotency_key = $2`,
        [employee.id, body.data.idempotencyKey],
      );
      if (reused.rowCount) {
        throw new EmployeeLeaveError(409, "IDEMPOTENCY_KEY_REUSED", "Kunci pengiriman sudah dipakai. Muat ulang halaman lalu coba lagi.");
      }

      const replacement = { replacesRequestId: proposal.requestId, postponementProposalId: proposal.id };
      const common = {
        employee,
        actorAccountId: principal.id,
        startOn: proposal.proposedStartOn,
        endOn: proposal.proposedEndOn,
        reason: proposal.reason,
        idempotencyKey: body.data.idempotencyKey,
        noticeReferenceOn: proposal.submittedOn,
        replacement,
      };
      let created: { requestId: string; insertedSteps: Array<{ id: string; name: string }>; criticalReviewRequired: boolean };
      if (proposal.policyKey === "annual") {
        const result = await insertAnnualRequest(client, common);
        created = { ...result, criticalReviewRequired: result.preview.criticalPeriods.length > 0 };
      } else if (isPlannedKey(proposal.policyKey)) {
        const result = await insertPlannedRequest(client, {
          ...common,
          policyKey: proposal.policyKey,
          evidence: { kind: "copy", fromRequestId: proposal.requestId },
          encryptionKey,
        });
        created = { ...result, criticalReviewRequired: result.preview.criticalReviewRequired };
      } else {
        throw new LeaveWorkflowError("POSTPONEMENT_NOT_SUPPORTED", "Jenis cuti ini tidak dapat diusulkan tanggal lain.");
      }

      await client.query(
        `UPDATE leave_postponement_proposals
            SET status = 'accepted', responded_at = now(), replacement_request_id = $2
          WHERE id = $1`,
        [proposal.id, created.requestId],
      );
      await client.query(
        `UPDATE leave_requests SET status = 'postponed', updated_at = now() WHERE id = $1`,
        [proposal.requestId],
      );
      await addEvent(client, proposal.requestId, principal.id, "leave.postponement.accepted", {
        proposalId: proposal.id,
        replacementRequestId: created.requestId,
      });
      const leave = describeLeave({
        policyKey: proposal.policyKey as LeavePolicyKey,
        startOn: proposal.proposedStartOn,
        endOn: proposal.proposedEndOn,
        workingDays: (await client.query<{ workingDays: number }>(
          `SELECT working_days AS "workingDays" FROM leave_requests WHERE id = $1`, [created.requestId],
        )).rows[0]!.workingDays,
      });
      await notifyProposer(client, proposal, {
        eventType: "leave.postponement.accepted",
        title: "Usulan tanggal cuti diterima",
        body: `${employee.fullName} menerima usulan ${leave}. Pengajuan pengganti sudah dikirim dan menjalani persetujuan dari awal.`,
      });

      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.status(201).send({
        proposalId: proposal.id,
        status: "accepted",
        requestId: proposal.requestId,
        replacementRequestId: created.requestId,
        replacementStatus: "in_review",
        approvalChain: created.insertedSteps.map((step) => ({ id: step.id, name: step.name })),
        criticalReviewRequired: created.criticalReviewRequired,
        idempotentReplay: false,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });

  app.post("/leave/me/postponements/:proposalId/decline", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const params = proposalParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(404).send({ code: "POSTPONEMENT_NOT_FOUND", message: "Usulan tanggal tidak ditemukan." });
    }
    const body = declineSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send(INVALID);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const employee = await loadEmployeeContext(client, principal.id);
      const proposal = await lockOwnProposal(client, employee.id, params.data.proposalId);
      if (proposal.status === "declined") {
        await client.query("COMMIT");
        reply.header("Cache-Control", "no-store");
        return reply.send({
          proposalId: proposal.id,
          status: "declined",
          requestId: proposal.requestId,
          requestStatus: proposal.requestStatus,
          idempotentReplay: true,
        });
      }
      assertOpen(proposal);
      await client.query(
        `UPDATE leave_postponement_proposals
            SET status = 'declined', responded_at = now(), response_note = $2
          WHERE id = $1`,
        [proposal.id, body.data.reason],
      );
      await client.query(
        `UPDATE leave_requests SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [proposal.requestId],
      );
      await addEvent(client, proposal.requestId, principal.id, "leave.postponement.declined", {
        proposalId: proposal.id,
        ...(body.data.reason ? { reason: body.data.reason } : {}),
      });
      const policyName = getLeavePolicy(proposal.policyKey as LeavePolicyKey).name;
      await notifyProposer(client, proposal, {
        eventType: "leave.postponement.declined",
        title: "Usulan tanggal cuti ditolak pegawai",
        body: `${employee.fullName} tidak menerima usulan tanggal lain untuk ${policyName}. Pengajuan selesai tanpa cuti; tidak perlu tindakan lagi.`,
      });

      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.send({
        proposalId: proposal.id,
        status: "declined",
        requestId: proposal.requestId,
        requestStatus: "cancelled",
        idempotentReplay: false,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });
}
