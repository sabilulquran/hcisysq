// TRIP-001 Package 1 routes: employee request, APR-001 approval, HC assignment letter.
// Spec: docs/domain/business-travel.md.
//
// trips.* is HC-only: legacy Super Admin compatibility never grants it, so the admin routes
// resolve the permission from the organization context directly, like documents.*.
// Employee and approver access is ownership (the session's employee, the snapshotted step),
// never a permission.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { TripPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import {
  buildContentSnapshot,
  DocumentError,
  issueDocument,
  jakartaDate,
  loadEmployeeFacts,
  writeDocumentAudit,
} from "../documents/service.js";
import { LeaveApprovalConfigurationError } from "../leave/domain/approval-chain.js";
import {
  decideLeaveApprovalStep,
  LeaveWorkflowError,
  type LeaveApprovalStepState,
} from "../leave/domain/request-workflow.js";
import { LeaveOrganizationAuthorityError, resolveLeaveAuthorities } from "../leave/organization-authority.js";
import { notifyEmployee } from "../notifications/service.js";
import {
  approvalRequestStatus,
  canCancelTrip,
  canCompleteTrip,
  OCCUPYING_TRIP_STATUSES,
  TRIP_STATUSES,
  TripPolicyError,
  validateTripDates,
  type TripCanceller,
  type TripStatus,
} from "./domain.js";

type Queryable = Pool | PoolClient;

/** D-01 DRAFT: ORG-004 rollout key; without a rollout row the mode is LEGACY. */
const TRIP_WORKFLOW_KEY = "TRIP";
/** D-06 DRAFT: register code for the surat tugas, `001/ST/YSQ/XI/2026`. */
const ASSIGNMENT_NUMBER_CODE = "ST";
const ASSIGNMENT_DOCUMENT_CODE = "SURAT_TUGAS";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const datesBody = z.object({ startOn: isoDate, endOn: isoDate });
const submitBody = datesBody.extend({
  destination: z.string().trim().min(3).max(200),
  purpose: z.string().trim().min(10).max(1000),
  idempotencyKey: z.string().uuid(),
});
const idParams = z.object({ id: z.string().uuid() });
const stepParams = z.object({ stepId: z.string().uuid() });
const decisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), note: z.string().trim().max(1000).nullable().optional() }),
  z.object({ decision: z.literal("reject"), note: z.string().trim().min(5).max(1000) }),
]);
const employeeCancelBody = z.object({ reason: z.string().trim().min(5).max(500) });
const hcCancelBody = z.object({ reason: z.string().trim().min(10).max(500) });
const completeBody = z.object({ report: z.string().trim().min(10).max(2000) });
const listQuery = pageQuerySchema.extend({ status: z.enum(TRIP_STATUSES).optional() });
const adminListQuery = listQuery.extend({ employeeId: z.string().uuid().optional() });

class TripError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "TripError";
  }
}

interface EmployeeContext {
  id: string;
  fullName: string;
  directManagerEmployeeId: string | null;
  unitApproverEmployeeId: string | null;
}

interface ChainStep {
  employeeId: string;
  name: string;
  sources: string[];
}

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function today(): string {
  return jakartaDate(new Date());
}

function knownError(error: unknown): TripError | null {
  if (error instanceof TripError) return error;
  if (error instanceof DocumentError) return new TripError(error.statusCode, error.code, error.message);
  if (error instanceof TripPolicyError
    || error instanceof LeaveApprovalConfigurationError
    || error instanceof LeaveOrganizationAuthorityError
    || error instanceof LeaveWorkflowError) {
    return new TripError(409, error.code, error.message);
  }
  return null;
}

