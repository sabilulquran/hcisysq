import { hasOrganizationPermission } from "../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePrincipalFromCookie } from "../auth/authorization.js";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import {
  AuthError,
  AuthService,
  type AuthPrincipal,
} from "../auth/service.js";
import {
  LeaveApprovalConfigurationError,
  type LeaveApprovalStep,
} from "./domain/approval-chain.js";
import {
  PlannedLeavePolicyError,
  SUPPORTED_PLANNED_LEAVE_KEYS,
  type SupportedPlannedLeaveKey,
  validatePlannedLeaveRequest,
} from "./domain/planned-leave-policy.js";
import { getLeavePolicy } from "./domain/policy-catalog.js";
import {
  calculateWorkingDays,
  decodeWorkingWeekdays,
  WorkingCalendarError,
  type IsoWeekday,
  type LeaveCalendarException,
} from "./domain/working-calendar.js";
import {
  enqueueFinalApprovalOversight,
  LeaveOrganizationAuthorityError,
  resolveLeaveAuthorities,
} from "./organization-authority.js";

const plannedKeySchema = z.enum(SUPPORTED_PLANNED_LEAVE_KEYS);
const previewSchema = z.object({
  policyKey: plannedKeySchema,
  startOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hasEvidence: z.boolean().default(false),
});
const evidenceSchema = z.object({
  fileName: z.string().trim().min(1).max(180),
  contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  contentBase64: z.string().min(1).max(3_000_000),
});
const submitSchema = previewSchema.extend({
  reason: z.string().trim().max(1000).nullable().optional(),
  idempotencyKey: z.string().uuid(),
  evidence: evidenceSchema.nullable().optional(),
});
const requestEvidenceParamSchema = z.object({
  requestId: z.string().uuid(),
  evidenceId: z.string().uuid(),
});
const hcTaskParamSchema = z.object({ taskId: z.string().uuid() });
const hcValidationDecisionSchema = z.object({
  action: z.enum(["validate", "request_correction"]),
  note: z.string().trim().max(1000).nullable().optional(),
});
const hcApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).nullable().optional(),
});

interface EmployeeContextRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  unitId: string | null;
  unitName: string | null;
  positionName: string | null;
  directManagerEmployeeId: string | null;
  unitApproverEmployeeId: string | null;
}

interface CalendarSettingRow {
  workingWeekdayMask: number | null;
}

interface CalendarExceptionRow {
  date: string;
  isWorkingDay: boolean;
}

interface ApprovalActorRow {
  id: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  accountId: string | null;
  accountStatus: "invited" | "active" | "suspended" | "inactive" | null;
}

interface EvidenceRow {
  id: string;
  requestId: string;
  fileName: string;
  contentType: "application/pdf" | "image/jpeg" | "image/png";
  byteSize: number;
  ciphertext: string;
  iv: string;
  authTag: string;
}

interface PlannedSummaryRow {
  id: string;
  policyKey: SupportedPlannedLeaveKey;
  status: "in_review" | "approved" | "rejected" | "cancelled";
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  validationSummary: Record<string, unknown>;
  submittedAt: Date;
  finalDecidedAt: Date | null;
  currentApproverName: string | null;
  hcTaskKind: "validate" | "approve" | null;
  hcTaskStatus:
    | "waiting"
    | "pending"
    | "needs_correction"
    | "validated"
    | "approved"
    | "rejected"
    | null;
}

interface HcQueueRow {
  taskId: string;
  requestId: string;
  requesterEmployeeId: string;
  requesterName: string;
  employeeNumber: string;
  unitName: string | null;
  positionName: string | null;
  policyKey: SupportedPlannedLeaveKey;
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  validationSummary: Record<string, unknown>;
  evidenceRequirement: "none" | "required";
  submittedAt: Date;
  taskStatus: string;
  taskNote: string | null;
  evidence: Array<{
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    createdAt: string;
  }> | null;
}

class PlannedLeaveRouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlannedLeaveRouteError";
  }
}

function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function loadEmployeeContext(
  db: Pool | PoolClient,
  accountId: string,
  lock = false,
): Promise<EmployeeContextRow> {
  const result = await db.query<EmployeeContextRow>(
    `SELECT
      employee.id,
      employee.employee_number AS "employeeNumber",
      employee.full_name AS "fullName",
      employee.status,
      unit.id AS "unitId",
      unit.name AS "unitName",
      position.name AS "positionName",
      employee.direct_manager_employee_id AS "directManagerEmployeeId",
      unit.leave_approver_employee_id AS "unitApproverEmployeeId"
    FROM accounts account
    JOIN employees employee ON employee.id = account.employee_id
    LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
    LEFT JOIN positions position ON position.id = employee.position_id
    WHERE account.id = $1
      AND account.principal_type = 'EMPLOYEE'
      AND account.status = 'active'
    ${lock ? "FOR UPDATE OF employee" : ""}`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new PlannedLeaveRouteError(
      403,
      "EMPLOYEE_NOT_ACTIVE",
      "Akun tidak terhubung ke pegawai aktif.",
    );
  }
  return employee;
}

