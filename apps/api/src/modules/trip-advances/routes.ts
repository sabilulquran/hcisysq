// TRIP-002 routes: per diem rates, employee advance requests, APR-001 approval on the trip's own
// chain, Finance disbursement outside payroll, settlement against REIMB-001 claims, top-up and
// refunds, register and export. Spec: docs/domain/trip-advance-per-diem.md.
//
// trip_advances.* and trip_per_diem.manage are Finance/HC-only: legacy Super Admin compatibility
// never grants them, so the admin routes read the permission from the organization context
// directly. Employee and approver access is ownership (the session's employee, the snapshot step).
//
// Amounts appear in response bodies to the people allowed to see them, never in notifications,
// event metadata or logs. A database error loses its `detail` (which quotes the row) before it can
// reach the log.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { quoteCsvCell } from "../../lib/csv.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { TripAdvancePermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { jakartaDate } from "../documents/service.js";
import { decideLeaveApprovalStep, LeaveWorkflowError, type LeaveApprovalStepState } from "../leave/domain/request-workflow.js";
import { notifyEmployee } from "../notifications/service.js";
import {
  ACTIVE_TRIP_STATUSES,
  ADVANCE_STATUSES,
  ADVANCEABLE_TRIP_STATUSES,
  advanceLimit,
  applyRefund,
  approvalRequestStatus,
  assertAdvanceAmount,
  assertTransactionDate,
  canEmployeeCancel,
  canSubmitSettlement,
  DUE_ON_SQL,
  ENDED_TRIP_STATUSES,
  exportWindowOk,
  MAX_ADVANCE_EXPENSES,
  MAX_EXPORT_DAYS,
  MAX_EXPORT_ROWS,
  maxPerDiemDays,
  rupiahToJson,
  settle,
  SETTLEMENT_DUE_DAYS,
  toRupiah,
  TRANSACTION_METHODS,
  TripAdvancePolicyError,
  tripDays,
  UNSETTLED_STATUSES,
  ZONE_KEYS,
  zoneCatalog,
  ZONES,
  type AdvanceStatus,
  type ZoneKey,
} from "./domain.js";

type Queryable = Pool | PoolClient;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// JSON integers only: a fraction or a string is refused, never rounded (D-18).
const rupiah = (min: number) => z.number().int().min(min).max(1_000_000_000);
const text = (min: number, max: number) => z.string().trim().max(max)
  .refine((value) => [...value].length >= min, { message: `at least ${min} characters` });
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const createBody = z.object({
  businessTripId: z.string().uuid(),
  zone: z.enum(ZONE_KEYS),
  amount: rupiah(0),
  purpose: text(10, 1000),
  idempotencyKey: z.string().uuid(),
});
const estimateQuery = z.object({ tripId: z.string().uuid(), zone: z.enum(ZONE_KEYS) });
const idParams = z.object({ id: z.string().uuid() });
const stepParams = z.object({ stepId: z.string().uuid() });
const decisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), note: z.string().trim().max(1000).nullable().optional() }),
  z.object({ decision: z.literal("reject"), note: z.string().trim().min(5).max(1000) }),
]);
const employeeCancelBody = z.object({ reason: text(5, 500) });
const settlementRequestBody = z.object({ note: optionalText(1000) });
const financeReasonBody = z.object({ reason: text(10, 500) });
const transactionBody = z.object({
  paidOn: isoDate,
  method: z.enum(TRANSACTION_METHODS),
  reference: optionalText(200),
  note: optionalText(500),
  idempotencyKey: z.string().uuid(),
});
const refundBody = transactionBody.extend({ amount: rupiah(1) });
const settleBody = z.object({
  perDiemDays: z.number().int().min(0).max(30),
  note: optionalText(500),
  idempotencyKey: z.string().uuid(),
});
const rateBody = z.object({
  zone: z.enum(ZONE_KEYS),
  effectiveFrom: isoDate,
  dailyAmount: z.number().int().min(0).max(5_000_000),
  note: optionalText(500),
});
const statusFilter = z.enum(ADVANCE_STATUSES);
const myListQuery = pageQuerySchema.extend({ status: statusFilter.optional() });
const adminListQuery = pageQuerySchema.extend({
  status: statusFilter.optional(),
  employeeId: z.string().uuid().optional(),
  overdue: z.enum(["true", "false"]).optional(),
});
const periodQuery = z.object({ from: isoDate, to: isoDate, status: statusFilter.optional() });
const claimantQuery = pageQuerySchema.extend({ q: z.string().trim().min(2).max(100) });
const rateListQuery = pageQuerySchema.extend({ zone: z.enum(ZONE_KEYS).optional() });

class TripAdvanceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "TripAdvanceError";
  }
}

function send(reply: FastifyReply, status: number, body: unknown) {
  reply.header("Cache-Control", "no-store");
  return reply.status(status).send(body);
}

function today(): string {
  return jakartaDate(new Date());
}

const STATE_CONFLICT: [string, string] = ["TRIP_ADVANCE_STATE_CONFLICT", "Data uang muka sudah berubah. Muat ulang lalu coba lagi."];
/** Unique races a well-behaved client can lose. Anything else in class 23 is a bug, not a race. */
const UNIQUE_CONFLICTS: Record<string, [string, string]> = {
  trip_advance_approval_steps_one_pending_idx: [
    "APPROVAL_STATE_CONFLICT", "Tahap persetujuan aktif sudah berubah. Muat ulang sebelum mengambil keputusan.",
  ],
  trip_advances_employee_id_idempotency_key_key: STATE_CONFLICT,
  trip_advances_one_live_per_trip_idx: ["TRIP_ADVANCE_EXISTS", "Perjalanan ini sudah punya pengajuan uang muka."],
  trip_advance_transactions_advance_id_idempotency_key_key: STATE_CONFLICT,
  trip_advance_transactions_one_disbursement_idx: ["TRIP_ADVANCE_ALREADY_DISBURSED", "Uang muka ini sudah dicairkan."],
  trip_advance_transactions_one_top_up_idx: ["TRIP_ADVANCE_TOP_UP_ALREADY_PAID", "Selisih uang muka ini sudah dibayar."],
  trip_advance_settlement_claims_claim_id_key: STATE_CONFLICT,
  reimbursement_payments_claim_id_key: STATE_CONFLICT,
};

function knownError(error: unknown): TripAdvanceError | null {
  if (error instanceof TripAdvanceError) return error;
  if (error instanceof TripAdvancePolicyError || error instanceof LeaveWorkflowError) {
    return new TripAdvanceError(409, error.code, error.message);
  }
  const database = error as { code?: unknown; severity?: unknown; constraint?: unknown };
  if (database.code === "23505" && typeof database.severity === "string") {
    const conflict = UNIQUE_CONFLICTS[String(database.constraint)];
    if (conflict) return new TripAdvanceError(409, conflict[0], conflict[1]);
  }
  return null;
}

