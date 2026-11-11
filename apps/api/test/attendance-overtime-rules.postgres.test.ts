import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

// The cookie carries the account id; permissions are granted per account below.
const grants = new Map<string, string[]>();

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: token, email: `${token}@example.invalid`, principalType: "EMPLOYEE" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext(principal: { id: string }) {
      return { organizationPermissions: grants.get(principal.id) ?? [] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { registerAttendanceWorkforceRoutes } = await import("../src/modules/attendance/workforce-routes.js");

const config = {
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: "postgres://unused",
  AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

// ATT-011-6b-3 overtime rules against the real schema: D-10 (overtime does not apply by position or role),
// D-5b (non-blocking warnings), D-11 (HC notice by unit). Synthetic rows, always rolled back.
describe.skipIf(!allowed)("ATT-011-6b-3 overtime rules (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  const keys = ["boss", "staff", "other", "hcAdmin", "hcUnit", "hcOrg"] as const;
  const ids = Object.fromEntries(keys.map((key) => [key, ""])) as Record<(typeof keys)[number], string>;
  const accounts = { ...ids };
  const units = { school: "", branch: "", office: "" };
  const roles = { exempt: "", hcOps: "" };
  const roleKeys = { exempt: "", hcOps: "" };
  const positionKey = randomUUID();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const stack: string[] = [];
    let sequence = 0;
    const query = async (text: string, values?: unknown[]) => {
      const command = text.trim().toUpperCase();
      if (command === "BEGIN") {
        const savepoint = `rules_${++sequence}`;
        stack.push(savepoint);
        return client.query(`SAVEPOINT ${savepoint}`);
      }
      if (command === "COMMIT" || command === "ROLLBACK") {
        const savepoint = stack.pop();
        if (!savepoint) throw new Error("Unbalanced test transaction");
        if (command === "ROLLBACK") await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return client.query(text, values);
    };
    const transactionPool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;

    for (const key of Object.keys(units) as Array<keyof typeof units>) {
      units[key] = randomUUID();
      await client.query("INSERT INTO organizational_units (id, normalized_name, name) VALUES ($1, $2, $3)", [units[key], `ot-${units[key]}`, `Unit ${key}`]);
    }
    for (const key of keys) {
      ids[key] = randomUUID();
      accounts[key] = randomUUID();
      await client.query(
        `INSERT INTO employees (id, employee_number, full_name, status, started_on, direct_manager_employee_id, organizational_unit_id)
         VALUES ($1, $2, $3, 'active', '2026-01-01', $4, $5)`,
        [ids[key], `OTR-${ids[key]}`, `Synthetic ${key}`, key === "staff" || key === "other" ? ids.boss : null,
          key === "staff" ? units.branch : units.office],
      );
      await client.query(
        "INSERT INTO accounts (id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accounts[key], ids[key], `otr-${accounts[key]}@example.invalid`],
      );
    }
    grants.clear();
    grants.set(accounts.hcAdmin, ["attendance.overtime.manage", "attendance.policy.manage"]);
    grants.set(accounts.hcUnit, ["attendance.overtime.manage"]);

    // A role a rule can name, and an HC role carrying attendance.overtime.manage for D-11.
    for (const key of Object.keys(roles) as Array<keyof typeof roles>) {
      roles[key] = randomUUID();
      roleKeys[key] = `ot_${key}_${roles[key].slice(0, 8)}`;
      await client.query("INSERT INTO roles (id, role_key, name, is_system) VALUES ($1, $2, $3, false)", [roles[key], roleKeys[key], `Peran ${key}`]);
    }
    await client.query("INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, 'attendance.overtime.manage')", [roles.hcOps]);
    // hcUnit is scoped to the school; hcOrg to the whole organisation.
    await client.query(
      `INSERT INTO account_role_assignments (id, account_id, role_id, scope_type, organizational_unit_id)
       VALUES ($1, $2, $3, 'unit', $4), ($5, $6, $3, 'organization', NULL)`,
      [randomUUID(), accounts.hcUnit, roles.hcOps, units.school, randomUUID(), accounts.hcOrg],
    );

    // Structure in force today: the school (linked to its imported unit) above a branch (not linked);
    // staff holds the "Kepala Cabang" seat in the branch.
    const changeSet = randomUUID();
    const schoolNode = randomUUID();
    const branchNode = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1, 'Struktur uji', $3::date, 'PUBLISHED', $2, now(), now() + interval '1 day')`,
      [changeSet, accounts.hcAdmin, today],
    );
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, parent_node_key, effective_from, legacy_unit_id)
       VALUES ($1, $2, $3, 'Sekolah Uji', 'UNIT', NULL, '2026-01-01', $4), ($5, $2, $6, 'Cabang Uji', 'UNIT', $3, '2026-01-01', NULL)`,
      [randomUUID(), changeSet, schoolNode, units.school, randomUUID(), branchNode],
    );
    await client.query(
      `INSERT INTO organization_positions (id, change_set_id, stable_key, node_key, title, effective_from)
       VALUES ($1, $2, $3, $4, 'Kepala Cabang', '2026-01-01')`,
      [randomUUID(), changeSet, positionKey, branchNode],
    );
    await client.query(
      `INSERT INTO organization_incumbencies (id, change_set_id, position_key, employee_id, kind, effective_from)
       VALUES ($1, $2, $3, $4, 'PRIMARY', '2026-01-01')`,
      [randomUUID(), changeSet, positionKey, ids.staff],
    );

    app = Fastify({ logger: false });
    await registerAttendanceWorkforceRoutes(app, transactionPool, config, {
      calculationRunner: { kick: vi.fn(), recoverInterrupted: vi.fn(async () => 0), idle: vi.fn(async () => undefined) },
    });
  });

  afterEach(async () => {
    await app?.close();
    await client.query("ROLLBACK");
    client.release();
  });

  const as = (account: string) => (method: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { cookie: `hcis_session=${account}` }, ...(payload ? { payload } : {}) });
  const addRule = (targetKind: "position" | "role", targetRef: string, effectiveFrom = today) =>
    as(accounts.hcAdmin)("POST", "/admin/attendance/overtime-eligibility-rules", {
      targetKind, targetRef, reasonLabel: "Direktur — tidak menerima upah lembur", effectiveFrom,
    });
  const expectStatus = (response: { statusCode: number; body: string }, code: number) => expect(response.statusCode, response.body).toBe(code);
  const status = async (id: string) => (await client.query("SELECT status, decision_note AS note FROM attendance_overtime_requests WHERE id = $1", [id])).rows[0];
  const notices = async (account: string) => (await client.query(
    "SELECT event_key AS \"eventKey\" FROM in_app_notifications WHERE recipient_account_id = $1 AND event_key LIKE '%:approved:hc'", [account],
  )).rows;

  it("ships without a seeded rule and refuses rule administration without attendance.policy.manage", async () => {
    // DRAFT (spec section 10.11): HC picks the Direktur position; nothing is guessed in the migration.
    expect((await client.query("SELECT count(*)::int AS n FROM attendance_overtime_eligibility_rules")).rows[0].n).toBe(0);
    for (const [method, url, payload] of [
      ["GET", "/admin/attendance/overtime-eligibility-rules", undefined],
      ["GET", "/admin/attendance/overtime-eligibility-rules/targets", undefined],
      ["POST", "/admin/attendance/overtime-eligibility-rules", { targetKind: "role", targetRef: roleKeys.exempt, reasonLabel: "Uji", effectiveFrom: today }],
      ["POST", `/admin/attendance/overtime-eligibility-rules/${randomUUID()}/end`, { reason: "Uji akhir" }],
      ["GET", "/admin/attendance/overtime-policy", undefined],
      ["PUT", "/admin/attendance/overtime-policy", { effectiveFrom: today, dailyWarningMinutes: 60, weeklyWarningMinutes: 600 }],
    ] as const) {
      const response = await as(accounts.hcUnit)(method, url, payload as Record<string, unknown> | undefined);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await as(accounts.staff)("GET", "/admin/attendance/overtime-policy")).statusCode).toBe(403);
  });

  it("adds and ends a rule by position stable key, audited, never deleted, one open rule per target", async () => {
    const targets = await as(accounts.hcAdmin)("GET", "/admin/attendance/overtime-eligibility-rules/targets?kind=position&q=kepala%20cabang");
    expect(targets.json().items).toEqual([{ key: positionKey, label: "Kepala Cabang", detail: "Sekolah Uji › Cabang Uji" }]);
    expect((await addRule("position", randomUUID())).json().code).toBe("OVERTIME_RULE_TARGET_NOT_FOUND");
    const past = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect((await addRule("position", positionKey, past)).json().code).toBe("OVERTIME_RULE_DATE_IN_PAST");

    const created = await addRule("position", positionKey);
    expect(created.statusCode, created.body).toBe(201);
    const ruleId = created.json().id as string;
    expect(created.json().targetLabel).toBe("Kepala Cabang — Sekolah Uji › Cabang Uji");
    expect((await addRule("position", positionKey)).json().code).toBe("OVERTIME_RULE_ALREADY_OPEN");

    const listed = await as(accounts.hcAdmin)("GET", `/admin/attendance/overtime-eligibility-rules?positionKey=${positionKey}`);
    expect(listed.json()).toMatchObject({ total: 1, items: [{ id: ruleId, targetKind: "position", targetRef: positionKey, state: "active", targetActive: true }] });

    expect((await as(accounts.hcAdmin)("POST", `/admin/attendance/overtime-eligibility-rules/${ruleId}/end`, { reason: "x" })).statusCode).toBe(400);
    const ended = await as(accounts.hcAdmin)("POST", `/admin/attendance/overtime-eligibility-rules/${ruleId}/end`, { reason: "Salah pilih jabatan" });
    expect(ended.statusCode, ended.body).toBe(200);
    expect(ended.json().effectiveTo).toBe(past);
    expect((await as(accounts.hcAdmin)("POST", `/admin/attendance/overtime-eligibility-rules/${ruleId}/end`, { reason: "Lagi" })).json().code).toBe("OVERTIME_RULE_ALREADY_ENDED");
    const audit = await client.query("SELECT action FROM access_audit_events WHERE entity_id = $1 ORDER BY occurred_at", [ruleId]);
    expect(audit.rows.map((row) => row.action)).toEqual(["attendance.overtime_rule.created", "attendance.overtime_rule.ended"]);
    await client.query("SAVEPOINT guard");
    await expect(client.query("DELETE FROM attendance_overtime_eligibility_rules WHERE id = $1", [ruleId])).rejects.toThrow(/never deleted/);
    await client.query("ROLLBACK TO SAVEPOINT guard");
    // After the end the employee can request overtime again.
    expectStatus(await as(accounts.staff)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 30 }), 201);
  });

  it("blocks overtime where a rule applies (D-10) at submit, order and on behalf, and hides the employee from the picker", async () => {
    expect((await as(accounts.boss)("GET", "/attendance/team-overtime/subordinates")).json().items.map((item: { id: string }) => item.id).sort())
      .toEqual([ids.other, ids.staff].sort());
    expect((await addRule("position", positionKey)).statusCode).toBe(201);

    const own = await as(accounts.staff)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 60 });
    expect(own.statusCode).toBe(422);
    expect(own.json()).toMatchObject({ code: "OVERTIME_NOT_APPLICABLE", message: "Lembur tidak berlaku untuk jabatan Anda (Direktur — tidak menerima upah lembur)." });
    const onBehalf = await as(accounts.hcAdmin)("POST", "/admin/attendance/overtime", { employeeId: ids.staff, workDate: today, requestedMinutes: 60 });
    expect(onBehalf.json().code).toBe("OVERTIME_NOT_APPLICABLE");
    const order = await as(accounts.boss)("POST", "/attendance/team-overtime/orders", { employeeIds: [ids.staff, ids.other], workDate: today, requestedMinutes: 60, note: "Persiapan" });
    expect(order.statusCode).toBe(422);
    expect(order.json()).toMatchObject({ code: "OVERTIME_NOT_APPLICABLE", employees: [{ employeeId: ids.staff }] });
    expect((await client.query("SELECT count(*)::int AS n FROM attendance_overtime_requests WHERE employee_id = ANY($1::uuid[])", [[ids.staff, ids.other]])).rows[0].n).toBe(0);
    expect((await as(accounts.boss)("GET", "/attendance/team-overtime/subordinates")).json().items.map((item: { id: string }) => item.id)).toEqual([ids.other]);

    // A role rule works the same way, and the excluded person still approves for their own reports.
    await client.query("INSERT INTO account_role_assignments (id, account_id, role_id, scope_type) VALUES ($1, $2, $3, 'own')", [randomUUID(), accounts.boss, roles.exempt]);
    expect((await addRule("role", roleKeys.exempt)).statusCode).toBe(201);
    const bossOwn = await as(accounts.boss)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 60 });
    expect(bossOwn.json().code).toBe("OVERTIME_NOT_APPLICABLE");
    // A role recorded today never reaches back over days already worked, even with an earlier start date.
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    await client.query("UPDATE account_role_assignments SET starts_on = '2026-01-01' WHERE account_id = $1 AND role_id = $2", [accounts.boss, roles.exempt]);
    const reach = await client.query("SELECT attendance_overtime_excluding_rule($1, $2::date) AS today, attendance_overtime_excluding_rule($1, $3::date) AS yesterday", [ids.boss, today, yesterday]);
    expect(reach.rows[0].today).not.toBeNull();
    expect(reach.rows[0].yesterday).toBeNull();
    const id = (await as(accounts.other)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 45 })).json().id as string;
    expectStatus(await as(accounts.boss)("POST", `/attendance/team-overtime/${id}/decision`, { decision: "approve" }), 200);
  });

  it("cancels a waiting request automatically when a rule starts applying before approval (409), and drops overtime minutes", async () => {
    const requested = (await as(accounts.staff)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 60 })).json().id as string;
    const approvedBefore = (await as(accounts.staff)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 30 })).json().id as string;
    expectStatus(await as(accounts.boss)("POST", `/attendance/team-overtime/${approvedBefore}/decision`, { decision: "approve" }), 200);
    const before = await client.query("SELECT overtime_minutes FROM attendance_result_versions WHERE employee_id = $1 AND work_date = $2 ORDER BY version DESC LIMIT 1", [ids.staff, today]);
    expect(before.rows[0].overtime_minutes).toBe(30);

    expect((await addRule("position", positionKey)).statusCode).toBe(201);
    // The engine leaves the excluded day without overtime minutes; the approved request stays.
    const after = await client.query("SELECT overtime_minutes, safe_metadata FROM attendance_result_versions WHERE employee_id = $1 AND work_date = $2 ORDER BY version DESC LIMIT 1", [ids.staff, today]);
    expect(after.rows[0].overtime_minutes).toBe(0);
    expect(after.rows[0].safe_metadata).toMatchObject({ overtimeRequestIds: [approvedBefore], overtimeExcludedByRuleId: expect.any(String) });
    expect((await status(approvedBefore)).status).toBe("approved");

    const refused = await as(accounts.boss)("POST", `/attendance/team-overtime/${requested}/decision`, { decision: "approve" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("OVERTIME_NO_LONGER_APPLICABLE");
    expect(await status(requested)).toMatchObject({ status: "cancelled", note: "Dibatalkan otomatis: lembur tidak berlaku (Direktur — tidak menerima upah lembur)." });
    const events = await client.query("SELECT event_type, payload FROM attendance_overtime_events WHERE overtime_request_id = $1 ORDER BY created_at", [requested]);
    expect(events.rows.map((row) => row.event_type)).toEqual(["submitted", "auto_cancelled"]);
    expect(events.rows[1].payload).toMatchObject({ automatic: true, triggeredByAccountId: accounts.boss });

    // HC still sees both rows, marked; the report leaves the excluded day out.
    const list = (await as(accounts.hcAdmin)("GET", "/admin/attendance/overtime?status=all")).json();
    const row = list.items.find((item: { id: string }) => item.id === approvedBefore);
    expect(row.excludedByRule).toBe("Direktur — tidak menerima upah lembur");
    const { buildAttendanceReport } = await import("../src/modules/attendance/reporting.js");
    const report = await buildAttendanceReport(client as unknown as Pool, { type: "overtime", from: today, to: today, employeeId: ids.staff });
    expect(report).toMatchObject({ items: [], excludedByRuleCount: 2 });
  });

  it("warns without blocking above the PP 35/2021 guide (D-5b) and keeps the warning with the approval", async () => {
    expect((await as(accounts.hcAdmin)("GET", "/admin/attendance/overtime-policy")).json().current).toMatchObject({ dailyWarningMinutes: 240, weeklyWarningMinutes: 1080, source: "default" });
    const put = await as(accounts.hcAdmin)("PUT", "/admin/attendance/overtime-policy", { effectiveFrom: today, dailyWarningMinutes: 60, weeklyWarningMinutes: 100 });
    expect(put.statusCode, put.body).toBe(200);
    const policyAudit = await client.query("SELECT payload FROM access_audit_events WHERE entity_id = $1 AND action = 'attendance.overtime_policy.updated'", [put.json().id]);
    expect(policyAudit.rows[0].payload).toMatchObject({ dailyWarningMinutes: 60, previous: { source: "default" } });

    const dry = await as(accounts.staff)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 90, dryRun: true });
    expect(dry.statusCode, dry.body).toBe(200);
    expect(dry.json().warnings.map((item: { code: string }) => item.code)).toEqual(["OVERTIME_DAILY_GUIDE_EXCEEDED"]);
    expect(dry.json().warnings[0].message).toBe("Melebihi batas PP 35/2021: 1,5 j hari ini (acuan 1 j).");
    expect((await client.query("SELECT count(*)::int AS n FROM attendance_overtime_requests WHERE employee_id = $1", [ids.staff])).rows[0].n).toBe(0);

    const created = await as(accounts.staff)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 90 });
    expect(created.statusCode).toBe(201);
    expect(created.json().warnings).toHaveLength(1);
    const id = created.json().id as string;
    const pending = (await as(accounts.boss)("GET", "/attendance/team-overtime")).json();
    expect(pending.items[0].warnings.map((item: { code: string }) => item.code)).toEqual(["OVERTIME_DAILY_GUIDE_EXCEEDED"]);

    const approved = await as(accounts.boss)("POST", `/attendance/team-overtime/${id}/decision`, { decision: "approve", approvedMinutes: 50 });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().warnings).toEqual([]);
    const second = (await as(accounts.staff)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 60 })).json();
    expect(second.warnings.map((item: { code: string }) => item.code)).toEqual(["OVERTIME_DAILY_GUIDE_EXCEEDED", "OVERTIME_WEEKLY_GUIDE_EXCEEDED"]);
    expectStatus(await as(accounts.boss)("POST", `/attendance/team-overtime/${second.id}/decision`, { decision: "approve" }), 200);
    const audit = await client.query("SELECT payload FROM access_audit_events WHERE entity_id = $1 AND action = 'attendance.overtime.supervisor_approved'", [second.id]);
    expect(audit.rows[0].payload.warnings).toHaveLength(2);
    const event = await client.query("SELECT payload FROM attendance_overtime_events WHERE overtime_request_id = $1 AND event_type = 'approved'", [second.id]);
    expect(event.rows[0].payload.warnings).toHaveLength(2);
    const hc = (await as(accounts.hcAdmin)("GET", "/admin/attendance/overtime?status=approved")).json();
    expect(hc.items.find((item: { id: string }) => item.id === second.id).warnings).toHaveLength(2);
  });

  it("notifies HC staff of the employee's unit or a unit above it (D-11), else the organisation-wide holders", async () => {
    // staff sits in the branch, below the school hcUnit is scoped to: only hcUnit is told.
    const id = (await as(accounts.staff)("POST", "/attendance/overtime", { workDate: today, requestedMinutes: 30 })).json().id as string;
    expectStatus(await as(accounts.boss)("POST", `/attendance/team-overtime/${id}/decision`, { decision: "approve" }), 200);
    expect(await notices(accounts.hcUnit)).toEqual([{ eventKey: `overtime:${id}:approved:hc` }]);
    expect(await notices(accounts.hcOrg)).toEqual([]);
    expect(await notices(accounts.boss)).toEqual([]);

    // other's unit has no unit-scoped HC: the organisation-scoped holder is told (flow B, agreed order).
    const order = (await as(accounts.boss)("POST", "/attendance/team-overtime/orders", { employeeIds: [ids.other], workDate: today, requestedMinutes: 30, note: "Persiapan" })).json();
    const orderId = order.orders[0].id as string;
    expectStatus(await as(accounts.other)("POST", `/attendance/overtime/${orderId}/respond`, { decision: "agree" }), 200);
    expect(await notices(accounts.hcOrg)).toEqual([{ eventKey: `overtime:${orderId}:approved:hc` }]);
    expect((await notices(accounts.hcUnit)).length).toBe(1);
    expect(await notices(accounts.other)).toEqual([]);
  });

  it("answers whether the signed-in employee is a supervisor", async () => {
    expect((await as(accounts.boss)("GET", "/attendance/team-overtime/status")).json()).toEqual({ isSupervisor: true });
    expect((await as(accounts.staff)("GET", "/attendance/team-overtime/status")).json()).toEqual({ isSupervisor: false });
  });
});
