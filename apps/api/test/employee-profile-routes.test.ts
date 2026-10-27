// EMP-007 P2-2 routes: who may read and write, what the domain refuses, the
// lock before every read-modify-write, and the audit rows that must carry no
// personal data. Fake pool; synthetic records only.
//
// What the fake pool can prove is the route's own behaviour. The SQL itself
// (the expiring-certificate worklist, the verification history that must
// survive a revert) is proved against PostgreSQL in
// employee-profile-records.integration.test.ts.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerEmployeeProfileRoutes } from "../src/modules/employees/employee-profile-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://employee-profile-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "22".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const EDUCATION_ID = "40000000-0000-4000-8000-000000000001";
const SKILL_ID = "40000000-0000-4000-8000-000000000002";

type Persona = "anonymous" | "employee" | "reader" | "hc" | "super_admin";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: [],
  reader: ["employees.read.all"],
  hc: ["employees.read.all", "employees.manage"],
  super_admin: [],
};

const EDUCATION_ROW = {
  id: EDUCATION_ID,
  employeeId: EMPLOYEE_ID,
  level: "D4_S1",
  institutionName: "Universitas Sintetis",
  major: "Pendidikan Agama Islam",
  startedYear: 2014,
  completedYear: 2018,
  completionStatus: "SELESAI",
  degreeTitle: "S.Pd.",
  certificateNumber: null,
  archiveReference: null,
  notes: null,
  verificationStatus: "DILAPORKAN",
  verifiedAt: null,
  unverifiedAt: null,
  unverifiedReason: null,
  voidedAt: null,
  voidedReason: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};

const SKILL_ROW = {
  id: SKILL_ID,
  employeeId: EMPLOYEE_ID,
  kind: "SERTIFIKAT",
  name: "Sertifikat Pendidik",
  category: "PENGAJARAN",
  proficiency: null,
  issuer: "Kementerian Agama",
  certificateNumber: null,
  issuedOn: "2024-01-10",
  expiresOn: "2020-01-10",
  archiveReference: null,
  notes: null,
  verificationStatus: "DIVERIFIKASI",
  verifiedAt: new Date("2026-10-01T00:00:00Z"),
  unverifiedAt: null,
  unverifiedReason: null,
  voidedAt: null,
  voidedReason: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};

const EDUCATION_BODY = {
  level: "D4_S1",
  institutionName: "Universitas Sintetis",
  major: "Pendidikan Agama Islam",
  startedYear: 2014,
  completedYear: 2018,
  completionStatus: "SELESAI",
  degreeTitle: "S.Pd.",
};

const SKILL_BODY = {
  kind: "SERTIFIKAT",
  name: "Sertifikat Pendidik",
  category: "PENGAJARAN",
  issuer: "Kementerian Agama",
  issuedOn: "2024-01-10",
  expiresOn: "2029-01-10",
};

