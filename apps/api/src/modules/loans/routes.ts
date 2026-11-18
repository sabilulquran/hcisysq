// LOAN-001 Package 1 routes: employee request, APR-001 approval, Finance disbursement,
// instalment schedule, repayments. Spec: docs/domain/employee-loans.md.
//
// loans.* is Finance/HC-only: legacy Super Admin compatibility never grants it, so the admin
// routes resolve the permission from the organization context directly, like trips.*.
// Employee and approver access is ownership (the session's employee, the snapshotted step),
// never a permission.
//
// Amounts are sensitive (spec §7): they appear in response bodies to the people allowed to see
// them, never in notifications, event metadata or logs. A database error is reduced to its code
// before it can reach the log, because PostgreSQL puts the failing row — amounts included — in
// the error detail.

import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { pageOffset, pageQuerySchema, pagination } from "../../lib/pagination.js";
import type { LoanPermission } from "../auth/permissions.js";
import { AUTH_COOKIE_NAME, AuthService, readCookie, type AuthPrincipal } from "../auth/service.js";
import { jakartaDate } from "../documents/service.js";
import { LeaveApprovalConfigurationError } from "../leave/domain/approval-chain.js";
import {
  decideLeaveApprovalStep,
  LeaveWorkflowError,
  type LeaveApprovalStepState,
} from "../leave/domain/request-workflow.js";
import {
  governanceActorIsRequester,
  LeaveOrganizationAuthorityError,
  resolveLeaveAuthorities,
} from "../leave/organization-authority.js";
import { notifyEmployee } from "../notifications/service.js";
import {
  APPROVAL_SEAT_LABELS,
  ApprovalSeatError,
  loadApprovalSeatMappings,
  resolveApprovalSeatPositions,
} from "../organization/approval-seats.js";
import {
  LOAN_GOVERNANCE_CAPABILITY,
  PostgresOrganizationRepository,
  type ApprovalSeatTarget,
  type OrganizationRolloutMode,
} from "../organization/index.js";
import {
  loanApprovalSeatKeys,
  LoanApprovalPolicyError,
  loadPembinaThreshold,
  seatLabelForSource,
  seatSource,
} from "./approval-seats.js";
import {
  approvalRequestStatus,
  assertPaymentFits,
  buildInstalmentSchedule,
  canCancelLoan,
  DISBURSEMENT_METHODS,
  instalmentStanding,
  isCalendarDate,
  LOAN_STATUSES,
  LoanPolicyError,
  OPEN_LOAN_STATUSES,
  PAYMENT_METHODS,
  repaymentStatus,
  resolveFirstDueMonth,
  rupiahToJson,
  toRupiah,
  validateLoanTerms,
  addMonths,
  type LoanCanceller,
  type LoanStatus,
} from "./domain.js";

type Queryable = Pool | PoolClient;

/** D-01 DRAFT: ORG-004 rollout key; without a rollout row the mode is LEGACY. */
const LOAN_WORKFLOW_KEY = "LOAN";
/**
 * LOAN-002 (owner decision 2026-11-18): under `STRUCTURE` the chain is approver unit, then the
 * fixed seats. Under `LEGACY` — which is what every workflow runs in production today — nothing
 * about this module's behaviour changes: the resolver keeps using the two legacy columns.
 */
const SEAT_CHAIN_MODE: OrganizationRolloutMode = "STRUCTURE";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const month = z.string().regex(/^\d{4}-\d{2}$/);
// JSON integers only: 1500000.5 or "1500000" is refused, never rounded.
const rupiah = z.number().int().positive().max(1_000_000_000);
const termsBody = z.object({ principal: rupiah, tenorMonths: z.number().int() });
const submitBody = termsBody.extend({
  purpose: z.string().trim().min(10).max(1000),
  idempotencyKey: z.string().uuid(),
});
const idParams = z.object({ id: z.string().uuid() });
const stepParams = z.object({ stepId: z.string().uuid() });
const paymentParams = idParams.extend({ paymentId: z.string().uuid() });
const decisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), note: z.string().trim().max(1000).nullable().optional() }),
  z.object({ decision: z.literal("reject"), note: z.string().trim().min(5).max(1000) }),
]);
const employeeCancelBody = z.object({ reason: z.string().trim().min(5).max(500) });
const financeReasonBody = z.object({ reason: z.string().trim().min(10).max(500) });
const disburseBody = z.object({
  disbursedOn: isoDate,
  method: z.enum(DISBURSEMENT_METHODS),
  reference: z.string().trim().max(200).nullable().optional(),
  firstDueMonth: month.nullable().optional(),
});
const paymentBody = z.object({
  amount: rupiah,
  paidOn: isoDate,
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  idempotencyKey: z.string().uuid(),
});
const listQuery = pageQuerySchema.extend({ status: z.enum(LOAN_STATUSES).optional() });
const adminListQuery = listQuery.extend({ employeeId: z.string().uuid().optional() });
const borrowerQuery = pageQuerySchema.extend({ q: z.string().trim().min(2).max(100) });

class LoanError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "LoanError";
  }
}

interface EmployeeContext {
  id: string;
  fullName: string;
  directManagerEmployeeId: string | null;
  unitApproverEmployeeId: string | null;
}

interface ChainStep {
  /** Exactly one of the two is set (migration 0169's XOR check). */
  employeeId: string | null;
  accountId: string | null;
  /** The approver's name, or — for an organ account, which has none in HCIS — its seat. */
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

const STATE_CONFLICT: [string, string] = ["LOAN_STATE_CONFLICT", "Data pinjaman sudah berubah. Muat ulang lalu coba lagi."];
/** Unique races a well-behaved client can lose. Anything else in class 23 is a bug, not a race. */
const UNIQUE_CONFLICTS: Record<string, [string, string]> = {
  employee_loans_one_open_idx: ["LOAN_ALREADY_OPEN", "Masih ada pinjaman yang diajukan atau belum lunas."],
  employee_loan_approval_steps_one_pending_idx: [
    "APPROVAL_STATE_CONFLICT", "Tahap persetujuan aktif sudah berubah. Muat ulang sebelum mengambil keputusan.",
  ],
  employee_loans_employee_id_idempotency_key_key: STATE_CONFLICT,
  employee_loan_payments_loan_id_idempotency_key_key: STATE_CONFLICT,
};

function knownError(error: unknown): LoanError | null {
  if (error instanceof LoanError) return error;
  if (error instanceof ApprovalSeatError) {
    return new LoanError(409, "LOAN_APPROVAL_SEAT_UNMAPPED", error.message);
  }
  if (error instanceof LoanPolicyError
    || error instanceof LoanApprovalPolicyError
    || error instanceof LeaveApprovalConfigurationError
    || error instanceof LeaveOrganizationAuthorityError
    || error instanceof LeaveWorkflowError) {
    return new LoanError(409, error.code, error.message);
  }
  const database = error as { code?: unknown; severity?: unknown; constraint?: unknown };
  if (database.code === "23505" && typeof database.severity === "string") {
    const conflict = UNIQUE_CONFLICTS[String(database.constraint)];
    if (conflict) return new LoanError(409, conflict[0], conflict[1]);
  }
  return null;
}

/**
 * Spec §7: an unexpected database error — including a broken money invariant (CHECK or the
 * deferred trigger), which means a code bug — becomes a logged 500 that keeps its code, its
 * constraint and its message (amount-free by design), and loses `detail`, where PostgreSQL
 * quotes the failing row with its amounts.
 */
function scrubbed(error: unknown): unknown {
  const database = error as { code?: unknown; severity?: unknown; constraint?: unknown; message?: unknown };
  if (typeof database.code === "string" && typeof database.severity === "string") {
    return Object.assign(new Error(`employee loan database error ${database.code}: ${String(database.message)}`), {
      code: database.code, constraint: database.constraint,
    });
  }
  return error;
}

/** Whole rupiah from a pg bigint (string) to a JSON integer. */
function amount(value: unknown): number {
  return rupiahToJson(toRupiah(value as string));
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
    throw new LoanError(403, "EMPLOYEE_NOT_ACTIVE", "Akun tidak terhubung ke pegawai aktif.");
  }
  return employee;
}