async function loadEmployeeContext(db: Queryable, accountId: string, lock = false): Promise<EmployeeContext> {
  const result = await db.query<EmployeeContext & { status: string }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status,
            employee.direct_manager_employee_id AS "directManagerEmployeeId",
            unit.leave_approver_employee_id AS "unitApproverEmployeeId"
       FROM accounts account
       JOIN employees employee ON employee.id = account.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
      WHERE account.id = $1
        AND account.principal_type = 'EMPLOYEE'
        AND account.status = 'active'
        AND employee.removed_at IS NULL
      ${lock ? "FOR UPDATE OF employee" : ""}`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new TripError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return employee;
}

/**
 * APR-001 at submission (D-01): the shared Leave resolver turns DIRECT_MANAGER and
 * UNIT_APPROVER into concrete employees, drops the requester and merges duplicates; every
 * approver must then be an active employee with an active account, or nothing is stored.
 */
async function resolveApprovalChain(db: Queryable, employee: EmployeeContext, effectiveDate: string) {
  const resolution = await resolveLeaveAuthorities(db, {
    workflowKey: TRIP_WORKFLOW_KEY,
    requesterEmployeeId: employee.id,
    effectiveDate,
    legacy: {
      directManagerEmployeeId: employee.directManagerEmployeeId,
      unitApproverEmployeeId: employee.unitApproverEmployeeId,
    },
    policyChain: "LINE_AND_UNIT",
  });
  const ids = resolution.approvalChain.map((step) => step.employeeId);
  if (ids.some((id) => !id)) {
    throw new TripError(409, "APPROVAL_CHAIN_EMPTY", "Rantai approval perjalanan dinas hanya dapat berisi pegawai.");
  }
  const actors = await db.query<{ id: string; fullName: string; status: string; accountStatus: string | null }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status, account.status AS "accountStatus"
       FROM employees employee
       LEFT JOIN accounts account ON account.employee_id = employee.id AND account.principal_type = 'EMPLOYEE'
      WHERE employee.id = ANY($1::uuid[]) AND employee.removed_at IS NULL`,
    [ids],
  );
  const byId = new Map(actors.rows.map((row) => [row.id, row]));
  const chain: ChainStep[] = resolution.approvalChain.map((step) => {
    const actor = byId.get(step.employeeId!);
    if (!actor || actor.status !== "active") {
      throw new TripError(409, "APPROVER_NOT_ACTIVE", "Rantai approval berisi approver yang tidak aktif.");
    }
    if (actor.accountStatus !== "active") {
      throw new TripError(409, "APPROVER_ACCOUNT_NOT_READY", `Akun approver ${actor.fullName} belum aktif.`);
    }
    return { employeeId: actor.id, name: actor.fullName, sources: step.sources };
  });
  return { chain, context: resolution.context };
}

/** D-05: one employee, one place at a time — no overlap with another trip, with leave, or with ATT-015. */
async function assertNoOverlap(db: Queryable, employeeId: string, startOn: string, endOn: string) {
  const trips = await db.query(
    `SELECT 1 FROM business_trip_requests
      WHERE employee_id = $1 AND status = ANY($4::text[])
        AND start_on <= $3::date AND end_on >= $2::date
      LIMIT 1`,
    [employeeId, startOn, endOn, [...OCCUPYING_TRIP_STATUSES]],
  );
  if (trips.rows[0]) {
    throw new TripError(409, "TRIP_OVERLAP", "Tanggal ini beririsan dengan perjalanan dinas Anda yang lain.");
  }
  const leave = await db.query(
    `SELECT 1 FROM leave_requests
      WHERE employee_id = $1 AND status IN ('in_review', 'approved')
        AND start_on <= $3::date AND end_on >= $2::date
      LIMIT 1`,
    [employeeId, startOn, endOn],
  );
  if (leave.rows[0]) {
    throw new TripError(409, "TRIP_LEAVE_OVERLAP", "Tanggal ini beririsan dengan cuti yang sedang diajukan atau sudah disetujui.");
  }
  // ATT-015 D-08: a tugas luar or WFH/WFA that is pending or approved also occupies the dates.
  const arrangement = await db.query(
    `SELECT 1 FROM attendance_work_arrangement_requests
      WHERE employee_id = $1 AND status IN ('IN_REVIEW', 'APPROVED')
        AND arrangement_type IN ('FIELD_ASSIGNMENT', 'REMOTE_WORK')
        AND start_on <= $3::date AND end_on >= $2::date
      LIMIT 1`,
    [employeeId, startOn, endOn],
  );
  if (arrangement.rows[0]) {
    throw new TripError(409, "TRIP_ARRANGEMENT_OVERLAP", "Tanggal ini beririsan dengan tugas luar atau WFH/WFA Anda.");
  }
}

