// REIMB-001 Package 1 acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerReimbursementRoutes } from "../src/modules/reimbursements/routes.js";

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

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n").toString("base64");
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("synthetic receipt")]).toString("base64");

type Who = "requester" | "manager" | "unitApprover" | "finance" | "other";

describe.skipIf(!allowed)("REIMB-001 reimbursements", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  const people = {} as Record<Who, { employeeId: string; accountId: string }>;
  const today = jakartaToday();
  const FINANCE = ["reimbursements.read", "reimbursements.manage"];

  async function insertEmployee(name: string, unitId: string | null) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id)
       VALUES ($1,$2,$3,'active','2020-01-06',$4)`,
      [id, `RMB-${id.slice(0, 8)}`, name, unitId],
    );
    return id;
  }

  async function insertAccount(employeeId: string, status = "active") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE',$4)`,
      [id, employeeId, `rmb-${id}@example.invalid`, status],
    );
    return id;
  }

  function actAs(who: Who, granted: string[] = []) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  const items = (overrides: Record<string, unknown>[] = []) => (overrides.length ? overrides : [
    { category: "TRANSPORT", expenseDate: today, description: "Tiket kereta ke Bandung", amount: 250_000 },
    { category: "MEALS", expenseDate: today, description: "Makan siang rapat", amount: 75_000 },
  ]);

  async function createDraft(overrides: Record<string, unknown> = {}, who: Who = "requester") {
    actAs(who);
    return app.inject({
      method: "POST", url: "/reimbursements/me",
      payload: { title: "Rapat koordinasi di Bandung", items: items(), idempotencyKey: randomUUID(), ...overrides },
    });
  }

  async function draft(overrides: Record<string, unknown> = {}) {
    const response = await createDraft(overrides);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function upload(id: string, contentBase64 = PDF, contentType = "application/pdf") {
    actAs("requester");
    return app.inject({ method: "POST", url: `/reimbursements/me/${id}/receipts`, payload: { contentType, contentBase64 } });
  }

  async function submitted(overrides: Record<string, unknown> = {}) {
    const id = await draft(overrides);
    expect((await upload(id)).statusCode).toBe(201);
    actAs("requester");
    const response = await app.inject({ method: "POST", url: `/reimbursements/me/${id}/submit` });
    expect(response.statusCode, response.body).toBe(200);
    return { id, steps: response.json().approvalChain as Array<{ id: string; employeeId: string }> };
  }

  async function decide(stepId: string, who: Who, decision: "approve" | "reject", note?: string) {
    actAs(who);
    return app.inject({ method: "POST", url: `/reimbursements/approvals/${stepId}/decision`, payload: { decision, note } });
  }

  async function approved() {
    const claim = await submitted();
    expect((await decide(claim.steps[0]!.id, "manager", "approve")).statusCode).toBe(200);
    expect((await decide(claim.steps[1]!.id, "unitApprover", "approve")).statusCode).toBe(200);
    return claim;
  }

  async function detail(id: string) {
    actAs("finance", FINANCE);
    const response = await app.inject({ method: "GET", url: `/admin/reimbursements/${id}` });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  async function verify(id: string, decisions?: Array<{ itemId: string; approvedAmount: number }>, note?: string) {
    const current = await detail(id);
    actAs("finance", FINANCE);
    return app.inject({
      method: "POST", url: `/admin/reimbursements/${id}/verify`,
      payload: {
        items: decisions ?? current.items.map((item: { id: string; amount: number }) => ({ itemId: item.id, approvedAmount: item.amount })),
        note,
      },
    });
  }

  async function pay(id: string, extra: Record<string, unknown> = {}) {
    actAs("finance", FINANCE);
    return app.inject({
      method: "POST", url: `/admin/reimbursements/${id}/pay`,
      payload: { paidOn: today, method: "TRANSFER", idempotencyKey: randomUUID(), ...extra },
    });
  }

  /** Runs the deferred money triggers of migration 0148 now instead of at COMMIT. */
  async function checkMoneyInvariants() {
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
  }

  async function insertTrip(who: Who, status: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO business_trip_requests (id, employee_id, destination, purpose, start_on, end_on, status, idempotency_key)
       VALUES ($1, $2, 'Bandung', 'Rapat koordinasi sekolah mitra', $3::date, $3::date, $4, $5)`,
      [id, people[who].employeeId, daysBefore(today, 3), status, randomUUID()],
    );
    return id;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1,$2,'Unit Reimbursement Sintetis')",
      [unitId, `unit-rmb-${unitId}`],
    );
    for (const key of ["manager", "unitApprover", "requester", "finance", "other"] as const) {
      const employeeId = await insertEmployee(`Pegawai ${key}`, unitId);
      people[key] = { employeeId, accountId: await insertAccount(employeeId) };
    }
    await client.query("UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1", [unitId, people.unitApprover.employeeId]);
    for (const key of ["requester", "finance", "other"] as const) {
      await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people[key].employeeId, people.manager.employeeId]);
    }
    actAs("requester");

    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    await registerReimbursementRoutes(app, savepointPool(client), config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("REIMB-001-A/B: a draft with receipts is submitted into a snapshotted chain and stays private", async () => {
    const list = await app.inject({ method: "GET", url: "/reimbursements/me" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().categories.map((category: { key: string }) => category.key)).toContain("ACCOMMODATION");
    expect(list.json().policy).toMatchObject({ maxClaimTotal: 10_000_000, maxItems: 10, maxReceipts: 10 });

    const id = await draft();
    expect((await upload(id, PNG, "image/png")).statusCode).toBe(201);
    expect((await upload(id, PNG, "application/pdf")).json().code).toBe("REIMBURSEMENT_RECEIPT_INVALID");
    const preview = await app.inject({ method: "GET", url: "/reimbursements/me/approvers" });
    expect(preview.json().approvalChain.map((step: { employeeId: string }) => step.employeeId))
      .toEqual([people.manager.employeeId, people.unitApprover.employeeId]);

    // Drafts are invisible to the register and to other employees.
    actAs("finance", FINANCE);
    expect((await app.inject({ method: "GET", url: `/admin/reimbursements/${id}` })).statusCode).toBe(404);
    actAs("other");
    expect((await app.inject({ method: "GET", url: `/reimbursements/me/${id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: `/reimbursements/me/${id}`, payload: { title: "Diubah orang lain", items: items() } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/reimbursements/me/${id}/submit` })).statusCode).toBe(404);

    actAs("requester");
    const submit = await app.inject({ method: "POST", url: `/reimbursements/me/${id}/submit` });
    expect(submit.statusCode, submit.body).toBe(200);
    expect((await app.inject({ method: "POST", url: `/reimbursements/me/${id}/submit` })).json().code).toBe("REIMBURSEMENT_NOT_SUBMITTABLE");
    expect((await app.inject({ method: "PUT", url: `/reimbursements/me/${id}`, payload: { title: "Ubah setelah kirim", items: items() } })).json().code)
      .toBe("REIMBURSEMENT_NOT_EDITABLE");

    // A later change of manager does not rewrite the stored chain.
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people.requester.employeeId, people.finance.employeeId]);
    actAs("requester");
    const own = await app.inject({ method: "GET", url: `/reimbursements/me/${id}` });
    expect(own.json()).toMatchObject({ status: "IN_REVIEW", claimedTotal: 325_000, verifiedTotal: null, payment: null });
    expect(own.json().steps.map((step: { status: string }) => step.status)).toEqual(["pending", "waiting"]);
    expect(own.json().receipts).toHaveLength(1);
    const receipt = own.json().receipts[0].id as string;
    const file = await app.inject({ method: "GET", url: `/reimbursements/me/${id}/receipts/${receipt}` });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-disposition"]).toMatch(/^attachment; filename="bukti-reimbursement-/);
    expect(file.rawPayload.subarray(0, 8)).toEqual(Buffer.from(PNG, "base64").subarray(0, 8));

    actAs("other");
    expect((await app.inject({ method: "GET", url: `/reimbursements/me/${id}/receipts/${receipt}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/reimbursements/me/${id}/cancel`, payload: { reason: "bukan milik saya" } })).statusCode).toBe(404);
  });

  it("REIMB-001-C: only the snapshotted approver decides and opens the claim; a decision lands once", async () => {
    const claim = await submitted();
    // The second approver's step is still waiting: nothing opens for them yet.
    actAs("unitApprover");
    expect((await app.inject({ method: "GET", url: `/reimbursements/approvals/${claim.steps[1]!.id}` })).statusCode).toBe(403);
    expect((await decide(claim.steps[0]!.id, "unitApprover", "approve")).statusCode).toBe(403);
    expect((await decide(claim.steps[1]!.id, "unitApprover", "approve")).json().code).toBe("STEP_NOT_PENDING");

    actAs("manager");
    const queue = await app.inject({ method: "GET", url: "/reimbursements/approvals" });
    expect(queue.json().items).toEqual([expect.objectContaining({ claimId: claim.id, claimedTotal: 325_000, itemCount: 2, receiptCount: 1 })]);
    const view = await app.inject({ method: "GET", url: `/reimbursements/approvals/${claim.steps[0]!.id}` });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().items).toHaveLength(2);
    expect(view.json()).not.toHaveProperty("payment");
    const receipt = view.json().receipts[0].id as string;
    expect((await app.inject({ method: "GET", url: `/reimbursements/approvals/${claim.steps[0]!.id}/receipts/${receipt}` })).statusCode).toBe(200);
    actAs("other");
    expect((await app.inject({ method: "GET", url: `/reimbursements/approvals/${claim.steps[0]!.id}/receipts/${receipt}` })).statusCode).toBe(403);

    expect((await decide(claim.steps[0]!.id, "manager", "approve")).statusCode).toBe(200);
    expect((await decide(claim.steps[0]!.id, "manager", "approve")).statusCode).toBe(409);
    expect((await decide(claim.steps[1]!.id, "unitApprover", "reject")).statusCode).toBe(400);
    expect((await decide(claim.steps[1]!.id, "unitApprover", "reject", "Bukti konsumsi bukan untuk rapat")).statusCode).toBe(200);
    const rejected = await detail(claim.id);
    expect(rejected).toMatchObject({ status: "REJECTED", rejectedBy: "APPROVER" });
    expect(rejected.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "reimbursement.draft.created", "reimbursement.receipt.added", "reimbursement.request.submitted",
      "reimbursement.receipt.read", "reimbursement.approval.approved_step", "reimbursement.request.rejected",
    ]);
  });

  it("REIMB-001-D: a missing or inactive approver leaves the draft untouched", async () => {
    const id = await draft();
    expect((await upload(id)).statusCode).toBe(201);
    await client.query("UPDATE accounts SET status = 'invited' WHERE id = $1", [people.unitApprover.accountId]);
    actAs("requester");
    const response = await app.inject({ method: "POST", url: `/reimbursements/me/${id}/submit` });
    expect(response.json().code).toBe("APPROVER_ACCOUNT_NOT_READY");
    const row = await client.query("SELECT status FROM reimbursement_claims WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("DRAFT");
    const steps = await client.query("SELECT count(*)::int AS count FROM reimbursement_approval_steps WHERE claim_id = $1", [id]);
    expect(steps.rows[0].count).toBe(0);
  });

  it("REIMB-001-E: limits, dates, receipts and trips are enforced; a create is replayed", async () => {
    const over = await createDraft({ items: items([{ category: "MEALS", expenseDate: today, description: "Konsumsi", amount: 1_000_001 }]) });
    expect(over.json().code).toBe("REIMBURSEMENT_ITEM_ABOVE_LIMIT");
    const total = await createDraft({ items: items(Array.from({ length: 4 }, () => ({ category: "TRANSPORT", expenseDate: today, description: "Tiket", amount: 3_000_000 }))) });
    expect(total.json().code).toBe("REIMBURSEMENT_TOTAL_ABOVE_LIMIT");
    const future = await createDraft({ items: items([{ category: "OTHER", expenseDate: "2999-01-01", description: "Masa depan", amount: 5_000 }]) });
    expect(future.json().code).toBe("REIMBURSEMENT_EXPENSE_IN_FUTURE");
    expect((await createDraft({ items: items([{ category: "OTHER", expenseDate: today, description: "Pecahan", amount: 5_000.5 }]) })).statusCode).toBe(400);
    // Lengths are counted in characters, as the database counts them: three emoji are three, not six.
    expect((await createDraft({ title: "\u{1F600}\u{1F600}\u{1F600}" })).statusCode).toBe(400);

    // D-06: another employee's trip, or one still in review, cannot be linked.
    const othersTrip = await insertTrip("other", "APPROVED");
    expect((await createDraft({ businessTripId: othersTrip })).json().code).toBe("REIMBURSEMENT_TRIP_NOT_ELIGIBLE");
    const pendingTrip = await insertTrip("requester", "IN_REVIEW");
    expect((await createDraft({ businessTripId: pendingTrip })).json().code).toBe("REIMBURSEMENT_TRIP_NOT_ELIGIBLE");
    const trip = await insertTrip("requester", "APPROVED");
    actAs("requester");
    const trips = await app.inject({ method: "GET", url: "/reimbursements/me/trips" });
    expect(trips.json().items.map((item: { id: string }) => item.id)).toEqual([trip]);

    const key = randomUUID();
    const first = await createDraft({ idempotencyKey: key, businessTripId: trip });
    expect(first.statusCode).toBe(201);
    const replay = await createDraft({ idempotencyKey: key, businessTripId: trip });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: first.json().id, idempotentReplay: true });

    // No receipt, no submission.
    actAs("requester");
    expect((await app.inject({ method: "POST", url: `/reimbursements/me/${first.json().id}/submit` })).json().code)
      .toBe("REIMBURSEMENT_RECEIPT_REQUIRED");

    // An expense older than 90 days is saved as a draft but refused at submission (D-04).
    const old = await draft({ items: items([{ category: "OTHER", expenseDate: daysBefore(today, 91), description: "Lama", amount: 5_000 }]) });
    expect((await upload(old)).statusCode).toBe(201);
    actAs("requester");
    expect((await app.inject({ method: "POST", url: `/reimbursements/me/${old}/submit` })).json().code).toBe("REIMBURSEMENT_EXPENSE_TOO_OLD");

    // D-07: at most five open drafts.
    await draft();
    await draft();
    await draft();
    expect((await createDraft()).json().code).toBe("REIMBURSEMENT_TOO_MANY_DRAFTS");

    // Discarding a draft erases its receipts for good.
    actAs("requester");
    const discard = await app.inject({ method: "POST", url: `/reimbursements/me/${old}/cancel`, payload: {} });
    expect(discard.statusCode, discard.body).toBe(200);
    const purged = await client.query("SELECT count(*)::int AS count FROM reimbursement_receipts WHERE claim_id = $1 AND ciphertext IS NOT NULL", [old]);
    expect(purged.rows[0].count).toBe(0);
    expect((await createDraft()).statusCode).toBe(201);
  });

  it("REIMB-001-F/K: Finance verifies an approved claim, never its own and never one it approved", async () => {
    const pending = await submitted();
    expect((await verify(pending.id)).json().code).toBe("REIMBURSEMENT_NOT_VERIFIABLE");

    const claim = await approved();
    // The requester holding reimbursements.manage still cannot verify their own claim.
    actAs("requester", FINANCE);
    const self = await app.inject({ method: "POST", url: `/admin/reimbursements/${claim.id}/verify`, payload: { items: [{ itemId: randomUUID(), approvedAmount: 1 }] } });
    expect(self.json().code).toBe("REIMBURSEMENT_SELF_ACTION_FORBIDDEN");
    // An approver of this claim holding reimbursements.manage cannot verify it either.
    actAs("manager", FINANCE);
    const approver = await app.inject({ method: "POST", url: `/admin/reimbursements/${claim.id}/verify`, payload: { items: [{ itemId: randomUUID(), approvedAmount: 1 }] } });
    expect(approver.json().code).toBe("REIMBURSEMENT_APPROVER_CANNOT_PROCESS");

    const current = await detail(claim.id);
    const [transport, meals] = current.items as Array<{ id: string; amount: number }>;
    expect((await verify(claim.id, [{ itemId: transport!.id, approvedAmount: 250_001 }, { itemId: meals!.id, approvedAmount: 75_000 }])).json().code)
      .toBe("REIMBURSEMENT_APPROVED_EXCEEDS_CLAIM");
    expect((await verify(claim.id, [{ itemId: transport!.id, approvedAmount: 250_000 }, { itemId: meals!.id, approvedAmount: 50_000 }])).json().code)
      .toBe("REIMBURSEMENT_REDUCTION_NOTE_REQUIRED");
    const ok = await verify(claim.id, [{ itemId: transport!.id, approvedAmount: 250_000 }, { itemId: meals!.id, approvedAmount: 50_000 }],
      "Konsumsi dibatasi untuk dua orang");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: "VERIFIED", verifiedTotal: 300_000, reducedItems: 1 });
    await checkMoneyInvariants();

    // After verification the employee can no longer withdraw it.
    actAs("requester");
    expect((await app.inject({ method: "POST", url: `/reimbursements/me/${claim.id}/cancel`, payload: { reason: "Tidak jadi diklaim" } })).json().code)
      .toBe("REIMBURSEMENT_NOT_CANCELLABLE");
    const own = await app.inject({ method: "GET", url: `/reimbursements/me/${claim.id}` });
    expect(own.json().items.map((item: { approvedAmount: number }) => item.approvedAmount)).toEqual([250_000, 50_000]);
  });

  it("REIMB-001-G/H: payment is the verified total, recorded once, and payroll stays off", async () => {
    const claim = await approved();
    expect((await pay(claim.id)).json().code).toBe("REIMBURSEMENT_NOT_PAYABLE");
    expect((await verify(claim.id)).statusCode).toBe(200);
    expect((await pay(claim.id, { method: "PAYROLL", payrollMonth: "2026-12" })).json().code).toBe("REIMBURSEMENT_PAYROLL_HANDOFF_DISABLED");
    expect((await pay(claim.id, { paidOn: "2000-01-01" })).json().code).toBe("REIMBURSEMENT_PAYMENT_DATE");

    const key = randomUUID();
    const paid = await pay(claim.id, { idempotencyKey: key, reference: "TRF-001" });
    expect(paid.statusCode, paid.body).toBe(201);
    expect(paid.json()).toMatchObject({ status: "PAID", amount: 325_000, idempotentReplay: false });
    const replay = await pay(claim.id, { idempotencyKey: key, reference: "TRF-001" });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ paymentId: paid.json().paymentId, idempotentReplay: true });
    expect((await pay(claim.id, { idempotencyKey: key, method: "CASH" })).json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await pay(claim.id, { idempotencyKey: key, reference: "TRF-002" })).json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await pay(claim.id)).json().code).toBe("REIMBURSEMENT_ALREADY_PAID");
    const payments = await client.query("SELECT amount::int AS amount FROM reimbursement_payments WHERE claim_id = $1", [claim.id]);
    expect(payments.rows).toEqual([{ amount: 325_000 }]);
    await checkMoneyInvariants();

    const state = await detail(claim.id);
    expect(state).toMatchObject({ status: "PAID", payment: { amount: 325_000, method: "TRANSFER", reference: "TRF-001" } });
    actAs("finance", FINANCE);
    expect((await app.inject({ method: "POST", url: `/admin/reimbursements/${claim.id}/reject`, payload: { reason: "Ternyata ganda" } })).json().code)
      .toBe("REIMBURSEMENT_NOT_REJECTABLE");
  });

  it("D-09: Finance rejects a verified claim with a reason", async () => {
    const claim = await approved();
    expect((await verify(claim.id)).statusCode).toBe(200);
    actAs("finance", FINANCE);
    expect((await app.inject({ method: "POST", url: `/admin/reimbursements/${claim.id}/reject`, payload: { reason: "pendek" } })).statusCode).toBe(400);
    const rejected = await app.inject({ method: "POST", url: `/admin/reimbursements/${claim.id}/reject`, payload: { reason: "Bukti yang sama sudah dibayar lewat kas unit" } });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await detail(claim.id)).toMatchObject({ status: "REJECTED", rejectedBy: "FINANCE", verifiedTotal: 325_000 });
    await checkMoneyInvariants();
  });

  it("REIMB-001-I/L: history and notifications carry no amount, and the database refuses inconsistent money", async () => {
    const claim = await approved();
    expect((await verify(claim.id)).statusCode).toBe(200);
    expect((await pay(claim.id)).statusCode).toBe(201);
    const events = await client.query<{ metadata: Record<string, unknown>; note: string | null }>(
      "SELECT metadata, note FROM reimbursement_events WHERE claim_id = $1", [claim.id],
    );
    for (const event of events.rows) {
      expect(JSON.stringify(event)).not.toMatch(/325000|325\.000|250000|250\.000|75000|75\.000/);
    }
    const notifications = await client.query<{ title: string; body: string }>(
      `SELECT title, body FROM in_app_notifications WHERE event_key LIKE 'reimbursement.%'`,
    );
    expect(notifications.rows.length).toBeGreaterThan(0);
    for (const notification of notifications.rows) {
      expect(`${notification.title} ${notification.body}`).not.toMatch(/Rp|\d{3}\.\d{3}|\d{5,}/);
    }

    await client.query("SAVEPOINT tamper");
    await client.query("UPDATE reimbursement_claims SET claimed_total = claimed_total + 1 WHERE id = $1", [claim.id]);
    await expect(checkMoneyInvariants()).rejects.toThrow(/claimed total does not match/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");

    await client.query("SAVEPOINT tamper");
    await expect(client.query("UPDATE reimbursement_items SET amount = amount + 1 WHERE claim_id = $1", [claim.id]))
      .rejects.toThrow(/fixed once the claim is submitted/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");

    await client.query("SAVEPOINT tamper");
    await expect(client.query("DELETE FROM reimbursement_payments WHERE claim_id = $1", [claim.id])).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");

    await client.query("SAVEPOINT tamper");
    await expect(client.query("UPDATE reimbursement_events SET note = 'x' WHERE claim_id = $1", [claim.id])).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");

    await client.query("SAVEPOINT tamper");
    await expect(client.query("INSERT INTO reimbursement_receipts (id, claim_id, content_type, byte_size, sha256, ciphertext, iv, auth_tag, uploaded_by_account_id) VALUES ($1,$2,'application/pdf',1,repeat('a',64),'x','x','x',$3)",
      [randomUUID(), claim.id, people.requester.accountId])).rejects.toThrow(/added to drafts only/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");

    await client.query("SAVEPOINT tamper");
    await client.query("UPDATE reimbursement_claims SET verified_total = verified_total - 1 WHERE id = $1", [claim.id]);
    await expect(checkMoneyInvariants()).rejects.toThrow(/verified total does not match/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");
  });

  it("REIMB-001-J: the register, summary and export need reimbursements.read, page with a true total and audit the export", async () => {
    const claim = await approved();
    await draft();
    actAs("finance", ["loans.read", "payroll.approve"]);
    expect((await app.inject({ method: "GET", url: "/admin/reimbursements" })).statusCode).toBe(403);
    actAs("finance", ["reimbursements.read"]);
    const page = await app.inject({ method: "GET", url: `/admin/reimbursements?employeeId=${people.requester.employeeId}&pageSize=1` });
    expect(page.statusCode, page.body).toBe(200);
    // The draft is not in the register.
    expect(page.json().pagination).toMatchObject({ page: 1, pageSize: 1, total: 1 });
    expect(page.json().items[0]).toMatchObject({ id: claim.id, status: "APPROVED", claimedTotal: 325_000, itemCount: 2 });
    expect((await app.inject({ method: "GET", url: "/admin/reimbursements?category=ACCOMMODATION" })).json().pagination.total).toBe(0);
    expect((await app.inject({ method: "GET", url: "/admin/reimbursements?status=DRAFT" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/reimbursements?pageSize=101" })).statusCode).toBe(400);

    const claimants = await app.inject({ method: "GET", url: "/admin/reimbursements/claimants?q=Pegawai" });
    expect(claimants.json().items.map((item: { id: string }) => item.id)).toEqual([people.requester.employeeId]);

    const summary = await app.inject({ method: "GET", url: `/admin/reimbursements/summary?from=${today}&to=${today}` });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().byStatus).toEqual([{ status: "APPROVED", claims: 1, claimedTotal: 325_000, verifiedTotal: 0 }]);
    expect(summary.json().byCategory.map((row: { category: string; claimedTotal: number }) => [row.category, row.claimedTotal]))
      .toEqual([["MEALS", 75_000], ["TRANSPORT", 250_000]]);

    const csv = await app.inject({ method: "GET", url: `/admin/reimbursements/export.csv?from=${today}&to=${today}` });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csv.body.replace(String.fromCharCode(0xfeff), "").trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(claim.id);
    const exported = await client.query("SELECT metadata FROM reimbursement_events WHERE event_type = 'reimbursement.register.exported' AND actor_account_id = $1", [people.finance.accountId]);
    expect(exported.rows[0].metadata).toMatchObject({ rows: 1, from: today, to: today });

    // A reader opens receipts (recorded) but cannot act.
    const current = await detail(claim.id);
    actAs("finance", ["reimbursements.read"]);
    expect(current.receipts[0]).toMatchObject({ duplicateClaims: 0 });
    expect((await app.inject({ method: "GET", url: `/admin/reimbursements/${claim.id}/receipts/${current.receipts[0].id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/admin/reimbursements/${claim.id}/reject`, payload: { reason: "tidak berwenang sama sekali" } })).statusCode).toBe(403);
  });

  it("D-16: the same receipt on two live claims is flagged for Finance", async () => {
    const first = await submitted();
    // Another employee's private draft carrying the same file is never counted.
    const otherDraft = (await createDraft({}, "other")).json().id as string;
    actAs("other");
    const otherUpload = await app.inject({
      method: "POST", url: `/reimbursements/me/${otherDraft}/receipts`, payload: { contentType: "application/pdf", contentBase64: PDF },
    });
    expect(otherUpload.statusCode).toBe(201);
    expect((await detail(first.id)).receipts[0].duplicateClaims).toBe(0);
    const second = await submitted();
    const state = await detail(second.id);
    expect(state.receipts[0].duplicateClaims).toBe(1);
    expect((await detail(first.id)).receipts[0].duplicateClaims).toBe(1);
    // The employee and approver views do not carry the signal.
    actAs("requester");
    expect((await app.inject({ method: "GET", url: `/reimbursements/me/${second.id}` })).json().receipts[0]).not.toHaveProperty("duplicateClaims");
  });
});