interface PoolOptions {
  employeeMissing?: boolean;
  recordMissing?: boolean;
  recordVoided?: boolean;
  /** The record's employee has been removed from the master. */
  ownerRemoved?: boolean;
  /** The education rows a list returns, for the derived highest level. */
  educationRows?: Array<Record<string, unknown>>;
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
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT id FROM employees WHERE id = \$1/.test(sql)) {
      // employeeMissing stands for "removed from the master": reads, which do
      // not filter on removed_at, still find the row.
      const hidden = options.employeeMissing && sql.includes("removed_at IS NULL");
      return hidden ? { rows: [], rowCount: 0 } : { rows: [{ id: EMPLOYEE_ID }], rowCount: 1 };
    }
    if (sql.includes("FOR UPDATE")) {
      if (options.recordMissing) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          employeeId: EMPLOYEE_ID,
          voidedAt: options.recordVoided ? new Date("2026-10-02T00:00:00Z") : null,
          employeeRemoved: options.ownerRemoved === true,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employee_education")) {
      const rows = sql.includes("WHERE id = $1")
        ? [EDUCATION_ROW]
        : (options.educationRows ?? [EDUCATION_ROW]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM employee_skills s")) {
      return sql.includes("count(*)::int AS total")
        ? { rows: [{ total: 3 }], rowCount: 1 }
        : {
          rows: [{
            recordId: SKILL_ID, employeeId: EMPLOYEE_ID, employeeNumber: "YSQ-0001", fullName: "Pegawai Sintetis",
            unitName: "Unit Sintetis", name: "Sertifikat Pendidik", issuer: "Kementerian Agama",
            expiresOn: "2026-11-30", daysLeft: -4, verificationStatus: "DIVERIFIKASI",
          }],
          rowCount: 1,
        };
    }
    if (sql.includes("FROM employee_skills")) return { rows: [SKILL_ROW], rowCount: 1 };
    if (sql.includes("INSERT INTO employee_education")) { writes.push("INSERT education"); return { rows: [], rowCount: 1 }; }
    if (sql.includes("INSERT INTO employee_skills")) { writes.push("INSERT skill"); return { rows: [], rowCount: 1 }; }
    if (sql.includes("UPDATE employee_education SET level")) { writes.push("UPDATE education"); return { rows: [], rowCount: 1 }; }
    if (sql.includes("UPDATE employee_skills SET kind")) { writes.push("UPDATE skill"); return { rows: [], rowCount: 1 }; }
    if (/UPDATE employee_(education|skills)\s+SET verification_status/.test(sql)) {
      writes.push(`VERIFY ${sql.includes("DIVERIFIKASI") ? "set" : "revoke"}`);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE employee_(education|skills) SET voided_at/.test(sql)) { writes.push("VOID"); return { rows: [], rowCount: 1 }; }
    if (sql.includes("INSERT INTO employee_profile_audit_events")) {
      writes.push("INSERT audit");
      audits.push({ action: String(values?.[2]), payload: JSON.parse(String(values?.[6])) as Record<string, unknown> });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in employee profile routes test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, query, writes, audits };
}

async function call(
  persona: Persona,
  method: "GET" | "POST" | "PATCH",
  url: string,
  options: PoolOptions = {},
) {
  const { pool, writes, audits, query } = createPool(persona, options);
  const app = Fastify({ logger: false });
  await registerEmployeeProfileRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, writes, audits, query };
}

const READ_URLS = [
  `/admin/employees/${EMPLOYEE_ID}/education`,
  `/admin/employees/${EMPLOYEE_ID}/skills`,
  "/admin/employees/certificates/expiring",
];

const WRITE_CALLS: Array<["POST" | "PATCH", string, object]> = [
  ["POST", `/admin/employees/${EMPLOYEE_ID}/education`, EDUCATION_BODY],
  ["PATCH", `/admin/education-records/${EDUCATION_ID}`, EDUCATION_BODY],
  ["POST", `/admin/employees/${EMPLOYEE_ID}/skills`, SKILL_BODY],
  ["PATCH", `/admin/skill-records/${SKILL_ID}`, SKILL_BODY],
  ["POST", `/admin/education-records/${EDUCATION_ID}/verification`, { verified: true }],
  ["POST", `/admin/skill-records/${SKILL_ID}/void`, { reason: "Salah entri, catatan ganda" }],
];