async function addEvent(
  db: PoolClient,
  requestId: string,
  actorAccountId: string | null,
  eventType: string,
  note: string | null = null,
  metadata: Record<string, unknown> = {},
) {
  // clock_timestamp(), not now(): two events written in one transaction (approved_step then
  // request.approved, cancelled then revoked) must keep their order in the history.
  await db.query(
    `INSERT INTO business_trip_events (id, request_id, event_type, actor_account_id, note, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [randomUUID(), requestId, eventType, actorAccountId, note, JSON.stringify(metadata)],
  );
}

const SUMMARY_COLUMNS = `
  trip.id, trip.destination, trip.purpose, trip.status,
  to_char(trip.start_on, 'YYYY-MM-DD') AS "startOn", to_char(trip.end_on, 'YYYY-MM-DD') AS "endOn",
  trip.submitted_at AS "submittedAt", trip.final_decided_at AS "finalDecidedAt",
  document.document_number AS "documentNumber",
  approver.full_name AS "currentApproverName"`;
const SUMMARY_JOINS = `
  LEFT JOIN hr_issued_documents document ON document.id = trip.issued_document_id
  LEFT JOIN business_trip_approval_steps current_step
    ON current_step.request_id = trip.id AND current_step.status = 'pending'
  LEFT JOIN employees approver ON approver.id = current_step.approver_employee_id`;

async function loadTripDetail(db: Queryable, id: string, ownerEmployeeId: string | null) {
  const trip = await db.query(
    `SELECT ${SUMMARY_COLUMNS},
            trip.employee_id AS "employeeId", employee.full_name AS "employeeName",
            employee.employee_number AS "employeeNumber", unit.name AS "unitName",
            trip.cancel_reason AS "cancelReason", trip.completion_report AS "completionReport",
            trip.completed_at AS "completedAt",
            document.id AS "documentId", document.status AS "documentStatus",
            document.issued_at AS "documentIssuedAt", document.signer AS "documentSigner",
            document.content_snapshot AS "documentContent"
       FROM business_trip_requests trip
       JOIN employees employee ON employee.id = trip.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       ${SUMMARY_JOINS}
      WHERE trip.id = $1 AND ($2::uuid IS NULL OR trip.employee_id = $2)`,
    [id, ownerEmployeeId],
  );
  const row = trip.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const [steps, events] = await Promise.all([
    db.query(
      `SELECT step.id, step.step_order AS "order", step.status, step.sources,
              approver.full_name AS "approverName", step.acted_at AS "actedAt",
              step.decision_note AS "decisionNote"
         FROM business_trip_approval_steps step
         JOIN employees approver ON approver.id = step.approver_employee_id
        WHERE step.request_id = $1
        ORDER BY step.step_order ASC`,
      [id],
    ),
    db.query(
      `SELECT event.id, event.event_type AS "eventType", event.occurred_at AS "occurredAt",
              event.note, event.metadata, actor.full_name AS "actorName"
         FROM business_trip_events event
         LEFT JOIN accounts account ON account.id = event.actor_account_id
         LEFT JOIN employees actor ON actor.id = account.employee_id
        WHERE event.request_id = $1
        ORDER BY event.occurred_at ASC, event.id ASC`,
      [id],
    ),
  ]);
  const { documentId, documentStatus, documentIssuedAt, documentSigner, documentContent, ...trip_ } = row;
  return {
    ...trip_,
    assignmentLetter: documentId
      ? {
          id: documentId,
          documentNumber: row.documentNumber,
          status: documentStatus,
          issuedAt: documentIssuedAt,
          signer: documentSigner,
          content: documentContent,
        }
      : null,
    steps: steps.rows,
    events: events.rows,
  };
}

export async function registerTripRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for trip routes");
  const auth = injectedAuth ?? new AuthService(
    pool, config.AUTH_ENCRYPTION_KEY, config.AUTH_SESSION_TTL_HOURS, config.NODE_ENV === "production",
  );

  async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const session = await auth.getSession(readCookie(request.headers.cookie, AUTH_COOKIE_NAME));
    if (!session) {
      await send(reply, 401, { code: "UNAUTHENTICATED", message: "Sesi tidak ditemukan atau sudah berakhir." });
      return null;
    }
    return session.principal;
  }

  async function requireEmployee(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Perjalanan dinas hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: TripPermission,
  ): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "TRIP_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return principal;
  }

  async function handle(reply: FastifyReply, work: () => Promise<unknown>) {
    try {
      return await work();
    } catch (error) {
      const known = knownError(error);
      if (!known) throw error;
      return send(reply, known.statusCode, { code: known.code, message: known.message });
    }
  }

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs `work` in one transaction and answers only after COMMIT succeeded. */
  async function transact(reply: FastifyReply, work: (client: PoolClient) => Promise<[number, unknown]>) {
    return handle(reply, async () => {
      const [status, body] = await inTransaction(work);
      return send(reply, status, body);
    });
  }

  /**
   * D-08. Steps that never ran become `cancelled` rather than disappearing, and an issued
   * surat tugas is revoked in the same transaction, keeping its number (DOC-001 D-03).
   */
  async function cancelTrip(
    client: PoolClient,
    input: { id: string; ownerEmployeeId: string | null; by: TripCanceller; actorAccountId: string; reason: string },
  ) {
    const found = await client.query<{
      employeeId: string; status: TripStatus; documentId: string | null; documentNumber: string | null; destination: string;
    }>(
      `SELECT trip.employee_id AS "employeeId", trip.status, trip.issued_document_id AS "documentId",
              document.document_number AS "documentNumber", trip.destination
         FROM business_trip_requests trip
         LEFT JOIN hr_issued_documents document ON document.id = trip.issued_document_id
        WHERE trip.id = $1 AND ($2::uuid IS NULL OR trip.employee_id = $2)
        FOR UPDATE OF trip`,
      [input.id, input.ownerEmployeeId],
    );
    const trip = found.rows[0];
    if (!trip) throw new TripError(404, "TRIP_NOT_FOUND", "Perjalanan dinas tidak ditemukan.");
    if (!canCancelTrip(trip.status, input.by)) {
      throw new TripError(409, "TRIP_NOT_CANCELLABLE", trip.status === "ISSUED"
        ? "Surat tugas sudah terbit. Minta Human Capital membatalkan perjalanan ini."
        : "Perjalanan dinas ini tidak dapat dibatalkan.");
    }
    await client.query(
      `UPDATE business_trip_requests
          SET status = 'CANCELLED', cancelled_by_account_id = $2, cancel_reason = $3, updated_at = now()
        WHERE id = $1`,
      [input.id, input.actorAccountId, input.reason],
    );
    await client.query(
      `UPDATE business_trip_approval_steps SET status = 'cancelled'
        WHERE request_id = $1 AND status IN ('waiting', 'pending')`,
      [input.id],
    );
    await addEvent(client, input.id, input.actorAccountId, "trip.request.cancelled", input.reason, {
      by: input.by, previousStatus: trip.status,
    });
    if (trip.documentId) {
      await client.query(
        `UPDATE hr_issued_documents
            SET status = 'REVOKED', revoked_at = now(), revoked_by_account_id = $2, revoke_reason = $3
          WHERE id = $1 AND status = 'ISSUED'`,
        [trip.documentId, input.actorAccountId, input.reason],
      );
      await addEvent(client, input.id, input.actorAccountId, "trip.assignment.revoked", input.reason, {
        documentId: trip.documentId,
      });
      await writeDocumentAudit(client, {
        eventType: "doc.revoked",
        issuedDocumentId: trip.documentId,
        employeeId: trip.employeeId,
        actorAccountId: input.actorAccountId,
        reason: input.reason,
        metadata: { source: "TRIP-001", tripId: input.id, documentCode: ASSIGNMENT_DOCUMENT_CODE, documentNumber: trip.documentNumber },
      });
    }
    if (input.by === "hc") {
      await notifyEmployee(client, trip.employeeId, {
        eventKey: `trip.${input.id}.cancelled`,
        category: "system",
        title: "Perjalanan dinas dibatalkan",
        body: `Perjalanan dinas ke ${trip.destination} dibatalkan oleh Human Capital.`,
        href: `/app/trips?trip=${input.id}`,
        actorAccountId: input.actorAccountId,
      });
    }
    return { id: input.id, status: "CANCELLED" as const };
  }

  // ---------------------------------------------------------------- employee

  app.get("/trips/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = listQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_TRIP_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<{ total: number }>(
        `SELECT ${SUMMARY_COLUMNS}, count(*) OVER ()::int AS total
           FROM business_trip_requests trip
           ${SUMMARY_JOINS}
          WHERE trip.employee_id = $1 AND ($2::text IS NULL OR trip.status = $2)
          ORDER BY trip.start_on DESC, trip.submitted_at DESC, trip.id DESC
          LIMIT $3 OFFSET $4`,
        [employee.id, query.data.status ?? null, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, ...row }) => { void total; return row; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.get("/trips/me/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ID", message: "Perjalanan dinas tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      // TRIP-001-A: another employee's trip is indistinguishable from a missing one.
      const detail = await loadTripDetail(pool, params.data.id, employee.id);
      if (!detail) return send(reply, 404, { code: "TRIP_NOT_FOUND", message: "Perjalanan dinas tidak ditemukan." });
      return send(reply, 200, detail);
    });
  });

  app.post("/trips/me/preview", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = datesBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_REQUEST", message: "Tanggal perjalanan tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const submittedOn = today();
      const { days } = validateTripDates({ ...body.data, today: submittedOn });
      await assertNoOverlap(pool, employee.id, body.data.startOn, body.data.endOn);
      const { chain } = await resolveApprovalChain(pool, employee, submittedOn);
      return send(reply, 200, { days, approvalChain: chain });
    });
  });

  app.post("/trips/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = submitBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, {
        code: "INVALID_TRIP_REQUEST",
        message: "Tujuan (min. 3 karakter), keperluan (min. 10 karakter), atau tanggal tidak valid.",
      });
    }
    return transact(reply, async (client) => {
      // Locking the employee row serializes this employee's submissions, so two clicks
      // cannot both pass the overlap check (D-05).
      const employee = await loadEmployeeContext(client, principal.id, true);
      const replay = await client.query<{ id: string; status: TripStatus }>(
        `SELECT id, status FROM business_trip_requests WHERE employee_id = $1 AND idempotency_key = $2`,
        [employee.id, body.data.idempotencyKey],
      );
      if (replay.rows[0]) return [200, { ...replay.rows[0], idempotentReplay: true }];

      const submittedOn = today();
      const { days } = validateTripDates({ ...body.data, today: submittedOn });
      await assertNoOverlap(client, employee.id, body.data.startOn, body.data.endOn);
      const { chain, context } = await resolveApprovalChain(client, employee, submittedOn);

      const id = randomUUID();
      await client.query(
        `INSERT INTO business_trip_requests (
           id, employee_id, destination, purpose, start_on, end_on, status, idempotency_key, approval_snapshot
         ) VALUES ($1, $2, $3, $4, $5::date, $6::date, 'IN_REVIEW', $7, $8::jsonb)`,
        [
          id, employee.id, body.data.destination, body.data.purpose, body.data.startOn, body.data.endOn,
          body.data.idempotencyKey,
          JSON.stringify({
            workflowKey: TRIP_WORKFLOW_KEY,
            steps: chain.map((step) => ({ employeeId: step.employeeId, sources: step.sources })),
            authorityResolution: context,
          }),
        ],
      );
      const steps: Array<{ id: string; employeeId: string; name: string }> = [];
      for (const [index, step] of chain.entries()) {
        const stepId = randomUUID();
        await client.query(
          `INSERT INTO business_trip_approval_steps (id, request_id, step_order, approver_employee_id, sources, status)
           VALUES ($1, $2, $3, $4, $5::text[], $6)`,
          [stepId, id, index + 1, step.employeeId, step.sources, index === 0 ? "pending" : "waiting"],
        );
        steps.push({ id: stepId, employeeId: step.employeeId, name: step.name });
      }
      await addEvent(client, id, principal.id, "trip.request.submitted", null, {
        days, approvers: steps.length, mode: context.mode,
      });
      const first = steps[0]!;
      await notifyEmployee(client, first.employeeId, {
        eventKey: `trip.approval.${first.id}`,
        category: "system",
        title: "Persetujuan perjalanan dinas",
        body: `${employee.fullName} mengajukan perjalanan dinas ke ${body.data.destination}.`,
        href: "/app/approvals",
        actorAccountId: principal.id,
      });
      return [201, { id, status: "IN_REVIEW", days, approvalChain: steps, idempotentReplay: false }];
    });
  });

  app.post("/trips/me/:id/cancel", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ID", message: "Perjalanan dinas tidak valid." });
    const body = employeeCancelBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_CANCEL", message: "Alasan pembatalan minimal 5 karakter." });
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id);
      const result = await cancelTrip(client, {
        id: params.data.id, ownerEmployeeId: employee.id, by: "employee",
        actorAccountId: principal.id, reason: body.data.reason,
      });
      return [200, result];
    });
  });

  app.post("/trips/me/:id/complete", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ID", message: "Perjalanan dinas tidak valid." });
    const body = completeBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_REPORT", message: "Laporan singkat 10 sampai 2000 karakter." });
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id);
      const found = await client.query<{ status: TripStatus; endOn: string }>(
        `SELECT status, to_char(end_on, 'YYYY-MM-DD') AS "endOn"
           FROM business_trip_requests WHERE id = $1 AND employee_id = $2 FOR UPDATE`,
        [params.data.id, employee.id],
      );
      const trip = found.rows[0];
      if (!trip) throw new TripError(404, "TRIP_NOT_FOUND", "Perjalanan dinas tidak ditemukan.");
      if (!canCompleteTrip(trip.status, trip.endOn, today())) {
        throw new TripError(409, "TRIP_NOT_COMPLETABLE", trip.status === "ISSUED"
          ? "Perjalanan dapat diselesaikan mulai tanggal kembali."
          : "Perjalanan dinas hanya dapat diselesaikan setelah surat tugas terbit.");
      }
      await client.query(
        `UPDATE business_trip_requests
            SET status = 'COMPLETED', completion_report = $2, completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [params.data.id, body.data.report],
      );
      await addEvent(client, params.data.id, principal.id, "trip.request.completed");
      return [200, { id: params.data.id, status: "COMPLETED" }];
    });
  });

  // ---------------------------------------------------------------- approver

  app.get("/trips/approvals", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_TRIP_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<{ total: number }>(
        `SELECT step.id AS "stepId", trip.id AS "requestId", step.sources,
                requester.full_name AS "requesterName", requester.employee_number AS "requesterNumber",
                unit.name AS "unitName", trip.destination, trip.purpose,
                to_char(trip.start_on, 'YYYY-MM-DD') AS "startOn", to_char(trip.end_on, 'YYYY-MM-DD') AS "endOn",
                trip.submitted_at AS "submittedAt", count(*) OVER ()::int AS total
           FROM business_trip_approval_steps step
           JOIN business_trip_requests trip ON trip.id = step.request_id
           JOIN employees requester ON requester.id = trip.employee_id
           LEFT JOIN organizational_units unit ON unit.id = requester.organizational_unit_id
          WHERE step.approver_employee_id = $1 AND step.status = 'pending' AND trip.status = 'IN_REVIEW'
          ORDER BY trip.start_on ASC, trip.submitted_at ASC, step.id ASC
          LIMIT $2 OFFSET $3`,
        [employee.id, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, ...row }) => { void total; return row; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.post("/trips/approvals/:stepId/decision", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = stepParams.safeParse(request.params);
    const body = decisionBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return send(reply, 400, {
        code: "INVALID_APPROVAL_DECISION",
        message: "Keputusan tidak valid. Penolakan wajib disertai alasan minimal 5 karakter.",
      });
    }
    return transact(reply, async (client) => {
      const actor = await loadEmployeeContext(client, principal.id);
      // Lock order trip -> step, the same as cancelTrip, so a decision racing a cancellation
      // waits instead of deadlocking.
      await client.query(
        `SELECT 1 FROM business_trip_requests
          WHERE id = (SELECT request_id FROM business_trip_approval_steps WHERE id = $1)
          FOR UPDATE`,
        [params.data.stepId],
      );
      const found = await client.query<{
        id: string; requestId: string; approverEmployeeId: string; requestStatus: TripStatus;
        requesterEmployeeId: string; destination: string;
      }>(
        `SELECT step.id, step.request_id AS "requestId", step.approver_employee_id AS "approverEmployeeId",
                trip.status AS "requestStatus", trip.employee_id AS "requesterEmployeeId", trip.destination
           FROM business_trip_approval_steps step
           JOIN business_trip_requests trip ON trip.id = step.request_id
          WHERE step.id = $1
          FOR UPDATE OF step, trip`,
        [params.data.stepId],
      );
      const current = found.rows[0];
      if (!current) throw new TripError(404, "APPROVAL_STEP_NOT_FOUND", "Tahap approval tidak ditemukan.");
      // TRIP-001-C: the snapshot owns the step; nothing else grants it.
      if (current.approverEmployeeId !== actor.id) {
        throw new TripError(403, "APPROVAL_FORBIDDEN", "Tahap approval ini bukan milik akun Anda.");
      }
      const all = await client.query<LeaveApprovalStepState>(
        `SELECT id, step_order AS "order", status
           FROM business_trip_approval_steps WHERE request_id = $1 ORDER BY step_order ASC`,
        [current.requestId],
      );
      const decision = decideLeaveApprovalStep({
        requestStatus: approvalRequestStatus(current.requestStatus),
        stepId: current.id,
        decision: body.data.decision,
        steps: all.rows,
      });
      const note = body.data.note ?? null;
      await client.query(
        `UPDATE business_trip_approval_steps
            SET status = $2, acted_by_account_id = $3, acted_at = now(), decision_note = $4
          WHERE id = $1`,
        [current.id, decision.decidedStepStatus, principal.id, note],
      );
      if (decision.nextPendingStepId) {
        const next = await client.query<{ approverEmployeeId: string }>(
          `UPDATE business_trip_approval_steps SET status = 'pending' WHERE id = $1
           RETURNING approver_employee_id AS "approverEmployeeId"`,
          [decision.nextPendingStepId],
        );
        await notifyEmployee(client, next.rows[0]!.approverEmployeeId, {
          eventKey: `trip.approval.${decision.nextPendingStepId}`,
          category: "system",
          title: "Persetujuan perjalanan dinas",
          body: `Perjalanan dinas ke ${current.destination} menunggu keputusan Anda.`,
          href: "/app/approvals",
          actorAccountId: principal.id,
        });
      }
      const requestStatus: TripStatus = decision.requestStatus === "approved"
        ? "APPROVED"
        : decision.requestStatus === "rejected" ? "REJECTED" : "IN_REVIEW";
      if (requestStatus !== "IN_REVIEW") {
        await client.query(
          `UPDATE business_trip_requests
              SET status = $2, final_decided_at = now(), updated_at = now()
            WHERE id = $1`,
          [current.requestId, requestStatus],
        );
      }
      await addEvent(
        client, current.requestId, principal.id,
        body.data.decision === "reject" ? "trip.request.rejected" : "trip.approval.approved_step",
        note, { stepId: current.id },
      );
      if (requestStatus === "APPROVED") {
        await addEvent(client, current.requestId, principal.id, "trip.request.approved");
      }
      if (requestStatus !== "IN_REVIEW") {
        await notifyEmployee(client, current.requesterEmployeeId, {
          eventKey: `trip.${current.requestId}.${requestStatus.toLowerCase()}`,
          category: "system",
          title: requestStatus === "APPROVED" ? "Perjalanan dinas disetujui" : "Perjalanan dinas ditolak",
          body: requestStatus === "APPROVED"
            ? `Perjalanan dinas ke ${current.destination} disetujui. Surat tugas akan diterbitkan Human Capital.`
            : `Perjalanan dinas ke ${current.destination} ditolak. Lihat alasannya di riwayat.`,
          href: `/app/trips?trip=${current.requestId}`,
          actorAccountId: principal.id,
        });
      }
      return [200, {
        requestId: current.requestId,
        requestStatus,
        stepStatus: decision.decidedStepStatus,
        nextPendingStepId: decision.nextPendingStepId,
      }];
    });
  });

  // ------------------------------------------------------------------- admin

  app.get("/admin/trips", async (request, reply) => {
    if (!(await requirePermission(request, reply, "trips.read"))) return;
    const query = adminListQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_TRIP_FILTER", message: "Filter tidak valid." });
    // ENG-LIST-001: filters run before LIMIT; the page carries the true total.
    const result = await pool.query<{ total: number }>(
      `SELECT ${SUMMARY_COLUMNS},
              trip.employee_id AS "employeeId", employee.full_name AS "employeeName",
              employee.employee_number AS "employeeNumber", unit.name AS "unitName",
              count(*) OVER ()::int AS total
         FROM business_trip_requests trip
         JOIN employees employee ON employee.id = trip.employee_id
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
         ${SUMMARY_JOINS}
        WHERE ($1::text IS NULL OR trip.status = $1) AND ($2::uuid IS NULL OR trip.employee_id = $2)
        ORDER BY trip.start_on DESC, trip.submitted_at DESC, trip.id DESC
        LIMIT $3 OFFSET $4`,
      [query.data.status ?? null, query.data.employeeId ?? null, query.data.pageSize, pageOffset(query.data)],
    );
    return send(reply, 200, {
      items: result.rows.map(({ total, ...row }) => { void total; return row; }),
      pagination: pagination(query.data, result.rows[0]?.total ?? 0),
    });
  });

  app.get("/admin/trips/:id", async (request, reply) => {
    if (!(await requirePermission(request, reply, "trips.read"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ID", message: "Perjalanan dinas tidak valid." });
    const detail = await loadTripDetail(pool, params.data.id, null);
    if (!detail) return send(reply, 404, { code: "TRIP_NOT_FOUND", message: "Perjalanan dinas tidak ditemukan." });
    return send(reply, 200, detail);
  });

  app.post("/admin/trips/:id/issue", async (request, reply) => {
    const principal = await requirePermission(request, reply, "trips.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ID", message: "Perjalanan dinas tidak valid." });
    return transact(reply, async (client) => {
      const found = await client.query<{
        employeeId: string; status: TripStatus; destination: string; purpose: string; startOn: string; endOn: string;
      }>(
        `SELECT employee_id AS "employeeId", status, destination, purpose,
                to_char(start_on, 'YYYY-MM-DD') AS "startOn", to_char(end_on, 'YYYY-MM-DD') AS "endOn"
           FROM business_trip_requests WHERE id = $1 FOR UPDATE`,
        [params.data.id],
      );
      const trip = found.rows[0];
      if (!trip) throw new TripError(404, "TRIP_NOT_FOUND", "Perjalanan dinas tidak ditemukan.");
      if (trip.status !== "APPROVED") {
        throw new TripError(409, "TRIP_NOT_ISSUABLE", "Surat tugas hanya diterbitkan untuk perjalanan yang sudah disetujui.");
      }
      const employee = await loadEmployeeFacts(client, trip.employeeId);
      if (!employee) throw new TripError(404, "TRIP_NOT_FOUND", "Pegawai perjalanan ini tidak ditemukan.");
      if (employee.status !== "active") {
        throw new TripError(409, "TRIP_EMPLOYEE_NOT_ACTIVE", "Pegawai ini sudah tidak aktif; batalkan perjalanannya.");
      }
      // TRIP-001-F: without an eligible signer issueDocument throws before a number is taken,
      // and the rollback leaves the trip APPROVED.
      const issued = await issueDocument(client, {
        documentKind: "ASSIGNMENT",
        documentCode: ASSIGNMENT_DOCUMENT_CODE,
        numberCode: ASSIGNMENT_NUMBER_CODE,
        employee,
        issuedByAccountId: principal.id,
        // D-13: identity, placement and the trip itself; never money or home address.
        contentSnapshot: buildContentSnapshot(employee, {
          tripId: params.data.id,
          destination: trip.destination,
          purpose: trip.purpose,
          tripStartOn: trip.startOn,
          tripEndOn: trip.endOn,
        }),
      });
      await client.query(
        `UPDATE business_trip_requests
            SET status = 'ISSUED', issued_document_id = $2, updated_at = now()
          WHERE id = $1`,
        [params.data.id, issued.id],
      );
      await addEvent(client, params.data.id, principal.id, "trip.assignment.issued", null, {
        documentId: issued.id, documentNumber: issued.documentNumber,
      });
      // The DOC-001 register log sees the issue as well as a later revoke.
      await writeDocumentAudit(client, {
        eventType: "doc.issued",
        issuedDocumentId: issued.id,
        employeeId: trip.employeeId,
        actorAccountId: principal.id,
        metadata: { source: "TRIP-001", tripId: params.data.id, documentCode: ASSIGNMENT_DOCUMENT_CODE, documentNumber: issued.documentNumber },
      });
      await notifyEmployee(client, trip.employeeId, {
        eventKey: `trip.${params.data.id}.issued`,
        category: "system",
        title: "Surat tugas terbit",
        body: `Surat tugas ${issued.documentNumber} untuk perjalanan ke ${trip.destination} siap dicetak.`,
        href: `/app/trips?trip=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [200, {
        id: params.data.id,
        status: "ISSUED",
        documentId: issued.id,
        documentNumber: issued.documentNumber,
        signer: { title: issued.signerTitle, name: issued.signerName },
      }];
    });
  });

  app.post("/admin/trips/:id/cancel", async (request, reply) => {
    const principal = await requirePermission(request, reply, "trips.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ID", message: "Perjalanan dinas tidak valid." });
    const body = hcCancelBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_CANCEL", message: "Alasan pembatalan minimal 10 karakter." });
    return transact(reply, async (client) => {
      const result = await cancelTrip(client, {
        id: params.data.id, ownerEmployeeId: null, by: "hc", actorAccountId: principal.id, reason: body.data.reason,
      });
      return [200, result];
    });
  });
}
