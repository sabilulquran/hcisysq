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
import {
  calculateAnnualLeaveYearView,
  type AnnualLeavePeriodKey,
  type LeaveEntitlementGroup,
} from "./domain/annual-leave-policy.js";
import {
  AnnualLeaveRequestPolicyError,
  validateAnnualLeaveRequest,
} from "./domain/annual-leave-request.js";
import {
  LeaveApprovalConfigurationError,
  type LeaveApprovalStep,
} from "./domain/approval-chain.js";
import { getLeavePolicy } from "./domain/policy-catalog.js";
import {
  activateCriticalReviewAfterLineApproval,
  attachCriticalReview,
  loadApplicableCriticalPeriods,
} from "./critical-period-store.js";
import { notifyApprovalCancelled, notifyApprovalRequested } from "./approver-notifications.js";
import { postponementColumns, postponementJoin, type PostponementView } from "./postponement-store.js";
import {
  assertLeaveRequestCancellable,
  decideLeaveApprovalStep,
  LeaveWorkflowError,
  type LeaveApprovalStepState,
  type LeaveLineHandling,
  type LeaveRequestStatus,
} from "./domain/request-workflow.js";
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
  governanceActorIsRequester,
  resolveLeaveAuthorities,
} from "./organization-authority.js";

const annualRequestSchema = z.object({
  startOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().max(1000).nullable().optional(),
});
const annualSubmitSchema = annualRequestSchema.extend({
  idempotencyKey: z.string().uuid(),
});
const stepParamSchema = z.object({ stepId: z.string().uuid() });
const requestParamSchema = z.object({ id: z.string().uuid() });
const cancelSchema = z.object({
  reason: z.string().trim().max(500).nullable().optional().transform((value) => value || null),
});
const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).nullable().optional(),
});

type HcHandling = "notify" | "validate" | "approve" | "none";

export interface EmployeeContextRow {
  id: string;
  employeeNumber: string;
  fullName: string;
  status: "active" | "inactive" | "resigned";
  startedOn: string | null;
  leaveEntitlementGroup: LeaveEntitlementGroup | null;
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

interface GovernanceActorRow {
  id: string;
  email: string;
  status: string;
  principalType: string;
}

interface RequestSummaryRow {
  id: string;
  policyKey: string;
  status: LeaveRequestStatus;
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  annualPeriodKey: AnnualLeavePeriodKey | null;
  submittedAt: Date;
  finalDecidedAt: Date | null;
  currentApproverName: string | null;
  criticalReviewStatus: "waiting" | "pending" | "approved" | "rejected" | "cancelled" | null;
  canCancel: boolean;
  /** LEAVE-008 */
  postponement: PostponementView | null;
  replacesRequestId: string | null;
  canRespondToPostponement: boolean;
}

interface InboxRow {
  stepId: string;
  requestId: string;
  requesterEmployeeId: string;
  requesterName: string;
  policyKey: string;
  startOn: string;
  endOn: string;
  workingDays: number;
  reason: string | null;
  submittedAt: Date;
  sources: string[];
}

export class EmployeeLeaveError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EmployeeLeaveError";
  }
}

export function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