describe("EMP-007 P2-2 authorization", () => {
  it.each(READ_URLS)("refuses anonymous and employees without the permission on %s", async (url) => {
    expect((await call("anonymous", "GET", url)).response.statusCode).toBe(401);
    expect((await call("employee", "GET", url)).response.json()).toMatchObject({ code: "FORBIDDEN" });
    // Legacy Super Admin reads these, deliberately: Package 2 introduces no
    // permission of its own and lives under the employee master, which
    // ADMIN_PERMISSIONS already covers (spec §5.1).
    expect((await call("super_admin", "GET", url)).response.statusCode).toBe(200);
  }, 20_000);

  it.each(WRITE_CALLS)("refuses %s %s without employees.manage", async (method, url, payload) => {
    const { response, writes } = await call("reader", method, url, { payload });
    expect(response.statusCode).toBe(403);
    expect(writes).toEqual([]);
  }, 20_000);

  it("lets a reader read", async () => {
    expect((await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/education`)).response.statusCode).toBe(200);
  });
});

describe("EMP-007 education", () => {
  it("records a degree and audits the kind, not the institution", async () => {
    const { response, writes, audits } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/education`, {
      payload: EDUCATION_BODY,
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["INSERT education", "INSERT audit"]);
    expect(audits[0]).toMatchObject({ action: "employee.education.recorded", payload: { level: "D4_S1" } });
    expect(JSON.stringify(audits[0].payload)).not.toContain("Universitas Sintetis");
  });

  it("derives the highest level from the verified, unvoided rows alone", async () => {
    const { response } = await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/education`, {
      educationRows: [
        { ...EDUCATION_ROW, level: "S2", completionStatus: "SELESAI", verificationStatus: "DILAPORKAN" },
        { ...EDUCATION_ROW, level: "D4_S1", completionStatus: "SELESAI", verificationStatus: "DIVERIFIKASI" },
      ],
    });
    expect(response.json().highestLevel).toBe("D4_S1");
  });

  it("refuses a year the domain rejects, and writes nothing", async () => {
    const { response, writes } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/education`, {
      payload: { ...EDUCATION_BODY, startedYear: 2018, completedYear: 2014 },
    });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });

  it("refuses a level that is not one of ours", async () => {
    const { response } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/education`, {
      payload: { ...EDUCATION_BODY, level: "S1" },
    });
    expect(response.json()).toMatchObject({ code: "EMPLOYEE_RECORD_INVALID" });
  });

  it("still reads the records of an employee removed from the master", async () => {
    // D-14: removed is read-only, not invisible.
    expect((await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/education`, { employeeMissing: true }))
      .response.statusCode).toBe(200);
    expect((await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/skills`, { employeeMissing: true }))
      .response.statusCode).toBe(200);
  });

  it("refuses an unknown employee before touching anything", async () => {
    const { response, writes } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/education`, {
      payload: EDUCATION_BODY, employeeMissing: true,
    });
    expect(response.json()).toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });
    expect(writes).toEqual([]);
  });

  it("amends a record and audits which fields moved, not their values", async () => {
    const { response, writes, audits } = await call("hc", "PATCH", `/admin/education-records/${EDUCATION_ID}`, {
      payload: { ...EDUCATION_BODY, institutionName: "Universitas Lain" },
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["UPDATE education", "INSERT audit"]);
    expect(audits[0].payload).toMatchObject({ changedFields: ["institutionName"] });
    expect(JSON.stringify(audits[0].payload)).not.toContain("Universitas Lain");
  });
});