interface SeatPlan {
  seats: ApprovalSeatTarget[];
  /** Seat key by position key and by source, so a resolver failure can name the seat. */
  labels: Map<string, string>;
}

/**
 * LOAN-002: the seats this request's chain needs, looked up in the registry (migration 0168).
 *
 * Only `STRUCTURE` builds them. `LEGACY` is what production runs, and `SHADOW` keeps LEGACY as its
 * authoritative source, so neither may start failing because HC has not mapped a seat yet — under
 * SHADOW an unmapped seat simply leaves the diagnostic chain seatless.
 */
async function planApprovalSeats(
  db: Queryable,
  mode: OrganizationRolloutMode,
  effectiveDate: string,
  principalAmount: bigint,
): Promise<SeatPlan> {
  const empty: SeatPlan = { seats: [], labels: new Map() };
  if (mode === "LEGACY") return empty;
  try {
    const threshold = await loadPembinaThreshold(db, effectiveDate);
    const mappings = await loadApprovalSeatMappings(db, effectiveDate);
    const resolved = resolveApprovalSeatPositions(
      mappings, loanApprovalSeatKeys(principalAmount, threshold),
    );
    const labels = new Map<string, string>();
    const seats = resolved.map(({ seatKey, positionKey }) => {
      const source = seatSource(seatKey);
      labels.set(positionKey, APPROVAL_SEAT_LABELS[seatKey]);
      labels.set(source, APPROVAL_SEAT_LABELS[seatKey]);
      return { source, positionKey };
    });
    return { seats, labels };
  } catch (error) {
    if (mode !== SEAT_CHAIN_MODE
      && (error instanceof ApprovalSeatError || error instanceof LoanApprovalPolicyError)) {
      return empty;
    }
    throw error;
  }
}

/**
 * D-18: with a fixed chain, one unmapped or vacant seat blocks every kasbon in the institution, so
 * the refusal has to name the seat Human Capital must attend to. APR-001's all-or-nothing rule is
 * unchanged — nothing is stored.
 */
function seatFailure(error: unknown, plan: SeatPlan): LoanError | null {
  if (error instanceof ApprovalSeatError) {
    return new LoanError(409, "LOAN_APPROVAL_SEAT_UNMAPPED", error.message);
  }
  if (!(error instanceof LeaveOrganizationAuthorityError)) return null;
  const details = error.details;
  // M1: the unit approver resolving to the requester is a true, ordinary situation for a unit
  // head, not a missing configuration. Saying "Approver unit belum dikonfigurasi" would send HC
  // hunting a fault that is not there, so this says what is actually the case.
  if (error.code === "AUTHORITY_SELF_RESOLUTION" && details.source === "UNIT_APPROVER") {
    return new LoanError(409, "LOAN_UNIT_APPROVER_SELF",
      "Approver unit untuk pengajuan ini adalah Anda sendiri, sehingga rantai persetujuan kasbon "
      + "tidak dapat dibentuk. Hubungi Human Capital untuk menunjuk pejabat pengganti.");
  }
  const seat = plan.labels.get(String(details.positionKey ?? "")) ?? plan.labels.get(String(details.source ?? ""));
  if (!seat) return null;
  if (error.code === "AUTHORITY_SELF_RESOLUTION") {
    return new LoanError(409, "LOAN_APPROVAL_SEAT_SELF",
      `Pemohon menduduki kursi persetujuan ${seat}, sehingga pengajuan ini tidak dapat diproses.`);
  }
  return new LoanError(409, "LOAN_APPROVAL_SEAT_UNAVAILABLE",
    `Kursi persetujuan ${seat} belum dapat ditetapkan (${error.code}). Hubungi Human Capital.`);
}

/**
 * APR-001 at submission (D-01, amended by the owner decision of 2026-11-18): the shared resolver
 * turns the policy chain into concrete principals, drops the requester and merges duplicates.
 *
 * Under `LEGACY` that chain is still the direct manager then the unit approver, from the two legacy
 * columns. Under `STRUCTURE` it is the unit approver followed by the fixed seats, and a seat held
 * by an organ account produces an account step (ORG-013-5, migration 0169).
 *
 * Every employee approver must be an active employee with an active account; every account
 * approver must be an active Foundation Board account holding `loans.governance.approve`. Holding
 * the seat never confers the capability.
 */
async function resolveApprovalChain(
  db: Queryable,
  employee: EmployeeContext,
  effectiveDate: string,
  principalAmount: bigint,
) {
  const mode = await new PostgresOrganizationRepository(db)
    .getRolloutMode(LOAN_WORKFLOW_KEY, employee.id, effectiveDate);
  const plan = await planApprovalSeats(db, mode, effectiveDate, principalAmount);
  let resolution;
  try {
    resolution = await resolveLeaveAuthorities(db, {
      workflowKey: LOAN_WORKFLOW_KEY,
      requesterEmployeeId: employee.id,
      effectiveDate,
      legacy: {
        directManagerEmployeeId: employee.directManagerEmployeeId,
        unitApproverEmployeeId: employee.unitApproverEmployeeId,
      },
      policyChain: "UNIT_AND_APPROVAL_SEATS",
      approvalSeats: plan.seats,
      allowAccountPrincipal: true,
      accountCapability: LOAN_GOVERNANCE_CAPABILITY,
    });
  } catch (error) {
    const named = seatFailure(error, plan);
    if (named) throw named;
    throw error;
  }

  const employeeIds = resolution.approvalChain.flatMap((step) => step.employeeId ? [step.employeeId] : []);
  const accountIds = resolution.approvalChain.flatMap((step) => step.employeeId ? [] : [step.accountId!]);
  const actors = await db.query<{ id: string; fullName: string; status: string; accountStatus: string | null }>(
    `SELECT employee.id, employee.full_name AS "fullName", employee.status, account.status AS "accountStatus"
       FROM employees employee
       LEFT JOIN accounts account ON account.employee_id = employee.id AND account.principal_type = 'EMPLOYEE'
      WHERE employee.id = ANY($1::uuid[]) AND employee.removed_at IS NULL
        -- EMP-005 S2B §8.7: an approver outside HCIS management reads as not active.
        AND employee.management_scope = 'MANAGED'`,
    [employeeIds],
  );
  const byId = new Map(actors.rows.map((row) => [row.id, row]));
  // ORG-013-1: the account must be an active organ account that holds the capability, checked
  // again here so a capability lost between resolution and storage still stops the submission.
  const organ = accountIds.length === 0
    ? { rows: [] as Array<{ id: string; capable: boolean; isRequester: boolean }> }
    : await db.query<{ id: string; capable: boolean; isRequester: boolean }>(
      // ORG-013-1 butir 5: the same e-mail match the decision repeats. An organ account with no
      // e-mail counts as the requester, which fails closed rather than letting a loan jam later.
      `SELECT account.id,
              (
                NULLIF(lower(btrim(account.email)), '') IS NULL
                OR NULLIF(lower(btrim(account.email)), '') IN (
                  SELECT NULLIF(lower(btrim(value)), '')
                    FROM (
                      SELECT requester.email AS value FROM employees requester WHERE requester.id = $4
                      UNION ALL
                      SELECT linked.email FROM accounts linked
                       WHERE linked.employee_id = $4 AND linked.principal_type = 'EMPLOYEE'
                    ) AS requester_emails
                )
              ) AS "isRequester",
              EXISTS (
                SELECT 1 FROM account_role_assignments assignment
                JOIN role_permissions grant_row ON grant_row.role_id = assignment.role_id
                WHERE assignment.account_id = account.id
                  AND assignment.scope_type = 'organization'
                  AND grant_row.permission_key = $2
                  AND (assignment.starts_on IS NULL OR assignment.starts_on <= $3::date)
                  AND (assignment.ends_on IS NULL OR assignment.ends_on >= $3::date)
              ) AS capable
         FROM accounts account
        WHERE account.id = ANY($1::uuid[])
          AND account.principal_type = 'FOUNDATION_BOARD'
          AND account.employee_id IS NULL
          AND account.status = 'active'`,
      [accountIds, LOAN_GOVERNANCE_CAPABILITY, effectiveDate, employee.id],
    );
  const byAccount = new Map(organ.rows.map((row) => [row.id, row]));

  const chain: ChainStep[] = resolution.approvalChain.map((step) => {
    if (!step.employeeId) {
      const account = byAccount.get(step.accountId!);
      if (!account || !account.capable) {
        throw new LoanError(409, "APPROVER_ACCOUNT_NOT_READY",
          `Akun Organ Yayasan untuk kursi ${seatLabelForSource(step.sources) ?? "persetujuan"} belum siap menyetujui.`);
      }
      // M4 / D-19: the resolver's self-check only covers employee principals, so a requester who
      // also holds a separate FOUNDATION_BOARD account in one of the seats used to pass submission
      // and then jam: at decision time `governanceActorIsRequester` refuses BOTH approve and
      // reject, leaving the loan stuck in IN_REVIEW with nobody able to act. The same identity
      // check runs here, where the capability re-check already does, and refuses at submission.
      if (account.isRequester) {
        throw new LoanError(409, "LOAN_APPROVAL_SEAT_SELF",
          `Pemohon menduduki kursi persetujuan ${seatLabelForSource(step.sources) ?? "persetujuan"}, `
          + "sehingga pengajuan ini tidak dapat diproses.");
      }
      return {
        employeeId: null,
        accountId: step.accountId!,
        name: seatLabelForSource(step.sources) ?? "Organ Yayasan",
        sources: step.sources,
      };
    }
    const actor = byId.get(step.employeeId);
    if (!actor || actor.status !== "active") {
      throw new LoanError(409, "APPROVER_NOT_ACTIVE", "Rantai approval berisi approver yang tidak aktif.");
    }
    if (actor.accountStatus !== "active") {
      throw new LoanError(409, "APPROVER_ACCOUNT_NOT_READY", `Akun approver ${actor.fullName} belum aktif.`);
    }
    return { employeeId: actor.id, accountId: null, name: actor.fullName, sources: step.sources };
  });
  return { chain, context: resolution.context };
}

