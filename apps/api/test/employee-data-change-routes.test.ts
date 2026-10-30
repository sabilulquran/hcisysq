// EMP-003 P2-4 routes: whose proposal an employee can touch, the second
// validation at acceptance, the change written in the same transaction as the
// decision, and the audit rows that must not carry the proposed values.
// Fake pool; synthetic proposals only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerEmployeeDataChangeRoutes } from "../src/modules/employees/employee-data-change-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://employee-data-change-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "44".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_EMPLOYEE_ID = "10000000-0000-4000-8000-000000000002";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "60000000-0000-4000-8000-000000000001";

type Persona = "anonymous" | "employee" | "account_without_employee" | "reader" | "hc";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: [],
  account_without_employee: [],
  reader: ["employees.read.all"],
  hc: ["employees.read.all", "employees.manage"],
};

const ADDRESS_PAYLOAD = {
  kind: "DOMISILI",
  addressLine: "Jalan Sintetis 9",
  city: "Bandung",
  validFrom: "2026-11-01",
};

const CONTACT_PAYLOAD = { email: "pegawai@example.org", phone: "0800000000" };

const FAMILY_PAYLOAD = {
  relation: "PASANGAN",
  fullName: "Nama Sintetis",
  validFrom: "2015-06-01",
};

const REQUEST_ROW = {
  id: REQUEST_ID,
  employeeId: EMPLOYEE_ID,
  employeeNumber: "YSQ-0001",
  fullName: "Pegawai Sintetis",
  unitName: "Unit Sintetis",
  submittedByAccountId: ACCOUNT_ID,
  target: "ALAMAT",
  payload: ADDRESS_PAYLOAD,
  state: "DIAJUKAN",
  decidedByAccountId: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: new Date("2026-10-20T00:00:00Z"),
  updatedAt: new Date("2026-10-20T00:00:00Z"),
};

interface PoolOptions {
  /** The locked proposal, as the store would report it. */
  locked?: {
    employeeId?: string;
    target?: string;
    payload?: Record<string, unknown>;
    state?: string;
    employeeRemoved?: boolean;
    /** The employee is marked outside HCIS management (S2B §8.7). */
    employeeOutsideHcis?: boolean;
  } | null;
  openAddress?: { id: string; validFrom: string; validTo: string | null } | null;
  /** The acting employee is marked outside HCIS management (S2B §8.7). */
  employeeOutsideHcis?: boolean;
  /** The write raises this exclusion violation, constraint name and all. */
  periodConflict?: string;
  /** The write raises a CHECK violation the domain rules did not catch. */
  checkViolation?: boolean;
  payload?: object;
}

interface AuditRow {
  action: string;
  payload: Record<string, unknown>;
}

