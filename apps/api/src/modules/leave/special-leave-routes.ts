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
  SUPPORTED_SPECIAL_LEAVE_KEYS,
  SpecialLeavePolicyError,
  type SupportedSpecialLeaveKey,
  validateSpecialLeaveRequest,
} from "./domain/special-leave-policy.js";
import { getLeavePolicy } from "./domain/policy-catalog.js";
import {
  calculateWorkingDays,
  decodeWorkingWeekdays,
  WorkingCalendarError,
  type IsoWeekday,
  type LeaveCalendarException,
} from "./domain/working-calendar.js";

const specialKeySchema = z.enum(SUPPORTED_SPECIAL_LEAVE_KEYS);
const previewSchema = z.object({
  policyKey: specialKeySchema,
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
const requestParamSchema = z.object({ requestId: z.string().uuid() });
const evidenceParamSchema = z.object({
  requestId: z.string().uuid(),
  evidenceId: z.string().uuid(),
});
const taskParamSchema = z.object({ taskId: z.string().uuid() });
const hcDecisionSchema = z.object({
  action: z.enum(["validate", "request_correction"]),
  note: z.string().trim().max(1000).nullable().optional(),
});

interface EmployeeContextRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  unitName: string | null;
  positionName: string | null;
  directManagerEmployeeId: string | null;
  directManagerName: string | null;
  directManagerStatus: "active" | "inactive" | "resigned" | null;
}

interface CalendarSettingRow {
  workingWeekdayMask: number | null;
}

interface CalendarExceptionRow {
  date: string;
  isWorkingDay: boolean;
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
  createdAt: Date;
}

interface SpecialRequestRow {
  id: string;
  policyKey: SupportedSpecialLeaveKey;
  status: "in_review" | "approved" | "rejected" | "cancelled";
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  submittedAt: Date;
  finalDecidedAt: Date | null;
  hcTaskStatus:
    | "waiting"
    | "pending"
    | "needs_correction"
    | "validated"
    | "approved"
    | "rejected"
    | null;
  hcTaskNote: string | null;
  evidenceCount: number;
}

interface HcQueueRow {
  taskId: string;
  taskStatus: "pending" | "needs_correction";
  requestId: string;
  requesterEmployeeId: string;
  requesterName: string;
  employeeNumber: string;
  unitName: string | null;
  positionName: string | null;
  policyKey: SupportedSpecialLeaveKey;
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  evidenceRequirement: "none" | "required" | "required_deferred_allowed" | "conditional";
  submittedAt: Date;
  taskNote: string | null;
  evidence: Array<{
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
    createdAt: string;
  }> | null;
}

class EmployeeSpecialLeaveError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EmployeeSpecialLeaveError";
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
      e.id,
      e.employee_number AS "employeeNumber",
      e.full_name AS "fullName",
      e.status,
      u.name AS "unitName",
      p.name AS "positionName",
      e.direct_manager_employee_id AS "directManagerEmployeeId",
      manager.full_name AS "directManagerName",
      manager.status AS "directManagerStatus"
    FROM accounts a
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
    LEFT JOIN positions p ON p.id = e.position_id
    LEFT JOIN employees manager ON manager.id = e.direct_manager_employee_id
    WHERE a.id = $1
      AND a.principal_type = 'EMPLOYEE'
      AND a.status = 'active'
    ${lock ? "FOR UPDATE OF e" : ""}`,
    [accountId],
  );

  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new EmployeeSpecialLeaveError(
      403,
      "EMPLOYEE_NOT_ACTIVE",
      "Akun tidak terhubung ke pegawai aktif.",
    );
  }
  return employee;
}

export async function hasHcValidationPermission(db: Pool | PoolClient, accountId: string) {
  return hasOrganizationPermission(db, accountId, "leave.validate");
}

async function requireHcPermission(db: Pool | PoolClient, principal: AuthPrincipal) {
  if (!(await hasHcValidationPermission(db, principal.id))) {
    throw new EmployeeSpecialLeaveError(
      403,
      "HC_VALIDATION_FORBIDDEN",
      "Akun ini tidak memiliki penugasan Human Capital aktif pada scope organisasi.",
    );
  }
}

async function loadWorkingCalendar(
  db: Pool | PoolClient,
  startOn: string,
  endOn: string,
): Promise<{ workingWeekdays: IsoWeekday[]; exceptions: LeaveCalendarException[] }> {
  const [settingResult, exceptionResult] = await Promise.all([
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

  const workingWeekdays = decodeWorkingWeekdays(
    settingResult.rows[0]?.workingWeekdayMask,
  );
  if (!workingWeekdays) {
    throw new EmployeeSpecialLeaveError(
      409,
      "LEAVE_CALENDAR_NOT_CONFIGURED",
      "Kalender hari kerja belum dikonfigurasi oleh administrator.",
    );
  }
  return { workingWeekdays, exceptions: exceptionResult.rows };
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
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.contentBase64, "base64");
  } catch {
    throw new EmployeeSpecialLeaveError(
      400,
      "INVALID_EVIDENCE_CONTENT",
      "Isi dokumen pendukung tidak valid.",
    );
  }

  if (bytes.length === 0 || bytes.length > 2_097_152) {
    throw new EmployeeSpecialLeaveError(
      413,
      "EVIDENCE_TOO_LARGE",
      "Dokumen pendukung maksimal 2 MB per file.",
    );
  }

  const signatureOk =
    (input.contentType === "application/pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-") ||
    (input.contentType === "image/jpeg" &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (input.contentType === "image/png" &&
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

  if (!signatureOk) {
    throw new EmployeeSpecialLeaveError(
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

async function sendEvidence(
  reply: FastifyReply,
  evidence: EvidenceRow,
  encryptionKey: string,
) {
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

async function buildPreview(
  db: Pool | PoolClient,
  employee: EmployeeContextRow,
  input: z.infer<typeof previewSchema>,
) {
  const calendar = await loadWorkingCalendar(db, input.startOn, input.endOn);
  const calculation = calculateWorkingDays(input.startOn, input.endOn, calendar);
  const validation = validateSpecialLeaveRequest({
    policyKey: input.policyKey,
    submittedOn: jakartaToday(),
    startOn: input.startOn,
    endOn: input.endOn,
    workingDays: calculation.workingDays,
    hasEvidence: input.hasEvidence,
  });
  const warnings = [...validation.warnings];
  if (!employee.directManagerEmployeeId || employee.directManagerStatus !== "active") {
    warnings.push({
      code: "LINE_NOTIFICATION_UNRESOLVED",
      message:
        "Atasan langsung belum tersedia sebagai penerima notifikasi. Pengajuan tetap dapat dicatat dan Human Capital akan menerima task.",
    });
  }

  return {
    calculation,
    validation: { ...validation, warnings },
    managerNotification: employee.directManagerEmployeeId && employee.directManagerStatus === "active"
      ? { employeeId: employee.directManagerEmployeeId, name: employee.directManagerName }
      : null,
  };
}

function mapKnownError(error: unknown): EmployeeSpecialLeaveError | null {
  if (error instanceof EmployeeSpecialLeaveError) return error;
  if (error instanceof SpecialLeavePolicyError) {
    return new EmployeeSpecialLeaveError(409, error.code, error.message);
  }
  if (error instanceof WorkingCalendarError) {
    return new EmployeeSpecialLeaveError(409, error.code, error.message);
  }
  return null;
}

async function sendKnownError(reply: FastifyReply, error: unknown) {
  const known = mapKnownError(error);
  if (!known) throw error;
  return reply.status(known.statusCode).send({ code: known.code, message: known.message });
}

export async function registerSpecialLeaveRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for special leave routes");
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
      return await requirePrincipalFromCookie(
        auth,
        request.headers.cookie,
        "EMPLOYEE",
      );
    } catch (error) {
      if (error instanceof AuthError) {
        reply.header("Cache-Control", "no-store");
        await reply.status(error.statusCode).send({ code: error.code, message: error.message });
        return null;
      }
      throw error;
    }
  }

  app.get("/leave/special/me/summary", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;

    try {
      const employee = await loadEmployeeContext(pool, principal.id);
      const [requests, isHc] = await Promise.all([
        pool.query<SpecialRequestRow>(
          `SELECT
            r.id,
            r.policy_key AS "policyKey",
            r.status,
            r.start_on::text AS "startOn",
            r.end_on::text AS "endOn",
            r.working_days AS "workingDays",
            r.reason,
            r.submitted_at AS "submittedAt",
            r.final_decided_at AS "finalDecidedAt",
            task.status AS "hcTaskStatus",
            task.note AS "hcTaskNote",
            (SELECT count(*)::int FROM leave_request_evidence evidence WHERE evidence.leave_request_id = r.id) AS "evidenceCount"
          FROM leave_requests r
          LEFT JOIN leave_request_hc_tasks task ON task.leave_request_id = r.id
          WHERE r.employee_id = $1
            AND r.policy_key = ANY($2::text[])
          ORDER BY r.submitted_at DESC
          LIMIT 20`,
          [employee.id, [...SUPPORTED_SPECIAL_LEAVE_KEYS]],
        ),
        hasHcValidationPermission(pool, principal.id),
      ]);

      reply.header("Cache-Control", "no-store");
      return reply.send({
        employee: {
          id: employee.id,
          employeeNumber: employee.employeeNumber,
          fullName: employee.fullName,
          unitName: employee.unitName,
          positionName: employee.positionName,
        },
        hasHumanCapitalRole: isHc,
        policies: SUPPORTED_SPECIAL_LEAVE_KEYS.map((key) => getLeavePolicy(key)),
        requests: requests.rows.map((item) => ({
          ...item,
          policyName: getLeavePolicy(item.policyKey).name,
          submittedAt: item.submittedAt.toISOString(),
          finalDecidedAt: item.finalDecidedAt?.toISOString() ?? null,
        })),
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/leave/special/me/preview", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_SPECIAL_LEAVE_REQUEST",
        message: "Data preview Cuti Khusus tidak valid.",
      });
    }

    try {
      const employee = await loadEmployeeContext(pool, principal.id);
      const preview = await buildPreview(pool, employee, parsed.data);
      reply.header("Cache-Control", "no-store");
      return reply.send({
        policy: getLeavePolicy(parsed.data.policyKey),
        workingDays: preview.calculation.workingDays,
        workingDates: preview.calculation.workingDates,
        nonWorkingDates: preview.calculation.nonWorkingDates,
        evidencePending: preview.validation.evidencePending,
        managerNotification: preview.managerNotification,
        warnings: preview.validation.warnings,
        flow:
          preview.validation.hcHandling === "validate"
            ? ["Atasan langsung diberi notifikasi", "Human Capital memvalidasi administrasi"]
            : ["Atasan langsung diberi notifikasi", "Human Capital diberi notifikasi"],
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post(
    "/leave/special/me/submit",
    { bodyLimit: 3_500_000 },
    async (request, reply) => {
      const principal = await authenticateEmployee(request, reply);
      if (!principal) return;
      const parsed = submitSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          code: "INVALID_SPECIAL_LEAVE_REQUEST",
          message: "Data pengajuan Cuti Khusus tidak valid.",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const employee = await loadEmployeeContext(client, principal.id, true);
        const existing = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM leave_requests
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
        const status = preview.validation.hcHandling === "validate" ? "in_review" : "approved";
        await client.query(
          `INSERT INTO leave_requests (
            id, employee_id, policy_key, status, start_on, end_on, working_days,
            reason, hc_handling, idempotency_key, line_handling,
            evidence_requirement, emergency_notice, validation_summary, final_decided_at
          ) VALUES (
            $1, $2, $3, $4, $5::date, $6::date, $7,
            $8, $9, $10, 'notify', $11, $12, $13::jsonb,
            CASE WHEN $4 = 'approved' THEN now() ELSE NULL END
          )`,
          [
            requestId,
            employee.id,
            parsed.data.policyKey,
            status,
            parsed.data.startOn,
            parsed.data.endOn,
            preview.calculation.workingDays,
            parsed.data.reason ?? null,
            preview.validation.hcHandling,
            parsed.data.idempotencyKey,
            preview.validation.evidenceRequirement,
            preview.validation.emergencyNoticeAllowed,
            JSON.stringify({
              evidencePending: preview.validation.evidencePending,
              warnings: preview.validation.warnings,
            }),
          ],
        );

        const evidence = evidenceInput
          ? await storeEvidence(client, requestId, principal.id, evidenceInput, encryptionKey)
          : null;

        if (preview.validation.hcHandling === "validate") {
          await client.query(
            `INSERT INTO leave_request_hc_tasks (
              id, leave_request_id, task_kind, status, assigned_role_key
            ) VALUES ($1, $2, 'validate', 'pending', 'human_capital')`,
            [randomUUID(), requestId],
          );
        }

        await addEvent(client, requestId, principal.id, "leave.special.submitted", {
          policyKey: parsed.data.policyKey,
          workingDays: preview.calculation.workingDays,
          evidencePending: preview.validation.evidencePending,
        });

        if (preview.managerNotification) {
          await enqueueNotification(
            client,
            requestId,
            "leave.special.line_notified",
            "employee",
            preview.managerNotification.employeeId,
          );
        } else {
          await addEvent(client, requestId, principal.id, "leave.special.line_notification_unresolved");
        }

        await enqueueNotification(
          client,
          requestId,
          preview.validation.hcHandling === "validate"
            ? "leave.hc.validation.requested"
            : "leave.special.hc_notified",
          "role",
          "human_capital",
        );

        await client.query("COMMIT");
        return reply.status(201).send({
          id: requestId,
          status,
          policyKey: parsed.data.policyKey,
          workingDays: preview.calculation.workingDays,
          evidence,
          evidencePending: preview.validation.evidencePending,
          hcHandling: preview.validation.hcHandling,
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

  app.post(
    "/leave/special/me/requests/:requestId/evidence",
    { bodyLimit: 3_500_000 },
    async (request, reply) => {
      const principal = await authenticateEmployee(request, reply);
      if (!principal) return;
      const params = requestParamSchema.safeParse(request.params);
      const body = evidenceSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({
          code: "INVALID_EVIDENCE",
          message: "Dokumen pendukung tidak valid.",
        });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const employee = await loadEmployeeContext(client, principal.id);
        const requestResult = await client.query<{ status: string; policyKey: string }>(
          `SELECT status, policy_key AS "policyKey"
           FROM leave_requests
           WHERE id = $1
             AND employee_id = $2
             AND policy_key = ANY($3::text[])
           FOR UPDATE`,
          [params.data.requestId, employee.id, [...SUPPORTED_SPECIAL_LEAVE_KEYS]],
        );
        const leaveRequest = requestResult.rows[0];
        if (!leaveRequest) {
          throw new EmployeeSpecialLeaveError(404, "SPECIAL_LEAVE_NOT_FOUND", "Pengajuan Cuti Khusus tidak ditemukan.");
        }
        if (leaveRequest.status !== "in_review") {
          throw new EmployeeSpecialLeaveError(
            409,
            "EVIDENCE_UPLOAD_CLOSED",
            "Dokumen tambahan hanya dapat diunggah saat pengajuan masih dalam validasi.",
          );
        }

        const evidence = await storeEvidence(
          client,
          params.data.requestId,
          principal.id,
          body.data,
          encryptionKey,
        );
        await client.query(
          `UPDATE leave_request_hc_tasks
           SET status = CASE WHEN status = 'needs_correction' THEN 'pending' ELSE status END,
               updated_at = now()
           WHERE leave_request_id = $1 AND task_kind = 'validate'`,
          [params.data.requestId],
        );
        await addEvent(client, params.data.requestId, principal.id, "leave.evidence.added", {
          evidenceId: evidence.id,
        });
        await enqueueNotification(
          client,
          params.data.requestId,
          "leave.evidence.added.hc_notify",
          "role",
          "human_capital",
        );
        await client.query("COMMIT");
        return reply.status(201).send(evidence);
      } catch (error) {
        await client.query("ROLLBACK");
        return sendKnownError(reply, error);
      } finally {
        client.release();
      }
    },
  );

  app.get(
    "/leave/special/me/requests/:requestId/evidence/:evidenceId",
    async (request, reply) => {
      const principal = await authenticateEmployee(request, reply);
      if (!principal) return;
      const params = evidenceParamSchema.safeParse(request.params);
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
            evidence.auth_tag AS "authTag",
            evidence.created_at AS "createdAt"
           FROM leave_request_evidence evidence
           JOIN leave_requests request ON request.id = evidence.leave_request_id
           WHERE evidence.id = $1
             AND evidence.leave_request_id = $2
             AND request.employee_id = $3
             AND request.policy_key = ANY($4::text[])`,
          [
            params.data.evidenceId,
            params.data.requestId,
            employee.id,
            [...SUPPORTED_SPECIAL_LEAVE_KEYS],
          ],
        );
        const evidence = result.rows[0];
        if (!evidence) {
          throw new EmployeeSpecialLeaveError(404, "EVIDENCE_NOT_FOUND", "Dokumen tidak ditemukan.");
        }
        return sendEvidence(reply, evidence, encryptionKey);
      } catch (error) {
        return sendKnownError(reply, error);
      }
    },
  );

  app.get("/leave/hc/validation-queue", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;

    try {
      const actor = await loadEmployeeContext(pool, principal.id);
      await requireHcPermission(pool, principal);
      const result = await pool.query<HcQueueRow>(
        `SELECT
          task.id AS "taskId",
          task.status AS "taskStatus",
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
          request.evidence_requirement AS "evidenceRequirement",
          request.submitted_at AS "submittedAt",
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
        WHERE task.task_kind = 'validate'
          AND task.status = 'pending'
          AND request.status = 'in_review'
          AND request.policy_key = ANY($1::text[])
        ORDER BY request.submitted_at ASC`,
        [[...SUPPORTED_SPECIAL_LEAVE_KEYS]],
      );

      reply.header("Cache-Control", "no-store");
      return reply.send({
        actor: {
          id: actor.id,
          fullName: actor.fullName,
          employeeNumber: actor.employeeNumber,
          unitName: actor.unitName,
          positionName: actor.positionName,
        },
        items: result.rows.map((item) => ({
          ...item,
          policyName: getLeavePolicy(item.policyKey).name,
          submittedAt: item.submittedAt.toISOString(),
          evidence: item.evidence ?? [],
        })),
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get(
    "/leave/hc/requests/:requestId/evidence/:evidenceId",
    async (request, reply) => {
      const principal = await authenticateEmployee(request, reply);
      if (!principal) return;
      const params = evidenceParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ code: "INVALID_EVIDENCE", message: "Dokumen tidak valid." });
      }

      try {
        await requireHcPermission(pool, principal);
        const result = await pool.query<EvidenceRow>(
          `SELECT
            evidence.id,
            evidence.leave_request_id AS "requestId",
            evidence.original_filename AS "fileName",
            evidence.content_type AS "contentType",
            evidence.byte_size AS "byteSize",
            evidence.ciphertext,
            evidence.iv,
            evidence.auth_tag AS "authTag",
            evidence.created_at AS "createdAt"
           FROM leave_request_evidence evidence
           JOIN leave_request_hc_tasks task ON task.leave_request_id = evidence.leave_request_id
           JOIN leave_requests request ON request.id = evidence.leave_request_id
           WHERE evidence.id = $1
             AND evidence.leave_request_id = $2
             AND task.task_kind = 'validate'
             AND request.policy_key = ANY($3::text[])`,
          [params.data.evidenceId, params.data.requestId, [...SUPPORTED_SPECIAL_LEAVE_KEYS]],
        );
        const evidence = result.rows[0];
        if (!evidence) {
          throw new EmployeeSpecialLeaveError(404, "EVIDENCE_NOT_FOUND", "Dokumen tidak ditemukan.");
        }
        return sendEvidence(reply, evidence, encryptionKey);
      } catch (error) {
        return sendKnownError(reply, error);
      }
    },
  );

  app.post("/leave/hc/tasks/:taskId/decision", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const params = taskParamSchema.safeParse(request.params);
    const body = hcDecisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_HC_VALIDATION_DECISION",
        message: "Keputusan validasi HC tidak valid.",
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
      await requireHcPermission(client, principal);
      const result = await client.query<{
        taskId: string;
        requestId: string;
        requesterEmployeeId: string;
        taskStatus: string;
        requestStatus: string;
        evidenceRequirement: string;
      }>(
        `SELECT
          task.id AS "taskId",
          task.leave_request_id AS "requestId",
          request.employee_id AS "requesterEmployeeId",
          task.status AS "taskStatus",
          request.status AS "requestStatus",
          request.evidence_requirement AS "evidenceRequirement"
         FROM leave_request_hc_tasks task
         JOIN leave_requests request ON request.id = task.leave_request_id
         WHERE task.id = $1
           AND task.task_kind = 'validate'
           AND request.policy_key = ANY($2::text[])
         FOR UPDATE OF task, request`,
        [params.data.taskId, [...SUPPORTED_SPECIAL_LEAVE_KEYS]],
      );
      const task = result.rows[0];
      if (!task) {
        throw new EmployeeSpecialLeaveError(404, "HC_TASK_NOT_FOUND", "Task validasi HC tidak ditemukan.");
      }
      if (task.taskStatus !== "pending" || task.requestStatus !== "in_review") {
        throw new EmployeeSpecialLeaveError(409, "HC_TASK_NOT_PENDING", "Task validasi sudah tidak aktif.");
      }

      if (body.data.action === "validate") {
        if (["required", "required_deferred_allowed"].includes(task.evidenceRequirement)) {
          const evidenceCount = await client.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM leave_request_evidence WHERE leave_request_id = $1`,
            [task.requestId],
          );
          if ((evidenceCount.rows[0]?.count ?? 0) === 0) {
            throw new EmployeeSpecialLeaveError(
              409,
              "EVIDENCE_REQUIRED_BEFORE_VALIDATION",
              "Dokumen pendukung harus tersedia sebelum Human Capital menyelesaikan validasi.",
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
        await client.query("COMMIT");
        return reply.send({ requestId: task.requestId, requestStatus: "approved", taskStatus: "validated" });
      }

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
    } catch (error) {
      await client.query("ROLLBACK");
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });
}
