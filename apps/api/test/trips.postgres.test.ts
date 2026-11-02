// TRIP-001 Package 1 acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { attendanceExceptions } from "../src/modules/attendance/exceptions.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerDocumentRoutes } from "../src/modules/documents/routes.js";
import { registerTripRoutes } from "../src/modules/trips/routes.js";

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

function addDays(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

describe.skipIf(!allowed)("TRIP-001 business travel", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal;
  let permissions: string[];
  const people = {} as Record<"requester" | "manager" | "unitApprover" | "other", { employeeId: string; accountId: string }>;
  const today = jakartaToday();

  async function insertEmployee(name: string, unitId: string | null, structural: string | null = null) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, structural_position, started_on, organizational_unit_id)
       VALUES ($1,$2,$3,'active',$4,'2020-01-06',$5)`,
      [id, `TRIP-${id.slice(0, 8)}`, name, structural, unitId],
    );
    return id;
  }

  async function insertAccount(employeeId: string, status = "active") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE',$4)`,
      [id, employeeId, `trip-${id}@example.invalid`, status],
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
      url: "/trips/me",
      payload: {
        destination: "Yayasan Mitra Bandung",
        purpose: "Rapat koordinasi kurikulum tahfidz",
        startOn: addDays(today, 7),
        endOn: addDays(today, 8),
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
    return app.inject({ method: "POST", url: `/trips/approvals/${stepId}/decision`, payload: { decision, note } });
  }

  async function approvedTrip(overrides: Record<string, unknown> = {}) {
    const trip = await submitted(overrides);
    expect((await decide(trip.approvalChain[0]!.id, "manager", "approve")).statusCode).toBe(200);
    expect((await decide(trip.approvalChain[1]!.id, "unitApprover", "approve")).statusCode).toBe(200);
    return trip;
  }

  async function issue(id: string) {
    actAs("other", ["trips.read", "trips.manage"]);
    return app.inject({ method: "POST", url: `/admin/trips/${id}/issue`, payload: {} });
  }

  async function addSigner() {
    await insertEmployee("Kepala HCM Sintetis", null, "Kepala Human Capital Management");
  }

  async function counter() {
    const result = await client.query<{ lastSequence: number }>(
      `SELECT last_sequence AS "lastSequence" FROM hr_document_number_counters
        WHERE number_code = 'ST' AND number_year = $1`,
      [Number(today.slice(0, 4))],
    );
    return result.rows[0]?.lastSequence ?? 0;
  }

  async function tripStatus(id: string) {
    return (await client.query<{ status: string }>("SELECT status FROM business_trip_requests WHERE id = $1", [id])).rows[0]?.status;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1,$2,'Unit Perjalanan Sintetis')",
      [unitId, `unit-trip-${unitId}`],
    );
    for (const key of ["manager", "unitApprover", "requester", "other"] as const) {
      const employeeId = await insertEmployee(`Pegawai ${key}`, unitId);
      people[key] = { employeeId, accountId: await insertAccount(employeeId) };
    }
    await client.query("UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1", [unitId, people.unitApprover.employeeId]);
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people.requester.employeeId, people.manager.employeeId]);
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people.other.employeeId, people.manager.employeeId]);
    actAs("requester");

    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never;
    app = Fastify({ logger: false });
    await registerTripRoutes(app, savepointPool(client), config, auth);
    await registerDocumentRoutes(app, savepointPool(client), config, auth);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("TRIP-001-A/B/K: snapshots the chain at submission and keeps each trip private to its owner", async () => {
    const preview = await app.inject({
      method: "POST", url: "/trips/me/preview", payload: { startOn: addDays(today, 7), endOn: addDays(today, 8) },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().days).toBe(2);

    const trip = await submitted();
    expect(trip.approvalChain.map((step) => step.employeeId)).toEqual([people.manager.employeeId, people.unitApprover.employeeId]);

    // A later change of manager does not rewrite the stored chain (APR-001-B).
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1", [people.requester.employeeId, people.other.employeeId]);
    const detail = await app.inject({ method: "GET", url: `/trips/me/${trip.id}` });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().steps.map((step: { status: string }) => step.status)).toEqual(["pending", "waiting"]);
    expect(detail.json().events.map((event: { eventType: string }) => event.eventType)).toEqual(["trip.request.submitted"]);

    const list = await app.inject({ method: "GET", url: "/trips/me" });
    expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([trip.id]);
    expect(list.json().pagination).toMatchObject({ page: 1, pageSize: 25, total: 1 });

    actAs("other");
    expect((await app.inject({ method: "GET", url: `/trips/me/${trip.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/trips/me" })).json().items).toEqual([]);
    const foreignCancel = await app.inject({
      method: "POST", url: `/trips/me/${trip.id}/cancel`, payload: { reason: "Bukan perjalanan saya" },
    });
    expect(foreignCancel.statusCode).toBe(404);
  });

  it("replays an idempotent submission instead of storing a duplicate", async () => {
    const key = randomUUID();
    const first = await submit({ idempotencyKey: key });
    expect(first.statusCode, first.body).toBe(201);
    const again = await submit({ idempotencyKey: key });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.json().id, idempotentReplay: true });
  });

  it("TRIP-001-C: only the snapshotted approver decides, and a decided step cannot be decided again", async () => {
    const trip = await submitted();
    const [first, second] = trip.approvalChain;

    expect((await decide(first!.id, "requester", "approve")).statusCode).toBe(403);
    expect((await decide(first!.id, "unitApprover", "approve")).statusCode).toBe(403);
    actAs("manager");
    const inbox = await app.inject({ method: "GET", url: "/trips/approvals" });
    expect(inbox.json().items.map((item: { stepId: string }) => item.stepId)).toEqual([first!.id]);

    expect((await decide(first!.id, "manager", "approve")).json().requestStatus).toBe("IN_REVIEW");
    const repeat = await decide(first!.id, "manager", "approve");
    expect(repeat.statusCode).toBe(409);
    expect(repeat.json().code).toBe("STEP_NOT_PENDING");

    const rejectWithoutNote = await decide(second!.id, "unitApprover", "reject");
    expect(rejectWithoutNote.statusCode).toBe(400);
    const final = await decide(second!.id, "unitApprover", "approve");
    expect(final.json()).toMatchObject({ requestStatus: "APPROVED", stepStatus: "approved", nextPendingStepId: null });
    expect(await tripStatus(trip.id)).toBe("APPROVED");

    const notified = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM in_app_notifications WHERE event_key LIKE $1`, [`trip.${trip.id}.%`],
    );
    expect(notified.rows[0]!.count).toBe(1);
  });

  it("a rejection ends the chain and the reason reaches the history", async () => {
    const trip = await submitted();
    const rejected = await decide(trip.approvalChain[0]!.id, "manager", "reject", "Bentrok dengan ujian akhir");
    expect(rejected.json().requestStatus).toBe("REJECTED");
    actAs("requester");
    const detail = (await app.inject({ method: "GET", url: `/trips/me/${trip.id}` })).json();
    expect(detail.steps.map((step: { status: string }) => step.status)).toEqual(["rejected", "waiting"]);
    expect(detail.events.at(-1)).toMatchObject({ eventType: "trip.request.rejected", note: "Bentrok dengan ujian akhir" });
  });

  it("TRIP-001-D: an approver whose account is not active blocks submission and stores nothing", async () => {
    await client.query("UPDATE accounts SET status = 'invited' WHERE id = $1", [people.unitApprover.accountId]);
    const response = await submit();
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("APPROVER_ACCOUNT_NOT_READY");
    const stored = await client.query("SELECT 1 FROM business_trip_requests WHERE employee_id = $1", [people.requester.employeeId]);
    expect(stored.rowCount).toBe(0);
  });

  it("fails closed when the requester has no direct manager", async () => {
    await client.query("UPDATE employees SET direct_manager_employee_id = NULL WHERE id = $1", [people.requester.employeeId]);
    const response = await submit();
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DIRECT_MANAGER_MISSING");
  });

  it("TRIP-001-E: refuses past starts, trips over 30 days and overlapping trips or leave", async () => {
    expect((await submit({ startOn: addDays(today, -1), endOn: today })).json().code).toBe("TRIP_START_IN_PAST");
    expect((await submit({ startOn: addDays(today, 1), endOn: addDays(today, 30) })).json().code).toBe("TRIP_TOO_LONG");
    expect((await submit({ startOn: addDays(today, 1), endOn: addDays(today, 29) })).statusCode).toBe(201);
    expect((await submit({ startOn: addDays(today, 5), endOn: addDays(today, 40) })).json().code).toBe("TRIP_TOO_LONG");
    const overlap = await submit({ startOn: addDays(today, 29), endOn: addDays(today, 31) });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().code).toBe("TRIP_OVERLAP");

    await client.query(
      `INSERT INTO leave_requests(id, employee_id, policy_key, status, start_on, end_on, working_days, hc_handling, idempotency_key)
       VALUES ($1,$2,'annual','approved',$3,$3,1,'none',$4)`,
      [randomUUID(), people.requester.employeeId, addDays(today, 45), randomUUID()],
    );
    const leave = await submit({ startOn: addDays(today, 44), endOn: addDays(today, 46) });
    expect(leave.json().code).toBe("TRIP_LEAVE_OVERLAP");
  });

  it("TRIP-001-F: the letter is issued only from APPROVED, by trips.manage, and a missing signer takes no number", async () => {
    const trip = await submitted();
    expect((await issue(trip.id)).json().code).toBe("TRIP_NOT_ISSUABLE");
    await decide(trip.approvalChain[0]!.id, "manager", "approve");
    await decide(trip.approvalChain[1]!.id, "unitApprover", "approve");

    actAs("other", ["trips.read"]);
    expect((await app.inject({ method: "POST", url: `/admin/trips/${trip.id}/issue`, payload: {} })).statusCode).toBe(403);

    const before = await counter();
    const unsigned = await issue(trip.id);
    expect(unsigned.statusCode).toBe(409);
    expect(unsigned.json().code).toBe("DOCUMENT_SIGNER_UNAVAILABLE");
    expect(await counter()).toBe(before);
    expect(await tripStatus(trip.id)).toBe("APPROVED");

    await addSigner();
    const issued = await issue(trip.id);
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json().documentNumber).toMatch(/^\d{3}\/ST\/YSQ\/[IVX]+\/\d{4}$/);
    expect(await counter()).toBe(before + 1);
    const letter = await client.query<{ kind: string; content: Record<string, unknown> }>(
      `SELECT document_kind AS kind, content_snapshot AS content FROM hr_issued_documents WHERE id = $1`,
      [issued.json().documentId],
    );
    expect(letter.rows[0]!.kind).toBe("ASSIGNMENT");
    expect(letter.rows[0]!.content).toMatchObject({ destination: "Yayasan Mitra Bandung", tripId: trip.id });
    expect(Object.keys(letter.rows[0]!.content)).not.toEqual(expect.arrayContaining(["salary", "bankAccount", "address"]));
  });

  it("TRIP-001-G/H: after issue only HC cancels; the letter is revoked with its number and the DOC register cannot revoke it", async () => {
    await addSigner();
    const trip = await approvedTrip();
    const issued = (await issue(trip.id)).json() as { documentId: string; documentNumber: string };

    actAs("requester");
    const own = await app.inject({ method: "POST", url: `/trips/me/${trip.id}/cancel`, payload: { reason: "Acara diundur" } });
    expect(own.statusCode).toBe(409);
    expect(own.json().code).toBe("TRIP_NOT_CANCELLABLE");

    actAs("other", ["documents.correct"]);
    const viaRegister = await app.inject({
      method: "POST", url: `/admin/documents/issued/${issued.documentId}/revoke`, payload: { reason: "Dicoba lewat register DOC" },
    });
    expect(viaRegister.statusCode).toBe(409);

    actAs("other", ["trips.read", "trips.manage"]);
    const short = await app.inject({ method: "POST", url: `/admin/trips/${trip.id}/cancel`, payload: { reason: "Batal" } });
    expect(short.statusCode).toBe(400);
    const cancelled = await app.inject({
      method: "POST", url: `/admin/trips/${trip.id}/cancel`, payload: { reason: "Acara mitra dibatalkan panitia" },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const letter = await client.query<{ status: string; documentNumber: string }>(
      `SELECT status, document_number AS "documentNumber" FROM hr_issued_documents WHERE id = $1`, [issued.documentId],
    );
    expect(letter.rows[0]).toEqual({ status: "REVOKED", documentNumber: issued.documentNumber });
    const detail = (await app.inject({ method: "GET", url: `/admin/trips/${trip.id}` })).json();
    expect(detail.status).toBe("CANCELLED");
    expect(detail.events.map((event: { eventType: string }) => event.eventType)).toEqual([
      "trip.request.submitted", "trip.approval.approved_step", "trip.approval.approved_step", "trip.request.approved",
      "trip.assignment.issued", "trip.request.cancelled", "trip.assignment.revoked",
    ]);
    const register = await client.query<{ eventType: string }>(
      `SELECT event_type AS "eventType" FROM hr_document_audit_events
        WHERE issued_document_id = $1 ORDER BY occurred_at, event_type`,
      [issued.documentId],
    );
    expect(register.rows.map((row) => row.eventType).sort()).toEqual(["doc.issued", "doc.revoked"]);
  });

  it("an employee cancels a trip still in review, and the approver's inbox empties", async () => {
    const trip = await submitted();
    actAs("requester");
    const cancelled = await app.inject({ method: "POST", url: `/trips/me/${trip.id}/cancel`, payload: { reason: "Agenda berubah" } });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const steps = await client.query<{ status: string }>(
      "SELECT status FROM business_trip_approval_steps WHERE request_id = $1 ORDER BY step_order", [trip.id],
    );
    expect(steps.rows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    actAs("manager");
    expect((await app.inject({ method: "GET", url: "/trips/approvals" })).json().items).toEqual([]);
    expect((await decide(trip.approvalChain[0]!.id, "manager", "approve")).statusCode).toBe(409);
  });

  it("TRIP-001-I: completion needs an issued letter and the return date", async () => {
    await addSigner();
    const future = await approvedTrip();
    actAs("requester");
    const early = await app.inject({
      method: "POST", url: `/trips/me/${future.id}/complete`, payload: { report: "Laporan perjalanan singkat" },
    });
    expect(early.json().code).toBe("TRIP_NOT_COMPLETABLE");

    const sameDay = await approvedTrip({ startOn: today, endOn: today });
    actAs("requester");
    expect((await app.inject({
      method: "POST", url: `/trips/me/${sameDay.id}/complete`, payload: { report: "Laporan perjalanan singkat" },
    })).json().code).toBe("TRIP_NOT_COMPLETABLE");
    await issue(sameDay.id);
    actAs("requester");
    const done = await app.inject({
      method: "POST", url: `/trips/me/${sameDay.id}/complete`, payload: { report: "Rapat selesai, notulen dikirim ke unit." },
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(await tripStatus(sameDay.id)).toBe("COMPLETED");
  });

  it("TRIP-001-J: the HC register needs trips.read and pages with a true total", async () => {
    await submitted();
    actAs("other", []);
    expect((await app.inject({ method: "GET", url: "/admin/trips" })).statusCode).toBe(403);
    actAs("other", ["trips.read"]);
    const page = await app.inject({ method: "GET", url: `/admin/trips?employeeId=${people.requester.employeeId}&pageSize=1` });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().pagination).toMatchObject({ pageSize: 1, total: 1 });
    expect((await app.inject({ method: "GET", url: "/admin/trips?pageSize=101" })).statusCode).toBe(400);
  });

  it("TRIP-001-L: an approved trip is visible in the attendance exceptions without writing attendance", async () => {
    const trip = await approvedTrip();
    const before = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM attendance_daily_records");
    const result = await attendanceExceptions(savepointPool(client), {
      from: addDays(today, 7), to: addDays(today, 7), employeeId: people.requester.employeeId, page: 1, pageSize: 25,
    });
    expect(result.items).toEqual([expect.objectContaining({
      kind: "trip", id: trip.id, type: "Yayasan Mitra Bandung", typeName: "Perjalanan Dinas", status: "APPROVED",
    })]);
    const after = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM attendance_daily_records");
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it("TRIP-001-M: no money column exists in the trip schema", async () => {
    const columns = await client.query<{ column: string }>(
      `SELECT column_name AS column FROM information_schema.columns
        WHERE table_name IN ('business_trip_requests', 'business_trip_approval_steps', 'business_trip_events')`,
    );
    expect(columns.rows.filter((row) => /amount|cost|price|advance|allowance|nominal/i.test(row.column))).toEqual([]);
  });
});
