// LOAN-001 Package 1 acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerLoanRoutes } from "../src/modules/loans/routes.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The routes own their transactions; BEGIN/COMMIT/ROLLBACK become savepoints of the test's. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase();
    if (statement.startsWith("BEGIN")) return client.query(`SAVEPOINT test_sp_${++depth}`);
    if (statement.startsWith("COMMIT")) {
      const name = `test_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
      const name = `test_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

function jakartaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function nextMonth(date: string): string {
  const [year, month] = date.split("-").map(Number) as [number, number];
  const index = year * 12 + month; // month is 1-based, so this is already "next"
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

describe.skipIf(!allowed)("LOAN-001 employee loans", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  const people = {} as Record<"requester" | "manager" | "unitApprover" | "finance", { employeeId: string; accountId: string }>;
  const today = jakartaToday();
  const FINANCE = ["loans.read", "loans.manage"];

  async function insertEmployee(name: string, unitId: string | null) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id)
       VALUES ($1,$2,$3,'active','2020-01-06',$4)`,
      [id, `LOAN-${id.slice(0, 8)}`, name, unitId],
    );
    return id;
  }

  async function insertAccount(employeeId: string, status = "active") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE',$4)`,
      [id, employeeId, `loan-${id}@example.invalid`, status],
    );
    return id;
  }

  function actAs(who: keyof typeof people, granted: string[] = []) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  async function submit(overrides: Record<string, unknown> = {}) {
    actAs("requester");
    return app.inject({
      method: "POST",
      url: "/loans/me",
      payload: {
        principal: 1_000_000,
        tenorMonths: 3,
        purpose: "Biaya perbaikan rumah setelah hujan deras",
        idempotencyKey: randomUUID(),
        ...overrides,
      },
    });
  }

  async function submitted(overrides: Record<string, unknown> = {}) {
    const response = await submit(overrides);
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; approvalChain: Array<{ id: string; employeeId: string }> };
  }

  async function decide(stepId: string, who: keyof typeof people, decision: "approve" | "reject", note?: string) {
    actAs(who);
    return app.inject({ method: "POST", url: `/loans/approvals/${stepId}/decision`, payload: { decision, note } });
  }

  async function approvedLoan(overrides: Record<string, unknown> = {}) {
    const loan = await submitted(overrides);
    expect((await decide(loan.approvalChain[0]!.id, "manager", "approve")).statusCode).toBe(200);
    expect((await decide(loan.approvalChain[1]!.id, "unitApprover", "approve")).statusCode).toBe(200);
    return loan;
  }

  async function disburse(id: string, payload: Record<string, unknown> = {}) {
    actAs("finance", FINANCE);
    return app.inject({
      method: "POST", url: `/admin/loans/${id}/disburse`,
      payload: { disbursedOn: today, method: "TRANSFER", ...payload },
    });
  }

  async function disbursedLoan() {
    const loan = await approvedLoan();
    const response = await disburse(loan.id);
    expect(response.statusCode, response.body).toBe(200);
    return loan;
  }

  async function pay(id: string, amount: number, extra: Record<string, unknown> = {}) {
    actAs("finance", FINANCE);
    return app.inject({
      method: "POST", url: `/admin/loans/${id}/payments`,
      payload: { amount, paidOn: today, method: "PAYROLL_DEDUCTION", idempotencyKey: randomUUID(), ...extra },
    });
  }

  async function detail(id: string) {
    actAs("finance", FINANCE);
    const response = await app.inject({ method: "GET", url: `/admin/loans/${id}` });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  /** Runs the deferred money triggers of migration 0122 now instead of at COMMIT. */
  async function checkMoneyInvariants() {
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1,$2,'Unit Pinjaman Sintetis')",
      [unitId, `unit-loan-${unitId}`],
    );
    for (const key of ["manager", "unitApprover", "requester", "finance"] as const) {
      const employeeId = await insertEmployee(`Pegawai ${key}`, unitId);
      people[key] = { employeeId, accountId: await insertAccount(employeeId) };
    }
    await client.query("UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1", [unitId, people.unitApprover.employeeId]);
    for (const key of ["requester", "finance"] as const) {
      await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people[key].employeeId, people.manager.employeeId]);
    }
    actAs("requester");

    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    await registerLoanRoutes(app, savepointPool(client), config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("LOAN-001-A/B: snapshots the chain at submission and keeps each loan private to its owner", async () => {
    const preview = await app.inject({ method: "POST", url: "/loans/me/preview", payload: { principal: 1_000_000, tenorMonths: 3 } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().schedule.map((row: { amount: number }) => row.amount)).toEqual([333_000, 333_000, 334_000]);
    expect(preview.json().schedule[0].dueMonth).toBe(nextMonth(today));

    const loan = await submitted();
    expect(loan.approvalChain.map((step) => step.employeeId)).toEqual([people.manager.employeeId, people.unitApprover.employeeId]);

    // A later change of manager does not rewrite the stored chain (APR-001-B).
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people.requester.employeeId, people.finance.employeeId]);
    actAs("requester");
    const own = await app.inject({ method: "GET", url: `/loans/me/${loan.id}` });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json()).toMatchObject({ principal: 1_000_000, paidTotal: 0, outstanding: 1_000_000, status: "IN_REVIEW", schedule: [] });
    expect(own.json().steps.map((step: { status: string }) => step.status)).toEqual(["pending", "waiting"]);

    // Another employee cannot tell the loan exists.
    actAs("manager");
    expect((await app.inject({ method: "GET", url: `/loans/me/${loan.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/loans/me/${loan.id}/cancel`, payload: { reason: "bukan milik saya" } })).statusCode).toBe(404);

    // The approver sees what they decide on in the queue.
    const queue = await app.inject({ method: "GET", url: "/loans/approvals" });
    expect(queue.json().items).toEqual([expect.objectContaining({ loanId: loan.id, principal: 1_000_000, tenorMonths: 3 })]);
    expect(queue.json().pagination.total).toBe(1);
  });

  it("LOAN-001-C: only the snapshotted approver decides, and a decision lands once", async () => {
    const loan = await submitted();
    expect((await decide(loan.approvalChain[0]!.id, "unitApprover", "approve")).statusCode).toBe(403);
    expect((await decide(loan.approvalChain[1]!.id, "unitApprover", "approve")).json().code).toBe("STEP_NOT_PENDING");
    expect((await decide(loan.approvalChain[0]!.id, "manager", "approve")).statusCode).toBe(200);
    expect((await decide(loan.approvalChain[0]!.id, "manager", "approve")).statusCode).toBe(409);
    expect((await decide(loan.approvalChain[1]!.id, "unitApprover", "reject")).statusCode).toBe(400);
    expect((await decide(loan.approvalChain[1]!.id, "unitApprover", "reject", "Pinjaman sebelumnya belum lama lunas")).statusCode).toBe(200);
    const rejected = await detail(loan.id);
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.events.map((event: { eventType: string }) => event.eventType))
      .toEqual(["loan.request.submitted", "loan.approval.approved_step", "loan.request.rejected"]);
  });

  it("LOAN-001-D: a missing or inactive approver stores nothing", async () => {
    await client.query("UPDATE accounts SET status = 'invited' WHERE id = $1", [people.unitApprover.accountId]);
    const response = await submit();
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("APPROVER_ACCOUNT_NOT_READY");
    const count = await client.query("SELECT count(*)::int AS count FROM employee_loans WHERE employee_id = $1", [people.requester.employeeId]);
    expect(count.rows[0].count).toBe(0);
  });

  it("LOAN-001-E: refuses out-of-range terms and a second open loan, and replays an idempotent submit", async () => {
    expect((await submit({ principal: 50_000 })).json().code).toBe("LOAN_PRINCIPAL_OUT_OF_RANGE");
    expect((await submit({ tenorMonths: 5 })).json().code).toBe("LOAN_TENOR_OUT_OF_RANGE");
    expect((await submit({ principal: 1_000_000.5 })).statusCode).toBe(400);

    const key = randomUUID();
    const first = await submitted({ idempotencyKey: key });
    const replay = await submit({ idempotencyKey: key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: first.id, idempotentReplay: true });
    // The same key with other terms is not a retry.
    expect((await submit({ idempotencyKey: key, principal: 2_000_000 })).json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await submit()).json().code).toBe("LOAN_ALREADY_OPEN");

    // Once cancelled, the employee may ask again.
    actAs("requester");
    expect((await app.inject({ method: "POST", url: `/loans/me/${first.id}/cancel`, payload: { reason: "Salah nominal" } })).statusCode).toBe(200);
    expect((await submit()).statusCode).toBe(201);
  });

  it("LOAN-001-F/K: Finance disburses an approved loan into an exact schedule, never its own", async () => {
    const pending = await submitted();
    expect((await disburse(pending.id)).json().code).toBe("LOAN_NOT_DISBURSABLE");
    actAs("requester");
    await app.inject({ method: "POST", url: `/loans/me/${pending.id}/cancel`, payload: { reason: "Diajukan ulang" } });

    const loan = await approvedLoan({ principal: 1_234_567, tenorMonths: 6 });
    // D-14: the requester holding loans.manage still cannot disburse their own loan.
    actAs("requester", FINANCE);
    const self = await app.inject({ method: "POST", url: `/admin/loans/${loan.id}/disburse`, payload: { disbursedOn: today, method: "CASH" } });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe("LOAN_SELF_ACTION_FORBIDDEN");

    // D-14: an approver of this loan holding loans.manage cannot also hand over the money.
    actAs("manager", FINANCE);
    const approverDisburse = await app.inject({ method: "POST", url: `/admin/loans/${loan.id}/disburse`, payload: { disbursedOn: today, method: "CASH" } });
    expect(approverDisburse.statusCode).toBe(403);
    expect(approverDisburse.json().code).toBe("LOAN_APPROVER_CANNOT_DISBURSE");

    expect((await disburse(loan.id, { firstDueMonth: today.slice(0, 7) })).json().code).toBe("LOAN_FIRST_DUE_TOO_EARLY");
    const response = await disburse(loan.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: "DISBURSED", firstDueMonth: nextMonth(today), instalments: 6 });

    const disbursed = await detail(loan.id);
    expect(disbursed.schedule.map((row: { amount: number }) => row.amount)).toEqual([205_000, 205_000, 205_000, 205_000, 205_000, 209_567]);
    expect(disbursed.schedule.reduce((total: number, row: { amount: number }) => total + row.amount, 0)).toBe(1_234_567);
    expect(disbursed.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "loan.request.submitted", "loan.approval.approved_step", "loan.approval.approved_step",
      "loan.request.approved", "loan.disbursed",
    ]);
    await checkMoneyInvariants();

    // No cancellation once money has moved (D-08).
    actAs("finance", FINANCE);
    const cancel = await app.inject({ method: "POST", url: `/admin/loans/${loan.id}/cancel`, payload: { reason: "Ingin dibatalkan saja" } });
    expect(cancel.json().code).toBe("LOAN_NOT_CANCELLABLE");
  });

  it("LOAN-001-G/H: payments pay down oldest first, settle the loan, and reverse cleanly", async () => {
    const loan = await disbursedLoan();
    expect((await pay(loan.id, 1_000_001)).json().code).toBe("LOAN_PAYMENT_EXCEEDS_BALANCE");
    expect((await pay(loan.id, 0)).statusCode).toBe(400);
    expect((await pay(loan.id, 1_000, { paidOn: "2000-01-01" })).json().code).toBe("LOAN_PAYMENT_DATE");

    const key = randomUUID();
    const first = await pay(loan.id, 400_000, { idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(201);
    expect((await pay(loan.id, 400_000, { idempotencyKey: key })).json()).toMatchObject({ idempotentReplay: true });
    expect((await pay(loan.id, 500_000, { idempotencyKey: key })).json().code).toBe("IDEMPOTENCY_KEY_REUSED");

    let state = await detail(loan.id);
    expect(state).toMatchObject({ status: "DISBURSED", paidTotal: 400_000, outstanding: 600_000 });
    expect(state.schedule.map((row: { paid: number; state: string }) => [row.paid, row.state]))
      .toEqual([[333_000, "PAID"], [67_000, "PARTIAL"], [0, "UNPAID"]]);

    // Pelunasan: the remaining balance in one payment.
    const payoff = await pay(loan.id, 600_000, { method: "CASH" });
    expect(payoff.json().status).toBe("PAID_OFF");
    expect((await pay(loan.id, 1_000)).json().code).toBe("LOAN_NOT_REPAYABLE");
    await checkMoneyInvariants();

    // Reversing the payoff reopens the loan with the right balance.
    actAs("finance", FINANCE);
    const short = await app.inject({
      method: "POST", url: `/admin/loans/${loan.id}/payments/${payoff.json().paymentId}/reverse`, payload: { reason: "salah" },
    });
    expect(short.statusCode).toBe(400);
    const reversed = await app.inject({
      method: "POST", url: `/admin/loans/${loan.id}/payments/${payoff.json().paymentId}/reverse`,
      payload: { reason: "Dana tunai ternyata belum diterima kasir" },
    });
    expect(reversed.statusCode, reversed.body).toBe(200);
    expect(reversed.json().status).toBe("DISBURSED");
    const again = await app.inject({
      method: "POST", url: `/admin/loans/${loan.id}/payments/${payoff.json().paymentId}/reverse`,
      payload: { reason: "Dana tunai ternyata belum diterima kasir" },
    });
    expect(again.json().code).toBe("LOAN_PAYMENT_ALREADY_REVERSED");

    state = await detail(loan.id);
    expect(state).toMatchObject({ status: "DISBURSED", paidTotal: 400_000, outstanding: 600_000, paidOffAt: null });
    expect(state.payments.map((payment: { status: string }) => payment.status)).toEqual(["ACTIVE", "REVERSED"]);
    expect(state.events.map((event: { eventType: string }) => event.eventType).slice(-4))
      .toEqual(["loan.payment.recorded", "loan.payment.recorded", "loan.paid_off", "loan.payment.reversed"]);
    await checkMoneyInvariants();

    // The employee sees the same standing on their own screen.
    actAs("requester");
    const own = await app.inject({ method: "GET", url: `/loans/me/${loan.id}` });
    expect(own.json()).toMatchObject({ outstanding: 600_000 });
    expect(own.json().payments).toHaveLength(2);
  });

  it("LOAN-001-I/L: history carries no amount, and the database refuses inconsistent money", async () => {
    const loan = await disbursedLoan();
    expect((await pay(loan.id, 250_000)).statusCode).toBe(201);
    const events = await client.query<{ metadata: Record<string, unknown>; note: string | null }>(
      "SELECT metadata, note FROM employee_loan_events WHERE loan_id = $1", [loan.id],
    );
    for (const event of events.rows) {
      expect(JSON.stringify(event)).not.toMatch(/250000|250\.000|1000000|1\.000\.000|333000/);
    }
    const notifications = await client.query<{ title: string; body: string }>(
      `SELECT title, body FROM in_app_notifications WHERE event_key LIKE $1`, [`loan.%`],
    );
    expect(notifications.rows.length).toBeGreaterThan(0);
    for (const notification of notifications.rows) {
      expect(`${notification.title} ${notification.body}`).not.toMatch(/Rp|\d{3}\.\d{3}|\d{6}/);
    }

    await client.query("SAVEPOINT tamper");
    await client.query("UPDATE employee_loans SET paid_total = paid_total + 1 WHERE id = $1", [loan.id]);
    await expect(checkMoneyInvariants()).rejects.toThrow(/paid total does not match/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");

    await client.query("SAVEPOINT tamper");
    await expect(client.query("UPDATE employee_loan_instalments SET amount = amount + 1 WHERE loan_id = $1", [loan.id]))
      .rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");

    await client.query("SAVEPOINT tamper");
    await expect(client.query("DELETE FROM employee_loan_payments WHERE loan_id = $1", [loan.id])).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");

    // A payment only ever moves ACTIVE -> REVERSED; its amount never changes in place.
    await client.query("SAVEPOINT tamper");
    await expect(client.query("UPDATE employee_loan_payments SET amount = amount + 1 WHERE loan_id = $1", [loan.id]))
      .rejects.toThrow(/may only be reversed/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");
  });

  it("LOAN-001-J: the register needs loans.read, pages with a true total, and filters by employee", async () => {
    await disbursedLoan();
    actAs("finance", ["trips.read"]);
    expect((await app.inject({ method: "GET", url: "/admin/loans" })).statusCode).toBe(403);
    actAs("finance", ["loans.read"]);
    const page = await app.inject({ method: "GET", url: `/admin/loans?employeeId=${people.requester.employeeId}&pageSize=1` });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().pagination).toMatchObject({ page: 1, pageSize: 1, total: 1 });
    expect(page.json().items[0]).toMatchObject({ employeeId: people.requester.employeeId, status: "DISBURSED", outstanding: 1_000_000 });
    expect((await app.inject({ method: "GET", url: "/admin/loans?pageSize=101" })).statusCode).toBe(400);
    // The typeahead finds borrowers only, never the wider employee register.
    const borrowers = await app.inject({ method: "GET", url: "/admin/loans/borrowers?q=Pegawai" });
    expect(borrowers.statusCode, borrowers.body).toBe(200);
    expect(borrowers.json().items.map((item: { id: string }) => item.id)).toEqual([people.requester.employeeId]);
    expect((await app.inject({ method: "GET", url: "/admin/loans/borrowers?q=P" })).statusCode).toBe(400);
    // A reader cannot move money.
    expect((await app.inject({ method: "POST", url: `/admin/loans/${page.json().items[0].id}/cancel`, payload: { reason: "tidak berwenang sama sekali" } })).statusCode).toBe(403);
  });
});
