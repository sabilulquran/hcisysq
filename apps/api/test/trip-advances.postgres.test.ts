// TRIP-002 acceptance against a real schema: advances, per diem rates by golongan and wilayah
// (SK 01.111/YSQ/VII/2026), settlement against REIMB-001 claims, and the no-double-payment rule.
// Synthetic employees only; every test runs inside one rolled-back transaction.
//
// Migration 0172 seeds the decree's six rates, so the rate table is NOT empty here: Staf earns
// Rp140.000 Luar Daerah and Rp60.000 Dalam Daerah. LUAR_NEGERI has no rate by design, which is
// what the "no rate" cases use.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerReimbursementRoutes } from "../src/modules/reimbursements/routes.js";
import { findReminderRule } from "../src/modules/reminders/rules.js";
import { registerTripAdvanceRoutes } from "../src/modules/trip-advances/routes.js";

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

type Who = "requester" | "manager" | "unitApprover" | "finance" | "hc" | "other";

describe.skipIf(!allowed)("TRIP-002 trip advances and per diem", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  const people = {} as Record<Who, { employeeId: string; accountId: string }>;
  const today = jakartaToday();
  const FINANCE = ["trip_advances.read", "trip_advances.manage", "trip_per_diem.manage", "reimbursements.read", "reimbursements.manage"];
  const HC = ["trip_advances.read", "trip_per_diem.manage"];
  /** Lampiran 1 SK 01.111/YSQ/VII/2026, the rows migration 0172 seeds. */
  const STAF_LUAR_DAERAH = 140_000;
  let classification: string;

  async function insertEmployee(name: string, unitId: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on, organizational_unit_id)
       VALUES ($1,$2,$3,'active','2020-01-06',$4)`,
      [id, `ADV-${id.slice(0, 8)}`, name, unitId],
    );
    return id;
  }

  /**
   * ORG-011 plumbing: one employment with a placement that names a job classification. That code,
   * not the job title text, is what the golongan is read from (D-20).
   */
  async function giveClassification(employeeId: string, code: string, unitId: string) {
    const employmentId = randomUUID();
    const actionId = randomUUID();
    await client.query(
      `INSERT INTO employments(id, employee_id, staff_type, started_on, start_basis, service_start_on, source, opened_by_action_id)
       VALUES ($1, $2, 'KEPENDIDIKAN', '2020-01-06'::date, 'RECORDED', '2020-01-06'::date, 'BASELINE_FROM_MASTER', $3)`,
      [employmentId, employeeId, actionId],
    );
    await client.query(
      `INSERT INTO employment_actions(id, employee_id, employment_id, action_type, recorded_at)
       VALUES ($1, $2, $3, 'BASELINE', now())`,
      [actionId, employeeId, employmentId],
    );
    await client.query(
      `INSERT INTO employment_placements
         (id, employment_id, kind, legacy_unit_id, job_title_label, effective_from, effective_from_basis,
          opened_by_action_id, job_classification_code)
       VALUES ($1,$2,'PRIMARY',$3,'Jabatan sintetis','2020-01-06'::date,'RECORDED',$4,$5)`,
      [randomUUID(), employmentId, unitId, actionId, code],
    );
  }

  async function addClassificationCode(code: string, name = `Klasifikasi ${code}`) {
    await client.query(
      `INSERT INTO job_classifications (id, code, name, family, effective_from)
       VALUES ($1,$2,$3,'SUPPORT','2020-01-01'::date)`,
      [randomUUID(), code, name],
    );
  }

  async function mapGolongan(code: string, golongan: string, granted = HC) {
    actAs("hc", granted);
    return app.inject({
      method: "PUT", url: "/admin/trip-per-diem-golongan",
      payload: { jobClassificationCode: code, golongan },
    });
  }

  async function insertAccount(employeeId: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [id, employeeId, `adv-${id}@example.invalid`],
    );
    return id;
  }

  function actAs(who: Who, granted: string[] = []) {
    principal = { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" };
    permissions = granted;
  }

  /** A trip with the APR-001 chain TRIP-001 would have snapshotted: manager, then unit approver. */
  async function insertTrip(status = "APPROVED", startOn = daysBefore(today, 3), endOn = daysBefore(today, 1), who: Who = "requester") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO business_trip_requests (id, employee_id, destination, purpose, start_on, end_on, status, idempotency_key)
       VALUES ($1, $2, 'Surabaya', 'Pelatihan guru di sekolah mitra', $3::date, $4::date, $5, $6)`,
      [id, people[who].employeeId, startOn, endOn, status, randomUUID()],
    );
    for (const [index, approver] of (["manager", "unitApprover"] as const).entries()) {
      await client.query(
        `INSERT INTO business_trip_approval_steps (id, request_id, step_order, approver_employee_id, sources, status, acted_at)
         VALUES ($1, $2, $3, $4, $5::text[], 'approved', now())`,
        [randomUUID(), id, index + 1, people[approver].employeeId, [index === 0 ? "DIRECT_MANAGER" : "UNIT_APPROVER"]],
      );
    }
    return id;
  }

  async function request(tripId: string, amount: number, extra: Record<string, unknown> = {}) {
    actAs("requester");
    return app.inject({
      method: "POST", url: "/trip-advances/me",
      payload: {
        businessTripId: tripId, wilayah: "LUAR_DAERAH", amount,
        purpose: "Tiket pesawat dan hotel tiga malam", idempotencyKey: randomUUID(), ...extra,
      },
    });
  }

  async function decide(stepId: string, who: Who, decision: "approve" | "reject", note?: string) {
    actAs(who);
    return app.inject({ method: "POST", url: `/trip-advances/approvals/${stepId}/decision`, payload: { decision, note } });
  }

  async function approvedAdvance(tripId: string, amount: number, extra: Record<string, unknown> = {}) {
    const created = await request(tripId, amount, extra);
    expect(created.statusCode, created.body).toBe(201);
    const steps = created.json().approvalChain as Array<{ id: string }>;
    expect((await decide(steps[0]!.id, "manager", "approve")).statusCode).toBe(200);
    const last = await decide(steps[1]!.id, "unitApprover", "approve");
    expect(last.json().advanceStatus).toBe("APPROVED");
    return created.json().id as string;
  }

  async function finance(method: "GET" | "POST", url: string, payload?: Record<string, unknown>, granted = FINANCE) {
    actAs("finance", granted);
    return app.inject({ method, url, payload });
  }

  const transaction = (extra: Record<string, unknown> = {}) => ({ paidOn: today, method: "TRANSFER", idempotencyKey: randomUUID(), ...extra });

  async function addRate(golongan: string, wilayah: string, effectiveFrom: string, dailyAmount: number) {
    actAs("hc", HC);
    const response = await app.inject({
      method: "POST", url: "/admin/trip-per-diem-rates", payload: { golongan, wilayah, effectiveFrom, dailyAmount },
    });
    expect(response.statusCode, response.body).toBe(201);
  }

  /** A REIMB-001 claim linked to the trip, taken through approval and (optionally) verification. */
  async function claim(tripId: string, verify = true) {
    actAs("requester");
    const draft = await app.inject({
      method: "POST", url: "/reimbursements/me",
      payload: {
        title: "Biaya perjalanan ke Surabaya", businessTripId: tripId, idempotencyKey: randomUUID(),
        items: [{ category: "TRANSPORT", expenseDate: today, description: "Taksi bandara", amount: 325_000 }],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const id = draft.json().id as string;
    expect((await app.inject({ method: "POST", url: `/reimbursements/me/${id}/receipts`, payload: { contentType: "application/pdf", contentBase64: PDF } })).statusCode).toBe(201);
    return {
      id,
      async submit() {
        actAs("requester");
        const submitted = await app.inject({ method: "POST", url: `/reimbursements/me/${id}/submit` });
        expect(submitted.statusCode, submitted.body).toBe(200);
        for (const [index, step] of (submitted.json().approvalChain as Array<{ id: string }>).entries()) {
          actAs(index === 0 ? "manager" : "unitApprover");
          expect((await app.inject({ method: "POST", url: `/reimbursements/approvals/${step.id}/decision`, payload: { decision: "approve" } })).statusCode).toBe(200);
        }
        if (!verify) return;
        const detail = await finance("GET", `/admin/reimbursements/${id}`);
        const items = detail.json().items.map((item: { id: string; amount: number }) => ({ itemId: item.id, approvedAmount: item.amount }));
        const verified = await finance("POST", `/admin/reimbursements/${id}/verify`, { items });
        expect(verified.statusCode, verified.body).toBe(200);
      },
    };
  }

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
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1,$2,'Unit Uang Muka Sintetis')",
      [unitId, `unit-adv-${unitId}`],
    );
    for (const key of ["manager", "unitApprover", "requester", "finance", "hc", "other"] as const) {
      const employeeId = await insertEmployee(`Pegawai ${key}`, unitId);
      people[key] = { employeeId, accountId: await insertAccount(employeeId) };
    }
    await client.query("UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1", [unitId, people.unitApprover.employeeId]);
    // D-20: every synthetic employee is a Staf, stated through an ORG-011 classification.
    classification = `STAF_${randomUUID().slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
    await addClassificationCode(classification, "Staf sintetis");
    await client.query(
      `INSERT INTO trip_per_diem_golongan_map (job_classification_code, golongan, updated_by_account_id)
       VALUES ($1, 'STAF', $2)`,
      [classification, people.hc.accountId],
    );
    for (const key of ["requester", "other"] as const) await giveClassification(people[key].employeeId, classification, unitId);
    // D-22: uang saku ships locked, so this file's world has to switch it on before anything
    // here can reach the per diem path at all. What holds that switch, and what the lock shuts,
    // belongs to `trip-per-diem-activation.postgres.test.ts`.
    await client.query(
      `INSERT INTO trip_per_diem_activation (id, state, reason, changed_by_account_id)
       VALUES ($1, 'ACTIVE', 'Fixture TRIP-002: uang saku dinyalakan untuk uji', $2)`,
      [randomUUID(), people.hc.accountId],
    );
    for (const key of ["requester", "finance", "hc", "other"] as const) {
      await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people[key].employeeId, people.manager.employeeId]);
    }
    actAs("requester");
    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    const routed = savepointPool(client);
    await registerReimbursementRoutes(app, routed, config, auth);
    await registerTripAdvanceRoutes(app, routed, config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("TRIP-002-A/B/C: an advance on the employee's own trip copies the trip's chain and keeps to its limit", async () => {
    const tripId = await insertTrip();
    const estimate = await app.inject({ method: "GET", url: `/trip-advances/me/estimate?tripId=${tripId}&wilayah=LUAR_DAERAH` });
    expect(estimate.statusCode, estimate.body).toBe(200);
    // D-02/D-20: Staf, Luar Daerah, from the decree seeded by migration 0172.
    expect(estimate.json()).toMatchObject({
      days: 3, golongan: "STAF", dailyRate: STAF_LUAR_DAERAH, perDiemEstimate: 3 * STAF_LUAR_DAERAH,
      maxAmount: 10_000_000 + 3 * STAF_LUAR_DAERAH, rateEffectiveFrom: "2026-07-10",
    });
    expect(estimate.json().approvalChain.map((step: { employeeId: string }) => step.employeeId))
      .toEqual([people.manager.employeeId, people.unitApprover.employeeId]);

    expect((await request(tripId, 10_000_001 + 3 * STAF_LUAR_DAERAH)).json().code).toBe("TRIP_ADVANCE_AMOUNT_ABOVE_LIMIT");
    expect((await request(tripId, 150_000.5)).statusCode).toBe(400);
    expect((await request(tripId, "150000" as unknown as number)).statusCode).toBe(400);
    const key = randomUUID();
    const created = await request(tripId, 2_000_000, { idempotencyKey: key });
    expect(created.statusCode, created.body).toBe(201);
    expect((await request(tripId, 2_000_000, { idempotencyKey: key })).json()).toMatchObject({ id: created.json().id, idempotentReplay: true });
    expect((await request(tripId, 1_000_000, { idempotencyKey: key })).json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await request(tripId, 500_000)).json().code).toBe("TRIP_ADVANCE_EXISTS");

    const othersTrip = await insertTrip("APPROVED", today, today, "other");
    expect((await request(othersTrip, 100_000)).json().code).toBe("TRIP_ADVANCE_TRIP_NOT_ELIGIBLE");
    const completed = await insertTrip("REJECTED");
    expect((await request(completed, 100_000)).json().code).toBe("TRIP_ADVANCE_TRIP_NOT_ELIGIBLE");

    actAs("requester");
    const own = await app.inject({ method: "GET", url: `/trip-advances/me/${created.json().id}` });
    expect(own.json()).toMatchObject({ status: "IN_REVIEW", amount: 2_000_000, wilayah: "LUAR_DAERAH", tripDestination: "Surabaya" });
    expect(own.json().steps.map((step: { status: string }) => step.status)).toEqual(["pending", "waiting"]);
    actAs("other");
    expect((await app.inject({ method: "GET", url: `/trip-advances/me/${created.json().id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/trip-advances/me/${created.json().id}/cancel`, payload: { reason: "bukan milik saya" } })).statusCode).toBe(404);

    // History never carries an amount.
    const events = await client.query(`SELECT metadata::text FROM trip_advance_events WHERE advance_id = $1`, [created.json().id]);
    expect(events.rows.map((row) => row.metadata).join(" ")).not.toMatch(/2000000/);
    const notes = await client.query(`SELECT title, body FROM in_app_notifications WHERE recipient_account_id = $1`, [people.manager.accountId]);
    expect(JSON.stringify(notes.rows)).not.toMatch(/2\.000\.000|2000000/);
  });

  it("TRIP-002-B: an approver without an active account fails the request and stores nothing", async () => {
    const tripId = await insertTrip();
    await client.query("UPDATE accounts SET status = 'suspended' WHERE id = $1", [people.unitApprover.accountId]);
    const response = await request(tripId, 500_000);
    expect(response.json().code).toBe("APPROVER_ACCOUNT_NOT_READY");
    expect((await client.query("SELECT 1 FROM trip_advances WHERE business_trip_id = $1", [tripId])).rowCount).toBe(0);
  });

  it("TRIP-002-D..H: disburse, settle against verified claims, then collect the refund in parts", async () => {
    const tripId = await insertTrip("APPROVED", daysBefore(today, 3), daysBefore(today, 1));
    // D-02: only the first rate of a golongan x wilayah pair may start in the past, and the
    // decree's own row already occupies that slot for Staf / Luar Daerah.
    actAs("hc", HC);
    expect((await app.inject({
      method: "POST", url: "/admin/trip-per-diem-rates",
      payload: { golongan: "STAF", wilayah: "LUAR_DAERAH", effectiveFrom: daysBefore(today, 2), dailyAmount: 1 },
    })).json().code).toBe("TRIP_PER_DIEM_RATE_BACKDATED");
    const id = await approvedAdvance(tripId, 2_000_000);

    // D-16: the requester and the advance's approvers do not pay it out.
    actAs("requester", FINANCE);
    expect((await app.inject({ method: "POST", url: `/admin/trip-advances/${id}/disburse`, payload: transaction() })).json().code)
      .toBe("TRIP_ADVANCE_SELF_ACTION_FORBIDDEN");
    actAs("manager", FINANCE);
    expect((await app.inject({ method: "POST", url: `/admin/trip-advances/${id}/disburse`, payload: transaction() })).json().code)
      .toBe("TRIP_ADVANCE_APPROVER_CANNOT_PROCESS");
    expect((await finance("POST", `/admin/trip-advances/${id}/disburse`, transaction(), ["trip_advances.read"])).statusCode).toBe(403);

    const disbursement = transaction();
    const paid = await finance("POST", `/admin/trip-advances/${id}/disburse`, disbursement);
    expect(paid.statusCode, paid.body).toBe(201);
    expect(paid.json()).toMatchObject({ status: "DISBURSED", amount: 2_000_000 });
    expect((await finance("POST", `/admin/trip-advances/${id}/disburse`, disbursement)).json()).toMatchObject({ idempotentReplay: true });
    expect((await finance("POST", `/admin/trip-advances/${id}/disburse`, { ...disbursement, reference: "lain" })).json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await finance("POST", `/admin/trip-advances/${id}/disburse`, transaction())).json().code).toBe("TRIP_ADVANCE_ALREADY_DISBURSED");
    actAs("requester");
    expect((await app.inject({ method: "POST", url: `/trip-advances/me/${id}/cancel`, payload: { reason: "tidak jadi berangkat" } })).json().code)
      .toBe("TRIP_ADVANCE_NOT_CANCELLABLE");

    // D-08: a draft claim on the trip holds the settlement request back.
    const expense = await claim(tripId);
    actAs("requester");
    expect((await app.inject({ method: "POST", url: `/trip-advances/me/${id}/settlement`, payload: {} })).json().code).toBe("TRIP_ADVANCE_CLAIMS_OPEN");
    await expense.submit();
    // D-13: the verified claim is not paid on its own while the advance is open.
    const direct = await finance("POST", `/admin/reimbursements/${expense.id}/pay`, transaction());
    expect(direct.json().code).toBe("REIMBURSEMENT_SETTLED_THROUGH_ADVANCE");

    actAs("requester");
    const submitted = await app.inject({ method: "POST", url: `/trip-advances/me/${id}/settlement`, payload: { note: "Semua bukti sudah diklaim." } });
    expect(submitted.statusCode, submitted.body).toBe(200);

    const preview = await finance("GET", `/admin/trip-advances/${id}`);
    expect(preview.json().settlementPreview).toMatchObject({
      maxPerDiemDays: 3, golongan: "STAF", dailyRate: STAF_LUAR_DAERAH, verifiedClaims: 1, pendingClaims: 0,
    });
    expect((await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 4, idempotencyKey: randomUUID() })).json().code)
      .toBe("TRIP_ADVANCE_PER_DIEM_DAYS");
    const settleKey = randomUUID();
    const settled = await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 3, idempotencyKey: settleKey });
    expect(settled.statusCode, settled.body).toBe(200);
    // 3 x 140.000 + 325.000 - 2.000.000 = -1.255.000: the employee owes the rest.
    expect(settled.json()).toMatchObject({ status: "AWAITING_REFUND", perDiemAmount: 420_000, claimsTotal: 325_000, settlementBalance: -1_255_000 });
    expect((await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 3, idempotencyKey: settleKey })).json())
      .toMatchObject({ idempotentReplay: true, settlementBalance: -1_255_000 });
    // TRIP-002-M: a newer rate version does not move a settlement that is already recorded.
    await addRate("STAF", "LUAR_DAERAH", today, 500_000);
    const reread = await finance("GET", `/admin/trip-advances/${id}`);
    expect(reread.json()).toMatchObject({ perDiemRate: STAF_LUAR_DAERAH, perDiemAmount: 420_000, settlementBalance: -1_255_000 });
    expect((await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 2, note: "Pulang sehari lebih awal", idempotencyKey: settleKey })).json().code)
      .toBe("IDEMPOTENCY_KEY_REUSED");

    const settledClaim = await finance("GET", `/admin/reimbursements/${expense.id}`);
    expect(settledClaim.json()).toMatchObject({ status: "PAID", payment: expect.objectContaining({ method: "ADVANCE", amount: 325_000 }) });

    expect((await finance("POST", `/admin/trip-advances/${id}/top-up`, transaction())).json().code).toBe("TRIP_ADVANCE_NO_TOP_UP_DUE");
    expect((await finance("POST", `/admin/trip-advances/${id}/refunds`, transaction({ amount: 1_255_001 }))).json().code).toBe("TRIP_ADVANCE_REFUND_EXCEEDS_DUE");
    const firstRefund = transaction({ amount: 1_000_000 });
    expect((await finance("POST", `/admin/trip-advances/${id}/refunds`, firstRefund)).json()).toMatchObject({ status: "AWAITING_REFUND", refundOutstanding: 255_000 });
    expect((await finance("POST", `/admin/trip-advances/${id}/refunds`, firstRefund)).json()).toMatchObject({ idempotentReplay: true });
    const last = await finance("POST", `/admin/trip-advances/${id}/refunds`, transaction({ amount: 255_000 }));
    expect(last.json()).toMatchObject({ status: "SETTLED", refundOutstanding: 0 });

    const closed = await finance("GET", `/admin/trip-advances/${id}`);
    expect(closed.json()).toMatchObject({ status: "SETTLED", refundedTotal: 1_255_000, refundOutstanding: 0 });
    expect(closed.json().settledClaims).toEqual([expect.objectContaining({ claimId: expense.id, verifiedTotal: 325_000 })]);
    expect(closed.json().events.map((event: { eventType: string }) => event.eventType)).toEqual(expect.arrayContaining([
      "trip_advance.disbursed", "trip_advance.settlement.submitted", "trip_advance.settled", "trip_advance.refund.recorded", "trip_advance.closed",
    ]));
    await checkMoneyInvariants();
  });

  it("TRIP-002-F/G: per diem only — no rate means no settlement; a positive balance is paid once", async () => {
    const tripId = await insertTrip("APPROVED", daysBefore(today, 3), daysBefore(today, 1));
    // D-01b: the decree sets no rate abroad, so LUAR_NEGERI is the "no rate" case.
    const id = await approvedAdvance(tripId, 0, { wilayah: "LUAR_NEGERI" });
    expect((await finance("POST", `/admin/trip-advances/${id}/disburse`, transaction())).json().code).toBe("TRIP_ADVANCE_NOT_DISBURSABLE");
    actAs("requester");
    expect((await app.inject({ method: "POST", url: `/trip-advances/me/${id}/settlement`, payload: {} })).statusCode).toBe(200);

    expect((await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 3, idempotencyKey: randomUUID() })).json().code)
      .toBe("TRIP_PER_DIEM_RATE_MISSING");
    expect((await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 2, idempotencyKey: randomUUID() })).json().code)
      .toBe("TRIP_ADVANCE_REDUCTION_NOTE_REQUIRED");
    await addRate("STAF", "LUAR_NEGERI", daysBefore(today, 10), 200_000);
    // A rate dated after departure does not apply to this trip.
    await addRate("STAF", "LUAR_NEGERI", today, 999_000);
    const settled = await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 3, idempotencyKey: randomUUID() });
    expect(settled.json()).toMatchObject({ status: "AWAITING_TOP_UP", settlementBalance: 600_000 });

    const topUp = transaction();
    expect((await finance("POST", `/admin/trip-advances/${id}/top-up`, topUp)).json()).toMatchObject({ status: "SETTLED", amount: 600_000 });
    expect((await finance("POST", `/admin/trip-advances/${id}/top-up`, topUp)).json()).toMatchObject({ idempotentReplay: true });
    expect((await finance("POST", `/admin/trip-advances/${id}/top-up`, transaction())).json().code).toBe("TRIP_ADVANCE_NO_TOP_UP_DUE");
    await checkMoneyInvariants();
  });

  it("TRIP-002-E/D-14: settlement waits for the return date; a cancelled trip earns no per diem and still takes claims", async () => {
    const future = await insertTrip("APPROVED", today, daysBefore(today, -2));
    const id = await approvedAdvance(future, 1_000_000);
    expect((await finance("POST", `/admin/trip-advances/${id}/disburse`, transaction())).statusCode).toBe(201);
    actAs("requester");
    expect((await app.inject({ method: "POST", url: `/trip-advances/me/${id}/settlement`, payload: {} })).json().code).toBe("TRIP_ADVANCE_TRIP_NOT_ENDED");

    await client.query("UPDATE business_trip_requests SET status = 'CANCELLED', cancel_reason = 'Acara ditunda penyelenggara', updated_at = now() WHERE id = $1", [future]);
    // REIMB-001 D-19: the cancelled trip with a disbursed advance can still be linked.
    const expense = await claim(future);
    await expense.submit();
    actAs("requester");
    expect((await app.inject({ method: "POST", url: `/trip-advances/me/${id}/settlement`, payload: {} })).statusCode).toBe(200);
    expect((await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 1, idempotencyKey: randomUUID() })).json().code)
      .toBe("TRIP_ADVANCE_PER_DIEM_DAYS");
    const settled = await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 0, idempotencyKey: randomUUID() });
    expect(settled.json()).toMatchObject({ status: "AWAITING_REFUND", perDiemAmount: 0, claimsTotal: 325_000, settlementBalance: -675_000 });
  });

  it("TRIP-002-D/09: an overdue advance is flagged in the register and reminded without amounts", async () => {
    const tripId = await insertTrip("APPROVED", daysBefore(today, 25), daysBefore(today, 20));
    const id = await approvedAdvance(tripId, 750_000);
    expect((await finance("POST", `/admin/trip-advances/${id}/disburse`, transaction())).statusCode).toBe(201);

    const overdue = await finance("GET", `/admin/trip-advances?overdue=true&employeeId=${people.requester.employeeId}`);
    expect(overdue.json().items).toEqual([expect.objectContaining({ id, overdue: true, dueOn: daysBefore(today, 6) })]);
    expect((await finance("GET", `/admin/trip-advances?overdue=false&employeeId=${people.requester.employeeId}`)).json().items).toEqual([]);

    const candidates = await findReminderRule("trip_advance.settlement_overdue")!.generate(client, { today });
    const mine = candidates.filter((candidate) => candidate.accountId === people.requester.accountId);
    expect(mine).toEqual([expect.objectContaining({ occurrenceKey: `${id}:w0`, href: `/app/trip-advances?uangmuka=${id}` })]);
    expect(mine.map((row) => `${row.title} ${row.body} ${row.whatsappText}`).join(" ")).not.toMatch(/750|Rp/);
  });

  it("TRIP-002-D/09: a cancelled trip is due 14 days after its cancellation event, not its last update", async () => {
    const tripId = await insertTrip("APPROVED", today, daysBefore(today, -20));
    const id = await approvedAdvance(tripId, 500_000);
    expect((await finance("POST", `/admin/trip-advances/${id}/disburse`, transaction())).statusCode).toBe(201);
    // Cancelled 20 days ago per TRIP-001's event; the row was touched again today.
    await client.query(
      "UPDATE business_trip_requests SET status = 'CANCELLED', cancel_reason = 'Acara dibatalkan penyelenggara', updated_at = now() WHERE id = $1",
      [tripId],
    );
    await client.query(
      `INSERT INTO business_trip_events (id, request_id, event_type, actor_account_id, note, occurred_at)
       VALUES ($1, $2, 'trip.request.cancelled', $3, 'Acara dibatalkan penyelenggara', ($4::date + time '10:00') AT TIME ZONE 'Asia/Jakarta')`,
      [randomUUID(), tripId, people.requester.accountId, daysBefore(today, 20)],
    );
    const register = await finance("GET", `/admin/trip-advances?employeeId=${people.requester.employeeId}`);
    expect(register.json().items).toEqual([expect.objectContaining({ id, dueOn: daysBefore(today, 6), overdue: true })]);
  });

  it("TRIP-002-I: permissions guard the register, the actions and the rate table", async () => {
    const tripId = await insertTrip();
    const id = await approvedAdvance(tripId, 500_000);
    expect((await finance("GET", "/admin/trip-advances", undefined, [])).statusCode).toBe(403);
    expect((await finance("GET", `/admin/trip-advances/${id}`, undefined, ["reimbursements.read", "trips.read"])).statusCode).toBe(403);
    expect((await finance("POST", `/admin/trip-advances/${id}/reject`, { reason: "Anggaran unit sudah habis" }, ["trip_advances.read"])).statusCode).toBe(403);
    expect((await finance("GET", "/admin/trip-per-diem-rates", undefined, ["trip_per_diem.manage"])).statusCode).toBe(200);
    const rateBody = { golongan: "STAF", wilayah: "DALAM_DAERAH", effectiveFrom: today, dailyAmount: 50_000 };
    expect((await finance("POST", "/admin/trip-per-diem-rates", rateBody, ["trip_advances.read"])).statusCode).toBe(403);
    expect((await finance("POST", "/admin/trip-per-diem-rates", { ...rateBody, dailyAmount: 50_000.5 }, HC)).statusCode).toBe(400);
    // D-20: the golongan map is Finance/HC only as well.
    expect((await finance("GET", "/admin/trip-per-diem-golongan", undefined, [])).statusCode).toBe(403);
    expect((await mapGolongan(classification, "KEPALA_UNIT", ["trip_advances.read"])).statusCode).toBe(403);

    const rejected = await finance("POST", `/admin/trip-advances/${id}/reject`, { reason: "Anggaran unit sudah habis" });
    expect(rejected.json()).toMatchObject({ status: "REJECTED" });
    // A rejected advance frees the trip for a new request.
    expect((await request(tripId, 300_000)).statusCode).toBe(201);

    const exported = await finance("GET", `/admin/trip-advances/export.csv?from=${daysBefore(today, 1)}&to=${today}`);
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain("ID uang muka");
    const audit = await client.query(`SELECT 1 FROM trip_advance_events WHERE event_type = 'trip_advance.register.exported' AND actor_account_id = $1`, [people.finance.accountId]);
    expect(audit.rowCount).toBe(1);
    expect((await finance("GET", `/admin/trip-advances/export.csv?from=2025-01-01&to=${today}`)).statusCode).toBe(400);
  });

  it("TRIP-002-L: the rate follows golongan x wilayah x date, and an unmapped classification refuses", async () => {
    const tripId = await insertTrip("APPROVED", daysBefore(today, 3), daysBefore(today, 1));
    const url = (wilayah: string) => `/trip-advances/me/estimate?tripId=${tripId}&wilayah=${wilayah}`;

    // Lampiran 1: Staf earns Rp60.000 in Dalam Daerah and Rp140.000 outside it.
    actAs("requester");
    expect((await app.inject({ method: "GET", url: url("DALAM_DAERAH") })).json())
      .toMatchObject({ golongan: "STAF", dailyRate: 60_000, perDiemEstimate: 180_000 });
    expect((await app.inject({ method: "GET", url: url("LUAR_DAERAH") })).json())
      .toMatchObject({ golongan: "STAF", dailyRate: 140_000, perDiemEstimate: 420_000 });
    // D-01b: the decree says nothing about going abroad, so there is no rate, not Rp0.
    expect((await app.inject({ method: "GET", url: url("LUAR_NEGERI") })).json())
      .toMatchObject({ golongan: "STAF", dailyRate: null, perDiemEstimate: 0 });

    // The same person as Kepala Unit Kerja: Rp160.000 outside the region.
    expect((await mapGolongan(classification, "KEPALA_UNIT")).statusCode).toBe(200);
    actAs("requester");
    expect((await app.inject({ method: "GET", url: url("LUAR_DAERAH") })).json())
      .toMatchObject({ golongan: "KEPALA_UNIT", dailyRate: 160_000, perDiemEstimate: 480_000 });

    // D-20: unmapped is a configuration error, never the cheapest tier.
    actAs("hc", HC);
    expect((await app.inject({ method: "DELETE", url: `/admin/trip-per-diem-golongan/${classification}` })).statusCode).toBe(200);
    actAs("requester");
    const unmapped = await app.inject({ method: "GET", url: url("LUAR_DAERAH") });
    expect(unmapped.statusCode).toBe(409);
    expect(unmapped.json().code).toBe("TRIP_PER_DIEM_GOLONGAN_UNMAPPED");
    expect(unmapped.json().message).toContain(classification);
    expect((await request(tripId, 100_000)).json().code).toBe("TRIP_PER_DIEM_GOLONGAN_UNMAPPED");
    expect((await client.query("SELECT 1 FROM trip_advances WHERE business_trip_id = $1", [tripId])).rowCount).toBe(0);

    // An employee with no classification at all is refused just as plainly.
    await client.query("UPDATE employment_placements SET job_classification_code = NULL WHERE job_classification_code = $1", [classification]);
    expect((await mapGolongan(classification, "STAF")).statusCode).toBe(200);
    actAs("requester");
    expect((await app.inject({ method: "GET", url: url("LUAR_DAERAH") })).json().code).toBe("TRIP_PER_DIEM_GOLONGAN_UNMAPPED");

    // An audit row per mapping change, without any amount (D-17).
    const audit = await client.query(
      `SELECT event_type, metadata::text AS metadata FROM trip_advance_events
        WHERE event_type IN ('trip_advance.golongan.mapped', 'trip_advance.golongan.unmapped') ORDER BY occurred_at`,
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      "trip_advance.golongan.mapped", "trip_advance.golongan.unmapped", "trip_advance.golongan.mapped",
    ]);
    expect(audit.rows.map((row) => row.metadata).join(" ")).not.toMatch(/140000|60000/);
  });

  it("TRIP-002-M: uang saku already paid by the organiser is not paid twice (D-21)", async () => {
    const tripId = await insertTrip("APPROVED", daysBefore(today, 3), daysBefore(today, 1));
    const id = await approvedAdvance(tripId, 1_000_000);
    expect((await finance("POST", `/admin/trip-advances/${id}/disburse`, transaction())).statusCode).toBe(201);

    actAs("requester");
    const submitted = await app.inject({
      method: "POST", url: `/trip-advances/me/${id}/settlement`,
      payload: { note: "Uang saku sudah diberikan panitia di lokasi.", organizerPerDiemReceived: true },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().organizerPerDiemReceived).toBe(true);

    const detail = await finance("GET", `/admin/trip-advances/${id}`);
    expect(detail.json()).toMatchObject({ organizerPerDiemDeclared: true, organizerPerDiemApplied: false, organizerPerDiemSource: null });

    // Diktum Keempat: no per diem days may be counted at all.
    expect((await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 3, idempotencyKey: randomUUID() })).json().code)
      .toBe("TRIP_PER_DIEM_NOT_PAYABLE_TWICE");
    // Correcting the employee's declaration is allowed, but never silently.
    expect((await finance("POST", `/admin/trip-advances/${id}/settle`, {
      perDiemDays: 3, organizerPerDiemPaid: false, idempotencyKey: randomUUID(),
    })).statusCode).toBe(400);
    // Withholding it is recorded in words.
    expect((await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 0, idempotencyKey: randomUUID() })).statusCode).toBe(400);
    const settled = await finance("POST", `/admin/trip-advances/${id}/settle`, {
      perDiemDays: 0, waiveReason: "Uang saku sudah diterima dari penyelenggara kegiatan.", idempotencyKey: randomUUID(),
    });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json()).toMatchObject({ status: "AWAITING_REFUND", perDiemAmount: 0, settlementBalance: -1_000_000 });

    const after = await finance("GET", `/admin/trip-advances/${id}`);
    expect(after.json()).toMatchObject({
      perDiemAmount: 0, perDiemGolonganLabel: null,
      organizerPerDiemDeclared: true, organizerPerDiemApplied: true, organizerPerDiemSource: "EMPLOYEE",
      organizerPerDiemOverrideReason: null,
      perDiemWaiveReason: "Uang saku sudah diterima dari penyelenggara kegiatan.",
    });
    await checkMoneyInvariants();
  });

  it("TRIP-002-M: Finance may correct a mistaken declaration, with the reason and the source recorded", async () => {
    const tripId = await insertTrip("APPROVED", daysBefore(today, 3), daysBefore(today, 1));
    const id = await approvedAdvance(tripId, 0);
    actAs("requester");
    // The employee ticked the box by mistake; without a way back the uang saku would be gone.
    expect((await app.inject({
      method: "POST", url: `/trip-advances/me/${id}/settlement`, payload: { organizerPerDiemReceived: true },
    })).statusCode).toBe(200);

    const corrected = await finance("POST", `/admin/trip-advances/${id}/settle`, {
      perDiemDays: 3, organizerPerDiemPaid: false,
      organizerOverrideReason: "Pegawai keliru mencentang; panitia tidak memberi uang saku.",
      idempotencyKey: randomUUID(),
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(corrected.json()).toMatchObject({ status: "AWAITING_TOP_UP", perDiemAmount: 3 * STAF_LUAR_DAERAH });

    const after = await finance("GET", `/admin/trip-advances/${id}`);
    expect(after.json()).toMatchObject({
      // The employee's own statement is kept as it was: it is an audit fact, not a display detail.
      organizerPerDiemDeclared: true,
      organizerPerDiemApplied: false,
      organizerPerDiemSource: "FINANCE",
      organizerPerDiemOverrideReason: "Pegawai keliru mencentang; panitia tidak memberi uang saku.",
    });
    await checkMoneyInvariants();
  });

  it("TRIP-002-M: remapping a golongan after settlement does not move the recorded numbers", async () => {
    const tripId = await insertTrip("APPROVED", daysBefore(today, 3), daysBefore(today, 1));
    const id = await approvedAdvance(tripId, 0);
    actAs("requester");
    expect((await app.inject({ method: "POST", url: `/trip-advances/me/${id}/settlement`, payload: {} })).statusCode).toBe(200);
    const settled = await finance("POST", `/admin/trip-advances/${id}/settle`, { perDiemDays: 3, idempotencyKey: randomUUID() });
    expect(settled.json()).toMatchObject({ perDiemAmount: 3 * STAF_LUAR_DAERAH, status: "AWAITING_TOP_UP" });

    // HC remaps the classification to a dearer golongan afterwards.
    expect((await mapGolongan(classification, "PIMPINAN")).statusCode).toBe(200);
    const reread = await finance("GET", `/admin/trip-advances/${id}`);
    expect(reread.json()).toMatchObject({
      perDiemRate: STAF_LUAR_DAERAH,
      perDiemAmount: 3 * STAF_LUAR_DAERAH,
      perDiemGolonganLabel: "Staf",
      settlementBalance: 3 * STAF_LUAR_DAERAH,
    });
    const stored = await client.query<{ perDiemGolongan: string }>(
      `SELECT per_diem_golongan AS "perDiemGolongan" FROM trip_advances WHERE id = $1`, [id],
    );
    expect(stored.rows[0]!.perDiemGolongan).toBe("STAF");
  });

  it("TRIP-002-J: the database refuses money that does not add up and history that changes", async () => {
    const tripId = await insertTrip();
    const id = await approvedAdvance(tripId, 400_000);
    expect((await finance("POST", `/admin/trip-advances/${id}/disburse`, transaction())).statusCode).toBe(201);

    await client.query("SAVEPOINT tamper");
    await expect(client.query("UPDATE trip_advance_transactions SET amount = 1 WHERE advance_id = $1", [id])).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");
    await expect(client.query("DELETE FROM trip_advance_events WHERE advance_id = $1", [id])).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");
    await client.query(
      `INSERT INTO trip_per_diem_rates (id, golongan, wilayah, effective_from, daily_amount, created_by_account_id)
       VALUES ($1, 'STAF', 'DALAM_DAERAH', $2, 1000, $3)`,
      [randomUUID(), today, people.hc.accountId],
    );
    await expect(client.query("DELETE FROM trip_per_diem_rates WHERE wilayah = 'DALAM_DAERAH'")).rejects.toThrow(/append-only/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");
    await expect(client.query("UPDATE trip_advances SET amount = 500000 WHERE id = $1", [id]).then(checkMoneyInvariants))
      .rejects.toThrow(/disbursement does not match/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");
    await expect(client.query(
      `UPDATE trip_advances SET status = 'AWAITING_REFUND', settlement_submitted_at = now(), settled_at = now(), settlement_key = $2,
              settled_by_account_id = $3, per_diem_days = 0, per_diem_amount = 0, claims_total = 0, settlement_balance = -1
        WHERE id = $1`,
      [id, randomUUID(), people.finance.accountId],
    )).rejects.toThrow(/check constraint/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");
    await expect(client.query(
      `INSERT INTO trip_advance_transactions (id, advance_id, kind, amount, transacted_on, method, idempotency_key, recorded_by_account_id)
       VALUES ($1, $2, 'REFUND', 1000, $3, 'CASH', $4, $5)`,
      [randomUUID(), id, today, randomUUID(), people.finance.accountId],
    ).then(checkMoneyInvariants)).rejects.toThrow(/refund without an amount owed/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");
    // An ADVANCE payment needs a settlement behind it.
    const expense = await claim(tripId);
    await expense.submit();
    await expect(client.query(
      `INSERT INTO reimbursement_payments (id, claim_id, amount, paid_on, method, idempotency_key, recorded_by_account_id)
       VALUES ($1, $2, 325000, $3, 'ADVANCE', $4, $5)`,
      [randomUUID(), expense.id, today, randomUUID(), people.finance.accountId],
    ).then(checkMoneyInvariants)).rejects.toThrow(/advance payment has no trip advance settlement|payment without being paid/);
    await client.query("ROLLBACK TO SAVEPOINT tamper");
    // Nothing here touches payroll.
    const payroll = await client.query(
      `SELECT count(*)::int AS count FROM information_schema.triggers WHERE event_object_table LIKE 'payroll_%' AND action_statement ILIKE '%trip_advance%'`,
    );
    expect(payroll.rows[0].count).toBe(0);
  });
});