async function loadWorkingCalendar(
  db: Pool | PoolClient,
  startOn: string,
  endOn: string,
): Promise<{ workingWeekdays: IsoWeekday[]; exceptions: LeaveCalendarException[] }> {
  const [settings, exceptions] = await Promise.all([
    db.query<CalendarSettingRow>(
      `SELECT working_weekday_mask AS "workingWeekdayMask"
       FROM leave_calendar_settings
       WHERE singleton = true`,
    ),
    db.query<CalendarExceptionRow>(
      `SELECT calendar_date::text AS date, is_working_day AS "isWorkingDay"
       FROM leave_calendar_exceptions
       WHERE calendar_date BETWEEN $1::date AND $2::date
       ORDER BY calendar_date ASC`,
      [startOn, endOn],
    ),
  ]);
  const workingWeekdays = decodeWorkingWeekdays(settings.rows[0]?.workingWeekdayMask);
  if (!workingWeekdays) {
    throw new PlannedLeaveRouteError(
      409,
      "LEAVE_CALENDAR_NOT_CONFIGURED",
      "Kalender hari kerja belum dikonfigurasi.",
    );
  }
  return { workingWeekdays, exceptions: exceptions.rows };
}

async function hydrateApprovalChain(
  db: Pool | PoolClient,
  chain: readonly LeaveApprovalStep[],
): Promise<Array<LeaveApprovalStep & { name: string }>> {
  const ids = chain.map((step) => step.employeeId);
  const result = await db.query<ApprovalActorRow>(
    `SELECT
      employee.id,
      employee.full_name AS "fullName",
      employee.status,
      account.id AS "accountId",
      account.status AS "accountStatus"
    FROM employees employee
    LEFT JOIN accounts account
      ON account.employee_id = employee.id
      AND account.principal_type = 'EMPLOYEE'
    WHERE employee.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  return chain.map((step) => {
    const actor = byId.get(step.employeeId);
    if (!actor || actor.status !== "active") {
      throw new PlannedLeaveRouteError(
        409,
        "APPROVER_NOT_ACTIVE",
        "Rantai persetujuan berisi approver yang tidak aktif.",
      );
    }
    if (!actor.accountId || actor.accountStatus !== "active") {
      throw new PlannedLeaveRouteError(
        409,
        "APPROVER_ACCOUNT_NOT_READY",
        `Akun approver ${actor.fullName} belum aktif.`,
      );
    }
    return { ...step, name: actor.fullName };
  });
}

async function resolveApprovalChain(
  db: Pool | PoolClient,
  employee: EmployeeContextRow,
  policyKey: SupportedPlannedLeaveKey,
  effectiveDate: string,
) {
  const resolution = await resolveLeaveAuthorities(db, {
    workflowKey: `leave.${policyKey}`,
    requesterEmployeeId: employee.id,
    effectiveDate,
    legacy: {
      directManagerEmployeeId: employee.directManagerEmployeeId,
      unitApproverEmployeeId: employee.unitApproverEmployeeId,
    },
    policyChain: policyKey === "unpaid" ? "UNIT_ONLY" : "LINE_AND_UNIT",
  });
  return {
    approvalChain: await hydrateApprovalChain(db, resolution.approvalChain),
    authorityResolution: resolution.context,
  };
}

async function priorApprovedHajjCount(db: Pool | PoolClient, employeeId: string) {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM leave_hajj_final_usage
     WHERE employee_id = $1`,
    [employeeId],
  );
  return result.rows[0]?.count ?? 0;
}

async function buildPreview(
  db: Pool | PoolClient,
  employee: EmployeeContextRow,
  input: z.infer<typeof previewSchema>,
) {
  const calendar = await loadWorkingCalendar(db, input.startOn, input.endOn);
  const calculation = calculateWorkingDays(input.startOn, input.endOn, calendar);
  const validation = validatePlannedLeaveRequest({
    policyKey: input.policyKey,
    submittedOn: jakartaToday(),
    startOn: input.startOn,
    endOn: input.endOn,
    workingDays: calculation.workingDays,
    hasEvidence: input.hasEvidence,
    priorApprovedHajjCount:
      input.policyKey === "hajj" ? await priorApprovedHajjCount(db, employee.id) : 0,
  });
  const { approvalChain, authorityResolution } = await resolveApprovalChain(
    db,
    employee,
    input.policyKey,
    jakartaToday(),
  );
  return { calculation, validation, approvalChain, authorityResolution };
}