/**
 * ORG-013-5: a Foundation Board account decides a loan step only while it holds
 * `loans.governance.approve`. Holding the seat is not the capability (ORG-013-1).
 */
async function assertLoanGovernanceCapability(db: Queryable, accountId: string): Promise<void> {
  const capability = await db.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM account_role_assignments assignment
       JOIN role_permissions grant_row ON grant_row.role_id = assignment.role_id
       WHERE assignment.account_id = $1
         AND assignment.scope_type = 'organization'
         AND grant_row.permission_key = $3
         AND (assignment.starts_on IS NULL OR assignment.starts_on <= $2::date)
         AND (assignment.ends_on IS NULL OR assignment.ends_on >= $2::date)
     ) AS allowed`,
    [accountId, today(), LOAN_GOVERNANCE_CAPABILITY],
  );
  if (!capability.rows[0]?.allowed) {
    throw new LoanError(403, "APPROVAL_FORBIDDEN", "Capability governance approval pinjaman tidak tersedia.");
  }
}

/** D-06: one open loan per employee. */
async function assertNoOpenLoan(db: Queryable, employeeId: string) {
  const open = await db.query(
    `SELECT 1 FROM employee_loans WHERE employee_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
    [employeeId, [...OPEN_LOAN_STATUSES]],
  );
  if (open.rows[0]) {
    throw new LoanError(409, "LOAN_ALREADY_OPEN", "Masih ada pinjaman yang diajukan atau belum lunas.");
  }
}

function previewSchedule(principal: bigint, tenorMonths: number, submittedOn: string) {
  // The real first month is fixed at disbursement (D-09); the preview assumes next month.
  return buildInstalmentSchedule({ principal, tenorMonths, firstDueMonth: addMonths(submittedOn.slice(0, 7), 1) })
    .map((row) => ({ sequence: row.sequence, dueMonth: row.dueMonth, amount: rupiahToJson(row.amount) }));
}