/** An unexpected database error keeps its code, constraint and message and loses `detail`. */
function scrubbed(error: unknown): unknown {
  const database = error as { code?: unknown; severity?: unknown; constraint?: unknown; message?: unknown };
  if (typeof database.code === "string" && typeof database.severity === "string") {
    return Object.assign(new Error(`trip advance database error ${database.code}: ${String(database.message)}`), {
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

interface EmployeeContext { id: string; fullName: string }

async function loadEmployeeContext(db: Queryable, accountId: string, lock = false): Promise<EmployeeContext> {
  const result = await db.query<EmployeeContext & { status: string }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status
       FROM accounts account
       JOIN employees employee ON employee.id = account.employee_id
      WHERE account.id = $1 AND account.principal_type = 'EMPLOYEE' AND account.status = 'active'
        AND employee.removed_at IS NULL
      ${lock ? "FOR NO KEY UPDATE OF employee" : ""}`,
    [accountId],
  );
  const employee = result.rows[0];
  if (!employee || employee.status !== "active") {
    throw new TripAdvanceError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return employee;
}

interface TripRow {
  id: string;
  employeeId: string;
  status: string;
  destination: string;
  startOn: string;
  endOn: string;
  cancelledOn: string | null;
}

const TRIP_COLUMNS = `trip.id, trip.employee_id AS "employeeId", trip.status, trip.destination,
  to_char(trip.start_on, 'YYYY-MM-DD') AS "startOn", to_char(trip.end_on, 'YYYY-MM-DD') AS "endOn",
  CASE WHEN trip.status = 'CANCELLED'
       THEN to_char((trip.updated_at AT TIME ZONE 'Asia/Jakarta')::date, 'YYYY-MM-DD') END AS "cancelledOn"`;

async function loadTrip(db: Queryable, tripId: string, lock: "" | "FOR SHARE" = "") {
  const found = await db.query<TripRow>(`SELECT ${TRIP_COLUMNS} FROM business_trip_requests trip WHERE trip.id = $1 ${lock}`, [tripId]);
  return found.rows[0] ?? null;
}

/** D-02: the latest version of the zone's rate effective on `on`; a same-day correction wins. */
async function rateInForce(db: Queryable, zone: string, on: string) {
  const found = await db.query<{ id: string; dailyAmount: string; effectiveFrom: string }>(
    `SELECT id, daily_amount::text AS "dailyAmount", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom"
       FROM trip_per_diem_rates
      WHERE zone = $1 AND effective_from <= $2::date
      ORDER BY effective_from DESC, created_at DESC, id DESC
      LIMIT 1`,
    [zone, on],
  );
  const row = found.rows[0];
  return row ? { id: row.id, dailyAmount: toRupiah(row.dailyAmount), effectiveFrom: row.effectiveFrom } : null;
}

interface ChainStep { employeeId: string; name: string; sources: string[] }

/**
 * D-05: the trip's own snapshotted chain, in order. Every approver must still be an active,
 * HCIS-managed employee with an active account, or nothing is stored.
 */
async function copyTripChain(db: Queryable, tripId: string): Promise<ChainStep[]> {
  const found = await db.query<{
    employeeId: string; name: string; sources: string[]; status: string | null; scope: string | null; accountStatus: string | null;
  }>(
    `SELECT step.approver_employee_id AS "employeeId", employee.full_name AS name, step.sources,
            CASE WHEN employee.removed_at IS NULL THEN employee.status END AS status,
            employee.management_scope AS scope, account.status AS "accountStatus"
       FROM business_trip_approval_steps step
       JOIN employees employee ON employee.id = step.approver_employee_id
       LEFT JOIN LATERAL (
         SELECT candidate.status FROM accounts candidate
          WHERE candidate.employee_id = employee.id AND candidate.principal_type = 'EMPLOYEE'
          ORDER BY (candidate.status = 'active') DESC, candidate.id
          LIMIT 1
       ) account ON true
      WHERE step.request_id = $1
      ORDER BY step.step_order ASC`,
    [tripId],
  );
  if (found.rows.length === 0) {
    throw new TripAdvanceError(409, "APPROVAL_CHAIN_EMPTY", "Perjalanan ini tidak punya rantai persetujuan.");
  }
  const seen = new Set<string>();
  const chain: ChainStep[] = [];
  for (const row of found.rows) {
    if (row.status !== "active" || row.scope !== "MANAGED") {
      throw new TripAdvanceError(409, "APPROVER_NOT_ACTIVE", "Rantai approval berisi approver yang tidak aktif.");
    }
    if (row.accountStatus !== "active") {
      throw new TripAdvanceError(409, "APPROVER_ACCOUNT_NOT_READY", `Akun approver ${row.name} belum aktif.`);
    }
    if (seen.has(row.employeeId)) continue;
    seen.add(row.employeeId);
    chain.push({ employeeId: row.employeeId, name: row.name, sources: row.sources });
  }
  return chain;
}

async function addEvent(
  db: Queryable,
  advanceId: string | null,
  actorAccountId: string | null,
  eventType: string,
  note: string | null = null,
  metadata: Record<string, unknown> = {},
) {
  await db.query(
    `INSERT INTO trip_advance_events (id, advance_id, event_type, actor_account_id, note, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [randomUUID(), advanceId, eventType, actorAccountId, note, JSON.stringify(metadata)],
  );
}

const SUMMARY_COLUMNS = `
  advance.id, advance.status, advance.zone, advance.amount::text AS amount, advance.purpose,
  advance.submitted_at AS "submittedAt", advance.settlement_balance::text AS "settlementBalance",
  advance.business_trip_id AS "businessTripId", trip.destination AS "tripDestination", trip.status AS "tripStatus",
  to_char(trip.start_on, 'YYYY-MM-DD') AS "tripStartOn", to_char(trip.end_on, 'YYYY-MM-DD') AS "tripEndOn",
  to_char(${DUE_ON_SQL}, 'YYYY-MM-DD') AS "dueOn",
  (advance.status = 'DISBURSED' AND $1::date > ${DUE_ON_SQL}) AS overdue,
  approver.full_name AS "currentApproverName"`;
const SUMMARY_JOINS = `
  JOIN business_trip_requests trip ON trip.id = advance.business_trip_id
  LEFT JOIN trip_advance_approval_steps current_step
    ON current_step.advance_id = advance.id AND current_step.status = 'pending'
  LEFT JOIN employees approver ON approver.id = current_step.approver_employee_id`;

type SummaryRow = { amount: string; settlementBalance: string | null; zone: ZoneKey; total?: number } & Record<string, unknown>;

function summary({ amount: value, settlementBalance, total, ...row }: SummaryRow) {
  void total;
  return { ...row, zoneLabel: ZONES[row.zone] ?? row.zone, amount: amount(value), settlementBalance: optionalAmount(settlementBalance) };
}

/**
 * One advance with its trip, steps, transactions, settled claims, the trip's linked claims, the
 * settlement preview and history — all bounded by the advance itself (one trip, one employee).
 */
async function loadAdvanceDetail(db: Queryable, id: string, ownerEmployeeId: string | null) {
  const on = today();
  const found = await db.query<SummaryRow & {
    employeeId: string; perDiemDays: number | null; perDiemRate: string | null; perDiemAmount: string | null;
    claimsTotal: string | null; tripStatus: string; tripStartOn: string; tripEndOn: string; zone: ZoneKey;
  }>(
    `SELECT ${SUMMARY_COLUMNS},
            advance.employee_id AS "employeeId", employee.full_name AS "employeeName",
            employee.employee_number AS "employeeNumber", unit.name AS "unitName",
            advance.final_decided_at AS "finalDecidedAt", advance.disbursed_at AS "disbursedAt",
            advance.settlement_submitted_at AS "settlementSubmittedAt", advance.settlement_note AS "settlementNote",
            advance.per_diem_days AS "perDiemDays", advance.per_diem_rate::text AS "perDiemRate",
            advance.per_diem_amount::text AS "perDiemAmount", advance.claims_total::text AS "claimsTotal",
            advance.settlement_finance_note AS "settlementFinanceNote", advance.settled_at AS "settledAt",
            advance.closed_at AS "closedAt", advance.rejected_by AS "rejectedBy", advance.reject_reason AS "rejectReason",
            advance.cancel_reason AS "cancelReason"
       FROM trip_advances advance
       JOIN employees employee ON employee.id = advance.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       ${SUMMARY_JOINS}
      WHERE advance.id = $2 AND ($3::uuid IS NULL OR advance.employee_id = $3)`,
    [on, id, ownerEmployeeId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const owner = ownerEmployeeId !== null;
  const [steps, transactions, settled, linked, events, rate] = await Promise.all([
    db.query(
      `SELECT step.id, step.step_order AS "order", step.status, step.sources, approver.full_name AS "approverName",
              step.acted_at AS "actedAt", step.decision_note AS "decisionNote"
         FROM trip_advance_approval_steps step
         JOIN employees approver ON approver.id = step.approver_employee_id
        WHERE step.advance_id = $1 ORDER BY step.step_order ASC`,
      [id],
    ),
    db.query<{ amount: string } & Record<string, unknown>>(
      `SELECT transaction.id, transaction.kind, transaction.amount::text AS amount,
              to_char(transaction.transacted_on, 'YYYY-MM-DD') AS "transactedOn", transaction.method,
              transaction.reference, transaction.note, transaction.recorded_at AS "recordedAt",
              recorder.full_name AS "recordedByName"
         FROM trip_advance_transactions transaction
         LEFT JOIN accounts account ON account.id = transaction.recorded_by_account_id
         LEFT JOIN employees recorder ON recorder.id = account.employee_id
        WHERE transaction.advance_id = $1
        ORDER BY transaction.recorded_at ASC, transaction.id ASC`,
      [id],
    ),
    db.query<{ verifiedTotal: string } & Record<string, unknown>>(
      `SELECT settled.claim_id AS "claimId", claim.title, settled.verified_total::text AS "verifiedTotal"
         FROM trip_advance_settlement_claims settled
         JOIN reimbursement_claims claim ON claim.id = settled.claim_id
        WHERE settled.advance_id = $1
        ORDER BY claim.submitted_at ASC, claim.id ASC`,
      [id],
    ),
    // The trip's claims by this employee; drafts stay private to their owner.
    db.query<{ claimedTotal: string; verifiedTotal: string | null } & Record<string, unknown>>(
      `SELECT claim.id, claim.title, claim.status, claim.claimed_total::text AS "claimedTotal",
              claim.verified_total::text AS "verifiedTotal"
         FROM reimbursement_claims claim
        WHERE claim.employee_id = $1 AND claim.business_trip_id = $2
          AND claim.status <> 'CANCELLED' AND ($3::boolean OR claim.submitted_at IS NOT NULL)
        ORDER BY claim.created_at ASC, claim.id ASC`,
      [row.employeeId, row.businessTripId, owner],
    ),
    db.query(
      `SELECT event.id, event.event_type AS "eventType", event.occurred_at AS "occurredAt",
              event.note, event.metadata, actor.full_name AS "actorName"
         FROM trip_advance_events event
         LEFT JOIN accounts account ON account.id = event.actor_account_id
         LEFT JOIN employees actor ON actor.id = account.employee_id
        WHERE event.advance_id = $1
        ORDER BY event.occurred_at ASC, event.id ASC`,
      [id],
    ),
    rateInForce(db, row.zone, row.tripStartOn),
  ]);
  const refunded = transactions.rows
    .filter((transaction) => transaction.kind === "REFUND")
    .reduce((sum, transaction) => sum + toRupiah(transaction.amount), 0n);
  const balance = row.settlementBalance === null ? null : toRupiah(row.settlementBalance);
  const maxDays = maxPerDiemDays({ status: row.tripStatus, startOn: row.tripStartOn, endOn: row.tripEndOn });
  return {
    ...summary(row),
    perDiemDays: row.perDiemDays,
    perDiemRate: optionalAmount(row.perDiemRate),
    perDiemAmount: optionalAmount(row.perDiemAmount),
    claimsTotal: optionalAmount(row.claimsTotal),
    refundedTotal: rupiahToJson(refunded),
    refundOutstanding: balance !== null && balance < 0n ? rupiahToJson(-balance - refunded) : 0,
    steps: steps.rows,
    transactions: transactions.rows.map((transaction) => ({ ...transaction, amount: amount(transaction.amount) })),
    settledClaims: settled.rows.map((claim) => ({ ...claim, verifiedTotal: amount(claim.verifiedTotal) })),
    linkedClaims: linked.rows.map((claim) => ({
      ...claim, claimedTotal: amount(claim.claimedTotal), verifiedTotal: optionalAmount(claim.verifiedTotal),
    })),
    // What a settlement would count today (D-10); the settle route recomputes it under lock.
    settlementPreview: {
      maxPerDiemDays: maxDays,
      tripDays: tripDays(row.tripStartOn, row.tripEndOn),
      dailyRate: rate ? rupiahToJson(rate.dailyAmount) : null,
      rateEffectiveFrom: rate?.effectiveFrom ?? null,
      verifiedClaims: linked.rows.filter((claim) => claim.status === "VERIFIED").length,
      pendingClaims: linked.rows.filter((claim) => claim.status === "IN_REVIEW" || claim.status === "APPROVED").length,
      openClaims: linked.rows.filter((claim) => claim.status === "DRAFT" || claim.status === "IN_REVIEW").length,
    },
    events: events.rows,
  };
}

export async function registerTripAdvanceRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for trip advance routes");
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
      await send(reply, 403, { code: "FORBIDDEN", message: "Uang muka dinas hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  /** Passes when the account holds any of `permissions` at organization scope. */
  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    ...permissions: TripAdvancePermission[]
  ): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!permissions.some((permission) => context.organizationPermissions.includes(permission))) {
      await send(reply, 403, { code: "TRIP_ADVANCE_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
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
      // The money invariants are deferred triggers (migration 0157); COMMIT is where they run.
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function transact(reply: FastifyReply, work: (client: PoolClient) => Promise<[number, unknown]>) {
    return handle(reply, async () => {
      const [status, body] = await inTransaction(work);
      return send(reply, status, body);
    });
  }

  interface LockedAdvance {
    employeeId: string;
    businessTripId: string;
    status: AdvanceStatus;
    zone: ZoneKey;
    amount: string;
    decidedOn: string | null;
    settledOn: string | null;
    settlementKey: string | null;
    perDiemDays: number | null;
    settlementFinanceNote: string | null;
    settlementBalance: string | null;
  }

  async function lockAdvance(client: PoolClient, id: string, ownerEmployeeId: string | null): Promise<LockedAdvance> {
    const found = await client.query<LockedAdvance>(
      `SELECT employee_id AS "employeeId", business_trip_id AS "businessTripId", status, zone, amount::text AS amount,
              to_char(final_decided_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS "decidedOn",
              to_char(settled_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS "settledOn",
              settlement_key AS "settlementKey", settlement_balance::text AS "settlementBalance",
              per_diem_days AS "perDiemDays", settlement_finance_note AS "settlementFinanceNote"
         FROM trip_advances
        WHERE id = $1 AND ($2::uuid IS NULL OR employee_id = $2)
        FOR UPDATE`,
      [id, ownerEmployeeId],
    );
    const advance = found.rows[0];
    if (!advance) throw new TripAdvanceError(404, "TRIP_ADVANCE_NOT_FOUND", "Uang muka tidak ditemukan.");
    return advance;
  }

  /** D-16: Finance never processes its own advance. */
  async function assertNotOwn(db: Queryable, actorAccountId: string, employeeId: string) {
    const actor = await db.query<{ employeeId: string | null }>(`SELECT employee_id AS "employeeId" FROM accounts WHERE id = $1`, [actorAccountId]);
    if (actor.rows[0]?.employeeId === employeeId) {
      throw new TripAdvanceError(403, "TRIP_ADVANCE_SELF_ACTION_FORBIDDEN", "Uang muka milik Anda sendiri harus diproses petugas lain.");
    }
  }

  /** D-16: whoever sits in this advance's chain does not also pay money out on it. */
  async function assertNotApprover(db: Queryable, advanceId: string, actorAccountId: string) {
    const approver = await db.query(
      `SELECT 1 FROM trip_advance_approval_steps step
        WHERE step.advance_id = $1
          AND (step.acted_by_account_id = $2
            OR step.approver_employee_id = (SELECT employee_id FROM accounts WHERE id = $2))
        LIMIT 1`,
      [advanceId, actorAccountId],
    );
    if (approver.rows[0]) {
      throw new TripAdvanceError(403, "TRIP_ADVANCE_APPROVER_CANNOT_PROCESS", "Penyetuju uang muka ini tidak boleh sekaligus mengeluarkan uangnya.");
    }
  }

  // ---------------------------------------------------------------- employee

  /** D-04: the employee's own trip in a status an advance may be asked for. */
  async function eligibleTrip(db: Queryable, tripId: string, employeeId: string, lock: "" | "FOR SHARE" = "") {
    const trip = await loadTrip(db, tripId, lock);
    if (!trip || trip.employeeId !== employeeId || !(ADVANCEABLE_TRIP_STATUSES as readonly string[]).includes(trip.status)) {
      throw new TripAdvanceError(409, "TRIP_ADVANCE_TRIP_NOT_ELIGIBLE", "Pilih perjalanan dinas Anda yang sedang diajukan, disetujui, atau sudah terbit surat tugasnya.");
    }
    return trip;
  }

  async function estimate(db: Queryable, trip: TripRow, zone: ZoneKey) {
    const days = tripDays(trip.startOn, trip.endOn);
    const rate = await rateInForce(db, zone, trip.startOn);
    const limit = advanceLimit(days, rate?.dailyAmount ?? null);
    return { days, rate, ...limit };
  }

  app.get("/trip-advances/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = myListQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<SummaryRow>(
        `SELECT ${SUMMARY_COLUMNS}, count(*) OVER ()::int AS total
           FROM trip_advances advance ${SUMMARY_JOINS}
          WHERE advance.employee_id = $2 AND ($3::text IS NULL OR advance.status = $3)
          ORDER BY advance.submitted_at DESC, advance.id DESC
          LIMIT $4 OFFSET $5`,
        [today(), employee.id, query.data.status ?? null, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(summary),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
        zones: zoneCatalog(),
        policy: { maxAdvanceExpenses: rupiahToJson(MAX_ADVANCE_EXPENSES), settlementDueDays: SETTLEMENT_DUE_DAYS },
      });
    });
  });

  app.get("/trip-advances/me/trips", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_FILTER", message: "Halaman tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<{ total: number }>(
        `SELECT trip.id, trip.destination, to_char(trip.start_on, 'YYYY-MM-DD') AS "startOn",
                to_char(trip.end_on, 'YYYY-MM-DD') AS "endOn", trip.status, count(*) OVER ()::int AS total
           FROM business_trip_requests trip
          WHERE trip.employee_id = $1 AND trip.status = ANY($2::text[])
            AND NOT EXISTS (SELECT 1 FROM trip_advances advance
                             WHERE advance.business_trip_id = trip.id AND advance.status NOT IN ('REJECTED', 'CANCELLED'))
          ORDER BY trip.start_on DESC, trip.id DESC
          LIMIT $3 OFFSET $4`,
        [employee.id, [...ADVANCEABLE_TRIP_STATUSES], query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, ...row }) => { void total; return row; }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.get("/trip-advances/me/estimate", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = estimateQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE", message: "Pilih perjalanan dan zona." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const trip = await eligibleTrip(pool, query.data.tripId, employee.id);
      const result = await estimate(pool, trip, query.data.zone);
      const chain = await copyTripChain(pool, trip.id);
      return send(reply, 200, {
        tripId: trip.id,
        zone: query.data.zone,
        days: result.days,
        dailyRate: result.rate ? rupiahToJson(result.rate.dailyAmount) : null,
        rateEffectiveFrom: result.rate?.effectiveFrom ?? null,
        perDiemEstimate: rupiahToJson(result.perDiemEstimate),
        maxAmount: rupiahToJson(result.maxAmount),
        approvalChain: chain,
      });
    });
  });

  app.get("/trip-advances/me/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_ID", message: "Uang muka tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      // TRIP-002-A: another employee's advance is indistinguishable from a missing one.
      const detail = await loadAdvanceDetail(pool, params.data.id, employee.id);
      if (!detail) return send(reply, 404, { code: "TRIP_ADVANCE_NOT_FOUND", message: "Uang muka tidak ditemukan." });
      return send(reply, 200, detail);
    });
  });

  app.post("/trip-advances/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = createBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, {
        code: "INVALID_TRIP_ADVANCE",
        message: "Perjalanan, zona, nominal bilangan bulat rupiah, dan rincian perkiraan (10–1000 karakter) wajib diisi.",
      });
    }
    return transact(reply, async (client) => {
      // Locking the employee row serializes this employee's requests (idempotency, one per trip).
      const employee = await loadEmployeeContext(client, principal.id, true);
      const replay = await client.query<{ id: string; status: AdvanceStatus; tripId: string; zone: string; amount: string; purpose: string }>(
        `SELECT id, status, business_trip_id AS "tripId", zone, amount::text AS amount, purpose
           FROM trip_advances WHERE employee_id = $1 AND idempotency_key = $2`,
        [employee.id, body.data.idempotencyKey],
      );
      const previous = replay.rows[0];
      if (previous) {
        // A retry replays only with the same terms; a reused key with other terms is refused.
        if (previous.tripId !== body.data.businessTripId || previous.zone !== body.data.zone
          || toRupiah(previous.amount) !== toRupiah(body.data.amount) || previous.purpose !== body.data.purpose) {
          throw new TripAdvanceError(409, "IDEMPOTENCY_KEY_REUSED", "Pengajuan ini sudah terkirim dengan isian lain. Muat ulang halaman.");
        }
        return [200, { id: previous.id, status: previous.status, idempotentReplay: true }];
      }
      const trip = await eligibleTrip(client, body.data.businessTripId, employee.id, "FOR SHARE");
      const live = await client.query(
        `SELECT 1 FROM trip_advances WHERE business_trip_id = $1 AND status NOT IN ('REJECTED', 'CANCELLED')`,
        [trip.id],
      );
      if (live.rows[0]) throw new TripAdvanceError(409, "TRIP_ADVANCE_EXISTS", "Perjalanan ini sudah punya pengajuan uang muka.");
      const value = toRupiah(body.data.amount);
      const limit = await estimate(client, trip, body.data.zone);
      assertAdvanceAmount(value, limit.maxAmount);
      const chain = await copyTripChain(client, trip.id);
      const id = randomUUID();
      await client.query(
        `INSERT INTO trip_advances (id, employee_id, business_trip_id, zone, amount, purpose, status, idempotency_key, approval_snapshot)
         VALUES ($1, $2, $3, $4, $5::bigint, $6, 'IN_REVIEW', $7, $8::jsonb)`,
        [
          id, employee.id, trip.id, body.data.zone, value.toString(), body.data.purpose, body.data.idempotencyKey,
          JSON.stringify({ source: "TRIP", tripId: trip.id, steps: chain.map((step) => ({ employeeId: step.employeeId, sources: step.sources })) }),
        ],
      );
      const steps: Array<{ id: string; employeeId: string; name: string }> = [];
      for (const [index, step] of chain.entries()) {
        const stepId = randomUUID();
        await client.query(
          `INSERT INTO trip_advance_approval_steps (id, advance_id, step_order, approver_employee_id, sources, status)
           VALUES ($1, $2, $3, $4, $5::text[], $6)`,
          [stepId, id, index + 1, step.employeeId, step.sources, index === 0 ? "pending" : "waiting"],
        );
        steps.push({ id: stepId, employeeId: step.employeeId, name: step.name });
      }
      await addEvent(client, id, principal.id, "trip_advance.request.submitted", null, {
        tripId: trip.id, zone: body.data.zone, perDiemOnly: value === 0n, approvers: steps.length,
      });
      const first = steps[0]!;
      await notifyEmployee(client, first.employeeId, {
        eventKey: `trip_advance.approval.${first.id}`,
        category: "system",
        title: "Persetujuan uang muka dinas",
        body: `${employee.fullName} mengajukan uang muka perjalanan dinas.`,
        href: "/app/approvals",
        actorAccountId: principal.id,
      });
      return [201, { id, status: "IN_REVIEW", approvalChain: steps, idempotentReplay: false }];
    });
  });

  app.post("/trip-advances/me/:id/cancel", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_ID", message: "Uang muka tidak valid." });
    const body = employeeCancelBody.safeParse(request.body ?? {});
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_CANCEL", message: "Alasan pembatalan 5–500 karakter." });
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id);
      const advance = await lockAdvance(client, params.data.id, employee.id);
      if (!canEmployeeCancel(advance.status)) {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_NOT_CANCELLABLE", "Uang muka yang sudah dicairkan diselesaikan lewat pertanggungjawaban.");
      }
      await client.query(
        `UPDATE trip_advances SET status = 'CANCELLED', cancel_reason = $2, cancelled_by_account_id = $3, updated_at = now() WHERE id = $1`,
        [params.data.id, body.data.reason, principal.id],
      );
      await client.query(
        `UPDATE trip_advance_approval_steps SET status = 'cancelled' WHERE advance_id = $1 AND status IN ('waiting', 'pending')`,
        [params.data.id],
      );
      await addEvent(client, params.data.id, principal.id, "trip_advance.request.cancelled", body.data.reason, {
        by: "employee", previousStatus: advance.status,
      });
      return [200, { id: params.data.id, status: "CANCELLED" }];
    });
  });

  app.post("/trip-advances/me/:id/settlement", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_ID", message: "Uang muka tidak valid." });
    const body = settlementRequestBody.safeParse(request.body ?? {});
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_SETTLEMENT", message: "Catatan paling banyak 1000 karakter." });
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id);
      const advance = await lockAdvance(client, params.data.id, employee.id);
      if (!canSubmitSettlement(advance.status, toRupiah(advance.amount))) {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_NOT_SETTLEABLE", "Pertanggungjawaban diajukan setelah uang muka dicairkan.");
      }
      const trip = (await loadTrip(client, advance.businessTripId, "FOR SHARE"))!;
      // D-08: after the return date, or at once when the trip never happened.
      if (!(ENDED_TRIP_STATUSES as readonly string[]).includes(trip.status) && today() < trip.endOn) {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_TRIP_NOT_ENDED", "Pertanggungjawaban diajukan pada atau sesudah tanggal kembali.");
      }
      const open = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM reimbursement_claims
          WHERE employee_id = $1 AND business_trip_id = $2 AND status IN ('DRAFT', 'IN_REVIEW')`,
        [employee.id, trip.id],
      );
      if (open.rows[0]?.count) {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_CLAIMS_OPEN", "Kirim atau buang draf klaim perjalanan ini, dan tunggu klaim yang dikirim selesai disetujui atasan.");
      }
      const note = body.data.note?.trim() || null;
      await client.query(
        `UPDATE trip_advances SET status = 'SETTLEMENT_SUBMITTED', settlement_submitted_at = now(), settlement_note = $2, updated_at = now()
          WHERE id = $1`,
        [params.data.id, note],
      );
      await addEvent(client, params.data.id, principal.id, "trip_advance.settlement.submitted", note);
      return [200, { id: params.data.id, status: "SETTLEMENT_SUBMITTED" }];
    });
  });

  // ---------------------------------------------------------------- approver

  app.get("/trip-advances/approvals", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<{ amount: string; zone: ZoneKey; total: number }>(
        `SELECT step.id AS "stepId", advance.id AS "advanceId", step.sources,
                requester.full_name AS "requesterName", requester.employee_number AS "requesterNumber",
                unit.name AS "unitName", advance.zone, advance.amount::text AS amount, advance.purpose,
                trip.destination AS "tripDestination", to_char(trip.start_on, 'YYYY-MM-DD') AS "tripStartOn",
                to_char(trip.end_on, 'YYYY-MM-DD') AS "tripEndOn", advance.submitted_at AS "submittedAt",
                count(*) OVER ()::int AS total
           FROM trip_advance_approval_steps step
           JOIN trip_advances advance ON advance.id = step.advance_id
           JOIN business_trip_requests trip ON trip.id = advance.business_trip_id
           JOIN employees requester ON requester.id = advance.employee_id
           LEFT JOIN organizational_units unit ON unit.id = requester.organizational_unit_id
          WHERE step.approver_employee_id = $1 AND step.status = 'pending' AND advance.status = 'IN_REVIEW'
          ORDER BY advance.submitted_at ASC, step.id ASC
          LIMIT $2 OFFSET $3`,
        [employee.id, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, amount: value, ...row }) => {
          void total;
          return { ...row, zoneLabel: ZONES[row.zone] ?? row.zone, amount: amount(value) };
        }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.post("/trip-advances/approvals/:stepId/decision", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = stepParams.safeParse(request.params);
    const body = decisionBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return send(reply, 400, { code: "INVALID_APPROVAL_DECISION", message: "Keputusan tidak valid. Penolakan wajib disertai alasan minimal 5 karakter." });
    }
    return transact(reply, async (client) => {
      const actor = await loadEmployeeContext(client, principal.id);
      // Lock order advance -> step, the same as cancellation.
      await client.query(
        `SELECT 1 FROM trip_advances WHERE id = (SELECT advance_id FROM trip_advance_approval_steps WHERE id = $1) FOR UPDATE`,
        [params.data.stepId],
      );
      const found = await client.query<{
        id: string; advanceId: string; approverEmployeeId: string; advanceStatus: AdvanceStatus; requesterEmployeeId: string; amount: string;
      }>(
        `SELECT step.id, step.advance_id AS "advanceId", step.approver_employee_id AS "approverEmployeeId",
                advance.status AS "advanceStatus", advance.employee_id AS "requesterEmployeeId", advance.amount::text AS amount
           FROM trip_advance_approval_steps step
           JOIN trip_advances advance ON advance.id = step.advance_id
          WHERE step.id = $1
          FOR UPDATE OF step, advance`,
        [params.data.stepId],
      );
      const current = found.rows[0];
      if (!current) throw new TripAdvanceError(404, "APPROVAL_STEP_NOT_FOUND", "Tahap approval tidak ditemukan.");
      if (current.approverEmployeeId !== actor.id) {
        throw new TripAdvanceError(403, "APPROVAL_FORBIDDEN", "Tahap approval ini bukan milik akun Anda.");
      }
      const all = await client.query<LeaveApprovalStepState>(
        `SELECT id, step_order AS "order", status FROM trip_advance_approval_steps WHERE advance_id = $1 ORDER BY step_order ASC`,
        [current.advanceId],
      );
      const decision = decideLeaveApprovalStep({
        requestStatus: approvalRequestStatus(current.advanceStatus),
        stepId: current.id,
        decision: body.data.decision,
        steps: all.rows,
      });
      const note = body.data.note ?? null;
      await client.query(
        `UPDATE trip_advance_approval_steps SET status = $2, acted_by_account_id = $3, acted_at = now(), decision_note = $4 WHERE id = $1`,
        [current.id, decision.decidedStepStatus, principal.id, note],
      );
      if (decision.nextPendingStepId) {
        const next = await client.query<{ approverEmployeeId: string }>(
          `UPDATE trip_advance_approval_steps SET status = 'pending' WHERE id = $1 RETURNING approver_employee_id AS "approverEmployeeId"`,
          [decision.nextPendingStepId],
        );
        await notifyEmployee(client, next.rows[0]!.approverEmployeeId, {
          eventKey: `trip_advance.approval.${decision.nextPendingStepId}`,
          category: "system",
          title: "Persetujuan uang muka dinas",
          body: "Uang muka perjalanan dinas pegawai menunggu keputusan Anda.",
          href: "/app/approvals",
          actorAccountId: principal.id,
        });
      }
      const status: AdvanceStatus = decision.requestStatus === "approved"
        ? "APPROVED" : decision.requestStatus === "rejected" ? "REJECTED" : "IN_REVIEW";
      if (status === "APPROVED") {
        await client.query(`UPDATE trip_advances SET status = 'APPROVED', final_decided_at = now(), updated_at = now() WHERE id = $1`, [current.advanceId]);
      } else if (status === "REJECTED") {
        await client.query(
          `UPDATE trip_advances SET status = 'REJECTED', rejected_by = 'APPROVER', reject_reason = $2, rejected_by_account_id = $3,
                  final_decided_at = now(), updated_at = now()
            WHERE id = $1`,
          [current.advanceId, note, principal.id],
        );
      }
      await addEvent(
        client, current.advanceId, principal.id,
        body.data.decision === "reject" ? "trip_advance.request.rejected" : "trip_advance.approval.approved_step",
        note, { stepId: current.id },
      );
      if (status === "APPROVED") await addEvent(client, current.advanceId, principal.id, "trip_advance.request.approved");
      if (status !== "IN_REVIEW") {
        const perDiemOnly = toRupiah(current.amount) === 0n;
        await notifyEmployee(client, current.requesterEmployeeId, {
          eventKey: `trip_advance.${current.advanceId}.${status.toLowerCase()}`,
          category: "system",
          title: status === "APPROVED" ? "Uang muka dinas disetujui" : "Uang muka dinas ditolak",
          body: status === "REJECTED"
            ? "Pengajuan uang muka dinas Anda ditolak. Lihat alasannya di riwayat."
            : perDiemOnly
              ? "Pengajuan uang harian Anda disetujui. Ajukan pertanggungjawaban setelah kembali."
              : "Uang muka dinas Anda disetujui. Keuangan akan mencairkannya.",
          href: `/app/trip-advances?uangmuka=${current.advanceId}`,
          actorAccountId: principal.id,
        });
      }
      return [200, { advanceId: current.advanceId, advanceStatus: status, stepStatus: decision.decidedStepStatus, nextPendingStepId: decision.nextPendingStepId }];
    });
  });

  // ------------------------------------------------------------------- admin

  /** ENG-LIST-001: every filter runs before LIMIT. $1 is today (WIB). */
  function registerWhere(filter: { status?: string | undefined; employeeId?: string | undefined; overdue?: string | undefined; from?: string; to?: string }) {
    return {
      sql: `($2::text IS NULL OR advance.status = $2)
        AND ($3::uuid IS NULL OR advance.employee_id = $3)
        AND ($4::boolean IS NULL OR (advance.status = 'DISBURSED' AND $1::date > ${DUE_ON_SQL}) = $4)
        AND ($5::date IS NULL OR (advance.submitted_at AT TIME ZONE 'Asia/Jakarta')::date >= $5::date)
        AND ($6::date IS NULL OR (advance.submitted_at AT TIME ZONE 'Asia/Jakarta')::date <= $6::date)`,
      values: [
        today(), filter.status ?? null, filter.employeeId ?? null,
        filter.overdue === undefined ? null : filter.overdue === "true", filter.from ?? null, filter.to ?? null,
      ],
    };
  }

  app.get("/admin/trip-advances", async (request, reply) => {
    if (!(await requirePermission(request, reply, "trip_advances.read"))) return;
    const query = adminListQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const where = registerWhere(query.data);
      const result = await pool.query<SummaryRow>(
        `SELECT ${SUMMARY_COLUMNS},
                advance.employee_id AS "employeeId", employee.full_name AS "employeeName",
                employee.employee_number AS "employeeNumber", unit.name AS "unitName",
                count(*) OVER ()::int AS total
           FROM trip_advances advance
           JOIN employees employee ON employee.id = advance.employee_id
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
           ${SUMMARY_JOINS}
          WHERE ${where.sql}
          ORDER BY advance.submitted_at DESC, advance.id DESC
          LIMIT $7 OFFSET $8`,
        [...where.values, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(summary),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
        zones: zoneCatalog(),
      });
    });
  });

  app.get("/admin/trip-advances/claimants", async (request, reply) => {
    if (!(await requirePermission(request, reply, "trip_advances.read"))) return;
    const query = claimantQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_FILTER", message: "Kata kunci minimal 2 huruf." });
    return handle(reply, async () => {
      const result = await pool.query<{ total: number }>(
        `SELECT employee.id, employee.full_name AS "fullName", employee.employee_number AS "employeeNumber",
                unit.name AS "unitName", count(*) OVER ()::int AS total
           FROM employees employee
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
          WHERE EXISTS (SELECT 1 FROM trip_advances advance WHERE advance.employee_id = employee.id)
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

  app.get("/admin/trip-advances/export.csv", async (request, reply) => {
    const principal = await requirePermission(request, reply, "trip_advances.read");
    if (!principal) return;
    const query = periodQuery.safeParse(request.query);
    if (!query.success || !exportWindowOk(query.data.from, query.data.to)) {
      return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_PERIOD", message: `Isi rentang tanggal pengajuan paling lama ${MAX_EXPORT_DAYS} hari.` });
    }
    return handle(reply, async () => {
      const where = registerWhere(query.data);
      const count = await pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM trip_advances advance
           JOIN business_trip_requests trip ON trip.id = advance.business_trip_id
          WHERE ${where.sql}`,
        where.values,
      );
      const total = count.rows[0]?.total ?? 0;
      if (total > MAX_EXPORT_ROWS) {
        return send(reply, 422, {
          code: "TRIP_ADVANCE_EXPORT_TOO_LARGE",
          message: `Hasil ekspor ${total} baris melebihi batas ${MAX_EXPORT_ROWS}. Persempit rentang tanggal atau status.`,
        });
      }
      const rows = await pool.query<Record<string, string | null>>(
        `SELECT advance.id, employee.employee_number AS "employeeNumber", employee.full_name AS "employeeName",
                unit.name AS "unitName", trip.destination,
                to_char(trip.start_on, 'YYYY-MM-DD') AS "startOn", to_char(trip.end_on, 'YYYY-MM-DD') AS "endOn",
                advance.zone, to_char(advance.submitted_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS "submittedOn",
                advance.status, advance.amount::text AS amount, advance.per_diem_days::text AS "perDiemDays",
                advance.per_diem_amount::text AS "perDiemAmount", advance.claims_total::text AS "claimsTotal",
                advance.settlement_balance::text AS balance,
                (SELECT COALESCE(sum(refund.amount), 0)::text FROM trip_advance_transactions refund
                  WHERE refund.advance_id = advance.id AND refund.kind = 'REFUND') AS refunded,
                to_char(${DUE_ON_SQL}, 'YYYY-MM-DD') AS "dueOn"
           FROM trip_advances advance
           JOIN employees employee ON employee.id = advance.employee_id
           LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
           JOIN business_trip_requests trip ON trip.id = advance.business_trip_id
          WHERE ${where.sql}
          ORDER BY advance.submitted_at ASC, advance.id ASC`,
        where.values,
      );
      // The export is the one register read that leaves HCIS, so it is recorded (D-19).
      await addEvent(pool, null, principal.id, "trip_advance.register.exported", null, {
        from: query.data.from, to: query.data.to, status: query.data.status ?? null, rows: rows.rows.length,
      });
      const header = [
        "ID uang muka", "NIP", "Nama", "Unit", "Tujuan", "Berangkat", "Kembali", "Zona", "Tanggal ajuan", "Status",
        "Uang muka", "Hari uang harian", "Uang harian", "Klaim diperhitungkan", "Selisih", "Pengembalian diterima", "Tenggat",
      ];
      const lines = [header.map(quoteCsvCell).join(",")];
      for (const row of rows.rows) {
        lines.push([
          row.id, row.employeeNumber, row.employeeName, row.unitName, row.destination, row.startOn, row.endOn,
          row.zone, row.submittedOn, row.status, row.amount, row.perDiemDays, row.perDiemAmount, row.claimsTotal,
          row.balance, row.refunded, row.dueOn,
        ].map((cell) => quoteCsvCell(cell ?? "")).join(","));
      }
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="uang-muka-dinas-${query.data.from}-${query.data.to}.csv"`);
      return send(reply, 200, `${String.fromCharCode(0xfeff)}${lines.join("\r\n")}\r\n`);
    });
  });

  app.get("/admin/trip-advances/:id", async (request, reply) => {
    if (!(await requirePermission(request, reply, "trip_advances.read"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_ID", message: "Uang muka tidak valid." });
    return handle(reply, async () => {
      const detail = await loadAdvanceDetail(pool, params.data.id, null);
      if (!detail) return send(reply, 404, { code: "TRIP_ADVANCE_NOT_FOUND", message: "Uang muka tidak ditemukan." });
      return send(reply, 200, detail);
    });
  });

  app.post("/admin/trip-advances/:id/reject", async (request, reply) => {
    const principal = await requirePermission(request, reply, "trip_advances.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_ID", message: "Uang muka tidak valid." });
    const body = financeReasonBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_REJECTION", message: "Alasan penolakan 10–500 karakter." });
    return transact(reply, async (client) => {
      const advance = await lockAdvance(client, params.data.id, null);
      await assertNotOwn(client, principal.id, advance.employeeId);
      if (advance.status !== "APPROVED") {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_NOT_REJECTABLE", "Keuangan hanya dapat menolak uang muka yang sudah disetujui dan belum dicairkan.");
      }
      await client.query(
        `UPDATE trip_advances SET status = 'REJECTED', rejected_by = 'FINANCE', reject_reason = $2, rejected_by_account_id = $3, updated_at = now()
          WHERE id = $1`,
        [params.data.id, body.data.reason, principal.id],
      );
      await addEvent(client, params.data.id, principal.id, "trip_advance.finance.rejected", body.data.reason);
      await notifyEmployee(client, advance.employeeId, {
        eventKey: `trip_advance.${params.data.id}.finance_rejected`,
        category: "system",
        title: "Uang muka dinas ditolak Keuangan",
        body: "Keuangan menolak uang muka dinas Anda. Lihat alasannya di riwayat.",
        href: `/app/trip-advances?uangmuka=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [200, { id: params.data.id, status: "REJECTED" }];
    });
  });

  type TransactionInput = z.infer<typeof transactionBody>;

  /** D-07/D-11/D-12: the same key with the same terms replays; with other terms it is refused. */
  async function replayTransaction(
    client: PoolClient, advanceId: string, input: TransactionInput & { amount?: number }, kind: "DISBURSEMENT" | "TOP_UP" | "REFUND",
  ) {
    const existing = await client.query<{
      id: string; kind: string; amount: string; transactedOn: string; method: string; reference: string | null; note: string | null;
    }>(
      `SELECT id, kind, amount::text AS amount, to_char(transacted_on, 'YYYY-MM-DD') AS "transactedOn", method, reference, note
         FROM trip_advance_transactions WHERE advance_id = $1 AND idempotency_key = $2`,
      [advanceId, input.idempotencyKey],
    );
    const previous = existing.rows[0];
    if (!previous) return null;
    const same = previous.kind === kind && previous.transactedOn === input.paidOn && previous.method === input.method
      && previous.reference === (input.reference || null) && previous.note === (input.note || null)
      && (input.amount === undefined || toRupiah(previous.amount) === toRupiah(input.amount));
    if (!same) {
      throw new TripAdvanceError(409, "IDEMPOTENCY_KEY_REUSED", "Transaksi ini sudah tercatat dengan nilai lain. Muat ulang halaman.");
    }
    return { transactionId: previous.id, amount: amount(previous.amount) };
  }

  async function recordTransaction(
    client: PoolClient, advanceId: string, actorAccountId: string, kind: "DISBURSEMENT" | "TOP_UP" | "REFUND", value: bigint, input: TransactionInput,
  ) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO trip_advance_transactions
         (id, advance_id, kind, amount, transacted_on, method, reference, note, idempotency_key, recorded_by_account_id)
       VALUES ($1, $2, $3, $4::bigint, $5::date, $6, $7, $8, $9, $10)`,
      [id, advanceId, kind, value.toString(), input.paidOn, input.method, input.reference || null, input.note || null, input.idempotencyKey, actorAccountId],
    );
    return id;
  }

  app.post("/admin/trip-advances/:id/disburse", async (request, reply) => {
    const principal = await requirePermission(request, reply, "trip_advances.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_ID", message: "Uang muka tidak valid." });
    const body = transactionBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_PAYMENT", message: "Tanggal, cara, atau kunci pengiriman tidak valid." });
    return transact(reply, async (client) => {
      const advance = await lockAdvance(client, params.data.id, null);
      await assertNotOwn(client, principal.id, advance.employeeId);
      const replay = await replayTransaction(client, params.data.id, body.data, "DISBURSEMENT");
      if (replay) return [200, { id: params.data.id, status: advance.status, ...replay, idempotentReplay: true }];
      if (advance.status !== "APPROVED") {
        throw new TripAdvanceError(409, advance.status === "DISBURSED" ? "TRIP_ADVANCE_ALREADY_DISBURSED" : "TRIP_ADVANCE_NOT_DISBURSABLE",
          advance.status === "DISBURSED" ? "Uang muka ini sudah dicairkan." : "Hanya uang muka yang sudah disetujui yang dapat dicairkan.");
      }
      const value = toRupiah(advance.amount);
      if (value === 0n) {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_NOT_DISBURSABLE", "Pengajuan ini hanya uang harian; tidak ada yang dicairkan.");
      }
      await assertNotApprover(client, params.data.id, principal.id);
      const trip = (await loadTrip(client, advance.businessTripId, "FOR SHARE"))!;
      if (!(ACTIVE_TRIP_STATUSES as readonly string[]).includes(trip.status)) {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_TRIP_NOT_ACTIVE", "Perjalanan dinas ini tidak lagi berjalan; tolak uang mukanya.");
      }
      assertTransactionDate(body.data.paidOn, advance.decidedOn!, today());
      const transactionId = await recordTransaction(client, params.data.id, principal.id, "DISBURSEMENT", value, body.data);
      await client.query(`UPDATE trip_advances SET status = 'DISBURSED', disbursed_at = now(), updated_at = now() WHERE id = $1`, [params.data.id]);
      await addEvent(client, params.data.id, principal.id, "trip_advance.disbursed", null, {
        transactionId, method: body.data.method, paidOn: body.data.paidOn,
      });
      await notifyEmployee(client, advance.employeeId, {
        eventKey: `trip_advance.${params.data.id}.disbursed`,
        category: "system",
        title: "Uang muka dinas dicairkan",
        body: "Keuangan mencairkan uang muka dinas Anda. Simpan bukti biaya untuk pertanggungjawaban.",
        href: `/app/trip-advances?uangmuka=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [201, { id: params.data.id, status: "DISBURSED", transactionId, amount: rupiahToJson(value), idempotentReplay: false }];
    });
  });

  app.post("/admin/trip-advances/:id/settle", async (request, reply) => {
    const principal = await requirePermission(request, reply, "trip_advances.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_ID", message: "Uang muka tidak valid." });
    const body = settleBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_SETTLEMENT", message: "Hari uang harian (bilangan bulat 0–30) dan kunci pengiriman wajib diisi." });
    return transact(reply, async (client) => {
      const advance = await lockAdvance(client, params.data.id, null);
      await assertNotOwn(client, principal.id, advance.employeeId);
      if (advance.settlementKey !== null && advance.settlementKey === body.data.idempotencyKey) {
        if (advance.perDiemDays !== body.data.perDiemDays || advance.settlementFinanceNote !== (body.data.note?.trim() || null)) {
          throw new TripAdvanceError(409, "IDEMPOTENCY_KEY_REUSED", "Penyelesaian ini sudah tercatat dengan isian lain. Muat ulang halaman.");
        }
        return [200, { id: params.data.id, status: advance.status, settlementBalance: optionalAmount(advance.settlementBalance), idempotentReplay: true }];
      }
      if (advance.status !== "SETTLEMENT_SUBMITTED") {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_NOT_SETTLEABLE", "Hanya uang muka yang pertanggungjawabannya sudah diajukan yang dapat diselesaikan.");
      }
      await assertNotApprover(client, params.data.id, principal.id);
      const trip = (await loadTrip(client, advance.businessTripId, "FOR SHARE"))!;
      const claims = await client.query<{ id: string; status: string; verifiedTotal: string | null }>(
        `SELECT id, status, verified_total::text AS "verifiedTotal" FROM reimbursement_claims
          WHERE employee_id = $1 AND business_trip_id = $2 AND status IN ('IN_REVIEW', 'APPROVED', 'VERIFIED')
          ORDER BY submitted_at ASC, id ASC
          FOR UPDATE`,
        [advance.employeeId, trip.id],
      );
      // D-16 / REIMB-001 D-13: whoever sits in a counted claim's chain does not turn it into money.
      const claimApprover = await client.query(
        `SELECT 1 FROM reimbursement_approval_steps step
          WHERE step.claim_id = ANY($1::uuid[])
            AND (step.acted_by_account_id = $2
              OR step.approver_employee_id = (SELECT employee_id FROM accounts WHERE id = $2))
          LIMIT 1`,
        [claims.rows.map((claim) => claim.id), principal.id],
      );
      if (claimApprover.rows[0]) {
        throw new TripAdvanceError(403, "TRIP_ADVANCE_APPROVER_CANNOT_PROCESS", "Penyetuju salah satu klaim perjalanan ini tidak boleh sekaligus menyelesaikannya.");
      }
      if (claims.rows.some((claim) => claim.status !== "VERIFIED")) {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_CLAIMS_PENDING", "Masih ada klaim perjalanan ini yang belum selesai disetujui atau diverifikasi.");
      }
      const verified = claims.rows.map((claim) => ({ id: claim.id, total: toRupiah(claim.verifiedTotal!) }));
      const maxDays = maxPerDiemDays(trip);
      const rate = body.data.perDiemDays > 0 ? await rateInForce(client, advance.zone, trip.startOn) : null;
      const note = body.data.note?.trim() || null;
      const result = settle({
        advanceAmount: toRupiah(advance.amount),
        claims: verified.map((claim) => claim.total),
        perDiemDays: body.data.perDiemDays,
        maxDays,
        dailyRate: rate?.dailyAmount ?? null,
        note,
      });
      const settledOn = today();
      for (const claim of verified) {
        const paymentId = randomUUID();
        await client.query(
          `INSERT INTO trip_advance_settlement_claims (advance_id, claim_id, verified_total) VALUES ($1, $2, $3::bigint)`,
          [params.data.id, claim.id, claim.total.toString()],
        );
        await client.query(
          `INSERT INTO reimbursement_payments (id, claim_id, amount, paid_on, method, reference, idempotency_key, recorded_by_account_id)
           VALUES ($1, $2, $3::bigint, $4::date, 'ADVANCE', $5, $6, $7)`,
          [paymentId, claim.id, claim.total.toString(), settledOn, "Diperhitungkan dengan uang muka dinas", randomUUID(), principal.id],
        );
        await client.query(`UPDATE reimbursement_claims SET status = 'PAID', paid_at = now(), updated_at = now() WHERE id = $1`, [claim.id]);
        await client.query(
          `INSERT INTO reimbursement_events (id, claim_id, event_type, actor_account_id, metadata, occurred_at)
           VALUES ($1, $2, 'reimbursement.paid', $3, $4::jsonb, clock_timestamp())`,
          [randomUUID(), claim.id, principal.id, JSON.stringify({ paymentId, method: "ADVANCE", paidOn: settledOn, tripAdvanceId: params.data.id })],
        );
      }
      await client.query(
        `UPDATE trip_advances
            SET status = $2, settlement_key = $3, per_diem_days = $4, per_diem_rate_id = $5, per_diem_rate = $6::bigint,
                per_diem_amount = $7::bigint, claims_total = $8::bigint, settlement_balance = $9::bigint,
                settlement_finance_note = $10, settled_at = now(), settled_by_account_id = $11,
                closed_at = CASE WHEN $2 = 'SETTLED' THEN now() END, updated_at = now()
          WHERE id = $1`,
        [
          params.data.id, result.status, body.data.idempotencyKey, body.data.perDiemDays, rate?.id ?? null,
          rate ? rate.dailyAmount.toString() : null, result.perDiemAmount.toString(), result.claimsTotal.toString(),
          result.balance.toString(), note, principal.id,
        ],
      );
      await addEvent(client, params.data.id, principal.id, "trip_advance.settled", note, {
        claims: verified.length, perDiemDays: body.data.perDiemDays, maxPerDiemDays: maxDays, outcome: result.status,
      });
      if (result.status === "SETTLED") await addEvent(client, params.data.id, principal.id, "trip_advance.closed");
      await notifyEmployee(client, advance.employeeId, {
        eventKey: `trip_advance.${params.data.id}.settled`,
        category: "system",
        title: "Pertanggungjawaban uang muka diselesaikan",
        body: result.status === "AWAITING_REFUND"
          ? "Keuangan menyelesaikan pertanggungjawaban Anda. Ada sisa uang muka yang perlu dikembalikan; lihat rinciannya."
          : result.status === "AWAITING_TOP_UP"
            ? "Keuangan menyelesaikan pertanggungjawaban Anda. Kekurangannya akan dibayarkan; lihat rinciannya."
            : "Keuangan menyelesaikan pertanggungjawaban uang muka Anda.",
        href: `/app/trip-advances?uangmuka=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [200, {
        id: params.data.id, status: result.status, perDiemAmount: rupiahToJson(result.perDiemAmount),
        claimsTotal: rupiahToJson(result.claimsTotal), settlementBalance: rupiahToJson(result.balance), idempotentReplay: false,
      }];
    });
  });

  app.post("/admin/trip-advances/:id/top-up", async (request, reply) => {
    const principal = await requirePermission(request, reply, "trip_advances.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_ID", message: "Uang muka tidak valid." });
    const body = transactionBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_PAYMENT", message: "Tanggal, cara, atau kunci pengiriman tidak valid." });
    return transact(reply, async (client) => {
      const advance = await lockAdvance(client, params.data.id, null);
      await assertNotOwn(client, principal.id, advance.employeeId);
      const replay = await replayTransaction(client, params.data.id, body.data, "TOP_UP");
      if (replay) return [200, { id: params.data.id, status: advance.status, ...replay, idempotentReplay: true }];
      if (advance.status !== "AWAITING_TOP_UP") {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_NO_TOP_UP_DUE", "Tidak ada kekurangan yang perlu dibayar untuk uang muka ini.");
      }
      await assertNotApprover(client, params.data.id, principal.id);
      assertTransactionDate(body.data.paidOn, advance.settledOn!, today());
      const value = toRupiah(advance.settlementBalance!);
      const transactionId = await recordTransaction(client, params.data.id, principal.id, "TOP_UP", value, body.data);
      await client.query(`UPDATE trip_advances SET status = 'SETTLED', closed_at = now(), updated_at = now() WHERE id = $1`, [params.data.id]);
      await addEvent(client, params.data.id, principal.id, "trip_advance.top_up.paid", null, {
        transactionId, method: body.data.method, paidOn: body.data.paidOn,
      });
      await addEvent(client, params.data.id, principal.id, "trip_advance.closed");
      await notifyEmployee(client, advance.employeeId, {
        eventKey: `trip_advance.${params.data.id}.top_up`,
        category: "system",
        title: "Kekurangan biaya dinas dibayar",
        body: "Keuangan mencatat pembayaran kekurangan biaya perjalanan dinas Anda.",
        href: `/app/trip-advances?uangmuka=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [201, { id: params.data.id, status: "SETTLED", transactionId, amount: rupiahToJson(value), idempotentReplay: false }];
    });
  });

  app.post("/admin/trip-advances/:id/refunds", async (request, reply) => {
    const principal = await requirePermission(request, reply, "trip_advances.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_ID", message: "Uang muka tidak valid." });
    const body = refundBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_REFUND", message: "Nominal (bilangan bulat rupiah), tanggal, cara, dan kunci pengiriman wajib diisi." });
    return transact(reply, async (client) => {
      const advance = await lockAdvance(client, params.data.id, null);
      await assertNotOwn(client, principal.id, advance.employeeId);
      const replay = await replayTransaction(client, params.data.id, body.data, "REFUND");
      if (replay) return [200, { id: params.data.id, status: advance.status, ...replay, idempotentReplay: true }];
      if (advance.status !== "AWAITING_REFUND") {
        throw new TripAdvanceError(409, "TRIP_ADVANCE_NO_REFUND_DUE", "Tidak ada sisa uang muka yang perlu dikembalikan.");
      }
      assertTransactionDate(body.data.paidOn, advance.settledOn!, today());
      const refunded = await client.query<{ total: string }>(
        `SELECT COALESCE(sum(amount), 0)::text AS total FROM trip_advance_transactions WHERE advance_id = $1 AND kind = 'REFUND'`,
        [params.data.id],
      );
      const value = toRupiah(body.data.amount);
      const remaining = applyRefund(-toRupiah(advance.settlementBalance!), toRupiah(refunded.rows[0]!.total), value);
      const transactionId = await recordTransaction(client, params.data.id, principal.id, "REFUND", value, body.data);
      const status: AdvanceStatus = remaining === 0n ? "SETTLED" : "AWAITING_REFUND";
      if (status === "SETTLED") {
        await client.query(`UPDATE trip_advances SET status = 'SETTLED', closed_at = now(), updated_at = now() WHERE id = $1`, [params.data.id]);
      }
      await addEvent(client, params.data.id, principal.id, "trip_advance.refund.recorded", null, {
        transactionId, method: body.data.method, receivedOn: body.data.paidOn, complete: remaining === 0n,
      });
      if (status === "SETTLED") await addEvent(client, params.data.id, principal.id, "trip_advance.closed");
      await notifyEmployee(client, advance.employeeId, {
        eventKey: `trip_advance.${params.data.id}.refund.${transactionId}`,
        category: "system",
        title: status === "SETTLED" ? "Uang muka dinas lunas" : "Pengembalian uang muka diterima",
        body: status === "SETTLED"
          ? "Keuangan mencatat pengembalian terakhir. Uang muka dinas Anda sudah selesai."
          : "Keuangan mencatat pengembalian sebagian. Lihat sisa kewajiban di detail uang muka.",
        href: `/app/trip-advances?uangmuka=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [201, { id: params.data.id, status, transactionId, refundOutstanding: rupiahToJson(remaining), idempotentReplay: false }];
    });
  });

  // ------------------------------------------------------------------- rates

  app.get("/admin/trip-per-diem-rates", async (request, reply) => {
    if (!(await requirePermission(request, reply, "trip_advances.read", "trip_per_diem.manage"))) return;
    const query = rateListQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_TRIP_ADVANCE_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const on = today();
      const [history, current] = await Promise.all([
        pool.query<{ dailyAmount: string; total: number; zone: ZoneKey }>(
          `SELECT rate.id, rate.zone, to_char(rate.effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
                  rate.daily_amount::text AS "dailyAmount", rate.note, rate.created_at AS "createdAt",
                  creator.full_name AS "createdByName", count(*) OVER ()::int AS total
             FROM trip_per_diem_rates rate
             LEFT JOIN accounts account ON account.id = rate.created_by_account_id
             LEFT JOIN employees creator ON creator.id = account.employee_id
            WHERE ($1::text IS NULL OR rate.zone = $1)
            ORDER BY rate.effective_from DESC, rate.created_at DESC, rate.id DESC
            LIMIT $2 OFFSET $3`,
          [query.data.zone ?? null, query.data.pageSize, pageOffset(query.data)],
        ),
        Promise.all(ZONE_KEYS.map(async (zone) => ({ zone, rate: await rateInForce(pool, zone, on) }))),
      ]);
      return send(reply, 200, {
        items: history.rows.map(({ total, dailyAmount, ...row }) => {
          void total;
          return { ...row, zoneLabel: ZONES[row.zone] ?? row.zone, dailyAmount: amount(dailyAmount) };
        }),
        pagination: pagination(query.data, history.rows[0]?.total ?? 0),
        current: current.map(({ zone, rate }) => ({
          zone, label: ZONES[zone], dailyAmount: rate ? rupiahToJson(rate.dailyAmount) : null, effectiveFrom: rate?.effectiveFrom ?? null,
        })),
      });
    });
  });

  app.post("/admin/trip-per-diem-rates", async (request, reply) => {
    const principal = await requirePermission(request, reply, "trip_per_diem.manage");
    if (!principal) return;
    const body = rateBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_TRIP_PER_DIEM_RATE", message: "Zona, tanggal berlaku, dan nominal per hari (bilangan bulat Rp0–Rp5.000.000) wajib diisi." });
    }
    return transact(reply, async (client) => {
      // D-02: a version may start in the past only as the first rate of its zone (the initial fill);
      // afterwards a back-dated row could change the per diem of advances already submitted.
      if (body.data.effectiveFrom < today()) {
        const existing = await client.query(`SELECT 1 FROM trip_per_diem_rates WHERE zone = $1 LIMIT 1`, [body.data.zone]);
        if (existing.rows[0]) {
          throw new TripAdvanceError(409, "TRIP_PER_DIEM_RATE_BACKDATED", "Versi tarif baru berlaku paling cepat hari ini. Hanya tarif pertama suatu zona yang boleh berlaku mundur.");
        }
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO trip_per_diem_rates (id, zone, effective_from, daily_amount, note, created_by_account_id)
         VALUES ($1, $2, $3::date, $4::bigint, $5, $6)`,
        [id, body.data.zone, body.data.effectiveFrom, String(body.data.dailyAmount), body.data.note?.trim() || null, principal.id],
      );
      await addEvent(client, null, principal.id, "trip_advance.rate.created", null, {
        rateId: id, zone: body.data.zone, effectiveFrom: body.data.effectiveFrom,
      });
      return [201, { id, zone: body.data.zone, effectiveFrom: body.data.effectiveFrom, dailyAmount: body.data.dailyAmount }];
    });
  });
}

/**
 * REIMB-001 D-19 (TRIP-002 D-13): a claim on a trip whose advance is not settled yet is paid
 * through that settlement, never on its own.
 */
export async function tripHasUnsettledAdvance(db: Queryable, tripId: string | null): Promise<boolean> {
  if (!tripId) return false;
  const found = await db.query(
    `SELECT 1 FROM trip_advances WHERE business_trip_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
    [tripId, [...UNSETTLED_STATUSES]],
  );
  return Boolean(found.rows[0]);
}
