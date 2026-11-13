// REIMB-001 Package 1 routes: employee drafts and receipts, APR-001 approval, Finance
// verification and payment outside payroll, register, summary and export.
// Spec: docs/domain/reimbursement.md.
//
// reimbursements.* is Finance/HC-only: legacy Super Admin compatibility never grants it, so the
// admin routes resolve the permission from the organization context directly, like loans.*.
// Employee and approver access is ownership (the session's employee, the snapshotted step).
//
// Amounts are sensitive (spec §7): they appear in response bodies to the people allowed to see
// them, never in notifications, event metadata or logs. A database error is reduced to its code
// before it can reach the log, because PostgreSQL puts the failing row in the error detail.

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { quoteCsvCell } from "../../lib/csv.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import type { ReimbursementPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { jakartaDate } from "../documents/service.js";
import {
  decodeDocumentFile,
  downloadFileName,
  EmployeeDocumentError,
  FILE_CONTENT_TYPES,
  MAX_FILE_BASE64_LENGTH,
  UPLOAD_BODY_LIMIT,
  type FileContentType,
} from "../employee-documents/domain.js";
import { fileDownloadHeaders } from "../employee-documents/file-store.js";
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
  assertExpensesFresh,
  canEmployeeCancel,
  canFinanceReject,
  CATEGORIES,
  CATEGORY_KEYS,
  categoryCatalog,
  CLAIM_STATUSES,
  exportWindowOk,
  LINKABLE_TRIP_STATUSES,
  MAX_CLAIM_TOTAL,
  MAX_EXPENSE_AGE_DAYS,
  MAX_EXPORT_DAYS,
  MAX_EXPORT_ROWS,
  MAX_ITEMS,
  MAX_OPEN_DRAFTS,
  MAX_RECEIPTS,
  MIN_ITEM_AMOUNT,
  PAYMENT_METHODS,
  ReimbursementPolicyError,
  rupiahToJson,
  toRupiah,
  validateItems,
  validatePayment,
  verifyAmounts,
  type CategoryKey,
  type ClaimStatus,
  type ItemInput,
} from "./domain.js";

type Queryable = Pool | PoolClient;

/** D-01 DRAFT: ORG-004 rollout key; without a rollout row the mode is LEGACY. */
const WORKFLOW_KEY = "REIMBURSEMENT";
const DRAFT_DISCARD_REASON = "Draf dibuang pegawai";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-\d{2}$/);
// JSON integers only: 150000.5 or "150000" is refused, never rounded (D-15).
const rupiah = z.number().int().positive().max(1_000_000_000);
/** Text whose length the database counts in characters (code points), not UTF-16 units. */
const text = (min: number, max: number) => z.string().trim().max(max)
  .refine((value) => [...value].length >= min, { message: `at least ${min} characters` });