async function addEvent(
  db: PoolClient,
  loanId: string,
  actorAccountId: string | null,
  eventType: string,
  note: string | null = null,
  metadata: Record<string, string | number | null> = {},
) {
  // clock_timestamp(), not now(): two events written in one transaction (approved_step then
  // request.approved, payment then paid_off) must keep their order in the history.
  await db.query(
    `INSERT INTO employee_loan_events (id, loan_id, event_type, actor_account_id, note, metadata, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [randomUUID(), loanId, eventType, actorAccountId, note, JSON.stringify(metadata)],
  );
}

const SUMMARY_COLUMNS = `
  loan.id, loan.status, loan.tenor_months AS "tenorMonths", loan.purpose,
  loan.principal_amount::text AS "principal", loan.paid_total::text AS "paidTotal",
  loan.submitted_at AS "submittedAt", loan.final_decided_at AS "finalDecidedAt",
  to_char(loan.disbursed_on, 'YYYY-MM-DD') AS "disbursedOn",
  to_char(loan.first_due_month, 'YYYY-MM') AS "firstDueMonth",
  approver.full_name AS "currentApproverName",
  current_step.sources AS "currentApproverSources"`;
const SUMMARY_JOINS = `
  LEFT JOIN employee_loan_approval_steps current_step
    ON current_step.loan_id = loan.id AND current_step.status = 'pending'
  LEFT JOIN employees approver ON approver.id = current_step.approver_employee_id`;

type SummaryRow = {
  principal: string;
  paidTotal: string;
  total?: number;
  currentApproverName?: string | null;
  currentApproverSources?: string[] | null;
} & Record<string, unknown>;

function summary({ principal, paidTotal, total, currentApproverSources, ...row }: SummaryRow) {
  void total;
  const principalAmount = toRupiah(principal);
  const paid = toRupiah(paidTotal);
  return {
    ...row,
    // ORG-013-5: an organ account has no name in HCIS, so its step is named by its seat.
    currentApproverName: row.currentApproverName
      ?? seatLabelForSource(currentApproverSources ?? []),
    principal: rupiahToJson(principalAmount),
    paidTotal: rupiahToJson(paid),
    outstanding: rupiahToJson(principalAmount - paid),
  };
}

async function loadLoanDetail(db: Queryable, id: string, ownerEmployeeId: string | null) {
  const found = await db.query<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS},
            loan.employee_id AS "employeeId", employee.full_name AS "employeeName",
            employee.employee_number AS "employeeNumber", unit.name AS "unitName",
            loan.cancel_reason AS "cancelReason", loan.disbursement_method AS "disbursementMethod",
            loan.disbursement_reference AS "disbursementReference", loan.paid_off_at AS "paidOffAt"
       FROM employee_loans loan
       JOIN employees employee ON employee.id = loan.employee_id
       LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
       ${SUMMARY_JOINS}
      WHERE loan.id = $1 AND ($2::uuid IS NULL OR loan.employee_id = $2)`,
    [id, ownerEmployeeId],
  );
  const row = found.rows[0];
  if (!row) return null;
  // Bounded by the loan itself: at most twelve instalments (D-04) and the payments recorded
  // against one loan, which can never exceed its principal.
  const [steps, instalments, payments, events] = await Promise.all([
    db.query(
      // LEFT JOIN: an ORG-013-5 account step has no employee row, and must still be listed.
      `SELECT step.id, step.step_order AS "order", step.status, step.sources,
              approver.full_name AS "approverName", step.acted_at AS "actedAt",
              step.decision_note AS "decisionNote"
         FROM employee_loan_approval_steps step
         LEFT JOIN employees approver ON approver.id = step.approver_employee_id
        WHERE step.loan_id = $1
        ORDER BY step.step_order ASC`,
      [id],
    ),
    db.query<{ sequence: number; dueMonth: string; amount: string }>(
      `SELECT sequence, to_char(due_month, 'YYYY-MM') AS "dueMonth", amount::text AS amount
         FROM employee_loan_instalments WHERE loan_id = $1 ORDER BY sequence ASC`,
      [id],
    ),
    db.query<{ amount: string } & Record<string, unknown>>(
      `SELECT payment.id, payment.amount::text AS amount, to_char(payment.paid_on, 'YYYY-MM-DD') AS "paidOn",
              payment.method, payment.reference, payment.note, payment.status,
              payment.recorded_at AS "recordedAt", recorder.full_name AS "recordedByName",
              payment.reversed_at AS "reversedAt", payment.reverse_reason AS "reverseReason"
         FROM employee_loan_payments payment
         LEFT JOIN accounts account ON account.id = payment.recorded_by_account_id
         LEFT JOIN employees recorder ON recorder.id = account.employee_id
        WHERE payment.loan_id = $1
        ORDER BY payment.paid_on ASC, payment.recorded_at ASC, payment.id ASC`,
      [id],
    ),
    db.query(
      `SELECT event.id, event.event_type AS "eventType", event.occurred_at AS "occurredAt",
              event.note, event.metadata, actor.full_name AS "actorName"
         FROM employee_loan_events event
         LEFT JOIN accounts account ON account.id = event.actor_account_id
         LEFT JOIN employees actor ON actor.id = account.employee_id
        WHERE event.loan_id = $1
        ORDER BY event.occurred_at ASC, event.id ASC`,
      [id],
    ),
  ]);
  const standing = instalmentStanding(
    instalments.rows.map((item) => ({ ...item, amount: toRupiah(item.amount) })),
    toRupiah(row.paidTotal),
    today().slice(0, 7),
  );
  return {
    ...summary(row),
    schedule: standing.map((item) => ({
      sequence: item.sequence,
      dueMonth: item.dueMonth,
      amount: rupiahToJson(item.amount),
      paid: rupiahToJson(item.paid),
      state: item.state,
      overdue: item.overdue,
    })),
    payments: payments.rows.map((payment) => ({ ...payment, amount: amount(payment.amount) })),
    steps: (steps.rows as Array<{ approverName: string | null; sources: string[] }>).map((step) => ({
      ...step,
      approverName: step.approverName ?? seatLabelForSource(step.sources),
    })),
    events: events.rows,
  };
}

