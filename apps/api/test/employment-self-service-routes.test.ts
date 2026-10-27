// EMP-005 / EMP-006 S7: reversal of the latest action, the expiring-contract
// worklist, and an employee's own employment page. Fake pool; synthetic data.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerEmploymentSelfServiceRoutes } from "../src/modules/employment/self-service-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://employment-self-service-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const EMPLOYMENT_ID = "40000000-0000-4000-8000-000000000001";
const UNIT_ID = "20000000-0000-4000-8000-000000000001";
const BASELINE_ACTION_ID = "50000000-0000-4000-8000-000000000001";
const EXTENSION_ACTION_ID = "50000000-0000-4000-8000-000000000002";

type Persona = "anonymous" | "employee" | "hc" | "hc_corrector" | "super_admin";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: [],
  hc: ["employment.read", "employment.manage"],
  hc_corrector: ["employment.read", "employment.manage", "employment.correct"],
  super_admin: [],
};

interface PoolOptions {
  mode?: "OFF" | "SHADOW" | "AUTHORITATIVE";
  /** The acting account is not linked to an employee. */
  accountWithoutEmployee?: boolean;
  /** The action the caller tries to reverse; defaults to the latest one. */
  targetActionId?: string;
  noHistory?: boolean;
  actorIsEmployee?: boolean;
}