export const hasActivePermission = hasOrganizationPermission;

async function requireHcValidator(db: Pool | PoolClient, principal: AuthPrincipal) {
  if (!(await hasActivePermission(db, principal.id, "leave.validate"))) {
    throw new PlannedLeaveRouteError(
      403,
      "HC_VALIDATION_FORBIDDEN",
      "Akun ini tidak memiliki kewenangan validasi Human Capital.",
    );
  }
}

async function requireHcActualApprover(db: Pool | PoolClient, principal: AuthPrincipal) {
  const [isHc, canApprove] = await Promise.all([
    hasActivePermission(db, principal.id, "leave.validate"),
    hasActivePermission(db, principal.id, "leave.hc.approve"),
  ]);
  if (!isHc || !canApprove) {
    throw new PlannedLeaveRouteError(
      403,
      "HC_APPROVAL_FORBIDDEN",
      "Akun ini tidak memiliki mandat actual approval Human Capital.",
    );
  }
}

async function addEvent(
  db: PoolClient,
  requestId: string,
  actorAccountId: string | null,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  await db.query(
    `INSERT INTO leave_request_events (
      id, leave_request_id, actor_account_id, event_type, payload
    ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), requestId, actorAccountId, eventType, JSON.stringify(payload)],
  );
}

async function enqueueNotification(
  db: PoolClient,
  requestId: string,
  eventType: string,
  targetType: "employee" | "role",
  targetKey: string,
) {
  await db.query(
    `INSERT INTO leave_notification_outbox (
      id, leave_request_id, event_type, target_type, target_key, payload
    ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
    [randomUUID(), requestId, eventType, targetType, targetKey],
  );
}

function decodeEvidence(input: z.infer<typeof evidenceSchema>): Buffer {
  const bytes = Buffer.from(input.contentBase64, "base64");
  if (bytes.length === 0 || bytes.length > 2_097_152) {
    throw new PlannedLeaveRouteError(
      413,
      "EVIDENCE_TOO_LARGE",
      "Dokumen pendukung maksimal 2 MB per file.",
    );
  }
  const signatureOk =
    (input.contentType === "application/pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-") ||
    (input.contentType === "image/jpeg" &&
      bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (input.contentType === "image/png" &&
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  if (!signatureOk) {
    throw new PlannedLeaveRouteError(
      400,
      "EVIDENCE_TYPE_MISMATCH",
      "Tipe file tidak sesuai dengan isi dokumen.",
    );
  }
  return bytes;
}

async function storeEvidence(
  db: PoolClient,
  requestId: string,
  accountId: string,
  input: z.infer<typeof evidenceSchema>,
  encryptionKey: string,
) {
  const bytes = decodeEvidence(input);
  const encrypted = encryptSecret(bytes.toString("base64"), encryptionKey);
  const evidenceId = randomUUID();
  await db.query(
    `INSERT INTO leave_request_evidence (
      id, leave_request_id, original_filename, content_type, byte_size,
      ciphertext, iv, auth_tag, uploaded_by_account_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      evidenceId,
      requestId,
      input.fileName,
      input.contentType,
      bytes.length,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      accountId,
    ],
  );
  return {
    id: evidenceId,
    fileName: input.fileName,
    contentType: input.contentType,
    byteSize: bytes.length,
  };
}

function safeDownloadName(value: string) {
  return value.replace(/[\r\n"\\]/g, "_");
}

function sendEvidence(reply: FastifyReply, evidence: EvidenceRow, encryptionKey: string) {
  const base64 = decryptSecret(
    { ciphertext: evidence.ciphertext, iv: evidence.iv, tag: evidence.authTag },
    encryptionKey,
  );
  const bytes = Buffer.from(base64, "base64");
  reply.header("Cache-Control", "private, no-store");
  reply.header("Content-Type", evidence.contentType);
  reply.header(
    "Content-Disposition",
    `attachment; filename="${safeDownloadName(evidence.fileName)}"`,
  );
  return reply.send(bytes);
}

function nextAction(item: PlannedSummaryRow) {
  if (item.status === "approved") return "Selesai";
  if (item.status === "rejected") return "Pengajuan ditolak";
  if (item.status === "cancelled") return "Pengajuan dibatalkan";
  if (item.currentApproverName) return `Menunggu persetujuan ${item.currentApproverName}`;
  if (item.hcTaskStatus === "pending") {
    return item.hcTaskKind === "approve"
      ? "Menunggu keputusan Human Capital"
      : "Menunggu pemeriksaan Human Capital";
  }
  if (item.hcTaskStatus === "needs_correction") return "Dokumen perlu dilengkapi";
  return "Menunggu proses berikutnya";
}

function mapKnownError(error: unknown): PlannedLeaveRouteError | null {
  if (error instanceof PlannedLeaveRouteError) return error;
  if (error instanceof PlannedLeavePolicyError) {
    return new PlannedLeaveRouteError(409, error.code, error.message);
  }
  if (error instanceof LeaveApprovalConfigurationError) {
    return new PlannedLeaveRouteError(409, error.code, error.message);
  }
  if (error instanceof LeaveOrganizationAuthorityError) {
    return new PlannedLeaveRouteError(409, error.code, error.message);
  }
  if (error instanceof WorkingCalendarError) {
    return new PlannedLeaveRouteError(409, error.code, error.message);
  }
  return null;
}

async function sendKnownError(reply: FastifyReply, error: unknown) {
  const known = mapKnownError(error);
  if (!known) throw error;
  return reply.status(known.statusCode).send({ code: known.code, message: known.message });
}

async function loadHcQueue(pool: Pool, taskKind: "validate" | "approve") {
  return pool.query<HcQueueRow>(
    `SELECT
      task.id AS "taskId",
      request.id AS "requestId",
      requester.id AS "requesterEmployeeId",
      requester.full_name AS "requesterName",
      requester.employee_number AS "employeeNumber",
      unit.name AS "unitName",
      position.name AS "positionName",
      request.policy_key AS "policyKey",
      request.start_on::text AS "startOn",
      request.end_on::text AS "endOn",
      request.working_days AS "workingDays",
      request.reason,
      request.validation_summary AS "validationSummary",
      request.evidence_requirement AS "evidenceRequirement",
      request.submitted_at AS "submittedAt",
      task.status AS "taskStatus",
      task.note AS "taskNote",
      evidence.items AS evidence
    FROM leave_request_hc_tasks task
    JOIN leave_requests request ON request.id = task.leave_request_id
    JOIN employees requester ON requester.id = request.employee_id
    LEFT JOIN organizational_units unit ON unit.id = requester.organizational_unit_id
    LEFT JOIN positions position ON position.id = requester.position_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
        'id', item.id,
        'fileName', item.original_filename,
        'contentType', item.content_type,
        'byteSize', item.byte_size,
        'createdAt', item.created_at
      ) ORDER BY item.created_at ASC) AS items
      FROM leave_request_evidence item
      WHERE item.leave_request_id = request.id
    ) evidence ON true
    WHERE task.task_kind = $1
      AND task.status = 'pending'
      AND request.status = 'in_review'
      AND request.policy_key = ANY($2::text[])
    ORDER BY request.submitted_at ASC`,
    [taskKind, [...SUPPORTED_PLANNED_LEAVE_KEYS]],
  );
}

export async function registerPlannedLeaveRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for planned leave routes");
  }
  const encryptionKey = config.AUTH_ENCRYPTION_KEY;
  const auth = new AuthService(
    pool,
    encryptionKey,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );

  async function authenticateEmployee(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthPrincipal | null> {
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

  app.get("/leave/planned/me/summary", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    try {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<PlannedSummaryRow>(
        `SELECT
          request.id,
          request.policy_key AS "policyKey",
          request.status,
          request.start_on::text AS "startOn",
          request.end_on::text AS "endOn",
          request.working_days AS "workingDays",
          request.reason,
          request.validation_summary AS "validationSummary",
          request.submitted_at AS "submittedAt",
          request.final_decided_at AS "finalDecidedAt",
          approver.full_name AS "currentApproverName",
          task.task_kind AS "hcTaskKind",
          task.status AS "hcTaskStatus"
        FROM leave_requests request
        LEFT JOIN leave_request_approval_steps active_step
          ON active_step.leave_request_id = request.id AND active_step.status = 'pending'
        LEFT JOIN employees approver ON approver.id = active_step.approver_employee_id
        LEFT JOIN leave_request_hc_tasks task ON task.leave_request_id = request.id
        WHERE request.employee_id = $1
          AND request.policy_key = ANY($2::text[])
        ORDER BY request.submitted_at DESC`,
        [employee.id, [...SUPPORTED_PLANNED_LEAVE_KEYS]],
      );
      reply.header("Cache-Control", "no-store");
      return reply.send({
        employee: {
          id: employee.id,
          employeeNumber: employee.employeeNumber,
          fullName: employee.fullName,
          unitName: employee.unitName,
          positionName: employee.positionName,
        },
        policies: SUPPORTED_PLANNED_LEAVE_KEYS.map((key) => getLeavePolicy(key)),
        requests: result.rows.map((item) => ({
          ...item,
          policyName: getLeavePolicy(item.policyKey).name,
          nextAction: nextAction(item),
          submittedAt: item.submittedAt.toISOString(),
          finalDecidedAt: item.finalDecidedAt?.toISOString() ?? null,
        })),
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/leave/planned/me/preview", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_PLANNED_LEAVE_REQUEST",
        message: "Data pengajuan cuti tidak valid.",
      });
    }
    try {
      const employee = await loadEmployeeContext(pool, principal.id);
      const preview = await buildPreview(pool, employee, parsed.data);
      reply.header("Cache-Control", "no-store");
      return reply.send({
        policy: getLeavePolicy(parsed.data.policyKey),
        workingDays: preview.calculation.workingDays,
        calendarDurationDays: preview.validation.calendarDurationDays,
        workingDates: preview.calculation.workingDates,
        nonWorkingDates: preview.calculation.nonWorkingDates,
        minimumNoticeDays: preview.validation.minimumNoticeDays,
        noticeDays: preview.validation.noticeDays,
        unpaid: preview.validation.unpaid,
        approvalChain: preview.approvalChain,
        authorityResolution: preview.authorityResolution,
        nextAction: "Kirim pengajuan untuk memulai persetujuan",
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post(
    "/leave/planned/me/submit",
    { bodyLimit: 3_500_000 },
    async (request, reply) => {
      const principal = await authenticateEmployee(request, reply);
      if (!principal) return;
      const parsed = submitSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          code: "INVALID_PLANNED_LEAVE_REQUEST",
          message: "Data pengajuan cuti tidak valid.",
        });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const employee = await loadEmployeeContext(client, principal.id, true);
        const existing = await client.query<{ id: string; status: string }>(
          `SELECT id, status
           FROM leave_requests
           WHERE employee_id = $1 AND idempotency_key = $2`,
          [employee.id, parsed.data.idempotencyKey],
        );
        if (existing.rows[0]) {
          await client.query("COMMIT");
          return reply.send({ ...existing.rows[0], idempotentReplay: true });
        }

        const evidenceInput = parsed.data.evidence ?? null;
        const preview = await buildPreview(client, employee, {
          policyKey: parsed.data.policyKey,
          startOn: parsed.data.startOn,
          endOn: parsed.data.endOn,
          hasEvidence: evidenceInput !== null,
        });
        const requestId = randomUUID();
        const policy = getLeavePolicy(parsed.data.policyKey);
        await client.query(
          `INSERT INTO leave_requests (
            id, employee_id, policy_key, status, start_on, end_on, working_days,
            reason, hc_handling, idempotency_key, line_handling,
            evidence_requirement, emergency_notice, validation_summary,
            administration_status
          ) VALUES (
            $1, $2, $3, 'in_review', $4::date, $5::date, $6,
            $7, $8, $9, 'approval', $10, false, $11::jsonb,
            'not_applicable'
          )`,
          [
            requestId,
            employee.id,
            parsed.data.policyKey,
            parsed.data.startOn,
            parsed.data.endOn,
            preview.calculation.workingDays,
            parsed.data.reason ?? null,
            preview.validation.hcHandling,
            parsed.data.idempotencyKey,
            preview.validation.evidenceRequirement,
            JSON.stringify({
              policyKey: parsed.data.policyKey,
              workingDays: preview.calculation.workingDays,
              workingDates: preview.calculation.workingDates,
              calendarDurationDays: preview.validation.calendarDurationDays,
              minimumNoticeDays: preview.validation.minimumNoticeDays,
              noticeDays: preview.validation.noticeDays,
              unpaid: preview.validation.unpaid,
              approvalSnapshot: preview.approvalChain.map((step) => ({
                employeeId: step.employeeId,
                sources: step.sources,
              })),
              authorityResolution: preview.authorityResolution,
            }),
          ],
        );

        const evidence = evidenceInput
          ? await storeEvidence(client, requestId, principal.id, evidenceInput, encryptionKey)
          : null;

        const insertedSteps: Array<{ id: string; employeeId: string; name: string }> = [];
        for (const [index, step] of preview.approvalChain.entries()) {
          const stepId = randomUUID();
          await client.query(
            `INSERT INTO leave_request_approval_steps (
              id, leave_request_id, step_order, approver_employee_id, sources, status
            ) VALUES ($1, $2, $3, $4, $5::text[], $6)`,
            [
              stepId,
              requestId,
              index + 1,
              step.employeeId,
              step.sources,
              index === 0 ? "pending" : "waiting",
            ],
          );
          insertedSteps.push({ id: stepId, employeeId: step.employeeId, name: step.name });
        }

        await client.query(
          `INSERT INTO leave_request_hc_tasks (
            id, leave_request_id, task_kind, status, assigned_role_key
          ) VALUES ($1, $2, $3, 'waiting', 'human_capital')`,
          [randomUUID(), requestId, preview.validation.hcHandling],
        );

        await addEvent(client, requestId, principal.id, "leave.planned.submitted", {
          policyKey: parsed.data.policyKey,
          workingDays: preview.calculation.workingDays,
          calendarDurationDays: preview.validation.calendarDurationDays,
          unpaid: preview.validation.unpaid,
          authorityResolution: preview.authorityResolution,
        });
        const firstStep = insertedSteps[0];
        if (firstStep) {
          await enqueueNotification(
            client,
            requestId,
            "leave.approval.requested",
            "employee",
            firstStep.employeeId,
          );
        }
        await client.query("COMMIT");
        return reply.status(201).send({
          id: requestId,
          status: "in_review",
          policyKey: parsed.data.policyKey,
          policyName: policy.name,
          workingDays: preview.calculation.workingDays,
          calendarDurationDays: preview.validation.calendarDurationDays,
          unpaid: preview.validation.unpaid,
          evidence,
          approvalChain: insertedSteps,
          nextAction: firstStep
            ? `Menunggu persetujuan ${firstStep.name}`
            : "Menunggu proses berikutnya",
          idempotentReplay: false,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        return sendKnownError(reply, error);
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/leave/planned/me/requests/:requestId/evidence/:evidenceId",
    async (request, reply) => {
      const principal = await authenticateEmployee(request, reply);
      if (!principal) return;
      const params = requestEvidenceParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ code: "INVALID_EVIDENCE", message: "Dokumen tidak valid." });
      }
      try {
        const employee = await loadEmployeeContext(pool, principal.id);
        const result = await pool.query<EvidenceRow>(
          `SELECT
            evidence.id,
            evidence.leave_request_id AS "requestId",
            evidence.original_filename AS "fileName",
            evidence.content_type AS "contentType",
            evidence.byte_size AS "byteSize",
            evidence.ciphertext,
            evidence.iv,
            evidence.auth_tag AS "authTag"
          FROM leave_request_evidence evidence
          JOIN leave_requests request ON request.id = evidence.leave_request_id
          WHERE evidence.id = $1
            AND evidence.leave_request_id = $2
            AND request.employee_id = $3
            AND request.policy_key = ANY($4::text[])`,
          [params.data.evidenceId, params.data.requestId, employee.id, [...SUPPORTED_PLANNED_LEAVE_KEYS]],
        );
        const evidence = result.rows[0];
        if (!evidence) {
          throw new PlannedLeaveRouteError(404, "EVIDENCE_NOT_FOUND", "Dokumen tidak ditemukan.");
        }
        return sendEvidence(reply, evidence, encryptionKey);
      } catch (error) {
        return sendKnownError(reply, error);
      }
    },
  );

  app.get("/leave/planned/hc/validation-queue", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    try {
      await requireHcValidator(pool, principal);
      const result = await loadHcQueue(pool, "validate");
      reply.header("Cache-Control", "no-store");
      return reply.send({
        items: result.rows.map((item) => ({
          ...item,
          policyName: getLeavePolicy(item.policyKey).name,
          evidence: item.evidence ?? [],
          submittedAt: item.submittedAt.toISOString(),
        })),
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post(
    "/leave/planned/hc/tasks/:taskId/validation-decision",
    async (request, reply) => {
      const principal = await authenticateEmployee(request, reply);
      if (!principal) return;
      const params = hcTaskParamSchema.safeParse(request.params);
      const body = hcValidationDecisionSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          code: "INVALID_HC_VALIDATION_DECISION",
          message: "Keputusan validasi Human Capital tidak valid.",
        });
      }
      if (body.data.action === "request_correction" && !body.data.note) {
        return reply.status(400).send({
          code: "HC_CORRECTION_NOTE_REQUIRED",
          message: "Catatan perbaikan wajib diisi.",
        });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await requireHcValidator(client, principal);
        const result = await client.query<{
          taskId: string;
          requestId: string;
          requesterEmployeeId: string;
          taskStatus: string;
          requestStatus: string;
          evidenceRequirement: string;
          policyKey: SupportedPlannedLeaveKey;
        }>(
          `SELECT
            task.id AS "taskId",
            task.leave_request_id AS "requestId",
            request.employee_id AS "requesterEmployeeId",
            task.status AS "taskStatus",
            request.status AS "requestStatus",
            request.evidence_requirement AS "evidenceRequirement",
            request.policy_key AS "policyKey"
          FROM leave_request_hc_tasks task
          JOIN leave_requests request ON request.id = task.leave_request_id
          WHERE task.id = $1
            AND task.task_kind = 'validate'
            AND request.policy_key = ANY($2::text[])
          FOR UPDATE OF task, request`,
          [params.data.taskId, [...SUPPORTED_PLANNED_LEAVE_KEYS]],
        );
        const task = result.rows[0];
        if (!task) {
          throw new PlannedLeaveRouteError(404, "HC_TASK_NOT_FOUND", "Task validasi tidak ditemukan.");
        }
        if (task.taskStatus !== "pending" || task.requestStatus !== "in_review") {
          throw new PlannedLeaveRouteError(409, "HC_TASK_NOT_PENDING", "Task validasi sudah tidak aktif.");
        }

        if (body.data.action === "request_correction") {
          await client.query(
            `UPDATE leave_request_hc_tasks
             SET status = 'needs_correction', note = $2, acted_by_account_id = $3,
                 acted_at = now(), updated_at = now()
             WHERE id = $1`,
            [task.taskId, body.data.note, principal.id],
          );
          await addEvent(client, task.requestId, principal.id, "leave.hc.correction_requested", {
            taskId: task.taskId,
          });
          await enqueueNotification(
            client,
            task.requestId,
            "leave.hc.correction_requested.employee_notify",
            "employee",
            task.requesterEmployeeId,
          );
          await client.query("COMMIT");
          return reply.send({
            requestId: task.requestId,
            requestStatus: "in_review",
            taskStatus: "needs_correction",
          });
        }

        if (task.evidenceRequirement === "required") {
          const evidenceCount = await client.query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM leave_request_evidence
             WHERE leave_request_id = $1`,
            [task.requestId],
          );
          if ((evidenceCount.rows[0]?.count ?? 0) === 0) {
            throw new PlannedLeaveRouteError(
              409,
              "EVIDENCE_REQUIRED_BEFORE_VALIDATION",
              "Dokumen pendukung harus tersedia sebelum validasi selesai.",
            );
          }
        }

        await client.query(
          `UPDATE leave_request_hc_tasks
           SET status = 'validated', note = $2, acted_by_account_id = $3,
               acted_at = now(), updated_at = now()
           WHERE id = $1`,
          [task.taskId, body.data.note ?? null, principal.id],
        );
        await client.query(
          `UPDATE leave_requests
           SET status = 'approved', final_decided_at = now(), updated_at = now()
           WHERE id = $1`,
          [task.requestId],
        );
        await addEvent(client, task.requestId, principal.id, "leave.hc.validated", {
          taskId: task.taskId,
        });
        await enqueueNotification(
          client,
          task.requestId,
          "leave.hc.validated.employee_notify",
          "employee",
          task.requesterEmployeeId,
        );
        await enqueueFinalApprovalOversight(client, {
          requestId: task.requestId,
          workflowKey: `leave.${task.policyKey}`,
          effectiveDate: jakartaToday(),
        });
        await client.query("COMMIT");
        return reply.send({
          requestId: task.requestId,
          requestStatus: "approved",
          taskStatus: "validated",
        });
      } catch (error) {
        await client.query("ROLLBACK");
        return sendKnownError(reply, error);
      } finally {
        client.release();
      }
    },
  );

  app.get("/leave/planned/hc/approval-queue", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    try {
      await requireHcActualApprover(pool, principal);
      const result = await loadHcQueue(pool, "approve");
      reply.header("Cache-Control", "no-store");
      return reply.send({
        items: result.rows.map((item) => ({
          ...item,
          policyName: getLeavePolicy(item.policyKey).name,
          evidence: item.evidence ?? [],
          submittedAt: item.submittedAt.toISOString(),
        })),
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post(
    "/leave/planned/hc/tasks/:taskId/approval-decision",
    async (request, reply) => {
      const principal = await authenticateEmployee(request, reply);
      if (!principal) return;
      const params = hcTaskParamSchema.safeParse(request.params);
      const body = hcApprovalDecisionSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          code: "INVALID_HC_APPROVAL_DECISION",
          message: "Keputusan Human Capital tidak valid.",
        });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await requireHcActualApprover(client, principal);
        const result = await client.query<{
          taskId: string;
          requestId: string;
          requesterEmployeeId: string;
          taskStatus: string;
          requestStatus: string;
          policyKey: SupportedPlannedLeaveKey;
        }>(
          `SELECT
            task.id AS "taskId",
            task.leave_request_id AS "requestId",
            request.employee_id AS "requesterEmployeeId",
            task.status AS "taskStatus",
            request.status AS "requestStatus",
            request.policy_key AS "policyKey"
          FROM leave_request_hc_tasks task
          JOIN leave_requests request ON request.id = task.leave_request_id
          WHERE task.id = $1
            AND task.task_kind = 'approve'
            AND request.policy_key = 'unpaid'
          FOR UPDATE OF task, request`,
          [params.data.taskId],
        );
        const task = result.rows[0];
        if (!task) {
          throw new PlannedLeaveRouteError(404, "HC_TASK_NOT_FOUND", "Task approval tidak ditemukan.");
        }
        if (task.taskStatus !== "pending" || task.requestStatus !== "in_review") {
          throw new PlannedLeaveRouteError(409, "HC_TASK_NOT_PENDING", "Task approval sudah tidak aktif.");
        }

        const approved = body.data.decision === "approve";
        await client.query(
          `UPDATE leave_request_hc_tasks
           SET status = $2, note = $3, acted_by_account_id = $4,
               acted_at = now(), updated_at = now()
           WHERE id = $1`,
          [task.taskId, approved ? "approved" : "rejected", body.data.note ?? null, principal.id],
        );
        await client.query(
          `UPDATE leave_requests
           SET status = $2, final_decided_at = now(), updated_at = now()
           WHERE id = $1`,
          [task.requestId, approved ? "approved" : "rejected"],
        );
        await addEvent(
          client,
          task.requestId,
          principal.id,
          approved ? "leave.hc.approved" : "leave.hc.rejected",
          { taskId: task.taskId, unpaid: true },
        );
        await enqueueNotification(
          client,
          task.requestId,
          approved ? "leave.hc.approved.employee_notify" : "leave.hc.rejected.employee_notify",
          "employee",
          task.requesterEmployeeId,
        );
        if (approved) {
          await enqueueFinalApprovalOversight(client, {
            requestId: task.requestId,
            workflowKey: `leave.${task.policyKey}`,
            effectiveDate: jakartaToday(),
          });
        }
        await client.query("COMMIT");
        return reply.send({
          requestId: task.requestId,
          requestStatus: approved ? "approved" : "rejected",
          taskStatus: approved ? "approved" : "rejected",
        });
      } catch (error) {
        await client.query("ROLLBACK");
        return sendKnownError(reply, error);
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/leave/planned/hc/requests/:requestId/evidence/:evidenceId",
    async (request, reply) => {
      const principal = await authenticateEmployee(request, reply);
      if (!principal) return;
      const params = requestEvidenceParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ code: "INVALID_EVIDENCE", message: "Dokumen tidak valid." });
      }
      try {
        const [canValidate, canApprove] = await Promise.all([
          hasActivePermission(pool, principal.id, "leave.validate"),
          Promise.all([
            hasActivePermission(pool, principal.id, "leave.validate"),
            hasActivePermission(pool, principal.id, "leave.hc.approve"),
          ]).then(([isHc, canHcApprove]) => isHc && canHcApprove),
        ]);
        if (!canValidate && !canApprove) {
          throw new PlannedLeaveRouteError(
            403,
            "EVIDENCE_FORBIDDEN",
            "Akun ini tidak berwenang membaca dokumen pendukung.",
          );
        }
        const result = await pool.query<EvidenceRow>(
          `SELECT
            evidence.id,
            evidence.leave_request_id AS "requestId",
            evidence.original_filename AS "fileName",
            evidence.content_type AS "contentType",
            evidence.byte_size AS "byteSize",
            evidence.ciphertext,
            evidence.iv,
            evidence.auth_tag AS "authTag"
          FROM leave_request_evidence evidence
          JOIN leave_requests request ON request.id = evidence.leave_request_id
          JOIN leave_request_hc_tasks task ON task.leave_request_id = request.id
          WHERE evidence.id = $1
            AND evidence.leave_request_id = $2
            AND request.policy_key = ANY($3::text[])
            AND (
              ($4::boolean AND task.task_kind = 'validate')
              OR ($5::boolean AND task.task_kind = 'approve')
            )`,
          [
            params.data.evidenceId,
            params.data.requestId,
            [...SUPPORTED_PLANNED_LEAVE_KEYS],
            canValidate,
            canApprove,
          ],
        );
        const evidence = result.rows[0];
        if (!evidence) {
          throw new PlannedLeaveRouteError(404, "EVIDENCE_NOT_FOUND", "Dokumen tidak ditemukan.");
        }
        return sendEvidence(reply, evidence, encryptionKey);
      } catch (error) {
        return sendKnownError(reply, error);
      }
    },
  );
}