export async function registerLoanRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
  injectedAuth?: Pick<AuthService, "getSession" | "getAuthorizationContext">,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required for loan routes");
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
      await send(reply, 403, { code: "FORBIDDEN", message: "Pinjaman hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  /**
   * ORG-013-5: the two approval routes also accept a Foundation Board session, the way Leave's
   * `/leave/approvals` do. Every other loan route stays employee-only — an organ account never
   * requests, cancels, disburses or reads the register.
   */
  async function requireApprover(request: FastifyRequest, reply: FastifyReply): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    if (principal.principalType !== "EMPLOYEE" && principal.principalType !== "FOUNDATION_BOARD") {
      await send(reply, 403, { code: "FORBIDDEN", message: "Pinjaman hanya tersedia untuk pegawai." });
      return null;
    }
    return principal;
  }

  async function requirePermission(
    request: FastifyRequest,
    reply: FastifyReply,
    permission: LoanPermission,
  ): Promise<AuthPrincipal | null> {
    const principal = await authenticate(request, reply);
    if (!principal) return null;
    const context = await auth.getAuthorizationContext(principal);
    if (!context.organizationPermissions.includes(permission)) {
      await send(reply, 403, { code: "LOAN_FORBIDDEN", message: "Anda tidak memiliki akses untuk tindakan ini." });
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
      // The money invariants are deferred triggers (migration 0122); COMMIT is where they run.
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
   * D-14: Finance never moves money on its own loan. The check reads the actor's employee
   * from the account, so an account without an employee passes (it cannot own a loan).
   */
  async function assertNotOwnLoan(db: Queryable, actorAccountId: string, loanEmployeeId: string) {
    const actor = await db.query<{ employeeId: string | null }>(
      `SELECT employee_id AS "employeeId" FROM accounts WHERE id = $1`,
      [actorAccountId],
    );
    if (actor.rows[0]?.employeeId === loanEmployeeId) {
      throw new LoanError(403, "LOAN_SELF_ACTION_FORBIDDEN", "Pinjaman milik Anda sendiri harus diproses petugas lain.");
    }
  }

  interface LockedLoan {
    employeeId: string;
    status: LoanStatus;
    principal: string;
    paidTotal: string;
    tenorMonths: number;
    disbursedOn: string | null;
    decidedOn: string | null;
  }

  async function lockLoan(client: PoolClient, id: string, ownerEmployeeId: string | null = null): Promise<LockedLoan> {
    const found = await client.query<LockedLoan>(
      `SELECT employee_id AS "employeeId", status, principal_amount::text AS principal,
              paid_total::text AS "paidTotal", tenor_months AS "tenorMonths",
              to_char(disbursed_on, 'YYYY-MM-DD') AS "disbursedOn",
              to_char(final_decided_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS "decidedOn"
         FROM employee_loans
        WHERE id = $1 AND ($2::uuid IS NULL OR employee_id = $2)
        FOR UPDATE`,
      [id, ownerEmployeeId],
    );
    const loan = found.rows[0];
    if (!loan) throw new LoanError(404, "LOAN_NOT_FOUND", "Pinjaman tidak ditemukan.");
    return loan;
  }

  /** D-08. Steps that never ran become `cancelled` rather than disappearing. */
  async function cancelLoan(
    client: PoolClient,
    input: { id: string; ownerEmployeeId: string | null; by: LoanCanceller; actorAccountId: string; reason: string },
  ) {
    const loan = await lockLoan(client, input.id, input.ownerEmployeeId);
    if (input.by === "finance") await assertNotOwnLoan(client, input.actorAccountId, loan.employeeId);
    if (!canCancelLoan(loan.status)) {
      throw new LoanError(409, "LOAN_NOT_CANCELLABLE", loan.status === "DISBURSED"
        ? "Pinjaman sudah dicairkan dan tidak dapat dibatalkan; selesaikan lewat pelunasan."
        : "Pinjaman ini tidak dapat dibatalkan.");
    }
    await client.query(
      `UPDATE employee_loans
          SET status = 'CANCELLED', cancelled_by_account_id = $2, cancel_reason = $3, updated_at = now()
        WHERE id = $1`,
      [input.id, input.actorAccountId, input.reason],
    );
    await client.query(
      `UPDATE employee_loan_approval_steps SET status = 'cancelled'
        WHERE loan_id = $1 AND status IN ('waiting', 'pending')`,
      [input.id],
    );
    await addEvent(client, input.id, input.actorAccountId, "loan.request.cancelled", input.reason, {
      by: input.by, previousStatus: loan.status,
    });
    if (input.by === "finance") {
      await notifyEmployee(client, loan.employeeId, {
        eventKey: `loan.${input.id}.cancelled`,
        category: "system",
        title: "Pengajuan pinjaman dibatalkan",
        body: "Pengajuan pinjaman Anda dibatalkan oleh Keuangan. Lihat alasannya di riwayat.",
        href: `/app/loans?loan=${input.id}`,
        actorAccountId: input.actorAccountId,
      });
    }
    return { id: input.id, status: "CANCELLED" as const };
  }

  // ---------------------------------------------------------------- employee

  app.get("/loans/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const query = listQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_LOAN_FILTER", message: "Filter tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const result = await pool.query<SummaryRow & { total: number }>(
        `SELECT ${SUMMARY_COLUMNS}, count(*) OVER ()::int AS total
           FROM employee_loans loan
           ${SUMMARY_JOINS}
          WHERE loan.employee_id = $1 AND ($2::text IS NULL OR loan.status = $2)
          ORDER BY loan.submitted_at DESC, loan.id DESC
          LIMIT $3 OFFSET $4`,
        [employee.id, query.data.status ?? null, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(summary),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.get("/loans/me/:id", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_LOAN_ID", message: "Pinjaman tidak valid." });
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      // LOAN-001-A: another employee's loan is indistinguishable from a missing one.
      const detail = await loadLoanDetail(pool, params.data.id, employee.id);
      if (!detail) return send(reply, 404, { code: "LOAN_NOT_FOUND", message: "Pinjaman tidak ditemukan." });
      return send(reply, 200, detail);
    });
  });

  app.post("/loans/me/preview", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = termsBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_LOAN_REQUEST", message: "Pokok pinjaman harus bilangan bulat rupiah." });
    }
    return handle(reply, async () => {
      const employee = await loadEmployeeContext(pool, principal.id);
      const submittedOn = today();
      const principalAmount = toRupiah(body.data.principal);
      validateLoanTerms({ principal: principalAmount, tenorMonths: body.data.tenorMonths });
      await assertNoOpenLoan(pool, employee.id);
      const { chain } = await resolveApprovalChain(pool, employee, submittedOn, principalAmount);
      return send(reply, 200, {
        schedule: previewSchedule(principalAmount, body.data.tenorMonths, submittedOn),
        approvalChain: chain,
      });
    });
  });

  app.post("/loans/me", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const body = submitBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, {
        code: "INVALID_LOAN_REQUEST",
        message: "Pokok (bilangan bulat rupiah), lama cicilan, atau keperluan (min. 10 karakter) tidak valid.",
      });
    }
    return transact(reply, async (client) => {
      // Locking the employee row serializes this employee's submissions, so two clicks
      // cannot both pass the one-open-loan check (D-06).
      const employee = await loadEmployeeContext(client, principal.id, true);
      const replay = await client.query<{ id: string; status: LoanStatus; principal: string; tenorMonths: number }>(
        `SELECT id, status, principal_amount::text AS principal, tenor_months AS "tenorMonths"
           FROM employee_loans WHERE employee_id = $1 AND idempotency_key = $2`,
        [employee.id, body.data.idempotencyKey],
      );
      const previous = replay.rows[0];
      if (previous) {
        // A key names one submission; the same key with other terms is a client bug, not a retry.
        if (toRupiah(previous.principal) !== toRupiah(body.data.principal) || previous.tenorMonths !== body.data.tenorMonths) {
          throw new LoanError(409, "IDEMPOTENCY_KEY_REUSED", "Pengajuan ini sudah terkirim dengan nilai lain. Muat ulang halaman.");
        }
        return [200, { id: previous.id, status: previous.status, idempotentReplay: true }];
      }

      const submittedOn = today();
      const principalAmount = toRupiah(body.data.principal);
      validateLoanTerms({ principal: principalAmount, tenorMonths: body.data.tenorMonths });
      await assertNoOpenLoan(client, employee.id);
      const { chain, context } = await resolveApprovalChain(client, employee, submittedOn, principalAmount);

      const id = randomUUID();
      await client.query(
        `INSERT INTO employee_loans (
           id, employee_id, principal_amount, tenor_months, purpose, status, idempotency_key, approval_snapshot
         ) VALUES ($1, $2, $3::bigint, $4, $5, 'IN_REVIEW', $6, $7::jsonb)`,
        [
          id, employee.id, principalAmount.toString(), body.data.tenorMonths, body.data.purpose,
          body.data.idempotencyKey,
          JSON.stringify({
            workflowKey: LOAN_WORKFLOW_KEY,
            steps: chain.map((step) => ({
              employeeId: step.employeeId, accountId: step.accountId, sources: step.sources,
            })),
            authorityResolution: context,
          }),
        ],
      );
      const steps: Array<{ id: string; employeeId: string | null; accountId: string | null; name: string }> = [];
      for (const [index, step] of chain.entries()) {
        const stepId = randomUUID();
        await client.query(
          `INSERT INTO employee_loan_approval_steps (
             id, loan_id, step_order, approver_employee_id, approver_account_id, sources, status
           ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7)`,
          [stepId, id, index + 1, step.employeeId, step.accountId, step.sources,
            index === 0 ? "pending" : "waiting"],
        );
        steps.push({ id: stepId, employeeId: step.employeeId, accountId: step.accountId, name: step.name });
      }
      await addEvent(client, id, principal.id, "loan.request.submitted", null, {
        tenorMonths: body.data.tenorMonths, approvers: steps.length, mode: context.mode,
      });
      const first = steps[0]!;
      // NOTIF-004 is employee-keyed. An organ account sees its step in Panel Organ Yayasan
      // instead, exactly as it does for Leave; nothing names an amount either way.
      if (first.employeeId) {
        await notifyEmployee(client, first.employeeId, {
          eventKey: `loan.approval.${first.id}`,
          category: "system",
          title: "Persetujuan pinjaman",
          body: `${employee.fullName} mengajukan pinjaman pegawai.`,
          href: "/app/approvals",
          actorAccountId: principal.id,
        });
      }
      return [201, { id, status: "IN_REVIEW", approvalChain: steps, idempotentReplay: false }];
    });
  });

  app.post("/loans/me/:id/cancel", async (request, reply) => {
    const principal = await requireEmployee(request, reply);
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_LOAN_ID", message: "Pinjaman tidak valid." });
    const body = employeeCancelBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_LOAN_CANCEL", message: "Alasan pembatalan minimal 5 karakter." });
    return transact(reply, async (client) => {
      const employee = await loadEmployeeContext(client, principal.id);
      const result = await cancelLoan(client, {
        id: params.data.id, ownerEmployeeId: employee.id, by: "employee",
        actorAccountId: principal.id, reason: body.data.reason,
      });
      return [200, result];
    });
  });

  // ---------------------------------------------------------------- approver

  app.get("/loans/approvals", async (request, reply) => {
    const principal = await requireApprover(request, reply);
    if (!principal) return;
    const query = pageQuerySchema.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_LOAN_FILTER", message: "Filter tidak valid." });
    const organ = principal.principalType !== "EMPLOYEE";
    return handle(reply, async () => {
      if (organ) await assertLoanGovernanceCapability(pool, principal.id);
      const owner = organ ? principal.id : (await loadEmployeeContext(pool, principal.id)).id;
      // The approver sees the amount and tenor they are deciding on, and nothing else of the loan.
      const result = await pool.query<{ principal: string; total: number }>(
        `SELECT step.id AS "stepId", loan.id AS "loanId", step.sources,
                requester.full_name AS "requesterName", requester.employee_number AS "requesterNumber",
                unit.name AS "unitName", loan.purpose, loan.tenor_months AS "tenorMonths",
                loan.principal_amount::text AS principal,
                loan.submitted_at AS "submittedAt", count(*) OVER ()::int AS total
           FROM employee_loan_approval_steps step
           JOIN employee_loans loan ON loan.id = step.loan_id
           JOIN employees requester ON requester.id = loan.employee_id
           LEFT JOIN organizational_units unit ON unit.id = requester.organizational_unit_id
          WHERE ${organ ? "step.approver_account_id" : "step.approver_employee_id"} = $1
            AND step.status = 'pending' AND loan.status = 'IN_REVIEW'
          ORDER BY loan.submitted_at ASC, step.id ASC
          LIMIT $2 OFFSET $3`,
        [owner, query.data.pageSize, pageOffset(query.data)],
      );
      return send(reply, 200, {
        items: result.rows.map(({ total, principal: value, ...row }) => {
          void total;
          return { ...row, principal: amount(value) };
        }),
        pagination: pagination(query.data, result.rows[0]?.total ?? 0),
      });
    });
  });

  app.post("/loans/approvals/:stepId/decision", async (request, reply) => {
    const principal = await requireApprover(request, reply);
    if (!principal) return;
    const organ = principal.principalType !== "EMPLOYEE";
    const params = stepParams.safeParse(request.params);
    const body = decisionBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return send(reply, 400, {
        code: "INVALID_APPROVAL_DECISION",
        message: "Keputusan tidak valid. Penolakan wajib disertai alasan minimal 5 karakter.",
      });
    }
    return transact(reply, async (client) => {
      const actorEmployeeId = organ ? null : (await loadEmployeeContext(client, principal.id)).id;
      // Lock order loan -> step, the same as cancelLoan, so a decision racing a cancellation
      // waits instead of deadlocking.
      await client.query(
        `SELECT 1 FROM employee_loans
          WHERE id = (SELECT loan_id FROM employee_loan_approval_steps WHERE id = $1)
          FOR UPDATE`,
        [params.data.stepId],
      );
      const found = await client.query<{
        id: string; loanId: string; approverEmployeeId: string | null; approverAccountId: string | null;
        loanStatus: LoanStatus; requesterEmployeeId: string;
      }>(
        `SELECT step.id, step.loan_id AS "loanId", step.approver_employee_id AS "approverEmployeeId",
                step.approver_account_id AS "approverAccountId",
                loan.status AS "loanStatus", loan.employee_id AS "requesterEmployeeId"
           FROM employee_loan_approval_steps step
           JOIN employee_loans loan ON loan.id = step.loan_id
          WHERE step.id = $1
          FOR UPDATE OF step, loan`,
        [params.data.stepId],
      );
      const current = found.rows[0];
      if (!current) throw new LoanError(404, "APPROVAL_STEP_NOT_FOUND", "Tahap approval tidak ditemukan.");
      // LOAN-001-C: the snapshot owns the step; nothing else grants it.
      const ownsStep = organ
        ? current.approverAccountId === principal.id
        : current.approverEmployeeId === actorEmployeeId;
      if (!ownsStep) {
        throw new LoanError(403, "APPROVAL_FORBIDDEN", "Tahap approval ini bukan milik akun Anda.");
      }
      if (organ) {
        // ORG-013-1 butir 5: holding the seat is not the capability, and the e-mail match repeats
        // the submit-time self-approval rule for a principal that has no employee id.
        await assertLoanGovernanceCapability(client, principal.id);
        if (await governanceActorIsRequester(client, principal.id, current.requesterEmployeeId)) {
          throw new LoanError(403, "LOAN_SELF_ACTION_FORBIDDEN",
            "Pengajuan ini tidak dapat diputuskan oleh pemohon sendiri.");
        }
      }
      const all = await client.query<LeaveApprovalStepState>(
        `SELECT id, step_order AS "order", status
           FROM employee_loan_approval_steps WHERE loan_id = $1 ORDER BY step_order ASC`,
        [current.loanId],
      );
      const decision = decideLeaveApprovalStep({
        requestStatus: approvalRequestStatus(current.loanStatus),
        stepId: current.id,
        decision: body.data.decision,
        steps: all.rows,
      });
      const note = body.data.note ?? null;
      await client.query(
        `UPDATE employee_loan_approval_steps
            SET status = $2, acted_by_account_id = $3, acted_at = now(), decision_note = $4
          WHERE id = $1`,
        [current.id, decision.decidedStepStatus, principal.id, note],
      );
      if (decision.nextPendingStepId) {
        const next = await client.query<{ approverEmployeeId: string | null }>(
          `UPDATE employee_loan_approval_steps SET status = 'pending' WHERE id = $1
           RETURNING approver_employee_id AS "approverEmployeeId"`,
          [decision.nextPendingStepId],
        );
        const nextEmployeeId = next.rows[0]!.approverEmployeeId;
        if (nextEmployeeId) {
          await notifyEmployee(client, nextEmployeeId, {
            eventKey: `loan.approval.${decision.nextPendingStepId}`,
            category: "system",
            title: "Persetujuan pinjaman",
            body: "Pengajuan pinjaman pegawai menunggu keputusan Anda.",
            href: "/app/approvals",
            actorAccountId: principal.id,
          });
        }
      }
      const loanStatus: LoanStatus = decision.requestStatus === "approved"
        ? "APPROVED"
        : decision.requestStatus === "rejected" ? "REJECTED" : "IN_REVIEW";
      if (loanStatus !== "IN_REVIEW") {
        await client.query(
          `UPDATE employee_loans SET status = $2, final_decided_at = now(), updated_at = now() WHERE id = $1`,
          [current.loanId, loanStatus],
        );
      }
      await addEvent(
        client, current.loanId, principal.id,
        body.data.decision === "reject" ? "loan.request.rejected" : "loan.approval.approved_step",
        note, { stepId: current.id },
      );
      if (loanStatus === "APPROVED") await addEvent(client, current.loanId, principal.id, "loan.request.approved");
      if (loanStatus !== "IN_REVIEW") {
        await notifyEmployee(client, current.requesterEmployeeId, {
          eventKey: `loan.${current.loanId}.${loanStatus.toLowerCase()}`,
          category: "system",
          title: loanStatus === "APPROVED" ? "Pinjaman disetujui" : "Pinjaman ditolak",
          body: loanStatus === "APPROVED"
            ? "Pengajuan pinjaman Anda disetujui. Keuangan akan mencairkan dan menetapkan jadwal cicilan."
            : "Pengajuan pinjaman Anda ditolak. Lihat alasannya di riwayat.",
          href: `/app/loans?loan=${current.loanId}`,
          actorAccountId: principal.id,
        });
      }
      return [200, {
        loanId: current.loanId,
        loanStatus,
        stepStatus: decision.decidedStepStatus,
        nextPendingStepId: decision.nextPendingStepId,
      }];
    });
  });

  // ------------------------------------------------------------------- admin

  app.get("/admin/loans", async (request, reply) => {
    if (!(await requirePermission(request, reply, "loans.read"))) return;
    const query = adminListQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_LOAN_FILTER", message: "Filter tidak valid." });
    // ENG-LIST-001: filters run before LIMIT; the page carries the true total.
    return handle(reply, async () => {
    const result = await pool.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS},
              loan.employee_id AS "employeeId", employee.full_name AS "employeeName",
              employee.employee_number AS "employeeNumber", unit.name AS "unitName",
              count(*) OVER ()::int AS total
         FROM employee_loans loan
         JOIN employees employee ON employee.id = loan.employee_id
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
         ${SUMMARY_JOINS}
        WHERE ($1::text IS NULL OR loan.status = $1) AND ($2::uuid IS NULL OR loan.employee_id = $2)
        ORDER BY loan.submitted_at DESC, loan.id DESC
        LIMIT $3 OFFSET $4`,
      [query.data.status ?? null, query.data.employeeId ?? null, query.data.pageSize, pageOffset(query.data)],
    );
    return send(reply, 200, {
      items: result.rows.map(summary),
      pagination: pagination(query.data, result.rows[0]?.total ?? 0),
    });
    });
  });

  // ENG-LIST-001 typeahead for the register filter. It searches borrowers only — people the
  // reader already sees in the register — so loans.read opens no wider employee directory.
  app.get("/admin/loans/borrowers", async (request, reply) => {
    if (!(await requirePermission(request, reply, "loans.read"))) return;
    const query = borrowerQuery.safeParse(request.query);
    if (!query.success) return send(reply, 400, { code: "INVALID_LOAN_FILTER", message: "Kata kunci minimal 2 huruf." });
    return handle(reply, async () => {
    const result = await pool.query<{ total: number }>(
      `SELECT employee.id, employee.full_name AS "fullName", employee.employee_number AS "employeeNumber",
              unit.name AS "unitName", count(*) OVER ()::int AS total
         FROM employees employee
         LEFT JOIN organizational_units unit ON unit.id = employee.organizational_unit_id
        WHERE EXISTS (SELECT 1 FROM employee_loans loan WHERE loan.employee_id = employee.id)
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

  app.get("/admin/loans/:id", async (request, reply) => {
    if (!(await requirePermission(request, reply, "loans.read"))) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_LOAN_ID", message: "Pinjaman tidak valid." });
    return handle(reply, async () => {
      const detail = await loadLoanDetail(pool, params.data.id, null);
      if (!detail) return send(reply, 404, { code: "LOAN_NOT_FOUND", message: "Pinjaman tidak ditemukan." });
      return send(reply, 200, detail);
    });
  });

  app.post("/admin/loans/:id/disburse", async (request, reply) => {
    const principal = await requirePermission(request, reply, "loans.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_LOAN_ID", message: "Pinjaman tidak valid." });
    const body = disburseBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_LOAN_DISBURSEMENT", message: "Tanggal, cara pencairan, atau bulan cicilan pertama tidak valid." });
    }
    return transact(reply, async (client) => {
      const loan = await lockLoan(client, params.data.id);
      await assertNotOwnLoan(client, principal.id, loan.employeeId);
      if (loan.status !== "APPROVED") {
        throw new LoanError(409, "LOAN_NOT_DISBURSABLE", "Hanya pinjaman yang sudah disetujui yang dapat dicairkan.");
      }
      // D-14: the cash gate is independent of the approval. Whoever sits in this loan's chain
      // (decided or not) cannot also hand over the money.
      //
      // M4 finding (e): matching the ids alone missed the case that matters most — an organ member
      // who also has an employee account with `loans.manage`. Their seat step carries an
      // `approver_account_id` that is not the disbursing account, and `approver_employee_id` is
      // NULL, so every id comparison fails and D-14 silently lets the same person approve and pay.
      // The last clause matches the person, by the same e-mail rule ORG-013-1 butir 5 uses.
      const approver = await client.query(
        `SELECT 1 FROM employee_loan_approval_steps step
          WHERE step.loan_id = $1
            AND (step.acted_by_account_id = $2
              OR step.approver_account_id = $2
              OR step.approver_employee_id = (SELECT employee_id FROM accounts WHERE id = $2)
              OR EXISTS (
                SELECT 1
                  FROM accounts seat_account
                  JOIN accounts actor ON actor.id = $2
                  LEFT JOIN employees actor_employee ON actor_employee.id = actor.employee_id
                 WHERE seat_account.id = step.approver_account_id
                   AND NULLIF(lower(btrim(seat_account.email)), '') IS NOT NULL
                   AND NULLIF(lower(btrim(seat_account.email)), '') IN (
                     NULLIF(lower(btrim(actor.email)), ''),
                     NULLIF(lower(btrim(actor_employee.email)), '')
                   )
              ))
          LIMIT 1`,
        [params.data.id, principal.id],
      );
      if (approver.rows[0]) {
        throw new LoanError(403, "LOAN_APPROVER_CANNOT_DISBURSE", "Penyetuju pinjaman ini tidak boleh sekaligus mencairkannya.");
      }
      const employee = await client.query<{ status: string }>(
        `SELECT status FROM employees WHERE id = $1 AND removed_at IS NULL`,
        [loan.employeeId],
      );
      if (employee.rows[0]?.status !== "active") {
        throw new LoanError(409, "LOAN_EMPLOYEE_NOT_ACTIVE", "Pegawai ini sudah tidak aktif; batalkan pinjamannya.");
      }
      // Money is not handed over before the last approval (D-09).
      if (loan.decidedOn && body.data.disbursedOn < loan.decidedOn) {
        throw new LoanError(409, "LOAN_DISBURSED_BEFORE_APPROVAL", "Tanggal pencairan tidak boleh sebelum pinjaman disetujui.");
      }
      const firstDueMonth = resolveFirstDueMonth({
        disbursedOn: body.data.disbursedOn, firstDueMonth: body.data.firstDueMonth ?? null, today: today(),
      });
      const schedule = buildInstalmentSchedule({
        principal: toRupiah(loan.principal), tenorMonths: loan.tenorMonths, firstDueMonth,
      });
      for (const instalment of schedule) {
        await client.query(
          `INSERT INTO employee_loan_instalments (id, loan_id, sequence, due_month, amount)
           VALUES ($1, $2, $3, ($4 || '-01')::date, $5::bigint)`,
          [randomUUID(), params.data.id, instalment.sequence, instalment.dueMonth, instalment.amount.toString()],
        );
      }
      await client.query(
        `UPDATE employee_loans
            SET status = 'DISBURSED', disbursed_on = $2::date, disbursement_method = $3, disbursement_reference = $4,
                first_due_month = ($5 || '-01')::date, disbursed_by_account_id = $6, disbursed_at = now(), updated_at = now()
          WHERE id = $1`,
        [params.data.id, body.data.disbursedOn, body.data.method, body.data.reference || null, firstDueMonth, principal.id],
      );
      await addEvent(client, params.data.id, principal.id, "loan.disbursed", null, {
        method: body.data.method, firstDueMonth, instalments: schedule.length,
      });
      await notifyEmployee(client, loan.employeeId, {
        eventKey: `loan.${params.data.id}.disbursed`,
        category: "system",
        title: "Pinjaman dicairkan",
        body: `Pinjaman Anda sudah dicairkan. Cicilan pertama jatuh pada ${firstDueMonth}.`,
        href: `/app/loans?loan=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [200, { id: params.data.id, status: "DISBURSED", firstDueMonth, instalments: schedule.length }];
    });
  });

  app.post("/admin/loans/:id/payments", async (request, reply) => {
    const principal = await requirePermission(request, reply, "loans.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_LOAN_ID", message: "Pinjaman tidak valid." });
    const body = paymentBody.safeParse(request.body);
    if (!body.success) {
      return send(reply, 400, { code: "INVALID_LOAN_PAYMENT", message: "Jumlah (bilangan bulat rupiah), tanggal, atau cara bayar tidak valid." });
    }
    return transact(reply, async (client) => {
      const loan = await lockLoan(client, params.data.id);
      await assertNotOwnLoan(client, principal.id, loan.employeeId);
      const replay = await client.query<{ id: string; amount: string; paidOn: string; method: string }>(
        `SELECT id, amount::text AS amount, to_char(paid_on, 'YYYY-MM-DD') AS "paidOn", method
           FROM employee_loan_payments WHERE loan_id = $1 AND idempotency_key = $2`,
        [params.data.id, body.data.idempotencyKey],
      );
      const previous = replay.rows[0];
      if (previous) {
        if (toRupiah(previous.amount) !== toRupiah(body.data.amount)
          || previous.paidOn !== body.data.paidOn || previous.method !== body.data.method) {
          throw new LoanError(409, "IDEMPOTENCY_KEY_REUSED", "Pembayaran ini sudah tercatat dengan nilai lain. Muat ulang halaman.");
        }
        return [200, { id: params.data.id, paymentId: previous.id, status: loan.status, idempotentReplay: true }];
      }
      // Package 2: while payroll deducts instalments itself, a hand-recorded
      // PAYROLL_DEDUCTION would count the same slip twice (employee-loans.md §9.2).
      // A loan payroll already mirrors is refused too while the switch is off:
      // a deduction set on the mirror would be recorded on approval as well.
      const mirrored = body.data.method === "PAYROLL_DEDUCTION" && config.LOAN_PAYROLL_DEDUCTION_ENABLED !== "1"
        ? (await client.query("SELECT 1 FROM payroll_loans WHERE employee_loan_id = $1", [params.data.id])).rows.length > 0
        : false;
      if (body.data.method === "PAYROLL_DEDUCTION" && (config.LOAN_PAYROLL_DEDUCTION_ENABLED === "1" || mirrored)) {
        throw new LoanError(409, "LOAN_PAYROLL_DEDUCTION_AUTOMATIC",
          "Potongan gaji dicatat otomatis saat periode payroll disahkan; catat tunai atau transfer saja.");
      }
      if (loan.status !== "DISBURSED") {
        throw new LoanError(409, "LOAN_NOT_REPAYABLE", loan.status === "PAID_OFF"
          ? "Pinjaman ini sudah lunas."
          : "Pembayaran hanya dicatat untuk pinjaman yang sudah dicairkan.");
      }
      if (!isCalendarDate(body.data.paidOn) || body.data.paidOn < loan.disbursedOn! || body.data.paidOn > today()) {
        throw new LoanError(409, "LOAN_PAYMENT_DATE", "Tanggal bayar antara tanggal pencairan dan hari ini.");
      }
      const principalAmount = toRupiah(loan.principal);
      const paidBefore = toRupiah(loan.paidTotal);
      const paymentAmount = toRupiah(body.data.amount);
      assertPaymentFits(paymentAmount, principalAmount - paidBefore);
      const paidAfter = paidBefore + paymentAmount;
      const status = repaymentStatus(principalAmount, paidAfter);

      const paymentId = randomUUID();
      await client.query(
        `INSERT INTO employee_loan_payments (
           id, loan_id, amount, paid_on, method, reference, note, idempotency_key, recorded_by_account_id, recorded_at
         ) VALUES ($1, $2, $3::bigint, $4::date, $5, $6, $7, $8, $9, clock_timestamp())`,
        [
          paymentId, params.data.id, paymentAmount.toString(), body.data.paidOn, body.data.method,
          body.data.reference || null, body.data.note || null, body.data.idempotencyKey, principal.id,
        ],
      );
      await client.query(
        `UPDATE employee_loans
            SET paid_total = $2::bigint, status = $3,
                paid_off_at = CASE WHEN $3 = 'PAID_OFF' THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1`,
        [params.data.id, paidAfter.toString(), status],
      );
      await addEvent(client, params.data.id, principal.id, "loan.payment.recorded", null, {
        paymentId, method: body.data.method, paidOn: body.data.paidOn,
      });
      if (status === "PAID_OFF") await addEvent(client, params.data.id, principal.id, "loan.paid_off");
      await notifyEmployee(client, loan.employeeId, {
        eventKey: `loan.payment.${paymentId}`,
        category: "system",
        title: status === "PAID_OFF" ? "Pinjaman lunas" : "Pembayaran pinjaman dicatat",
        body: status === "PAID_OFF"
          ? "Pinjaman Anda tercatat lunas."
          : "Keuangan mencatat pembayaran cicilan pinjaman Anda. Lihat sisa pinjaman di detail.",
        href: `/app/loans?loan=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [201, { id: params.data.id, paymentId, status, idempotentReplay: false }];
    });
  });

  app.post("/admin/loans/:id/payments/:paymentId/reverse", async (request, reply) => {
    const principal = await requirePermission(request, reply, "loans.manage");
    if (!principal) return;
    const params = paymentParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_LOAN_ID", message: "Pembayaran tidak valid." });
    const body = financeReasonBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_LOAN_REVERSAL", message: "Alasan koreksi minimal 10 karakter." });
    return transact(reply, async (client) => {
      const loan = await lockLoan(client, params.data.id);
      await assertNotOwnLoan(client, principal.id, loan.employeeId);
      const found = await client.query<{ amount: string; status: string; fromPayroll: boolean }>(
        `SELECT amount::text AS amount, status, source_payroll_period_id IS NOT NULL AS "fromPayroll"
           FROM employee_loan_payments
          WHERE id = $1 AND loan_id = $2 FOR UPDATE`,
        [params.data.paymentId, params.data.id],
      );
      const payment = found.rows[0];
      if (!payment) throw new LoanError(404, "LOAN_PAYMENT_NOT_FOUND", "Pembayaran tidak ditemukan.");
      if (payment.status !== "ACTIVE") {
        throw new LoanError(409, "LOAN_PAYMENT_ALREADY_REVERSED", "Pembayaran ini sudah dikoreksi.");
      }
      // A payment written by an approved payroll period mirrors the slip; it is
      // reversed only by reopening that period (employee-loans.md §9.2 item 3).
      if (payment.fromPayroll) {
        throw new LoanError(409, "LOAN_PAYMENT_FROM_PAYROLL",
          "Potongan ini berasal dari periode payroll yang sudah disahkan; koreksi lewat buka ulang periode itu.");
      }
      const principalAmount = toRupiah(loan.principal);
      const paidAfter = toRupiah(loan.paidTotal) - toRupiah(payment.amount);
      const status = repaymentStatus(principalAmount, paidAfter);
      await client.query(
        `UPDATE employee_loan_payments
            SET status = 'REVERSED', reversed_by_account_id = $2, reversed_at = clock_timestamp(), reverse_reason = $3
          WHERE id = $1`,
        [params.data.paymentId, principal.id, body.data.reason],
      );
      await client.query(
        `UPDATE employee_loans
            SET paid_total = $2::bigint, status = $3, paid_off_at = NULL, updated_at = now()
          WHERE id = $1`,
        [params.data.id, paidAfter.toString(), status],
      );
      await addEvent(client, params.data.id, principal.id, "loan.payment.reversed", body.data.reason, {
        paymentId: params.data.paymentId, previousStatus: loan.status,
      });
      await notifyEmployee(client, loan.employeeId, {
        eventKey: `loan.payment.${params.data.paymentId}.reversed`,
        category: "system",
        title: "Pembayaran pinjaman dikoreksi",
        body: "Keuangan mengoreksi satu pembayaran pinjaman Anda. Lihat alasannya di riwayat.",
        href: `/app/loans?loan=${params.data.id}`,
        actorAccountId: principal.id,
      });
      return [200, { id: params.data.id, paymentId: params.data.paymentId, status }];
    });
  });

  app.post("/admin/loans/:id/cancel", async (request, reply) => {
    const principal = await requirePermission(request, reply, "loans.manage");
    if (!principal) return;
    const params = idParams.safeParse(request.params);
    if (!params.success) return send(reply, 400, { code: "INVALID_LOAN_ID", message: "Pinjaman tidak valid." });
    const body = financeReasonBody.safeParse(request.body);
    if (!body.success) return send(reply, 400, { code: "INVALID_LOAN_CANCEL", message: "Alasan pembatalan minimal 10 karakter." });
    return transact(reply, async (client) => {
      const result = await cancelLoan(client, {
        id: params.data.id, ownerEmployeeId: null, by: "finance", actorAccountId: principal.id, reason: body.data.reason,
      });
      return [200, result];
    });
  });
}