function createPool(persona: Persona, options: PoolOptions = {}) {
  const writes: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: "00000000-0000-4000-8000-000000000001",
          email: "persona@example.org",
          principalType: persona === "super_admin" ? "SUPER_ADMIN" : "EMPLOYEE",
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT DISTINCT role_permission.permission_key AS "permissionKey"')) {
      const keys = PERMISSIONS[persona];
      return { rows: keys.map((permissionKey) => ({ permissionKey })), rowCount: keys.length };
    }
    if (sql.includes("FROM employment_rollout_settings WHERE id = 1")) {
      return { rows: [{ mode: options.mode ?? "AUTHORITATIVE", changedAt: new Date("2026-11-01T00:00:00Z") }], rowCount: 1 };
    }
    if (sql.includes("FROM accounts") && sql.includes("principal_type = 'EMPLOYEE'")) {
      return options.accountWithoutEmployee || persona === "super_admin"
        ? { rows: [], rowCount: 0 }
        : { rows: [{ employeeId: EMPLOYEE_ID }], rowCount: 1 };
    }
    if (sql.includes("FROM accounts WHERE id = $1 AND employee_id IS NOT NULL")) {
      return options.actorIsEmployee ? { rows: [{ employeeId: EMPLOYEE_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM employment_actions WHERE id = $1")) {
      return options.noHistory ? { rows: [], rowCount: 0 } : { rows: [{ employeeId: EMPLOYEE_ID }], rowCount: 1 };
    }
    if (sql.includes("WITH current_term AS") && sql.includes("count(*)::int AS total")) {
      return { rows: [{ total: 2 }], rowCount: 1 };
    }
    if (sql.includes("WITH current_term AS")) {
      return {
        rows: [
          {
            employeeId: EMPLOYEE_ID, employeeNumber: "YSQ-0001", fullName: "Pegawai Sintetis", unitName: "SDIT Sintetis",
            category: "KONTRAK", endsOn: "2027-09-30", sequence: 2, daysLeft: 20,
          },
          {
            employeeId: "10000000-0000-4000-8000-00000000000f", employeeNumber: "YSQ-0002", fullName: "Pegawai Lewat",
            unitName: null, category: "KONTRAK_HONORER", endsOn: "2027-08-31", sequence: 1, daysLeft: -10,
          },
        ],
        rowCount: 2,
      };
    }
    if (sql.includes("FROM employments WHERE")) {
      if (options.noHistory) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: EMPLOYMENT_ID, employeeId: EMPLOYEE_ID, legalEntityKey: null, staffType: "PENDIDIK",
          startedOn: "2026-07-01", startBasis: "RECORDED", serviceStartOn: "2026-07-01", endedOn: null,
          endBasis: null, endPrecision: null, endReason: null, voided: false, version: 4,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employment_terms t")) {
      if (options.noHistory) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: "t2", employmentId: EMPLOYMENT_ID, employeeId: EMPLOYEE_ID, sequence: 2, category: "KONTRAK",
          effectiveFrom: "2026-10-01", effectiveTo: "2027-09-30", contractReference: "001/PK/YSQ/2026", voided: false,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employment_placements p")) {
      if (options.noHistory) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: "p1", employmentId: EMPLOYMENT_ID, employeeId: EMPLOYEE_ID, kind: "PRIMARY", orgNodeKey: null,
          legacyUnitId: UNIT_ID, orgPositionKey: null, legacyPositionId: null, jobTitleLabel: "Guru Kelas",
          effectiveFrom: "2026-10-01", effectiveTo: null, effectiveFromBasis: "BASELINE_ASSUMED", voided: false,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employment_actions WHERE")) {
      if (options.noHistory) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: BASELINE_ACTION_ID, employeeId: EMPLOYEE_ID, employmentId: EMPLOYMENT_ID, actionType: "BASELINE",
            effectiveOn: null, state: "RECORDED", reversesActionId: null,
            recordedAtDate: new Date("2026-10-01T00:00:00Z"), rowChanges: [],
          },
          {
            id: EXTENSION_ACTION_ID, employeeId: EMPLOYEE_ID, employmentId: EMPLOYMENT_ID, actionType: "CONTRACT_EXTENSION",
            effectiveOn: "2026-10-01", state: "RECORDED", reversesActionId: null,
            recordedAtDate: new Date("2026-10-02T00:00:00Z"),
            rowChanges: [{ op: "OPEN", table: "TERM", id: "t2" }],
          },
        ],
        rowCount: 2,
      };
    }
    if (sql.includes("json_agg(json_build_object")) {
      // loadTimeline: the real projection runs over these rows.
      return {
        rows: [{
          id: EXTENSION_ACTION_ID,
          actionType: "CONTRACT_EXTENSION",
          effectiveOn: "2026-10-01",
          state: "RECORDED",
          reversesActionId: null,
          reversedByActionId: null,
          reasonCode: "KOREKSI_HC",
          previousSnapshot: { placement: { jobTitleLabel: "Guru Kelas" }, category: "KONTRAK" },
          newSnapshot: { placement: { jobTitleLabel: "Guru Kelas" }, termTo: "2027-09-30" },
          recordedAt: new Date("2026-10-02T00:00:00Z"),
          documents: [{ id: "d1", kind: "PERJANJIAN_KERJA", number: "001/PK/YSQ/2026", type: "PK_PERPANJANGAN" }],
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employment_action_documents")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM organizational_units WHERE id = ANY")) {
      return { rows: [{ id: UNIT_ID, name: "SDIT Sintetis" }], rowCount: 1 };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT version FROM employments WHERE id = $1 FOR UPDATE")) return { rows: [{ version: 4 }], rowCount: 1 };
    if (sql.includes("INSERT INTO employment_actions")) {
      writes.push("INSERT action");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employment_actions SET state = 'REVERSED'")) {
      writes.push("MARK reversed");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employment_terms SET") || sql.includes("UPDATE employment_placements SET")) {
      writes.push("VOID row");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employments SET version")) {
      writes.push("BUMP version");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employees SET status")) {
      writes.push("PROJECT employee");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employment_audit_events")) {
      writes.push("INSERT audit");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('functional_position AS "functionalPosition"')) {
      return { rows: [{ functionalPosition: "Guru Kelas", structuralPosition: null }], rowCount: 1 };
    }
    if (sql.includes("FROM employment_placements WHERE id = $1")) {
      return { rows: [{ functionalLabel: null, structuralLabel: null }], rowCount: 1 };
    }
    if (sql.includes("SELECT EXISTS")) return { rows: [{ present: false }], rowCount: 1 };
    throw new Error(`Unexpected SQL in employment self-service test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, writes };
}

async function call(
  persona: Persona,
  method: "GET" | "POST",
  url: string,
  options: PoolOptions & { payload?: object } = {},
) {
  const { pool, writes } = createPool(persona, options);
  const app = Fastify({ logger: false });
  await registerEmploymentSelfServiceRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, writes };
}

const REVERSAL_URL = `/admin/employment-actions/${EXTENSION_ACTION_ID}/reversal`;
const REASON = { reasonCode: "SALAH_INPUT", reasonNote: "Tanggal kontrak keliru" };

describe("EMP-005 §6.1 reversal", () => {
  it("needs employment.correct, not employment.manage", async () => {
    expect((await call("anonymous", "POST", REVERSAL_URL, { payload: REASON })).response.statusCode).toBe(401);
    expect((await call("employee", "POST", REVERSAL_URL, { payload: REASON })).response.statusCode).toBe(403);
    expect((await call("hc", "POST", REVERSAL_URL, { payload: REASON })).response.json()).toMatchObject({ code: "EMPLOYMENT_FORBIDDEN" });
    // Legacy Super Admin compatibility never carries employment.* (spec §9).
    expect((await call("super_admin", "POST", REVERSAL_URL, { payload: REASON })).response.statusCode).toBe(403);
  }, 20_000);

  it("undoes the latest action and marks it reversed", async () => {
    const { response, writes } = await call("hc_corrector", "POST", REVERSAL_URL, { payload: REASON });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ reversedActionId: EXTENSION_ACTION_ID, accountReactivated: false });
    expect(writes).toContain("INSERT action");
    expect(writes).toContain("MARK reversed");
    expect(writes).toContain("VOID row");
    expect(writes).toContain("PROJECT employee");
  });

  it("refuses an older action and the baseline with 409, an unknown one with 404", async () => {
    const older = await call("hc_corrector", "POST", `/admin/employment-actions/${BASELINE_ACTION_ID}/reversal`, { payload: REASON });
    expect(older.response.statusCode).toBe(409);
    expect(older.response.json()).toMatchObject({ code: "EMPLOYMENT_ACTION_NOT_REVERSIBLE" });
    const unknown = await call("hc_corrector", "POST", REVERSAL_URL, { noHistory: true, payload: REASON });
    expect(unknown.response.statusCode).toBe(404);
    expect(unknown.response.json()).toMatchObject({ code: "EMPLOYMENT_ACTION_NOT_FOUND" });
    expect(older.writes).toEqual([]);
    expect(unknown.writes).toEqual([]);
  });

  it("tells a malformed action id apart from a missing reason", async () => {
    const malformed = await call("hc_corrector", "POST", "/admin/employment-actions/bukan-uuid/reversal", { payload: REASON });
    expect(malformed.response.statusCode).toBe(400);
    expect(malformed.response.json()).toMatchObject({ code: "INVALID_EMPLOYMENT_REQUEST" });
  });

  it("requires a reason", async () => {
    const { response, writes } = await call("hc_corrector", "POST", REVERSAL_URL, { payload: { reasonNote: "lupa" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_REASON_REQUIRED" });
    expect(writes).toEqual([]);
  });

  it("is refused outside AUTHORITATIVE", async () => {
    for (const mode of ["OFF", "SHADOW"] as const) {
      const { response, writes } = await call("hc_corrector", "POST", REVERSAL_URL, { mode, payload: REASON });
      expect(response.statusCode).toBe(409);
      expect(writes).toEqual([]);
    }
  });

  it("refuses to reverse an action on the actor's own record", async () => {
    const { response, writes } = await call("hc_corrector", "POST", REVERSAL_URL, { actorIsEmployee: true, payload: REASON });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_SELF_ACTION_FORBIDDEN" });
    expect(writes).toEqual([]);
  });
});

describe("EMP-005 §13.4 contracts about to end", () => {
  it("lists the terms that need a decision, overdue ones marked", async () => {
    const { response } = await call("hc", "GET", "/admin/employment/contracts/expiring?withinDays=60");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ withinDays: 60, total: 2 });
    expect(body.rows[0]).toMatchObject({ fullName: "Pegawai Sintetis", daysLeft: 20, overdue: false });
    expect(body.rows[1]).toMatchObject({ daysLeft: -10, overdue: true });
  });

  it("needs employment.read and a mode other than OFF", async () => {
    expect((await call("employee", "GET", "/admin/employment/contracts/expiring")).response.statusCode).toBe(403);
    const off = await call("hc", "GET", "/admin/employment/contracts/expiring", { mode: "OFF" });
    expect(off.response.json()).toMatchObject({ code: "EMPLOYMENT_HISTORY_DISABLED" });
  });

  it("reports the real total even on a page past the end", async () => {
    const { response } = await call("hc", "GET", "/admin/employment/contracts/expiring?page=9&pageSize=25");
    expect(response.json()).toMatchObject({ total: 2, page: 9 });
  });

  it("rejects a window outside the allowed range", async () => {
    expect((await call("hc", "GET", "/admin/employment/contracts/expiring?withinDays=0")).response.statusCode).toBe(400);
    expect((await call("hc", "GET", "/admin/employment/contracts/expiring?withinDays=999")).response.statusCode).toBe(400);
  });
});

describe("EMP-005 D-17 my own employment", () => {
  it("shows the employee their own summary and history", async () => {
    const { response } = await call("employee", "GET", "/employees/me/employment");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "AKTIF",
      current: { category: "KONTRAK", jobTitleLabel: "Guru Kelas", unitName: "SDIT Sintetis" },
    });
  });

  it("carries the history with its job titles, and none of HC's notes about them", async () => {
    const { response } = await call("employee", "GET", "/employees/me/employment");
    const body = response.json();
    // The projection really ran: an entry is there, with where it placed them.
    expect(body.timeline).toHaveLength(1);
    expect(body.timeline[0]).toMatchObject({
      actionType: "CONTRACT_EXTENSION",
      jobTitleLabel: "Guru Kelas",
      documents: [{ kind: "PERJANJIAN_KERJA", number: "001/PK/YSQ/2026" }],
    });
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("reasonNote");
    expect(serialised).not.toContain("reasonCode");
    expect(serialised).not.toContain("KOREKSI_HC");
  });

  it("is refused to an account that is not an employee's", async () => {
    const { response } = await call("super_admin", "GET", "/employees/me/employment");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "EMPLOYEE_ACCOUNT_REQUIRED" });
  });

  it("needs a session, and says so plainly while the history is OFF", async () => {
    expect((await call("anonymous", "GET", "/employees/me/employment")).response.statusCode).toBe(401);
    const off = await call("employee", "GET", "/employees/me/employment", { mode: "OFF" });
    expect(off.response.json()).toMatchObject({ code: "EMPLOYMENT_HISTORY_DISABLED" });
  });
});