export async function loadEmployeeContext(
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
      e.started_on::text AS "startedOn",
      e.leave_entitlement_group AS "leaveEntitlementGroup",
      u.id AS "unitId",
      u.name AS "unitName",
      p.name AS "positionName",
      e.direct_manager_employee_id AS "directManagerEmployeeId",
      u.leave_approver_employee_id AS "unitApproverEmployeeId"
    FROM accounts a
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
    LEFT JOIN positions p ON p.id = e.position_id
    WHERE a.id = $1
      AND a.principal_type = 'EMPLOYEE'
      AND a.status = 'active'
      AND e.removed_at IS NULL
    ${lock ? "FOR UPDATE OF e" : ""}`,
    [accountId],
  );

  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new EmployeeLeaveError(
      403,
      "EMPLOYEE_NOT_ACTIVE",
      "Akun tidak terhubung ke pegawai aktif.",
    );
  }
  return employee;
}

async function loadAnnualUsage(
  db: Pool | PoolClient,
  employeeId: string,
  year: number,
  excludeRequestId: string | null = null,
): Promise<Partial<Record<AnnualLeavePeriodKey, number>>> {
  const result = await db.query<{ key: AnnualLeavePeriodKey; days: number }>(
    `SELECT
      annual_period_key AS key,
      coalesce(sum(working_days), 0)::int AS days
    FROM leave_requests
    WHERE employee_id = $1
      AND policy_key = 'annual'
      AND status IN ('in_review', 'approved')
      AND start_on >= make_date($2, 1, 1)
      AND start_on < make_date($2 + 1, 1, 1)
      AND annual_period_key IS NOT NULL
      AND ($3::uuid IS NULL OR id <> $3::uuid)
    GROUP BY annual_period_key`,
    [employeeId, year, excludeRequestId],
  );

  return Object.fromEntries(result.rows.map((row) => [row.key, row.days])) as Partial<
    Record<AnnualLeavePeriodKey, number>
  >;
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
      `SELECT
        calendar_date::text AS date,
        is_working_day AS "isWorkingDay"
       FROM leave_calendar_exceptions
       WHERE calendar_date BETWEEN $1::date AND $2::date
       ORDER BY calendar_date ASC`,
      [startOn, endOn],
    ),
  ]);

  const workingWeekdays = decodeWorkingWeekdays(settingResult.rows[0]?.workingWeekdayMask);
  if (!workingWeekdays) {
    throw new EmployeeLeaveError(
      409,
      "LEAVE_CALENDAR_NOT_CONFIGURED",
      "Kalender hari kerja belum dikonfigurasi oleh administrator.",
    );
  }

  return { workingWeekdays, exceptions: exceptionResult.rows };
}

async function hydrateApprovalChain(
  db: Pool | PoolClient,
  chain: readonly LeaveApprovalStep[],
): Promise<Array<LeaveApprovalStep & { name: string }>> {
  const ids = chain.flatMap((step) => step.employeeId ? [step.employeeId] : []);
  const accountIds = chain.flatMap((step) => step.accountId ? [step.accountId] : []);
  const result = await db.query<ApprovalActorRow>(
    `SELECT
      e.id,
      e.full_name AS "fullName",
      e.status,
      a.id AS "accountId",
      a.status AS "accountStatus"
    FROM employees e
    LEFT JOIN accounts a
      ON a.employee_id = e.id
      AND a.principal_type = 'EMPLOYEE'
    WHERE e.id = ANY($1::uuid[])
      AND e.removed_at IS NULL`,
    [ids],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const accounts = accountIds.length === 0
    ? { rows: [] as GovernanceActorRow[] }
    : await db.query<GovernanceActorRow>(
      `SELECT id, email, status, principal_type AS "principalType"
       FROM accounts WHERE id = ANY($1::uuid[])`,
      [accountIds],
    );
  const accountById = new Map(accounts.rows.map((row) => [row.id, row]));

  return chain.map((step) => {
    if ((step.principalType ?? "EMPLOYEE") === "ACCOUNT") {
      const actor = step.accountId ? accountById.get(step.accountId) : undefined;
      if (!actor || actor.principalType !== "FOUNDATION_BOARD" || actor.status !== "active") {
        throw new EmployeeLeaveError(
          409,
          "APPROVER_ACCOUNT_NOT_READY",
          "Akun governance approver belum aktif.",
        );
      }
      return {
        ...step,
        principalType: "ACCOUNT" as const,
        employeeId: null,
        accountId: actor.id,
        name: "Penyetuju Pengurus Yayasan",
      };
    }
    if (!step.employeeId) {
      throw new EmployeeLeaveError(409, "APPROVER_NOT_ACTIVE", "Principal approver tidak valid.");
    }
    const actor = byId.get(step.employeeId);
    if (!actor || actor.status !== "active") {
      throw new EmployeeLeaveError(
        409,
        "APPROVER_NOT_ACTIVE",
        "Rantai approval berisi approver yang tidak aktif.",
      );
    }
    if (!actor.accountId || actor.accountStatus !== "active") {
      throw new EmployeeLeaveError(
        409,
        "APPROVER_ACCOUNT_NOT_READY",
        `Akun approver ${actor.fullName} belum aktif.`,
      );
    }
    return {
      employeeId: actor.id,
      sources: step.sources,
      name: actor.fullName,
    };
  });
}

/**
 * `submittedOn` is the notice reference date: today for a new request, the original submission
 * date for a LEAVE-008 replacement (D-06). Approvers are always resolved on today's date
 * (`authorityDate`), so a replacement gets the chain in force when it is accepted (D-07).
 * `excludeRequestId` leaves the request being postponed out of the quota while its approver
 * checks a proposal (D-05).
 */
export async function buildAnnualPreview(
  db: Pool | PoolClient,
  employee: EmployeeContextRow,
  input: { startOn: string; endOn: string },
  submittedOn: string,
  excludeRequestId: string | null = null,
  authorityDate: string = jakartaToday(),
) {
  if (!employee.startedOn) {
    throw new EmployeeLeaveError(
      409,
      "EMPLOYMENT_START_MISSING",
      "Tanggal mulai kerja belum tersedia pada employee master.",
    );
  }

  const calendar = await loadWorkingCalendar(db, input.startOn, input.endOn);
  const calculation = calculateWorkingDays(input.startOn, input.endOn, calendar);
  const usedDaysByPeriod = await loadAnnualUsage(db, employee.id, yearOf(input.startOn), excludeRequestId);
  const validation = validateAnnualLeaveRequest({
    entitlementGroup: employee.leaveEntitlementGroup,
    employmentStartedOn: employee.startedOn,
    submittedOn,
    leaveStartOn: input.startOn,
    leaveEndOn: input.endOn,
    requestedWorkingDays: calculation.workingDays,
    usedDaysByPeriod,
  });
  const authorityResolution = await resolveLeaveAuthorities(db, {
    workflowKey: "leave.annual",
    requesterEmployeeId: employee.id,
    effectiveDate: authorityDate,
    legacy: {
      directManagerEmployeeId: employee.directManagerEmployeeId,
      unitApproverEmployeeId: employee.unitApproverEmployeeId,
    },
    policyChain: "LINE_AND_UNIT",
    allowAccountPrincipal: true,
  });
  const approvalChain = await hydrateApprovalChain(db, authorityResolution.approvalChain);
  // LEAVE-009: Cuti Tahunan in a critical period gets an HC review after line approval (D-02).
  const criticalPeriods = await loadApplicableCriticalPeriods(db, {
    unitId: employee.unitId,
    startOn: input.startOn,
    endOn: input.endOn,
  });

  return {
    calculation,
    validation,
    approvalChain,
    authorityResolution: authorityResolution.context,
    criticalPeriods,
  };
}

export async function addEvent(
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

export async function enqueueNotification(
  db: PoolClient,
  requestId: string,
  eventType: string,
  targetType: "employee" | "account" | "role",
  targetKey: string,
) {
  await db.query(
    `INSERT INTO leave_notification_outbox (
      id, leave_request_id, event_type, target_type, target_key, payload
    ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb)`,
    [randomUUID(), requestId, eventType, targetType, targetKey],
  );
}

async function activateHcTaskAfterLineApproval(
  db: PoolClient,
  requestId: string,
  handling: Extract<HcHandling, "validate" | "approve">,
) {
  const result = await db.query<{ id: string }>(
    `UPDATE leave_request_hc_tasks
     SET status = 'pending', updated_at = now()
     WHERE leave_request_id = $1
       AND task_kind = $2
       AND status = 'waiting'
     RETURNING id`,
    [requestId, handling],
  );
  if (!result.rows[0]) {
    throw new EmployeeLeaveError(
      409,
      "HC_TASK_NOT_READY",
      "Tahap Human Capital belum tersedia atau sudah berubah.",
    );
  }
  return result.rows[0].id;
}

/** ORG-013: a FOUNDATION_BOARD account decides a governance step only with this capability. */
export async function assertGovernanceApprovalCapability(
  db: Pool | PoolClient,
  accountId: string,
): Promise<void> {
  const capability = await db.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM account_role_assignments ara
       JOIN role_permissions rp ON rp.role_id = ara.role_id
       WHERE ara.account_id = $1
         AND rp.permission_key = 'leave.governance.approve'
         AND (ara.starts_on IS NULL OR ara.starts_on <= $2::date)
         AND (ara.ends_on IS NULL OR ara.ends_on >= $2::date)
         AND ara.scope_type = 'organization'
     ) AS allowed`,
    [accountId, jakartaToday()],
  );
  if (!capability.rows[0]?.allowed) {
    throw new EmployeeLeaveError(
      403,
      "APPROVAL_FORBIDDEN",
      "Capability governance approval tidak tersedia.",
    );
  }
}