function createPool(persona: Persona, options: PoolOptions = {}) {
  const writes: string[] = [];
  const audits: AuditRow[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: ACCOUNT_ID,
          email: "persona@example.org",
          principalType: "EMPLOYEE",
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
    if (sql.includes("FROM accounts") && sql.includes("principal_type = 'EMPLOYEE'")) {
      return persona === "account_without_employee"
        ? { rows: [], rowCount: 0 }
        : { rows: [{ employeeId: EMPLOYEE_ID }], rowCount: 1 };
    }
    if (sql.includes("management_scope = 'OUTSIDE_HCIS' AS outside")) {
      return { rows: [{ outside: options.employeeOutsideHcis === true }], rowCount: 1 };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("FOR UPDATE OF r")) {
      if (options.locked === null) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          employeeId: options.locked?.employeeId ?? EMPLOYEE_ID,
          submittedByAccountId: ACCOUNT_ID,
          target: options.locked?.target ?? "ALAMAT",
          payload: options.locked?.payload ?? ADDRESS_PAYLOAD,
          state: options.locked?.state ?? "DIAJUKAN",
          employeeRemoved: options.locked?.employeeRemoved === true,
          employeeOutsideHcis: options.locked?.employeeOutsideHcis === true,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("valid_to IS NULL") && sql.includes("FOR UPDATE")) {
      const open = options.openAddress ?? null;
      return open ? { rows: [open], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("count(*)::int AS total")) return { rows: [{ total: 7 }], rowCount: 1 };
    if (sql.includes("FROM employee_data_change_requests r")) return { rows: [REQUEST_ROW], rowCount: 1 };
    if (sql.includes("INSERT INTO employee_data_change_requests")) {
      writes.push("INSERT request");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employee_data_change_requests")) {
      writes.push(`DECIDE ${String(values?.[1])}`);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employee_addresses")) {
      if (options.periodConflict) {
        throw Object.assign(new Error("exclusion violation"), { code: "23P01", constraint: options.periodConflict });
      }
      if (options.checkViolation) throw Object.assign(new Error("check violation"), { code: "23514" });
      writes.push("INSERT address");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employee_addresses SET valid_to")) { writes.push("CLOSE address"); return { rows: [], rowCount: 1 }; }
    if (sql.includes("UPDATE employees SET") && sql.includes("WHERE id = $1")) {
      // The statement itself is the evidence: it must name only the columns
      // the proposal named.
      writes.push(`UPDATE contact [${sql.slice(sql.indexOf("SET") + 4, sql.indexOf("WHERE")).trim()}]`);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employee_family_members")) {
      if (options.periodConflict) {
        throw Object.assign(new Error("exclusion violation"), { code: "23P01", constraint: options.periodConflict });
      }
      writes.push("INSERT family");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employee_education")) { writes.push("INSERT education"); return { rows: [], rowCount: 1 }; }
    if (sql.includes("INSERT INTO employee_skills")) { writes.push("INSERT skill"); return { rows: [], rowCount: 1 }; }
    if (sql.includes("INSERT INTO employee_profile_audit_events")) {
      writes.push("INSERT audit");
      audits.push({ action: String(values?.[2]), payload: JSON.parse(String(values?.[6])) as Record<string, unknown> });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in data change routes test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, query, writes, audits };
}

async function call(persona: Persona, method: "GET" | "POST", url: string, options: PoolOptions = {}) {
  const { pool, writes, audits, query } = createPool(persona, options);
  const app = Fastify({ logger: false });
  await registerEmployeeDataChangeRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, writes, audits, query };
}

describe("EMP-003 P2-4 who may do what", () => {
  it("refuses an anonymous caller everywhere", async () => {
    for (const url of ["/employees/me/data-changes", "/admin/employees/data-changes"]) {
      expect((await call("anonymous", "GET", url)).response.statusCode).toBe(401);
    }
  });

  it("refuses an account that is not linked to an employee", async () => {
    const { response } = await call("account_without_employee", "GET", "/employees/me/data-changes");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "EMPLOYEE_ACCOUNT_REQUIRED" });
  });

  it("refuses the HC worklist and the decisions to an employee", async () => {
    expect((await call("employee", "GET", "/admin/employees/data-changes")).response.json())
      .toMatchObject({ code: "FORBIDDEN" });
    const decide = await call("employee", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`);
    expect(decide.response.statusCode).toBe(403);
    expect(decide.writes).toEqual([]);
  });

  it("refuses a decision to an account that may only read", async () => {
    const accept = await call("reader", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`);
    const reject = await call("reader", "POST", `/admin/data-change-requests/${REQUEST_ID}/reject`, {
      payload: { reason: "Tidak sesuai" },
    });
    expect(accept.response.statusCode).toBe(403);
    expect(reject.response.statusCode).toBe(403);
    expect([...accept.writes, ...reject.writes]).toEqual([]);
  });
});

describe("EMP-003 the employee's own proposals", () => {
  it("records one, auditing the section and the field names but not the values", async () => {
    const { response, writes, audits } = await call("employee", "POST", "/employees/me/data-changes", {
      payload: { target: "ALAMAT", payload: ADDRESS_PAYLOAD },
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["INSERT request", "INSERT audit"]);
    expect(audits[0]).toMatchObject({ action: "employee.data_change.submitted", payload: { target: "ALAMAT" } });
    expect(audits[0].payload.fields).toContain("addressLine");
    expect(JSON.stringify(audits[0].payload)).not.toContain("Jalan Sintetis");
  });

  it("refuses a proposal the domain would refuse", async () => {
    const { response, writes } = await call("employee", "POST", "/employees/me/data-changes", {
      payload: { target: "ALAMAT", payload: { ...ADDRESS_PAYLOAD, city: "" } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ field: "city" });
    expect(writes).toEqual([]);
  });

  it("refuses a proposal from an employee outside HCIS management", async () => {
    // Accepting it could only ever be refused, so the queue never collects it.
    const { response, writes } = await call("employee", "POST", "/employees/me/data-changes", {
      payload: { target: "ALAMAT", payload: ADDRESS_PAYLOAD }, employeeOutsideHcis: true,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EMPLOYEE_OUTSIDE_HCIS_READ_ONLY" });
    expect(writes).toEqual([]);
  });

  it("refuses a section it does not know", async () => {
    const { response, writes } = await call("employee", "POST", "/employees/me/data-changes", {
      payload: { target: "GAJI", payload: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });

  it("withdraws its own proposal without naming a decider", async () => {
    const { response, writes } = await call("employee", "POST", `/employees/me/data-changes/${REQUEST_ID}/cancel`);
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["DECIDE DIBATALKAN", "INSERT audit"]);
  });

  it("answers 404 for someone else's proposal, exactly as for a missing one", async () => {
    const other = await call("employee", "POST", `/employees/me/data-changes/${REQUEST_ID}/cancel`, {
      locked: { employeeId: OTHER_EMPLOYEE_ID },
    });
    const missing = await call("employee", "POST", `/employees/me/data-changes/${REQUEST_ID}/cancel`, { locked: null });
    expect(other.response.statusCode).toBe(404);
    expect(other.response.json()).toEqual(missing.response.json());
    expect(other.writes).toEqual([]);
  });

  it("refuses to withdraw a proposal that was already decided", async () => {
    const { response, writes } = await call("employee", "POST", `/employees/me/data-changes/${REQUEST_ID}/cancel`, {
      locked: { state: "DITERIMA" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "DATA_CHANGE_NOT_PENDING" });
    expect(writes).toEqual([]);
  });
});

describe("EMP-003 HC decides", () => {
  it("pages the worklist and reports the real total", async () => {
    const { response } = await call("reader", "GET", "/admin/employees/data-changes?page=3&pageSize=10");
    expect(response.json()).toMatchObject({ total: 7, page: 3, pageSize: 10, state: "DIAJUKAN" });
  });

  it("refuses a page size beyond a hundred", async () => {
    expect((await call("reader", "GET", "/admin/employees/data-changes?pageSize=500")).response.statusCode).toBe(400);
  });

  it("writes the change in the same transaction as the acceptance", async () => {
    const { response, writes, audits } = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      openAddress: { id: "old", validFrom: "2020-01-01", validTo: null },
    });
    expect(response.statusCode).toBe(200);
    // Closed, opened, decided, audited — one transaction, in that order.
    expect(writes).toEqual(["CLOSE address", "INSERT address", "DECIDE DITERIMA", "INSERT audit"]);
    expect(audits[0]).toMatchObject({
      action: "employee.data_change.accepted",
      payload: { target: "ALAMAT", appliedTo: "employee_addresses" },
    });
    expect(JSON.stringify(audits[0].payload)).not.toContain("Jalan Sintetis");
  });

  it("applies a contact proposal to the master instead of a record table", async () => {
    const { writes } = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      locked: { target: "KONTAK", payload: CONTACT_PAYLOAD },
    });
    expect(writes).toEqual([
      "UPDATE contact [email = $2, phone = $3, updated_at = now()]",
      "DECIDE DITERIMA",
      "INSERT audit",
    ]);
  });

  it("changes only the contact field the proposal named", async () => {
    // A proposal about the phone must not wipe the email. It used to: both
    // columns were written unconditionally, and neither the audit row nor
    // HC's screen showed that the email had gone.
    const { writes, audits } = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      locked: { target: "KONTAK", payload: { phone: "0813000000" } },
    });
    expect(writes[0]).toBe("UPDATE contact [phone = $2, updated_at = now()]");
    expect(writes[0]).not.toContain("email");
    expect(audits[0]?.payload).toMatchObject({ fields: ["phone"] });
  });

  it("writes an emptied contact field, and names it in the audit", async () => {
    const { writes, audits } = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      locked: { target: "KONTAK", payload: { email: null } },
    });
    expect(writes[0]).toBe("UPDATE contact [email = $2, updated_at = now()]");
    // Removing a value is a change, so the audit has to name the field.
    expect(audits[0]?.payload).toMatchObject({ fields: ["email"] });
  });

  it("refuses a contact proposal that names nothing at all", async () => {
    const { response, writes } = await call("employee", "POST", "/employees/me/data-changes", {
      payload: { target: "KONTAK", payload: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });

  it("validates again at acceptance, and writes nothing when the rules no longer fit", async () => {
    // The proposal was valid when it was made; the stored payload is not now.
    const { response, writes } = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      locked: { payload: { ...ADDRESS_PAYLOAD, postalCode: "40" } },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "DATA_CHANGE_NO_LONGER_VALID", field: "postalCode" });
    expect(writes).toEqual([]);
  });

  it("names the rule the database refused rather than one code for all", async () => {
    const overlap = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      periodConflict: "employee_addresses_single_current_excl",
    });
    expect(overlap.response.statusCode).toBe(409);
    expect(overlap.response.json()).toMatchObject({ code: "ADDRESS_PERIOD_OVERLAP" });

    const spouse = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      locked: { target: "KELUARGA", payload: FAMILY_PAYLOAD },
      periodConflict: "employee_family_single_spouse_excl",
    });
    expect(spouse.response.json()).toMatchObject({ code: "FAMILY_SPOUSE_OVERLAP" });
  });

  it("answers a CHECK the domain did not catch as a refusal, not a 500", async () => {
    const { response } = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      checkViolation: true,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "DATA_CHANGE_CONFLICT" });
  });

  it("undoes the decision when the change cannot be written", async () => {
    const { response, writes, query } = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      periodConflict: "employee_addresses_single_current_excl",
    });
    expect(response.statusCode).toBe(409);
    // Rolled back, not merely "no decision written".
    expect(query.mock.calls.some(([sql]) => /^\s*ROLLBACK/.test(String(sql)))).toBe(true);
    expect(query.mock.calls.some(([sql]) => /^\s*COMMIT/.test(String(sql)))).toBe(false);
    // Nothing was decided: an accepted proposal with no change behind it would
    // be a lie in the employee's own history.
    expect(writes.filter((write) => write.startsWith("DECIDE"))).toEqual([]);
  });

  it("refuses an acceptance whose address cannot be closed first", async () => {
    const { response, writes } = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      openAddress: { id: "old", validFrom: "2027-01-01", validTo: null },
    });
    expect(response.statusCode).toBe(409);
    // The address rule is what refused it, so that is the code HC sees.
    expect(response.json()).toMatchObject({ code: "ADDRESS_PERIOD_OVERLAP" });
    expect(writes.filter((write) => write.startsWith("DECIDE"))).toEqual([]);
  });

  it("rejects only with a reason, and writes no change", async () => {
    const bad = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/reject`, { payload: { reason: "x" } });
    expect(bad.response.statusCode).toBe(400);
    expect(bad.writes).toEqual([]);

    const ok = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/reject`, {
      payload: { reason: "Alamat tidak sesuai dokumen" },
    });
    expect(ok.response.statusCode).toBe(200);
    expect(ok.writes).toEqual(["DECIDE DITOLAK", "INSERT audit"]);
    expect(ok.audits[0]).toMatchObject({ action: "employee.data_change.rejected", payload: { noteLength: 27 } });
    expect(JSON.stringify(ok.audits[0].payload)).not.toContain("Alamat tidak sesuai");
  });

  it("refuses a proposal that is already decided, or whose employee has left", async () => {
    const decided = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      locked: { state: "DITOLAK" },
    });
    expect(decided.response.statusCode).toBe(409);
    expect(decided.writes).toEqual([]);

    const removed = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      locked: { employeeRemoved: true },
    });
    expect(removed.response.statusCode).toBe(404);
    expect(removed.response.json()).toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });
    expect(removed.writes).toEqual([]);
  });

  it("refuses to accept a proposal whose record is outside HCIS management", async () => {
    // The direct HC routes refuse that record, so accepting a proposal must
    // not be the way around them (S2B §8.7).
    const { response, writes } = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`, {
      locked: { employeeOutsideHcis: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EMPLOYEE_OUTSIDE_HCIS_READ_ONLY" });
    expect(writes).toEqual([]);
  });

  it("locks the proposal before deciding anything", async () => {
    const { query } = await call("hc", "POST", `/admin/data-change-requests/${REQUEST_ID}/accept`);
    const order = query.mock.calls.map(([sql]) => String(sql));
    const begin = order.findIndex((sql) => /^\s*BEGIN/.test(sql));
    const lock = order.findIndex((sql) => sql.includes("FOR UPDATE OF r"));
    const decide = order.findIndex((sql) => sql.includes("UPDATE employee_data_change_requests"));
    expect(lock).toBeGreaterThan(begin);
    expect(decide).toBeGreaterThan(lock);
  });
});