const itemBody = z.object({
  category: z.enum(CATEGORY_KEYS),
  expenseDate: isoDate,
  description: text(3, 300),
  amount: rupiah,
});
const draftBody = z.object({
  title: text(5, 200),
  businessTripId: z.string().uuid().nullable().optional(),
  items: z.array(itemBody).min(1).max(MAX_ITEMS),
});
const createBody = draftBody.extend({ idempotencyKey: z.string().uuid() });
const receiptBody = z.object({
  contentType: z.enum(FILE_CONTENT_TYPES),
  contentBase64: z.string().min(1).max(MAX_FILE_BASE64_LENGTH),
});
const idParams = z.object({ id: z.string().uuid() });
const receiptParams = idParams.extend({ receiptId: z.string().uuid() });
const stepParams = z.object({ stepId: z.string().uuid() });
const stepReceiptParams = stepParams.extend({ receiptId: z.string().uuid() });
const decisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), note: z.string().trim().max(1000).nullable().optional() }),
  z.object({ decision: z.literal("reject"), note: z.string().trim().min(5).max(1000) }),
]);
const employeeCancelBody = z.object({ reason: z.string().trim().max(500).nullable().optional() });
const financeReasonBody = z.object({ reason: z.string().trim().min(10).max(500) });
const verifyBody = z.object({
  items: z.array(z.object({
    itemId: z.string().uuid(),
    approvedAmount: z.number().int().min(0).max(1_000_000_000),
  })).min(1).max(MAX_ITEMS),
  note: z.string().trim().max(500).nullable().optional(),
});
const payBody = z.object({
  paidOn: isoDate,
  method: z.enum(PAYMENT_METHODS),
  payrollMonth: month.nullable().optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  idempotencyKey: z.string().uuid(),
});
const SUBMITTED_STATUSES = CLAIM_STATUSES.filter((status) => status !== "DRAFT");
const myListQuery = pageQuerySchema.extend({ status: z.enum(CLAIM_STATUSES).optional() });
const adminListQuery = pageQuerySchema.extend({
  status: z.enum(SUBMITTED_STATUSES as [ClaimStatus, ...ClaimStatus[]]).optional(),
  category: z.enum(CATEGORY_KEYS).optional(),
  employeeId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
const periodQuery = z.object({
  from: isoDate,
  to: isoDate,
  status: z.enum(SUBMITTED_STATUSES as [ClaimStatus, ...ClaimStatus[]]).optional(),
});
const claimantQuery = pageQuerySchema.extend({ q: z.string().trim().min(2).max(100) });

class ReimbursementError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "ReimbursementError";
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

const STATE_CONFLICT: [string, string] = ["REIMBURSEMENT_STATE_CONFLICT", "Data klaim sudah berubah. Muat ulang lalu coba lagi."];
/** Unique races a well-behaved client can lose. Anything else in class 23 is a bug, not a race. */
const UNIQUE_CONFLICTS: Record<string, [string, string]> = {
  reimbursement_approval_steps_one_pending_idx: [
    "APPROVAL_STATE_CONFLICT", "Tahap persetujuan aktif sudah berubah. Muat ulang sebelum mengambil keputusan.",
  ],
  reimbursement_claims_employee_id_idempotency_key_key: STATE_CONFLICT,
  reimbursement_items_claim_id_line_no_key: STATE_CONFLICT,
  reimbursement_payments_claim_id_key: ["REIMBURSEMENT_ALREADY_PAID", "Klaim ini sudah dibayar."],
};

function knownError(error: unknown): ReimbursementError | null {
  if (error instanceof ReimbursementError) return error;
  if (error instanceof ReimbursementPolicyError
    || error instanceof LeaveApprovalConfigurationError
    || error instanceof LeaveOrganizationAuthorityError
    || error instanceof LeaveWorkflowError) {
    return new ReimbursementError(409, error.code, error.message);
  }
  if (error instanceof EmployeeDocumentError) {
    // D-05: the EMP-011 file checks, under this module's codes.
    const code = error.code.replace("EMPLOYEE_DOCUMENT_FILE", "REIMBURSEMENT_RECEIPT");
    return new ReimbursementError(error.statusCode, code, error.message);
  }
  const database = error as { code?: unknown; severity?: unknown; constraint?: unknown };
  if (database.code === "23505" && typeof database.severity === "string") {
    const conflict = UNIQUE_CONFLICTS[String(database.constraint)];
    if (conflict) return new ReimbursementError(409, conflict[0], conflict[1]);
  }
  return null;
}

/**
 * Spec §7: an unexpected database error — including a broken money invariant, which means a code
 * bug — becomes a logged 500 that keeps its code, constraint and message (amount-free by design)
 * and loses `detail`, where PostgreSQL quotes the failing row with its amounts.
 */
function scrubbed(error: unknown): unknown {
  const database = error as { code?: unknown; severity?: unknown; constraint?: unknown; message?: unknown };
  if (typeof database.code === "string" && typeof database.severity === "string") {
    return Object.assign(new Error(`reimbursement database error ${database.code}: ${String(database.message)}`), {
      code: database.code, constraint: database.constraint,
    });
  }
  return error;
}

function amount(value: unknown): number {
  return rupiahToJson(toRupiah(value as string));
}

function optionalAmount(value: unknown): number | null {
  return value === null || value === undefined ? null : amount(value);
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
      ${lock ? "FOR NO KEY UPDATE OF employee" : ""}`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new ReimbursementError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return employee;
}

/**
 * APR-001 at submission (D-01): the shared Leave resolver turns DIRECT_MANAGER and UNIT_APPROVER
 * into concrete employees, drops the requester and merges duplicates; every approver must then be
 * an active employee with an active account, or nothing changes.
 */
async function resolveApprovalChain(db: Queryable, employee: EmployeeContext, effectiveDate: string) {
  const resolution = await resolveLeaveAuthorities(db, {
    workflowKey: WORKFLOW_KEY,
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
    throw new ReimbursementError(409, "APPROVAL_CHAIN_EMPTY", "Rantai approval reimbursement hanya dapat berisi pegawai.");
  }
  const actors = await db.query<{ id: string; fullName: string; status: string; accountStatus: string | null }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status, account.status AS "accountStatus"
       FROM employees employee
       LEFT JOIN accounts account ON account.employee_id = employee.id AND account.principal_type = 'EMPLOYEE'
      WHERE employee.id = ANY($1::uuid[]) AND employee.removed_at IS NULL
        -- EMP-005 S2B §8.7: an approver outside HCIS management reads as not active.
        AND employee.management_scope = 'MANAGED'`,
    [ids],
  );
  const byId = new Map(actors.rows.map((row) => [row.id, row]));
  const chain: ChainStep[] = resolution.approvalChain.map((step) => {
    const actor = byId.get(step.employeeId!);
    if (!actor || actor.status !== "active") {
      throw new ReimbursementError(409, "APPROVER_NOT_ACTIVE", "Rantai approval berisi approver yang tidak aktif.");
    }
    if (actor.accountStatus !== "active") {
      throw new ReimbursementError(409, "APPROVER_ACCOUNT_NOT_READY", `Akun approver ${actor.fullName} belum aktif.`);
    }
    return { employeeId: actor.id, name: actor.fullName, sources: step.sources };
  });
  return { chain, context: resolution.context };
}

/** D-06: only the employee's own trip, once it is approved. */
async function assertTripLinkable(db: Queryable, tripId: string | null | undefined, employeeId: string) {
  if (!tripId) return;
  const found = await db.query<{ status: string }>(
    `SELECT status FROM business_trip_requests WHERE id = $1 AND employee_id = $2`,
    [tripId, employeeId],
  );
  const status = found.rows[0]?.status;
  if (!status || !(LINKABLE_TRIP_STATUSES as readonly string[]).includes(status)) {
    throw new ReimbursementError(
      409, "REIMBURSEMENT_TRIP_NOT_ELIGIBLE",
      "Perjalanan dinas tidak dapat ditautkan. Pilih perjalanan Anda yang sudah disetujui, terbit, atau selesai.",
    );
  }
}

async function addEvent(
  db: Queryable,
  claimId: string | null,
  actorAccountId: string | null,
  eventType: string,
  note: string | null = null,
  metadata: Record<string, unknown> = {},
) {
  // clock_timestamp(), not now(): events written in one transaction keep their order.
  await db.query(
    `INSERT INTO reimbursement_events (id, claim_id, event_type, actor_account_id, note, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [randomUUID(), claimId, eventType, actorAccountId, note, JSON.stringify(metadata)],
  );
}

function toItems(items: ReadonlyArray<z.infer<typeof itemBody>>): ItemInput[] {
  return items.map((item) => ({ ...item, amount: toRupiah(item.amount) }));
}

async function writeItems(db: PoolClient, claimId: string, items: ItemInput[]) {
  await db.query(`DELETE FROM reimbursement_items WHERE claim_id = $1`, [claimId]);
  for (const [index, item] of items.entries()) {
    await db.query(
      `INSERT INTO reimbursement_items (id, claim_id, line_no, category, expense_date, description, amount)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7::bigint)`,
      [randomUUID(), claimId, index + 1, item.category, item.expenseDate, item.description, item.amount.toString()],
    );
  }
}

const SUMMARY_COLUMNS = `
  claim.id, claim.status, claim.title,
  claim.claimed_total::text AS "claimedTotal", claim.verified_total::text AS "verifiedTotal",
  claim.created_at AS "createdAt", claim.submitted_at AS "submittedAt", claim.paid_at AS "paidAt",
  claim.business_trip_id AS "businessTripId", trip.destination AS "tripDestination",
  (SELECT count(*)::int FROM reimbursement_items item WHERE item.claim_id = claim.id) AS "itemCount",
  approver.full_name AS "currentApproverName"`;
const SUMMARY_JOINS = `
  LEFT JOIN business_trip_requests trip ON trip.id = claim.business_trip_id
  LEFT JOIN reimbursement_approval_steps current_step
    ON current_step.claim_id = claim.id AND current_step.status = 'pending'
  LEFT JOIN employees approver ON approver.id = current_step.approver_employee_id`;

type SummaryRow = { claimedTotal: string; verifiedTotal: string | null; total?: number } & Record<string, unknown>;

function summary({ claimedTotal, verifiedTotal, total, ...row }: SummaryRow) {
  void total;
  return { ...row, claimedTotal: amount(claimedTotal), verifiedTotal: optionalAmount(verifiedTotal) };
}

type DetailScope = "OWNER" | "APPROVER" | "REGISTER";

/**
 * One claim with its items (≤ 10), receipts (≤ 10), steps, payment and history — bounded by the
 * claim itself. The approver view leaves out verification, payment and history.
 */
async function loadClaimDetail(db: Queryable, id: string, scope: DetailScope, ownerEmployeeId: string | null = null) {
  const found = await db.query<SummaryRow & { verificationNote: string | null }>(
    `SELECT ${SUMMARY_COLUMNS},
            claim.employee_id AS "employeeId", employee.full_name AS "employeeName",
            employee.employee_number AS "employeeNumber", unit.name AS "unitName",
            to_char(trip.start_on, 'YYYY-MM-DD') AS "tripStartOn", to_char(trip.end_on, 'YYYY-MM-DD') AS "tripEndOn",
            trip.status AS "tripStatus",
            claim.verified_at AS "verifiedAt", claim.verification_note AS "verificationNote",
            claim.rejected_by AS "rejectedBy", claim.reject_reason AS "rejectReason",
            claim.cancel_reason AS "cancelReason"
       FROM reimbursement_claims claim
       JOIN employees employee ON employee.id = claim.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       ${SUMMARY_JOINS}
      WHERE claim.id = $1 AND ($2::uuid IS NULL OR claim.employee_id = $2)
        -- Drafts are private to their owner; the register and approvers see submitted claims only.
        AND ($3::boolean OR claim.submitted_at IS NOT NULL)`,
    [id, ownerEmployeeId, scope === "OWNER"],
  );
  const row = found.rows[0];
  if (!row) return null;
  const [items, receipts, steps, payments, events] = await Promise.all([
    db.query<{ amount: string; approvedAmount: string | null; category: CategoryKey } & Record<string, unknown>>(
      `SELECT id, line_no AS "lineNo", category, to_char(expense_date, 'YYYY-MM-DD') AS "expenseDate",
              description, amount::text AS amount, approved_amount::text AS "approvedAmount"
         FROM reimbursement_items WHERE claim_id = $1 ORDER BY line_no ASC`,
      [id],
    ),
    db.query<{ duplicateClaims: number } & Record<string, unknown>>(
      `SELECT receipt.id, receipt.content_type AS "contentType", receipt.byte_size AS "byteSize",
              receipt.created_at AS "createdAt", receipt.purged_at IS NOT NULL AS purged,
              -- D-16: other live claims that carry the same file.
              (SELECT count(DISTINCT other.claim_id)::int
                 FROM reimbursement_receipts other
                 JOIN reimbursement_claims other_claim ON other_claim.id = other.claim_id
                WHERE receipt.purged_at IS NULL AND other.purged_at IS NULL
                  AND other.sha256 = receipt.sha256 AND other.claim_id <> receipt.claim_id
                  AND other_claim.status <> 'CANCELLED'
                  -- A private draft never shows up in the register, not even as a count.
                  AND other_claim.submitted_at IS NOT NULL) AS "duplicateClaims"
         FROM reimbursement_receipts receipt
        WHERE receipt.claim_id = $1 AND receipt.purged_at IS NULL
        ORDER BY receipt.created_at ASC, receipt.id ASC`,
      [id],
    ),
    db.query(
      `SELECT step.id, step.step_order AS "order", step.status, step.sources,
              approver.full_name AS "approverName", step.acted_at AS "actedAt",
              step.decision_note AS "decisionNote"
         FROM reimbursement_approval_steps step
         JOIN employees approver ON approver.id = step.approver_employee_id
        WHERE step.claim_id = $1
        ORDER BY step.step_order ASC`,
      [id],
    ),
    db.query<{ amount: string } & Record<string, unknown>>(
      `SELECT payment.id, payment.amount::text AS amount, to_char(payment.paid_on, 'YYYY-MM-DD') AS "paidOn",
              payment.method, to_char(payment.payroll_month, 'YYYY-MM') AS "payrollMonth",
              payment.reference, payment.note, payment.recorded_at AS "recordedAt",
              recorder.full_name AS "recordedByName"
         FROM reimbursement_payments payment
         LEFT JOIN accounts account ON account.id = payment.recorded_by_account_id
         LEFT JOIN employees recorder ON recorder.id = account.employee_id
        WHERE payment.claim_id = $1`,
      [id],
    ),
    db.query(
      `SELECT event.id, event.event_type AS "eventType", event.occurred_at AS "occurredAt",
              event.note, event.metadata, actor.full_name AS "actorName"
         FROM reimbursement_events event
         LEFT JOIN accounts account ON account.id = event.actor_account_id
         LEFT JOIN employees actor ON actor.id = account.employee_id
        WHERE event.claim_id = $1
        ORDER BY event.occurred_at ASC, event.id ASC`,
      [id],
    ),
  ]);
  const detail = {
    ...summary(row),
    items: items.rows.map(({ amount: value, approvedAmount, ...item }) => ({
      ...item,
      categoryLabel: CATEGORIES[item.category]?.label ?? item.category,
      amount: amount(value),
      approvedAmount: optionalAmount(approvedAmount),
    })),
    receipts: receipts.rows.map(({ duplicateClaims, ...receipt }) => (
      scope === "REGISTER" ? { ...receipt, duplicateClaims } : receipt
    )),
    steps: steps.rows,
  };
  if (scope === "APPROVER") {
    const { verifiedAt, verificationNote, verifiedTotal, paidAt, ...rest } = detail as Record<string, unknown>;
    void verifiedAt; void verificationNote; void verifiedTotal; void paidAt;
    return { ...rest, items: detail.items.map(({ approvedAmount, ...item }) => { void approvedAmount; return item; }) };
  }
  const payment = payments.rows[0];
  return {
    ...detail,
    payment: payment ? { ...payment, amount: amount(payment.amount) } : null,
    events: events.rows,
  };
}

export async function registerReimbursementRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for reimbursement routes");
  const encryptionKey = config.AUTH_ENCRYPTION_KEY;
  // D-11 DRAFT: off unless explicitly switched on; production keeps it off.
  const payrollHandoffEnabled = config.REIMBURSEMENT_PAYROLL_HANDOFF_ENABLED === "1";
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
      await send(reply, 403, { code: "FORBIDDEN", message: "Reimbursement hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: ReimbursementPermission,
  ): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "REIMBURSEMENT_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
      return null;
    }
    return principal;
  }

  async function handle(reply: FastifyReply, work: () => Promise<unknown>) {
    try {
      return await work();
    } catch (error) {
      const known = knownError(error);
      if (!known) throw scrubbed(error);
      return send(reply, known.statusCode, { code: known.code, message: known.message });
    }
  }

  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      // The money invariants are deferred triggers (migration 0148); COMMIT is where they run.
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

  interface LockedClaim {
    employeeId: string;
    status: ClaimStatus;
    businessTripId: string | null;
    verifiedTotal: string | null;
    verifiedOn: string | null;
    submitted: boolean;
  }

  async function lockClaim(client: PoolClient, id: string, ownerEmployeeId: string | null): Promise<LockedClaim> {
    const found = await client.query<LockedClaim>(
      `SELECT employee_id AS "employeeId", status, business_trip_id AS "businessTripId",
              verified_total::text AS "verifiedTotal",
              to_char(verified_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS "verifiedOn",
              submitted_at IS NOT NULL AS submitted
         FROM reimbursement_claims
        WHERE id = $1 AND ($2::uuid IS NULL OR employee_id = $2)
        FOR UPDATE`,
      [id, ownerEmployeeId],
    );
    const claim = found.rows[0];
    // The register never sees a draft (spec §6), so an unsubmitted claim reads as missing there.
    if (!claim || (ownerEmployeeId === null && !claim.submitted)) {
      throw new ReimbursementError(404, "REIMBURSEMENT_NOT_FOUND", "Klaim tidak ditemukan.");
    }
    return claim;
  }

  /** D-13: Finance never processes its own claim. An account without an employee passes. */
  async function assertNotOwnClaim(db: Queryable, actorAccountId: string, claimEmployeeId: string) {
    const actor = await db.query<{ employeeId: string | null }>(
      `SELECT employee_id AS "employeeId" FROM accounts WHERE id = $1`,
      [actorAccountId],
    );
    if (actor.rows[0]?.employeeId === claimEmployeeId) {
      throw new ReimbursementError(403, "REIMBURSEMENT_SELF_ACTION_FORBIDDEN", "Klaim milik Anda sendiri harus diproses petugas lain.");
    }
  }

  /** D-13: whoever sits in this claim's chain, decided or not, does not also verify or pay it. */
  async function assertNotApprover(db: Queryable, claimId: string, actorAccountId: string) {
    const approver = await db.query(
      `SELECT 1 FROM reimbursement_approval_steps step
        WHERE step.claim_id = $1
          AND (step.acted_by_account_id = $2
            OR step.approver_employee_id = (SELECT employee_id FROM accounts WHERE id = $2))
        LIMIT 1`,
      [claimId, actorAccountId],
    );
    if (approver.rows[0]) {
      throw new ReimbursementError(403, "REIMBURSEMENT_APPROVER_CANNOT_PROCESS", "Penyetuju klaim ini tidak boleh sekaligus memverifikasi atau membayarnya.");
    }
  }

  async function purgeReceipts(client: PoolClient, claimId: string, receiptId: string | null = null) {
    const purged = await client.query(
      `UPDATE reimbursement_receipts
          SET ciphertext = NULL, iv = NULL, auth_tag = NULL, purged_at = clock_timestamp(),
              -- An unkeyed hash of the plaintext would still confirm a known file; drop it too.
              sha256 = repeat('0', 64)
        WHERE claim_id = $1 AND ($2::uuid IS NULL OR id = $2) AND purged_at IS NULL
        RETURNING id`,
      [claimId, receiptId],
    );
    return purged.rowCount ?? 0;
  }

  /**
   * Streams one receipt after checking its integrity. A read by someone other than the owner is
   * recorded before a single byte leaves; a failed audit means no file (pattern EMP-011 D-11).
   */
  async function sendReceipt(
    reply: FastifyReply,
    claimId: string,
    receiptId: string,
    reader: { actorAccountId: string; via: "APPROVER" | "REGISTER" } | null,
  ) {
    const found = await pool.query<{
      contentType: FileContentType; byteSize: number; createdAt: Date; sha256: string;
      ciphertext: string | null; iv: string | null; tag: string | null;
    }>(
      `SELECT content_type AS "contentType", byte_size AS "byteSize", created_at AS "createdAt", sha256,
              ciphertext, iv, auth_tag AS tag
         FROM reimbursement_receipts WHERE id = $1 AND claim_id = $2`,
      [receiptId, claimId],
    );
    const receipt = found.rows[0];
    if (!receipt) return send(reply, 404, { code: "REIMBURSEMENT_RECEIPT_NOT_FOUND", message: "Bukti tidak ditemukan." });
    if (!receipt.ciphertext || !receipt.iv || !receipt.tag) {
      return send(reply, 410, { code: "REIMBURSEMENT_RECEIPT_PURGED", message: "Isi bukti sudah dihapus." });
    }
    const bytes = Buffer.from(decryptSecret({ ciphertext: receipt.ciphertext, iv: receipt.iv, tag: receipt.tag }, encryptionKey), "base64");
    const expected = Buffer.from(receipt.sha256, "hex");
    const actual = createHash("sha256").update(bytes).digest();
    if (bytes.length !== receipt.byteSize || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("Reimbursement receipt integrity check failed");
    }
    if (reader) {
      await addEvent(pool, claimId, reader.actorAccountId, "reimbursement.receipt.read", null, { receiptId, via: reader.via });
    }
    reply.headers(fileDownloadHeaders(receipt.contentType, downloadFileName("bukti-reimbursement", receipt.createdAt, receipt.contentType)));
    return reply.status(200).send(bytes);
  }

  // ---------------------------------------------------------------- employee

  app.get("/reimbursements/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = myListQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<SummaryRow & { total: number }>(
        `SELECT ${SUMMARY_COLUMNS}, count(*) OVER ()::int AS total
           FROM reimbursement_claims claim
           ${SUMMARY_JOINS}
          WHERE claim.employee_id = $1 AND ($2::text IS NULL OR claim.status = $2)
            -- A discarded draft is gone from the employee's list; its history stays in the database.
            AND NOT (claim.status = 'CANCELLED' AND claim.submitted_at IS NULL)
          ORDER BY claim.created_at DESC, claim.id DESC
          LIMIT $3 OFFSET $4`,
        [employee.id, query.data.status ?? null, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(summary),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
        categories: categoryCatalog(),
        policy: {
          minItemAmount: rupiahToJson(MIN_ITEM_AMOUNT),
          maxClaimTotal: rupiahToJson(MAX_CLAIM_TOTAL),
          maxItems: MAX_ITEMS,
          maxReceipts: MAX_RECEIPTS,
          maxExpenseAgeDays: MAX_EXPENSE_AGE_DAYS,
          maxOpenDrafts: MAX_OPEN_DRAFTS,
        },
      });
    });
  });

  app.get("/reimbursements/me/trips", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_FILTER", message: "Halaman tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<{ total: number }>(
        `SELECT trip.id, trip.destination, to_char(trip.start_on, 'YYYY-MM-DD') AS "startOn",
                to_char(trip.end_on, 'YYYY-MM-DD') AS "endOn", trip.status, count(*) OVER ()::int AS total
           FROM business_trip_requests trip
          WHERE trip.employee_id = $1 AND trip.status = ANY($2::text[])
          ORDER BY trip.start_on DESC, trip.id DESC
          LIMIT $3 OFFSET $4`,
        [employee.id, [...LINKABLE_TRIP_STATUSES], query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, ...row }) => { void total; return row; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.get("/reimbursements/me/approvers", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const { chain } = await resolveApprovalChain(pool, employee, today());
      return send(reply, 200, { approvalChain: chain });
    });
  });

  app.get("/reimbursements/me/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Klaim tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      // REIMB-001-A: another employee's claim is indistinguishable from a missing one.
      const detail = await loadClaimDetail(pool, params.data.id, "OWNER", employee.id);
      if (!detail) return send(reply, 404, { code: "REIMBURSEMENT_NOT_FOUND", message: "Klaim tidak ditemukan." });
      return send(reply, 200, detail);
    });
  });

  app.post("/reimbursements/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = createBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, {
        code: "INVALID_REIMBURSEMENT",
        message: "Judul (5–200 karakter), 1–10 baris biaya dengan kategori, tanggal, uraian, dan nominal bilangan bulat rupiah wajib diisi.",
      });
    }
    return transact(reply, async (client) => {
      // Locking the employee row serializes this employee's drafts (D-07 limit, idempotency).
      const employee = await loadEmployeeContext(client, principal.id, true);
      const replay = await client.query<{ id: string; status: ClaimStatus }>(
        `SELECT id, status FROM reimbursement_claims WHERE employee_id = $1 AND idempotency_key = $2`,
        [employee.id, body.data.idempotencyKey],
      );
      if (replay.rows[0]) return [200, { ...replay.rows[0], idempotentReplay: true }];
      const drafts = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reimbursement_claims WHERE employee_id = $1 AND status = 'DRAFT'`,
        [employee.id],
      );
      if ((drafts.rows[0]?.count ?? 0) >= MAX_OPEN_DRAFTS) {
        throw new ReimbursementError(409, "REIMBURSEMENT_TOO_MANY_DRAFTS", `Paling banyak ${MAX_OPEN_DRAFTS} draf. Kirim atau buang draf lain dulu.`);
      }
      const items = toItems(body.data.items);
      const total = validateItems(items, today());
      await assertTripLinkable(client, body.data.businessTripId, employee.id);
      const id = randomUUID();
      await client.query(
        `INSERT INTO reimbursement_claims (id, employee_id, title, business_trip_id, status, claimed_total, idempotency_key)
         VALUES ($1, $2, $3, $4, 'DRAFT', $5::bigint, $6)`,
        [id, employee.id, body.data.title, body.data.businessTripId ?? null, total.toString(), body.data.idempotencyKey],
      );
      await writeItems(client, id, items);
      await addEvent(client, id, principal.id, "reimbursement.draft.created", null, {
        items: items.length, linkedTrip: Boolean(body.data.businessTripId),
      });
      return [201, { id, status: "DRAFT", idempotentReplay: false }];
    });
  });

  app.put("/reimbursements/me/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Klaim tidak valid." });
    const body = draftBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, {
        code: "INVALID_REIMBURSEMENT",
        message: "Judul (5–200 karakter), 1–10 baris biaya dengan kategori, tanggal, uraian, dan nominal bilangan bulat rupiah wajib diisi.",
      });
    }
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id);
      const claim = await lockClaim(client, params.data.id, employee.id);
      if (claim.status !== "DRAFT") {
        throw new ReimbursementError(409, "REIMBURSEMENT_NOT_EDITABLE", "Klaim yang sudah dikirim tidak dapat diubah.");
      }
      const items = toItems(body.data.items);
      const total = validateItems(items, today());
      await assertTripLinkable(client, body.data.businessTripId, employee.id);
      await writeItems(client, params.data.id, items);
      await client.query(
        `UPDATE reimbursement_claims
            SET title = $2, business_trip_id = $3, claimed_total = $4::bigint, updated_at = now()
          WHERE id = $1`,
        [params.data.id, body.data.title, body.data.businessTripId ?? null, total.toString()],
      );
      await addEvent(client, params.data.id, principal.id, "reimbursement.draft.updated", null, {
        items: items.length, linkedTrip: Boolean(body.data.businessTripId),
      });
      return [200, { id: params.data.id, status: "DRAFT" }];
    });
  });

  app.post("/reimbursements/me/:id/receipts", { bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Klaim tidak valid." });
    const body = receiptBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "REIMBURSEMENT_RECEIPT_INVALID", message: "Bukti harus PDF, JPG, atau PNG, maksimal 4 MB." });
    }
    // D-05: size, signature and active-content checks run before a transaction is opened.
    let bytes: Buffer;
    try {
      bytes = decodeDocumentFile(body.data.contentType, body.data.contentBase64);
    } catch (error) {
      const known = knownError(error);
      if (!known) throw error;
      return send(reply, known.statusCode, { code: known.code, message: known.message });
    }
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id);
      const claim = await lockClaim(client, params.data.id, employee.id);
      if (claim.status !== "DRAFT") {
        throw new ReimbursementError(409, "REIMBURSEMENT_NOT_EDITABLE", "Bukti hanya dapat ditambahkan selama klaim masih draf.");
      }
      const count = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reimbursement_receipts WHERE claim_id = $1 AND purged_at IS NULL`,
        [params.data.id],
      );
      if ((count.rows[0]?.count ?? 0) >= MAX_RECEIPTS) {
        throw new ReimbursementError(409, "REIMBURSEMENT_TOO_MANY_RECEIPTS", `Paling banyak ${MAX_RECEIPTS} bukti per klaim.`);
      }
      const encrypted = encryptSecret(bytes.toString("base64"), encryptionKey);
      const receiptId = randomUUID();
      await client.query(
        `INSERT INTO reimbursement_receipts
           (id, claim_id, content_type, byte_size, sha256, ciphertext, iv, auth_tag, uploaded_by_account_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          receiptId, params.data.id, body.data.contentType, bytes.length,
          createHash("sha256").update(bytes).digest("hex"),
          encrypted.ciphertext, encrypted.iv, encrypted.tag, principal.id,
        ],
      );
      await addEvent(client, params.data.id, principal.id, "reimbursement.receipt.added", null, {
        receiptId, contentType: body.data.contentType,
      });
      return [201, { id: receiptId, contentType: body.data.contentType, byteSize: bytes.length }];
    });
  });

  app.delete("/reimbursements/me/:id/receipts/:receiptId", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = receiptParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Bukti tidak valid." });
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id);
      const claim = await lockClaim(client, params.data.id, employee.id);
      if (claim.status !== "DRAFT") {
        throw new ReimbursementError(409, "REIMBURSEMENT_NOT_EDITABLE", "Bukti hanya dapat dihapus selama klaim masih draf.");
      }
      if (!(await purgeReceipts(client, params.data.id, params.data.receiptId))) {
        throw new ReimbursementError(404, "REIMBURSEMENT_RECEIPT_NOT_FOUND", "Bukti tidak ditemukan.");
      }
      await addEvent(client, params.data.id, principal.id, "reimbursement.receipt.removed", null, { receiptId: params.data.receiptId });
      return [200, { id: params.data.receiptId, removed: true }];
    });
  });

  app.get("/reimbursements/me/:id/receipts/:receiptId", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = receiptParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Bukti tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const owned = await pool.query(`SELECT 1 FROM reimbursement_claims WHERE id = $1 AND employee_id = $2`, [params.data.id, employee.id]);
      if (!owned.rows[0]) return send(reply, 404, { code: "REIMBURSEMENT_NOT_FOUND", message: "Klaim tidak ditemukan." });
      return sendReceipt(reply, params.data.id, params.data.receiptId, null);
    });
  });

  app.post("/reimbursements/me/:id/submit", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Klaim tidak valid." });
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id, true);
      const claim = await lockClaim(client, params.data.id, employee.id);
      if (claim.status !== "DRAFT") {
        throw new ReimbursementError(409, "REIMBURSEMENT_NOT_SUBMITTABLE", "Hanya draf yang dapat dikirim.");
      }
      const stored = await client.query<{ category: string; expenseDate: string; description: string; amount: string }>(
        `SELECT category, to_char(expense_date, 'YYYY-MM-DD') AS "expenseDate", description, amount::text AS amount
           FROM reimbursement_items WHERE claim_id = $1 ORDER BY line_no`,
        [params.data.id],
      );
      const submittedOn = today();
      const items = stored.rows.map((item) => ({ ...item, amount: toRupiah(item.amount) }));
      validateItems(items, submittedOn);
      assertExpensesFresh(items, submittedOn);
      const receipts = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reimbursement_receipts WHERE claim_id = $1 AND purged_at IS NULL`,
        [params.data.id],
      );
      if (!receipts.rows[0]?.count) {
        throw new ReimbursementError(409, "REIMBURSEMENT_RECEIPT_REQUIRED", "Unggah minimal satu bukti pembayaran sebelum mengirim.");
      }
      await assertTripLinkable(client, claim.businessTripId, employee.id);
      const { chain, context } = await resolveApprovalChain(client, employee, submittedOn);

      await client.query(
        `UPDATE reimbursement_claims
            SET status = 'IN_REVIEW', submitted_at = now(), approval_snapshot = $2::jsonb, updated_at = now()
          WHERE id = $1`,
        [
          params.data.id,
          JSON.stringify({
            workflowKey: WORKFLOW_KEY,
            steps: chain.map((step) => ({ employeeId: step.employeeId, sources: step.sources })),
            authorityResolution: context,
          }),
        ],
      );
      const steps: Array<{ id: string; employeeId: string; name: string }> = [];
      for (const [index, step] of chain.entries()) {
        const stepId = randomUUID();
        await client.query(
          `INSERT INTO reimbursement_approval_steps (id, claim_id, step_order, approver_employee_id, sources, status)
           VALUES ($1, $2, $3, $4, $5::text[], $6)`,
          [stepId, params.data.id, index + 1, step.employeeId, step.sources, index === 0 ? "pending" : "waiting"],
        );
        steps.push({ id: stepId, employeeId: step.employeeId, name: step.name });
      }
      await addEvent(client, params.data.id, principal.id, "reimbursement.request.submitted", null, {
        items: items.length, receipts: receipts.rows[0].count, approvers: steps.length, mode: context.mode,
      });
      const first = steps[0]!;
      await notifyEmployee(client, first.employeeId, {
        eventKey: `reimbursement.approval.${first.id}`,
        category: "system",
        title: "Persetujuan reimbursement",
        body: `${employee.fullName} mengajukan klaim reimbursement.`,
        href: "/app/approvals",
        actorAccountId: principal.id,
      });
      return [200, { id: params.data.id, status: "IN_REVIEW", approvalChain: steps }];
    });
  });

  app.post("/reimbursements/me/:id/cancel", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Klaim tidak valid." });
    const body = employeeCancelBody.safeParse(request.body ?? {});
    if (!body.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_CANCEL", message: "Alasan pembatalan maksimal 500 karakter." });
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id);
      const claim = await lockClaim(client, params.data.id, employee.id);
      if (!canEmployeeCancel(claim.status)) {
        throw new ReimbursementError(409, "REIMBURSEMENT_NOT_CANCELLABLE", claim.status === "VERIFIED"
          ? "Klaim sudah diverifikasi Keuangan; hubungi Keuangan bila perlu dibatalkan."
          : "Klaim ini tidak dapat dibatalkan.");
      }
      const draft = claim.status === "DRAFT";
      const reason = draft ? DRAFT_DISCARD_REASON : (body.data.reason ?? "").trim();
      if (!draft && reason.length < 5) {
        throw new ReimbursementError(400, "INVALID_REIMBURSEMENT_CANCEL", "Alasan pembatalan minimal 5 karakter.");
      }
      // D-07: a discarded draft keeps no receipt content.
      const purged = draft ? await purgeReceipts(client, params.data.id) : 0;
      await client.query(
        `UPDATE reimbursement_claims
            SET status = 'CANCELLED', cancelled_by_account_id = $2, cancel_reason = $3, updated_at = now()
          WHERE id = $1`,
        [params.data.id, principal.id, reason],
      );
      await client.query(
        `UPDATE reimbursement_approval_steps SET status = 'cancelled'
          WHERE claim_id = $1 AND status IN ('waiting', 'pending')`,
        [params.data.id],
      );
      await addEvent(client, params.data.id, principal.id, "reimbursement.request.cancelled", draft ? null : reason, {
        by: "employee", previousStatus: claim.status, receiptsPurged: purged,
      });
      return [200, { id: params.data.id, status: "CANCELLED" }];
    });
  });

  // ---------------------------------------------------------------- approver

  /** Spec §6: an approver opens a claim through a step of theirs that has reached them. */
  async function approverStep(db: Queryable, stepId: string, accountId: string) {
    const actor = await loadEmployeeContext(db, accountId);
    const found = await db.query<{ claimId: string; approverEmployeeId: string; status: string }>(
      `SELECT claim_id AS "claimId", approver_employee_id AS "approverEmployeeId", status
         FROM reimbursement_approval_steps WHERE id = $1`,
      [stepId],
    );
    const step = found.rows[0];
    if (!step) throw new ReimbursementError(404, "APPROVAL_STEP_NOT_FOUND", "Tahap approval tidak ditemukan.");
    if (step.approverEmployeeId !== actor.id || !["pending", "approved", "rejected"].includes(step.status)) {
      throw new ReimbursementError(403, "APPROVAL_FORBIDDEN", "Tahap approval ini bukan milik akun Anda.");
    }
    return step;
  }

  app.get("/reimbursements/approvals", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<{ claimedTotal: string; total: number }>(
        `SELECT step.id AS "stepId", claim.id AS "claimId", step.sources,
                requester.full_name AS "requesterName", requester.employee_number AS "requesterNumber",
                unit.name AS "unitName", claim.title, claim.claimed_total::text AS "claimedTotal",
                (SELECT count(*)::int FROM reimbursement_items item WHERE item.claim_id = claim.id) AS "itemCount",
                (SELECT count(*)::int FROM reimbursement_receipts receipt
                  WHERE receipt.claim_id = claim.id AND receipt.purged_at IS NULL) AS "receiptCount",
                trip.destination AS "tripDestination",
                claim.submitted_at AS "submittedAt", count(*) OVER ()::int AS total
           FROM reimbursement_approval_steps step
           JOIN reimbursement_claims claim ON claim.id = step.claim_id
           JOIN employees requester ON requester.id = claim.employee_id
           LEFT JOIN organizational_units unit ON unit.id = requester.organizational_unit_id
           LEFT JOIN business_trip_requests trip ON trip.id = claim.business_trip_id
          WHERE step.approver_employee_id = $1 AND step.status = 'pending' AND claim.status = 'IN_REVIEW'
          ORDER BY claim.submitted_at ASC, step.id ASC
          LIMIT $2 OFFSET $3`,
        [employee.id, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, claimedTotal, ...row }) => { void total; return { ...row, claimedTotal: amount(claimedTotal) }; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.get("/reimbursements/approvals/:stepId", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = stepParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Tahap tidak valid." });
    return handle(reply, async () => {
      const step = await approverStep(pool, params.data.stepId, principal.id);
      const detail = await loadClaimDetail(pool, step.claimId, "APPROVER");
      if (!detail) return send(reply, 404, { code: "REIMBURSEMENT_NOT_FOUND", message: "Klaim tidak ditemukan." });
      return send(reply, 200, detail);
    });
  });

  app.get("/reimbursements/approvals/:stepId/receipts/:receiptId", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = stepReceiptParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Bukti tidak valid." });
    return handle(reply, async () => {
      const step = await approverStep(pool, params.data.stepId, principal.id);
      return sendReceipt(reply, step.claimId, params.data.receiptId, { actorAccountId: principal.id, via: "APPROVER" });
    });
  });

  app.post("/reimbursements/approvals/:stepId/decision", async (request, reply) => {
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
      // Lock order claim -> step, the same as cancellation, so a racing cancel waits.
      await client.query(
        `SELECT 1 FROM reimbursement_claims
          WHERE id = (SELECT claim_id FROM reimbursement_approval_steps WHERE id = $1)
          FOR UPDATE`,
        [params.data.stepId],
      );
      const found = await client.query<{
        id: string; claimId: string; approverEmployeeId: string; claimStatus: ClaimStatus; requesterEmployeeId: string;
      }>(
        `SELECT step.id, step.claim_id AS "claimId", step.approver_employee_id AS "approverEmployeeId",
                claim.status AS "claimStatus", claim.employee_id AS "requesterEmployeeId"
           FROM reimbursement_approval_steps step
           JOIN reimbursement_claims claim ON claim.id = step.claim_id
          WHERE step.id = $1
          FOR UPDATE OF step, claim`,
        [params.data.stepId],
      );
      const current = found.rows[0];
      if (!current) throw new ReimbursementError(404, "APPROVAL_STEP_NOT_FOUND", "Tahap approval tidak ditemukan.");
      // REIMB-001-C: the snapshot owns the step; nothing else grants it.
      if (current.approverEmployeeId !== actor.id) {
        throw new ReimbursementError(403, "APPROVAL_FORBIDDEN", "Tahap approval ini bukan milik akun Anda.");
      }
      const all = await client.query<LeaveApprovalStepState>(
        `SELECT id, step_order AS "order", status
           FROM reimbursement_approval_steps WHERE claim_id = $1 ORDER BY step_order ASC`,
        [current.claimId],
      );
      const decision = decideLeaveApprovalStep({
        requestStatus: approvalRequestStatus(current.claimStatus),
        stepId: current.id,
        decision: body.data.decision,
        steps: all.rows,
      });
      const note = body.data.note ?? null;
      await client.query(
        `UPDATE reimbursement_approval_steps
            SET status = $2, acted_by_account_id = $3, acted_at = now(), decision_note = $4
          WHERE id = $1`,
        [current.id, decision.decidedStepStatus, principal.id, note],
      );
      if (decision.nextPendingStepId) {
        const next = await client.query<{ approverEmployeeId: string }>(
          `UPDATE reimbursement_approval_steps SET status = 'pending' WHERE id = $1
           RETURNING approver_employee_id AS "approverEmployeeId"`,
          [decision.nextPendingStepId],
        );
        await notifyEmployee(client, next.rows[0]!.approverEmployeeId, {
          eventKey: `reimbursement.approval.${decision.nextPendingStepId}`,
          category: "system",
          title: "Persetujuan reimbursement",
          body: "Klaim reimbursement pegawai menunggu keputusan Anda.",
          href: "/app/approvals",
          actorAccountId: principal.id,
        });
      }
      const claimStatus: ClaimStatus = decision.requestStatus === "approved"
        ? "APPROVED"
        : decision.requestStatus === "rejected" ? "REJECTED" : "IN_REVIEW";
      if (claimStatus === "APPROVED") {
        await client.query(
          `UPDATE reimbursement_claims SET status = 'APPROVED', final_decided_at = now(), updated_at = now() WHERE id = $1`,
          [current.claimId],
        );
      } else if (claimStatus === "REJECTED") {
        await client.query(
          `UPDATE reimbursement_claims
              SET status = 'REJECTED', rejected_by = 'APPROVER', reject_reason = $2, rejected_by_account_id = $3,
                  final_decided_at = now(), updated_at = now()
            WHERE id = $1`,
          [current.claimId, note, principal.id],
        );
      }
      await addEvent(
        client, current.claimId, principal.id,
        body.data.decision === "reject" ? "reimbursement.request.rejected" : "reimbursement.approval.approved_step",
        note, { stepId: current.id },
      );
      if (claimStatus === "APPROVED") await addEvent(client, current.claimId, principal.id, "reimbursement.request.approved");
      if (claimStatus !== "IN_REVIEW") {
        await notifyEmployee(client, current.requesterEmployeeId, {
          eventKey: `reimbursement.${current.claimId}.${claimStatus.toLowerCase()}`,
          category: "system",
          title: claimStatus === "APPROVED" ? "Reimbursement disetujui" : "Reimbursement ditolak",
          body: claimStatus === "APPROVED"
            ? "Klaim reimbursement Anda disetujui. Keuangan akan memeriksa bukti lalu membayarnya."
            : "Klaim reimbursement Anda ditolak. Lihat alasannya di riwayat.",
          href: `/app/reimbursements?claim=${current.claimId}`,
          actorAccountId: principal.id,
        });
      }
      return [200, {
        claimId: current.claimId,
        claimStatus,
        stepStatus: decision.decidedStepStatus,
        nextPendingStepId: decision.nextPendingStepId,
      }];
    });
  });

  // ------------------------------------------------------------------- admin

  /** ENG-LIST-001: every filter runs before LIMIT. Dates are the submission day in WIB. */
  function registerWhere(filter: {
    status?: string | undefined; category?: string | undefined; employeeId?: string | undefined;
    from?: string | undefined; to?: string | undefined;
  }) {
    return {
      sql: `claim.submitted_at IS NOT NULL
        AND ($1::text IS NULL OR claim.status = $1)
        AND ($2::text IS NULL OR EXISTS (
          SELECT 1 FROM reimbursement_items filter_item WHERE filter_item.claim_id = claim.id AND filter_item.category = $2))
        AND ($3::uuid IS NULL OR claim.employee_id = $3)
        AND ($4::date IS NULL OR (claim.submitted_at AT TIME ZONE 'Asia/Jakarta')::date >= $4::date)
        AND ($5::date IS NULL OR (claim.submitted_at AT TIME ZONE 'Asia/Jakarta')::date <= $5::date)`,
      values: [filter.status ?? null, filter.category ?? null, filter.employeeId ?? null, filter.from ?? null, filter.to ?? null],
    };
  }

  app.get("/admin/reimbursements", async (request, reply) => {
    if (!(await requirePermission(request, reply, "reimbursements.read"))) return;
    const query = adminListQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const where = registerWhere(query.data);
      const result = await pool.query<SummaryRow>(
        `SELECT ${SUMMARY_COLUMNS},
                claim.employee_id AS "employeeId", employee.full_name AS "employeeName",
                employee.employee_number AS "employeeNumber", unit.name AS "unitName",
                count(*) OVER ()::int AS total
           FROM reimbursement_claims claim
           JOIN employees employee ON employee.id = claim.employee_id
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
           ${SUMMARY_JOINS}
          WHERE ${where.sql}
          ORDER BY claim.submitted_at DESC, claim.id DESC
          LIMIT $6 OFFSET $7`,
        [...where.values, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(summary),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
        categories: categoryCatalog(),
      });
    });
  });

  // ENG-LIST-001 typeahead for the register filter: claimants only, never the wider register.
  app.get("/admin/reimbursements/claimants", async (request, reply) => {
    if (!(await requirePermission(request, reply, "reimbursements.read"))) return;
    const query = claimantQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_FILTER", message: "Kata kunci minimal 2 huruf." });
    return handle(reply, async () => {
      const result = await pool.query<{ total: number }>(
        `SELECT employee.id, employee.full_name AS "fullName", employee.employee_number AS "employeeNumber",
                unit.name AS "unitName", count(*) OVER ()::int AS total
           FROM employees employee
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
          WHERE EXISTS (SELECT 1 FROM reimbursement_claims claim
                         WHERE claim.employee_id = employee.id AND claim.submitted_at IS NOT NULL)
            AND (employee.full_name ILIKE $1 OR employee.employee_number ILIKE $1)
          ORDER BY employee.full_name ASC, employee.id ASC
          LIMIT $2 OFFSET $3`,
        [`%${query.data.q.replace(/[\\%_]/g, "\\$&")}%`, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, ...row }) => { void total; return row; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.get("/admin/reimbursements/summary", async (request, reply) => {
    if (!(await requirePermission(request, reply, "reimbursements.read"))) return;
    const query = periodQuery.safeParse(request.query);
    if (!query.success || !exportWindowOk(query.data.from, query.data.to)) {
      return send(reply, 400, { code: "INVALID_REIMBURSEMENT_PERIOD", message: `Isi rentang tanggal pengajuan paling lama ${MAX_EXPORT_DAYS} hari.` });
    }
    return handle(reply, async () => {
      const where = registerWhere(query.data);
      const [byStatus, byCategory] = await Promise.all([
        pool.query<{ status: ClaimStatus; claims: number; claimedTotal: string; verifiedTotal: string }>(
          `SELECT claim.status, count(*)::int AS claims, COALESCE(sum(claim.claimed_total), 0)::text AS "claimedTotal",
                  -- A claim Finance rejected after verifying keeps its verified total as history only.
                  COALESCE(sum(claim.verified_total) FILTER (WHERE claim.status IN ('VERIFIED', 'PAID')), 0)::text AS "verifiedTotal"
             FROM reimbursement_claims claim WHERE ${where.sql}
            GROUP BY claim.status ORDER BY claim.status`,
          where.values,
        ),
        pool.query<{ category: CategoryKey; items: number; claimedTotal: string; verifiedTotal: string; paidTotal: string }>(
          `SELECT item.category, count(*)::int AS items, COALESCE(sum(item.amount), 0)::text AS "claimedTotal",
                  COALESCE(sum(item.approved_amount) FILTER (WHERE claim.status IN ('VERIFIED', 'PAID')), 0)::text AS "verifiedTotal",
                  COALESCE(sum(item.approved_amount) FILTER (WHERE claim.status = 'PAID'), 0)::text AS "paidTotal"
             FROM reimbursement_items item
             JOIN reimbursement_claims claim ON claim.id = item.claim_id
            WHERE ${where.sql}
            GROUP BY item.category ORDER BY item.category`,
          where.values,
        ),
      ]);
      return send(reply, 200, {
        from: query.data.from,
        to: query.data.to,
        byStatus: byStatus.rows.map((row) => ({ ...row, claimedTotal: amount(row.claimedTotal), verifiedTotal: amount(row.verifiedTotal) })),
        byCategory: byCategory.rows.map((row) => ({
          ...row,
          label: CATEGORIES[row.category]?.label ?? row.category,
          claimedTotal: amount(row.claimedTotal),
          verifiedTotal: amount(row.verifiedTotal),
          paidTotal: amount(row.paidTotal),
        })),
      });
    });
  });

  app.get("/admin/reimbursements/export.csv", async (request, reply) => {
    const principal = await requirePermission(request, reply, "reimbursements.read");
    if (!principal) return;
    const query = periodQuery.safeParse(request.query);
    if (!query.success || !exportWindowOk(query.data.from, query.data.to)) {
      return send(reply, 400, { code: "INVALID_REIMBURSEMENT_PERIOD", message: `Isi rentang tanggal pengajuan paling lama ${MAX_EXPORT_DAYS} hari.` });
    }
    return handle(reply, async () => {
      const where = registerWhere(query.data);
      const count = await pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM reimbursement_claims claim WHERE ${where.sql}`, where.values,
      );
      const total = count.rows[0]?.total ?? 0;
      // ENG-LIST-001-H: complete or explicitly refused, never silently cut.
      if (total > MAX_EXPORT_ROWS) {
        return send(reply, 422, {
          code: "REIMBURSEMENT_EXPORT_TOO_LARGE",
          message: `Hasil ekspor ${total} baris melebihi batas ${MAX_EXPORT_ROWS}. Persempit rentang tanggal atau status.`,
        });
      }
      const rows = await pool.query<Record<string, string | null>>(
        `SELECT claim.id, employee.employee_number AS "employeeNumber", employee.full_name AS "employeeName",
                unit.name AS "unitName", claim.title,
                to_char(claim.submitted_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS "submittedOn",
                claim.status, (SELECT count(*)::text FROM reimbursement_items item WHERE item.claim_id = claim.id) AS "itemCount",
                claim.claimed_total::text AS "claimedTotal", claim.verified_total::text AS "verifiedTotal",
                to_char(payment.paid_on, 'YYYY-MM-DD') AS "paidOn", payment.method, payment.reference,
                trip.destination AS "tripDestination"
           FROM reimbursement_claims claim
           JOIN employees employee ON employee.id = claim.employee_id
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
           LEFT JOIN reimbursement_payments payment ON payment.claim_id = claim.id
           LEFT JOIN business_trip_requests trip ON trip.id = claim.business_trip_id
          WHERE ${where.sql}
          ORDER BY claim.submitted_at ASC, claim.id ASC`,
        where.values,
      );
      // The export is the one register read that leaves HCIS, so it is recorded (D-17).
      await addEvent(pool, null, principal.id, "reimbursement.register.exported", null, {
        from: query.data.from, to: query.data.to, status: query.data.status ?? null, rows: rows.rows.length,
      });
      const header = [
        "ID klaim", "NIP", "Nama", "Unit", "Judul", "Tanggal ajuan", "Status", "Jumlah baris",
        "Total klaim", "Total disetujui", "Tanggal bayar", "Cara bayar", "No. bukti", "Perjalanan dinas",
      ];
      const lines = [header.map(quoteCsvCell).join(",")];
      for (const row of rows.rows) {
        lines.push([
          row.id, row.employeeNumber, row.employeeName, row.unitName, row.title, row.submittedOn, row.status,
          row.itemCount, row.claimedTotal, row.verifiedTotal, row.paidOn, row.method, row.reference, row.tripDestination,
        ].map((cell) => quoteCsvCell(cell ?? "")).join(","));
      }
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="reimbursement-${query.data.from}-${query.data.to}.csv"`);
      // A byte-order mark so spreadsheet programs read the file as UTF-8.
      return send(reply, 200, `${String.fromCharCode(0xfeff)}${lines.join("\r\n")}\r\n`);
    });
  });

  app.get("/admin/reimbursements/:id", async (request, reply) => {
    if (!(await requirePermission(request, reply, "reimbursements.read"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Klaim tidak valid." });
    return handle(reply, async () => {
      const detail = await loadClaimDetail(pool, params.data.id, "REGISTER");
      if (!detail) return send(reply, 404, { code: "REIMBURSEMENT_NOT_FOUND", message: "Klaim tidak ditemukan." });
      return send(reply, 200, detail);
    });
  });

  app.get("/admin/reimbursements/:id/receipts/:receiptId", async (request, reply) => {
    const principal = await requirePermission(request, reply, "reimbursements.read");
    if (!principal) return;
    const params = receiptParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Bukti tidak valid." });
    return handle(reply, async () => {
      const submitted = await pool.query(
        `SELECT 1 FROM reimbursement_claims WHERE id = $1 AND submitted_at IS NOT NULL`, [params.data.id],
      );
      if (!submitted.rows[0]) return send(reply, 404, { code: "REIMBURSEMENT_NOT_FOUND", message: "Klaim tidak ditemukan." });
      return sendReceipt(reply, params.data.id, params.data.receiptId, { actorAccountId: principal.id, via: "REGISTER" });
    });
  });

  app.post("/admin/reimbursements/:id/verify", async (request, reply) => {
    const principal = await requirePermission(request, reply, "reimbursements.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Klaim tidak valid." });
    const body = verifyBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_REIMBURSEMENT_VERIFICATION", message: "Nominal disetujui per baris harus bilangan bulat rupiah." });
    }
    return transact(reply, async (client) => {
      const claim = await lockClaim(client, params.data.id, null);
      await assertNotOwnClaim(client, principal.id, claim.employeeId);
      if (claim.status !== "APPROVED") {
        throw new ReimbursementError(409, "REIMBURSEMENT_NOT_VERIFIABLE", "Hanya klaim yang sudah disetujui yang dapat diverifikasi.");
      }
      await assertNotApprover(client, params.data.id, principal.id);
      const stored = await client.query<{ id: string; amount: string }>(
        `SELECT id, amount::text AS amount FROM reimbursement_items WHERE claim_id = $1 ORDER BY line_no`,
        [params.data.id],
      );
      const note = body.data.note?.trim() || null;
      const result = verifyAmounts(
        stored.rows.map((item) => ({ id: item.id, amount: toRupiah(item.amount) })),
        body.data.items.map((item) => ({ itemId: item.itemId, approvedAmount: toRupiah(item.approvedAmount) })),
        note,
      );
      for (const [itemId, value] of result.approved) {
        await client.query(
          `UPDATE reimbursement_items SET approved_amount = $3::bigint WHERE id = $1 AND claim_id = $2`,
          [itemId, params.data.id, value.toString()],
        );
      }
      await client.query(
        `UPDATE reimbursement_claims
            SET status = 'VERIFIED', verified_total = $2::bigint, verified_by_account_id = $3, verified_at = now(),
                verification_note = $4, updated_at = now()
          WHERE id = $1`,
        [params.data.id, result.total.toString(), principal.id, note],
      );
      await addEvent(client, params.data.id, principal.id, "reimbursement.verified", note, {
        items: stored.rows.length, reducedItems: result.reduced,
      });
      await notifyEmployee(client, claim.employeeId, {
        eventKey: `reimbursement.${params.data.id}.verified`,
        category: "system",
        title: "Reimbursement diverifikasi",
        body: result.reduced > 0
          ? "Keuangan memverifikasi klaim reimbursement Anda dengan penyesuaian. Lihat rinciannya di detail klaim."
          : "Keuangan memverifikasi klaim reimbursement Anda dan akan segera membayarnya.",
        href: `/app/reimbursements?claim=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [200, { id: params.data.id, status: "VERIFIED", verifiedTotal: rupiahToJson(result.total), reducedItems: result.reduced }];
    });
  });

  app.post("/admin/reimbursements/:id/reject", async (request, reply) => {
    const principal = await requirePermission(request, reply, "reimbursements.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Klaim tidak valid." });
    const body = financeReasonBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_REJECTION", message: "Alasan penolakan minimal 10 karakter." });
    return transact(reply, async (client) => {
      const claim = await lockClaim(client, params.data.id, null);
      await assertNotOwnClaim(client, principal.id, claim.employeeId);
      if (!canFinanceReject(claim.status)) {
        throw new ReimbursementError(409, "REIMBURSEMENT_NOT_REJECTABLE", claim.status === "PAID"
          ? "Klaim ini sudah dibayar."
          : "Keuangan hanya dapat menolak klaim yang sudah disetujui dan belum dibayar.");
      }
      await client.query(
        `UPDATE reimbursement_claims
            SET status = 'REJECTED', rejected_by = 'FINANCE', reject_reason = $2, rejected_by_account_id = $3, updated_at = now()
          WHERE id = $1`,
        [params.data.id, body.data.reason, principal.id],
      );
      await addEvent(client, params.data.id, principal.id, "reimbursement.finance.rejected", body.data.reason, {
        previousStatus: claim.status,
      });
      await notifyEmployee(client, claim.employeeId, {
        eventKey: `reimbursement.${params.data.id}.finance_rejected`,
        category: "system",
        title: "Reimbursement ditolak Keuangan",
        body: "Keuangan menolak klaim reimbursement Anda. Lihat alasannya di riwayat.",
        href: `/app/reimbursements?claim=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [200, { id: params.data.id, status: "REJECTED" }];
    });
  });

  app.post("/admin/reimbursements/:id/pay", async (request, reply) => {
    const principal = await requirePermission(request, reply, "reimbursements.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_REIMBURSEMENT_ID", message: "Klaim tidak valid." });
    const body = payBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_REIMBURSEMENT_PAYMENT", message: "Tanggal bayar, cara bayar, atau kunci pengiriman tidak valid." });
    }
    return transact(reply, async (client) => {
      const claim = await lockClaim(client, params.data.id, null);
      await assertNotOwnClaim(client, principal.id, claim.employeeId);
      // D-10: one payment per claim. The same key with the same terms is a retry and replays.
      const existing = await client.query<{
        id: string; idempotencyKey: string; paidOn: string; method: string; amount: string;
        payrollMonth: string | null; reference: string | null; note: string | null;
      }>(
        `SELECT id, idempotency_key AS "idempotencyKey", to_char(paid_on, 'YYYY-MM-DD') AS "paidOn", method, amount::text AS amount,
                to_char(payroll_month, 'YYYY-MM') AS "payrollMonth", reference, note
           FROM reimbursement_payments WHERE claim_id = $1`,
        [params.data.id],
      );
      const previous = existing.rows[0];
      if (previous) {
        if (previous.idempotencyKey !== body.data.idempotencyKey) {
          throw new ReimbursementError(409, "REIMBURSEMENT_ALREADY_PAID", "Klaim ini sudah dibayar.");
        }
        const same = previous.paidOn === body.data.paidOn && previous.method === body.data.method
          && previous.payrollMonth === (body.data.method === "PAYROLL" ? body.data.payrollMonth ?? null : null)
          && previous.reference === (body.data.reference || null) && previous.note === (body.data.note || null);
        if (!same) {
          throw new ReimbursementError(409, "IDEMPOTENCY_KEY_REUSED", "Pembayaran ini sudah tercatat dengan nilai lain. Muat ulang halaman.");
        }
        return [200, { id: params.data.id, paymentId: previous.id, status: "PAID", amount: amount(previous.amount), idempotentReplay: true }];
      }
      if (claim.status !== "VERIFIED") {
        throw new ReimbursementError(409, "REIMBURSEMENT_NOT_PAYABLE", "Hanya klaim yang sudah diverifikasi Keuangan yang dapat dibayar.");
      }
      await assertNotApprover(client, params.data.id, principal.id);
      const payrollMonth = body.data.method === "PAYROLL" ? body.data.payrollMonth ?? null : null;
      validatePayment({
        paidOn: body.data.paidOn,
        verifiedOn: claim.verifiedOn!,
        today: today(),
        method: body.data.method,
        payrollMonth: body.data.payrollMonth ?? null,
        payrollHandoffEnabled,
      });
      const paymentId = randomUUID();
      await client.query(
        `INSERT INTO reimbursement_payments (
           id, claim_id, amount, paid_on, method, payroll_month, reference, note, idempotency_key, recorded_by_account_id
         ) VALUES ($1, $2, $3::bigint, $4::date, $5, ($6 || '-01')::date, $7, $8, $9, $10)`,
        [
          paymentId, params.data.id, claim.verifiedTotal, body.data.paidOn, body.data.method, payrollMonth,
          body.data.reference || null, body.data.note || null, body.data.idempotencyKey, principal.id,
        ],
      );
      await client.query(
        `UPDATE reimbursement_claims SET status = 'PAID', paid_at = now(), updated_at = now() WHERE id = $1`,
        [params.data.id],
      );
      await addEvent(client, params.data.id, principal.id, "reimbursement.paid", null, {
        paymentId, method: body.data.method, paidOn: body.data.paidOn, payrollMonth,
      });
      await notifyEmployee(client, claim.employeeId, {
        eventKey: `reimbursement.${params.data.id}.paid`,
        category: "system",
        title: "Reimbursement dibayar",
        body: body.data.method === "PAYROLL"
          ? `Klaim reimbursement Anda dibayarkan bersama gaji bulan ${payrollMonth}.`
          : "Keuangan mencatat pembayaran klaim reimbursement Anda. Lihat rinciannya di detail klaim.",
        href: `/app/reimbursements?claim=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [201, { id: params.data.id, paymentId, status: "PAID", amount: amount(claim.verifiedTotal), idempotentReplay: false }];
    });
  });
}