export interface LeaveReplacementLink {
  replacesRequestId: string;
  postponementProposalId: string;
}

/**
 * Validates and stores one Cuti Tahunan request with its approval snapshot (APR-001), critical
 * review (LEAVE-009), audit event and first-approver notification. Shared by the submit route
 * and by LEAVE-008 acceptance, which passes the original request as `replacement`.
 * The caller owns the transaction and has locked the employee row.
 */
export async function insertAnnualRequest(
  client: PoolClient,
  input: {
    employee: EmployeeContextRow;
    actorAccountId: string;
    startOn: string;
    endOn: string;
    reason: string | null;
    idempotencyKey: string;
    noticeReferenceOn: string;
    replacement?: LeaveReplacementLink | null;
  },
) {
  const replacement = input.replacement ?? null;
  const preview = await buildAnnualPreview(
    client,
    input.employee,
    { startOn: input.startOn, endOn: input.endOn },
    input.noticeReferenceOn,
  );
  const requestId = randomUUID();
  const annualPolicy = getLeavePolicy("annual");
  await client.query(
    `INSERT INTO leave_requests (
      id, employee_id, policy_key, status, start_on, end_on, working_days,
      reason, annual_period_key, annual_entitlement_days,
      annual_period_limit_days, annual_available_before, hc_handling,
      idempotency_key, validation_summary, replaces_request_id
    ) VALUES (
      $1, $2, 'annual', 'in_review', $3::date, $4::date, $5,
      $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14
    )`,
    [
      requestId,
      input.employee.id,
      input.startOn,
      input.endOn,
      preview.validation.requestedWorkingDays,
      input.reason,
      preview.validation.periodKey,
      preview.validation.annualEntitlementDays,
      preview.validation.periodLimitDays,
      preview.validation.availableDaysBeforeRequest,
      annualPolicy.hcHandling,
      input.idempotencyKey,
      JSON.stringify({
        approvalSnapshot: preview.approvalChain.map((step) => ({
          principalType: step.principalType ?? "EMPLOYEE",
          employeeId: step.employeeId,
          accountId: step.accountId ?? null,
          sources: step.sources,
        })),
        authorityResolution: preview.authorityResolution,
        ...(preview.criticalPeriods.length > 0 ? { criticalPeriods: preview.criticalPeriods } : {}),
        ...(replacement
          ? {
            noticeReferenceOn: input.noticeReferenceOn,
            replacesRequestId: replacement.replacesRequestId,
            postponementProposalId: replacement.postponementProposalId,
          }
          : {}),
      }),
      replacement?.replacesRequestId ?? null,
    ],
  );
  if (preview.criticalPeriods.length > 0) {
    await attachCriticalReview(client, {
      requestId,
      actorAccountId: input.actorAccountId,
      periods: preview.criticalPeriods,
    });
  }

  const insertedSteps: Array<{ id: string; employeeId: string | null; accountId: string | null; name: string }> = [];
  for (const [index, step] of preview.approvalChain.entries()) {
    const stepId = randomUUID();
    await client.query(
      `INSERT INTO leave_request_approval_steps (
        id, leave_request_id, step_order, approver_employee_id, approver_account_id, sources, status
      ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7)`,
      [
        stepId,
        requestId,
        index + 1,
        step.employeeId,
        step.accountId ?? null,
        step.sources,
        index === 0 ? "pending" : "waiting",
      ],
    );
    insertedSteps.push({
      id: stepId,
      employeeId: step.employeeId,
      accountId: step.accountId ?? null,
      name: step.name,
    });
  }

  await addEvent(client, requestId, input.actorAccountId, "leave.request.submitted", {
    policyKey: "annual",
    workingDays: preview.validation.requestedWorkingDays,
    periodKey: preview.validation.periodKey,
    authorityResolution: preview.authorityResolution,
    ...(replacement ? { ...replacement } : {}),
  });
  const firstStep = insertedSteps[0];
  if (firstStep) {
    await enqueueNotification(
      client,
      requestId,
      "leave.approval.requested",
      firstStep.accountId ? "account" : "employee",
      firstStep.accountId ?? firstStep.employeeId!,
    );
    await notifyApprovalRequested(client, {
      requestId,
      stepId: firstStep.id,
      approverEmployeeId: firstStep.employeeId,
      approverAccountId: firstStep.accountId,
    });
  }
  return { requestId, preview, insertedSteps };
}