describe("EMP-007 skills", () => {
  it("records a certificate", async () => {
    const { response, writes } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/skills`, { payload: SKILL_BODY });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["INSERT skill", "INSERT audit"]);
  });

  it("refuses an expiry before the issue date", async () => {
    const { response, writes } = await call("hc", "POST", `/admin/employees/${EMPLOYEE_ID}/skills`, {
      payload: { ...SKILL_BODY, issuedOn: "2029-01-10", expiresOn: "2024-01-10" },
    });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });

  it("marks an expired certificate on read instead of changing it", async () => {
    const { response, writes } = await call("reader", "GET", `/admin/employees/${EMPLOYEE_ID}/skills`);
    expect(response.json().rows[0]).toMatchObject({ expiresOn: "2020-01-10", expired: true });
    expect(writes).toEqual([]);
  });
});

describe("EMP-007 verification and voiding", () => {
  it("verifies a record", async () => {
    const { response, writes, audits } = await call("hc", "POST", `/admin/education-records/${EDUCATION_ID}/verification`, {
      payload: { verified: true },
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["VERIFY set", "INSERT audit"]);
    expect(audits[0].action).toBe("employee.education.verified");
  });

  it("refuses to take verification back without a reason", async () => {
    const { response, writes } = await call("hc", "POST", `/admin/education-records/${EDUCATION_ID}/verification`, {
      payload: { verified: false },
    });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });

  it("takes verification back with a reason, auditing its length only", async () => {
    const { response, writes, audits } = await call("hc", "POST", `/admin/skill-records/${SKILL_ID}/verification`, {
      payload: { verified: false, reason: "Sertifikat asli tidak dapat ditunjukkan" },
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["VERIFY revoke", "INSERT audit"]);
    expect(audits[0]).toMatchObject({ action: "employee.skill.unverified", payload: { verified: false } });
    expect(JSON.stringify(audits[0].payload)).not.toContain("Sertifikat asli");
  });

  it("voids a record with a reason and refuses one without", async () => {
    const ok = await call("hc", "POST", `/admin/skill-records/${SKILL_ID}/void`, {
      payload: { reason: "Catatan ganda" },
    });
    expect(ok.response.json()).toMatchObject({ voided: true });
    expect(ok.writes).toEqual(["VOID", "INSERT audit"]);
    const bad = await call("hc", "POST", `/admin/skill-records/${SKILL_ID}/void`, { payload: { reason: "x" } });
    expect(bad.response.statusCode).toBe(400);
    expect(bad.writes).toEqual([]);
  });

  it("refuses an unknown record with 404 and an already-voided one with 409", async () => {
    const missing = await call("hc", "PATCH", `/admin/education-records/${EDUCATION_ID}`, {
      payload: EDUCATION_BODY, recordMissing: true,
    });
    expect(missing.response.statusCode).toBe(404);
    expect(missing.response.json()).toMatchObject({ code: "EMPLOYEE_RECORD_NOT_FOUND" });
    expect(missing.writes).toEqual([]);

    const voided = await call("hc", "POST", `/admin/skill-records/${SKILL_ID}/verification`, {
      payload: { verified: true }, recordVoided: true,
    });
    expect(voided.response.statusCode).toBe(409);
    expect(voided.response.json()).toMatchObject({ code: "EMPLOYEE_RECORD_VOIDED" });
    expect(voided.writes).toEqual([]);
  });

  it("refuses to touch a record of an employee removed from the master", async () => {
    // Its list already answers 404; a route reached by record id must not be
    // the way back into history the master calls read-only (EMP-001).
    const amend = await call("hc", "PATCH", `/admin/education-records/${EDUCATION_ID}`, {
      payload: EDUCATION_BODY, ownerRemoved: true,
    });
    expect(amend.response.statusCode).toBe(404);
    expect(amend.response.json()).toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });
    expect(amend.writes).toEqual([]);

    const verify = await call("hc", "POST", `/admin/skill-records/${SKILL_ID}/verification`, {
      payload: { verified: true }, ownerRemoved: true,
    });
    expect(verify.response.statusCode).toBe(404);
    expect(verify.writes).toEqual([]);

    const voided = await call("hc", "POST", `/admin/skill-records/${SKILL_ID}/void`, {
      payload: { reason: "Catatan ganda" }, ownerRemoved: true,
    });
    expect(voided.response.statusCode).toBe(404);
    expect(voided.writes).toEqual([]);
  });

  it("picks the table from the route, not from the query string", async () => {
    // ".../void?x=/education-records/" must still void a skill record.
    const { query } = await call("hc", "POST", `/admin/skill-records/${SKILL_ID}/void?x=/education-records/`, {
      payload: { reason: "Catatan ganda" },
    });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => /UPDATE employee_skills SET voided_at/.test(sql))).toBe(true);
    expect(statements.some((sql) => /employee_education/.test(sql))).toBe(false);
  });

  it("locks the row before deciding, so two editors cannot race", async () => {
    const { query } = await call("hc", "POST", `/admin/skill-records/${SKILL_ID}/void`, {
      payload: { reason: "Catatan ganda" },
    });
    const order = query.mock.calls.map(([sql]) => String(sql));
    const begin = order.findIndex((sql) => /^\s*BEGIN/.test(sql));
    const lock = order.findIndex((sql) => sql.includes("FOR UPDATE"));
    const write = order.findIndex((sql) => sql.includes("SET voided_at"));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(begin);
    expect(write).toBeGreaterThan(lock);
  });
});

describe("EMP-007 expiring certificates", () => {
  it("pages and reports the real total, flagging the ones already past", async () => {
    const { response } = await call("reader", "GET", "/admin/employees/certificates/expiring?page=2&pageSize=1");
    expect(response.json()).toMatchObject({ total: 3, page: 2, pageSize: 1, withinDays: 60 });
    expect(response.json().rows[0]).toMatchObject({ daysLeft: -4, expired: true });
  });

  it("refuses a window outside the allowed range", async () => {
    const { response } = await call("reader", "GET", "/admin/employees/certificates/expiring?withinDays=400");
    expect(response.statusCode).toBe(400);
  });

  it("caps the page size at a hundred", async () => {
    const { response } = await call("reader", "GET", "/admin/employees/certificates/expiring?pageSize=500");
    expect(response.statusCode).toBe(400);
  });
});