function mapKnownError(error: unknown): EmployeeLeaveError | null {
  if (error instanceof EmployeeLeaveError) return error;
  if (error instanceof AnnualLeaveRequestPolicyError) {
    return new EmployeeLeaveError(409, error.code, error.message);
  }
  if (error instanceof LeaveApprovalConfigurationError) {
    return new EmployeeLeaveError(409, error.code, error.message);
  }
  if (error instanceof LeaveOrganizationAuthorityError) {
    return new EmployeeLeaveError(409, error.code, error.message);
  }
  if (error instanceof WorkingCalendarError) {
    return new EmployeeLeaveError(409, error.code, error.message);
  }
  if (error instanceof LeaveWorkflowError) {
    return new EmployeeLeaveError(409, error.code, error.message);
  }
  return null;
}

async function sendKnownError(reply: FastifyReply, error: unknown) {
  const known = mapKnownError(error);
  if (!known) throw error;
  return reply.status(known.statusCode).send({ code: known.code, message: known.message });
}

export async function registerEmployeeLeaveRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) {
    throw new Error("AUTH_ENCRYPTION_KEY is required for employee leave routes");
  }

  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
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

  async function authenticateApprovalPrincipal(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthPrincipal | null> {
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
  app.get("/leave/me/summary", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;

    try {
      const employee = await loadEmployeeContext(pool, principal.id);
      const referenceDate = jakartaToday();
      const usedDaysByPeriod = await loadAnnualUsage(pool, employee.id, yearOf(referenceDate));
      const annualLeave =
        employee.startedOn && employee.leaveEntitlementGroup === "non_education"
          ? calculateAnnualLeaveYearView({
              employmentStartedOn: employee.startedOn,
              referenceDate,
              usedDaysByPeriod,
            })
          : null;
      const [requests, approvals] = await Promise.all([
        pool.query<RequestSummaryRow>(
          `SELECT
            r.id,
            r.policy_key AS "policyKey",
            r.status,
            r.start_on::text AS "startOn",
            r.end_on::text AS "endOn",
            r.working_days AS "workingDays",
            r.reason,
            r.annual_period_key AS "annualPeriodKey",
            r.submitted_at AS "submittedAt",
            r.final_decided_at AS "finalDecidedAt",
            CASE
              WHEN approver.id IS NOT NULL THEN approver.full_name
              WHEN current_step.approver_account_id IS NOT NULL
                AND current_step.sources @> ARRAY['GOVERNANCE_APPROVER']::text[]
                THEN 'Penyetuju Pengurus Yayasan'
              ELSE NULL
            END AS "currentApproverName",
            critical_review.status AS "criticalReviewStatus",
            (r.status = 'in_review' AND r.line_handling = 'approval') AS "canCancel",
            ${postponementColumns("r")}
          FROM leave_requests r
          LEFT JOIN leave_request_approval_steps current_step
            ON current_step.leave_request_id = r.id AND current_step.status = 'pending'
          LEFT JOIN employees approver ON approver.id = current_step.approver_employee_id
          LEFT JOIN leave_request_critical_reviews critical_review ON critical_review.leave_request_id = r.id
          ${postponementJoin("r")}
          WHERE r.employee_id = $1
          ORDER BY r.submitted_at DESC
          LIMIT 10`,
          [employee.id],
        ),
        pool.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM leave_request_approval_steps
           WHERE approver_employee_id = $1 AND status = 'pending'`,
          [employee.id],
        ),
      ]);

      reply.header("Cache-Control", "no-store");
      return reply.send({
        referenceDate,
        employee: {
          id: employee.id,
          employeeNumber: employee.employeeNumber,
          fullName: employee.fullName,
          unitName: employee.unitName,
          positionName: employee.positionName,
          leaveEntitlementGroup: employee.leaveEntitlementGroup,
          startedOn: employee.startedOn,
        },
        annualPolicy: getLeavePolicy("annual"),
        annualLeave,
        pendingApprovalCount: approvals.rows[0]?.count ?? 0,
        requests: requests.rows.map((item) => ({
          ...item,
          submittedAt: item.submittedAt.toISOString(),
          finalDecidedAt: item.finalDecidedAt?.toISOString() ?? null,
        })),
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/leave/me/annual/preview", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const parsed = annualRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_ANNUAL_LEAVE_REQUEST",
        message: "Tanggal atau alasan cuti tidak valid.",
      });
    }

    try {
      const employee = await loadEmployeeContext(pool, principal.id);
      const preview = await buildAnnualPreview(pool, employee, parsed.data, jakartaToday());
      reply.header("Cache-Control", "no-store");
      return reply.send({
        annualEntitlementDays: preview.validation.annualEntitlementDays,
        periodKey: preview.validation.periodKey,
        periodLimitDays: preview.validation.periodLimitDays,
        availableDaysBeforeRequest: preview.validation.availableDaysBeforeRequest,
        requestedWorkingDays: preview.validation.requestedWorkingDays,
        availableDaysAfterRequest: preview.validation.availableDaysAfterRequest,
        minimumNoticeDays: preview.validation.minimumNoticeDays,
        noticeDays: preview.validation.noticeDays,
        workingDates: preview.calculation.workingDates,
        nonWorkingDates: preview.calculation.nonWorkingDates,
        approvalChain: preview.approvalChain,
        authorityResolution: preview.authorityResolution,
        criticalPeriods: preview.criticalPeriods,
        criticalReviewRequired: preview.criticalPeriods.length > 0,
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/leave/me/annual/submit", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const parsed = annualSubmitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        code: "INVALID_ANNUAL_LEAVE_REQUEST",
        message: "Data pengajuan Cuti Tahunan tidak valid.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const employee = await loadEmployeeContext(client, principal.id, true);
      const existing = await client.query<{ id: string; status: LeaveRequestStatus }>(
        `SELECT id, status
         FROM leave_requests
         WHERE employee_id = $1 AND idempotency_key = $2`,
        [employee.id, parsed.data.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return reply.send({
          id: existing.rows[0].id,
          status: existing.rows[0].status,
          idempotentReplay: true,
        });
      }

      const { requestId, preview, insertedSteps } = await insertAnnualRequest(client, {
        employee,
        actorAccountId: principal.id,
        startOn: parsed.data.startOn,
        endOn: parsed.data.endOn,
        reason: parsed.data.reason ?? null,
        idempotencyKey: parsed.data.idempotencyKey,
        noticeReferenceOn: jakartaToday(),
      });

      await client.query("COMMIT");
      return reply.status(201).send({
        id: requestId,
        status: "in_review",
        workingDays: preview.validation.requestedWorkingDays,
        periodKey: preview.validation.periodKey,
        annualEntitlementDays: preview.validation.annualEntitlementDays,
        approvalChain: insertedSteps,
        criticalReviewRequired: preview.criticalPeriods.length > 0,
        idempotentReplay: false,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/leave/me/requests", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    try {
      const employee = await loadEmployeeContext(pool, principal.id);
      const requests = await pool.query<RequestSummaryRow>(
        `SELECT
          r.id,
          r.policy_key AS "policyKey",
          r.status,
          r.start_on::text AS "startOn",
          r.end_on::text AS "endOn",
          r.working_days AS "workingDays",
          r.reason,
          r.annual_period_key AS "annualPeriodKey",
          r.submitted_at AS "submittedAt",
          r.final_decided_at AS "finalDecidedAt",
          approver.full_name AS "currentApproverName",
          critical_review.status AS "criticalReviewStatus",
          (r.status = 'in_review' AND r.line_handling = 'approval') AS "canCancel",
          ${postponementColumns("r")}
        FROM leave_requests r
        LEFT JOIN leave_request_approval_steps current_step
          ON current_step.leave_request_id = r.id AND current_step.status = 'pending'
        LEFT JOIN employees approver ON approver.id = current_step.approver_employee_id
        LEFT JOIN leave_request_critical_reviews critical_review ON critical_review.leave_request_id = r.id
        ${postponementJoin("r")}
        WHERE r.employee_id = $1
        ORDER BY r.submitted_at DESC`,
        [employee.id],
      );
      reply.header("Cache-Control", "no-store");
      return reply.send({
        requests: requests.rows.map((item) => ({
          ...item,
          submittedAt: item.submittedAt.toISOString(),
          finalDecidedAt: item.finalDecidedAt?.toISOString() ?? null,
        })),
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  // LEAVE-010: the requester withdraws line-approval leave that still awaits a decision.
  // Decisions lock their step/task/review together with the request; this route locks the
  // request and then those rows, so it takes every lock NOWAIT and never waits while holding
  // one. A cancel that meets a decision in flight answers 409 LEAVE_REQUEST_BUSY instead of
  // risking a deadlock; the decision goes through, and a retry then sees the new state.
  app.post("/leave/me/requests/:id/cancel", async (request, reply) => {
    const principal = await authenticateEmployee(request, reply);
    if (!principal) return;
    const params = requestParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(404).send({ code: "LEAVE_REQUEST_NOT_FOUND", message: "Pengajuan cuti tidak ditemukan." });
    }
    const body = cancelSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({
        code: "INVALID_LEAVE_CANCELLATION",
        message: "Alasan pembatalan paling panjang 500 karakter.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const employee = await loadEmployeeContext(client, principal.id);
      const found = await client.query<{ status: LeaveRequestStatus; lineHandling: LeaveLineHandling; policyKey: string }>(
        `SELECT status, line_handling AS "lineHandling", policy_key AS "policyKey"
           FROM leave_requests
          WHERE id = $1 AND employee_id = $2
          FOR UPDATE NOWAIT`,
        [params.data.id, employee.id],
      );
      const leave = found.rows[0];
      if (!leave) {
        throw new EmployeeLeaveError(404, "LEAVE_REQUEST_NOT_FOUND", "Pengajuan cuti tidak ditemukan.");
      }
      assertLeaveRequestCancellable(leave);

      const steps = await client.query<{ status: string; approverEmployeeId: string | null; approverAccountId: string | null }>(
        `SELECT status, approver_employee_id AS "approverEmployeeId", approver_account_id AS "approverAccountId"
           FROM leave_request_approval_steps
          WHERE leave_request_id = $1
          FOR UPDATE NOWAIT`,
        [params.data.id],
      );
      const hcTask = await client.query<{ status: string }>(
        `SELECT status FROM leave_request_hc_tasks WHERE leave_request_id = $1 FOR UPDATE NOWAIT`,
        [params.data.id],
      );
      const review = await client.query<{ status: string }>(
        `SELECT status FROM leave_request_critical_reviews WHERE leave_request_id = $1 FOR UPDATE NOWAIT`,
        [params.data.id],
      );

      await client.query(
        `UPDATE leave_request_approval_steps SET status = 'cancelled'
          WHERE leave_request_id = $1 AND status IN ('waiting', 'pending')`,
        [params.data.id],
      );
      await client.query(
        `UPDATE leave_request_hc_tasks SET status = 'cancelled', updated_at = now()
          WHERE leave_request_id = $1 AND status IN ('waiting', 'pending', 'needs_correction')`,
        [params.data.id],
      );
      await client.query(
        `UPDATE leave_request_critical_reviews SET status = 'cancelled', updated_at = now()
          WHERE leave_request_id = $1 AND status IN ('waiting', 'pending')`,
        [params.data.id],
      );
      await client.query(
        `UPDATE leave_requests SET status = 'cancelled', updated_at = now() WHERE id = $1`,
        [params.data.id],
      );

      const pending = steps.rows.find((step) => step.status === "pending");
      const approver = pending
        ? { approverEmployeeId: pending.approverEmployeeId, approverAccountId: pending.approverAccountId }
        : undefined;
      const stage = approver
        ? "line"
        : review.rows[0]?.status === "pending"
          ? "critical_review"
          : "hc";
      await addEvent(client, params.data.id, principal.id, "leave.request.cancelled", {
        policyKey: leave.policyKey,
        stage,
        ...(body.data.reason ? { reason: body.data.reason } : {}),
      });
      if (approver) {
        await enqueueNotification(
          client,
          params.data.id,
          "leave.request.cancelled",
          approver.approverAccountId ? "account" : "employee",
          approver.approverAccountId ?? approver.approverEmployeeId!,
        );
        await notifyApprovalCancelled(client, { requestId: params.data.id, ...approver });
      } else if (hcTask.rows.some((row) => row.status === "pending" || row.status === "needs_correction") || stage === "critical_review") {
        await enqueueNotification(client, params.data.id, "leave.request.cancelled", "role", "human_capital");
      }

      await client.query("COMMIT");
      reply.header("Cache-Control", "no-store");
      return reply.send({ id: params.data.id, status: "cancelled" });
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: unknown }).code === "55P03") {
        return reply.status(409).send({
          code: "LEAVE_REQUEST_BUSY",
          message: "Pengajuan ini sedang diproses penyetuju. Muat ulang halaman, lalu coba lagi bila masih perlu dibatalkan.",
        });
      }
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });

  app.get("/leave/approvals", async (request, reply) => {
    const principal = await authenticateApprovalPrincipal(request, reply);
    if (!principal) return;
    try {
      const employee = principal.principalType === "EMPLOYEE"
        ? await loadEmployeeContext(pool, principal.id)
        : null;
      if (!employee) await assertGovernanceApprovalCapability(pool, principal.id);
      const result = await pool.query<InboxRow>(
        `SELECT
          s.id AS "stepId",
          r.id AS "requestId",
          requester.id AS "requesterEmployeeId",
          requester.full_name AS "requesterName",
          r.policy_key AS "policyKey",
          r.start_on::text AS "startOn",
          r.end_on::text AS "endOn",
          r.working_days AS "workingDays",
          r.reason,
          r.submitted_at AS "submittedAt",
          s.sources
        FROM leave_request_approval_steps s
        JOIN leave_requests r ON r.id = s.leave_request_id
        JOIN employees requester ON requester.id = r.employee_id
        WHERE (s.approver_employee_id = $1 OR s.approver_account_id = $2)
          AND s.status = 'pending'
          AND r.status = 'in_review'
        ORDER BY r.submitted_at ASC`,
        [
          employee?.id ?? null,
          principal.principalType === "FOUNDATION_BOARD" ? principal.id : null,
        ],
      );
      reply.header("Cache-Control", "no-store");
      return reply.send({
        items: result.rows.map((item) => ({
          ...item,
          submittedAt: item.submittedAt.toISOString(),
        })),
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/leave/approvals/:stepId/decision", async (request, reply) => {
    const principal = await authenticateApprovalPrincipal(request, reply);
    if (!principal) return;
    const params = stepParamSchema.safeParse(request.params);
    const body = decisionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        code: "INVALID_APPROVAL_DECISION",
        message: "Keputusan approval tidak valid.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const actor = principal.principalType === "EMPLOYEE"
        ? await loadEmployeeContext(client, principal.id)
        : null;
      const stepResult = await client.query<{
        id: string;
        requestId: string;
        requesterEmployeeId: string;
        approverEmployeeId: string | null;
        approverAccountId: string | null;
        status: LeaveApprovalStepState["status"];
        requestStatus: LeaveRequestStatus;
        hcHandling: HcHandling;
        policyKey: string;
      }>(
        `SELECT
          s.id,
          s.leave_request_id AS "requestId",
          r.employee_id AS "requesterEmployeeId",
          s.approver_employee_id AS "approverEmployeeId",
          s.approver_account_id AS "approverAccountId",
          s.status,
          r.status AS "requestStatus",
          r.hc_handling AS "hcHandling",
          r.policy_key AS "policyKey"
        FROM leave_request_approval_steps s
        JOIN leave_requests r ON r.id = s.leave_request_id
        WHERE s.id = $1
        FOR UPDATE OF s, r`,
        [params.data.stepId],
      );
      const current = stepResult.rows[0];
      if (!current) {
        throw new EmployeeLeaveError(404, "APPROVAL_STEP_NOT_FOUND", "Tahap approval tidak ditemukan.");
      }
      const ownsStep = actor
        ? current.approverEmployeeId === actor.id
        : current.approverAccountId === principal.id;
      if (!ownsStep) {
        throw new EmployeeLeaveError(
          403,
          "APPROVAL_FORBIDDEN",
          "Tahap approval ini bukan milik akun Anda.",
        );
      }
      if (!actor) {
        await assertGovernanceApprovalCapability(client, principal.id);
        if (await governanceActorIsRequester(client, principal.id, current.requesterEmployeeId)) {
          throw new EmployeeLeaveError(
            403,
            "APPROVAL_SELF_FORBIDDEN",
            "Pengajuan ini tidak dapat diputuskan oleh pemohon sendiri.",
          );
        }
      }

      const allStepsResult = await client.query<LeaveApprovalStepState>(
        `SELECT id, step_order AS "order", status
         FROM leave_request_approval_steps
         WHERE leave_request_id = $1
         ORDER BY step_order ASC`,
        [current.requestId],
      );
      const steps: LeaveApprovalStepState[] = allStepsResult.rows;
      const decision = decideLeaveApprovalStep({
        requestStatus: current.requestStatus,
        stepId: current.id,
        decision: body.data.decision,
        steps,
      });

      await client.query(
        `UPDATE leave_request_approval_steps
         SET status = $2,
             acted_by_account_id = $3,
             acted_at = now(),
             decision_note = $4
         WHERE id = $1`,
        [current.id, decision.decidedStepStatus, principal.id, body.data.note ?? null],
      );

      if (decision.nextPendingStepId) {
        const next = await client.query<{ approverEmployeeId: string | null; approverAccountId: string | null }>(
          `UPDATE leave_request_approval_steps
           SET status = 'pending'
           WHERE id = $1
           RETURNING approver_employee_id AS "approverEmployeeId", approver_account_id AS "approverAccountId"`,
          [decision.nextPendingStepId],
        );
        const target = next.rows[0];
        if (target) {
          await enqueueNotification(
            client,
            current.requestId,
            "leave.approval.requested",
            target.approverAccountId ? "account" : "employee",
            target.approverAccountId ?? target.approverEmployeeId!,
          );
          await notifyApprovalRequested(client, {
            requestId: current.requestId,
            stepId: decision.nextPendingStepId,
            approverEmployeeId: target.approverEmployeeId,
            approverAccountId: target.approverAccountId,
          });
        }
      }

      let effectiveRequestStatus: LeaveRequestStatus = decision.requestStatus;
      let hcTaskStatus: "pending" | null = null;
      // LEAVE-009 D-05: a critical-period review runs before any HC administrative task.
      const criticalReviewId = decision.requestStatus === "approved"
        ? await activateCriticalReviewAfterLineApproval(client, current.requestId)
        : null;
      if (criticalReviewId) {
        effectiveRequestStatus = "in_review";
      } else if (decision.requestStatus === "approved" && current.hcHandling === "validate") {
        await activateHcTaskAfterLineApproval(client, current.requestId, "validate");
        effectiveRequestStatus = "in_review";
        hcTaskStatus = "pending";
      } else if (decision.requestStatus === "approved" && current.hcHandling === "approve") {
        await activateHcTaskAfterLineApproval(client, current.requestId, "approve");
        effectiveRequestStatus = "in_review";
        hcTaskStatus = "pending";
      }

      if (effectiveRequestStatus !== current.requestStatus || decision.requestStatus === "approved") {
        await client.query(
          `UPDATE leave_requests
           SET status = $2,
               final_decided_at = CASE WHEN $2 IN ('approved', 'rejected') THEN now() ELSE NULL END,
               updated_at = now()
           WHERE id = $1`,
          [current.requestId, effectiveRequestStatus],
        );
      }

      const eventType =
        body.data.decision === "approve"
          ? "leave.request.approved_step"
          : "leave.request.rejected";
      await addEvent(client, current.requestId, principal.id, eventType, {
        stepId: current.id,
        hcHandling: current.hcHandling,
      });

      if (criticalReviewId) {
        await addEvent(client, current.requestId, principal.id, "leave.critical_review.pending", {
          reviewId: criticalReviewId,
        });
        await enqueueNotification(
          client,
          current.requestId,
          "leave.critical_review.requested",
          "role",
          "human_capital",
        );
        await enqueueNotification(
          client,
          current.requestId,
          "leave.line_approval.completed.employee_notify",
          "employee",
          current.requesterEmployeeId,
        );
      } else if (decision.requestStatus === "approved" && hcTaskStatus === "pending") {
        await addEvent(
          client,
          current.requestId,
          principal.id,
          current.hcHandling === "approve"
            ? "leave.hc.approval_pending"
            : "leave.hc.validation_pending",
        );
        await enqueueNotification(
          client,
          current.requestId,
          current.hcHandling === "approve"
            ? "leave.hc.approval.requested"
            : "leave.hc.validation.requested",
          "role",
          "human_capital",
        );
        await enqueueNotification(
          client,
          current.requestId,
          "leave.line_approval.completed.employee_notify",
          "employee",
          current.requesterEmployeeId,
        );
      } else if (effectiveRequestStatus === "approved") {
        await enqueueNotification(
          client,
          current.requestId,
          "leave.request.approved",
          "employee",
          current.requesterEmployeeId,
        );
        if (current.hcHandling === "notify") {
          await enqueueNotification(
            client,
            current.requestId,
            "leave.request.approved.hc_notify",
            "role",
            "human_capital",
          );
        }
      } else if (effectiveRequestStatus === "rejected") {
        await enqueueNotification(
          client,
          current.requestId,
          "leave.request.rejected",
          "employee",
          current.requesterEmployeeId,
        );
      }

      if (effectiveRequestStatus === "approved") {
        await enqueueFinalApprovalOversight(client, {
          requestId: current.requestId,
          workflowKey: `leave.${current.policyKey}`,
          effectiveDate: jakartaToday(),
          ...(current.approverEmployeeId
            ? { finalApproverEmployeeId: current.approverEmployeeId }
            : {}),
        });
      }

      await client.query("COMMIT");
      return reply.send({
        requestId: current.requestId,
        requestStatus: effectiveRequestStatus,
        stepStatus: decision.decidedStepStatus,
        nextPendingStepId: decision.nextPendingStepId,
        hcHandling: current.hcHandling,
        hcTaskStatus,
        criticalReviewStatus: criticalReviewId ? "pending" : null,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      return sendKnownError(reply, error);
    } finally {
      client.release();
    }
  });
}
