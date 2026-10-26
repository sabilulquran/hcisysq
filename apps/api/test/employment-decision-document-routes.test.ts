// EMP-010 S4 register routes: permissions, mode gate, the lock after linking,
// and the audited correction path. Fake pool; synthetic documents only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerDecisionDocumentRoutes } from "../src/modules/employment/decision-document-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://decision-documents-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const PK_ID = "30000000-0000-4000-8000-000000000001";
const SK_ID = "30000000-0000-4000-8000-000000000002";

type Persona = "anonymous" | "employee" | "hc" | "hc_corrector" | "super_admin";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: [],
  hc: ["employees.read.all", "employment.read", "employment.manage"],
  hc_corrector: ["employment.read", "employment.manage", "employment.correct"],
  super_admin: [],
};

const PK_ROW = {
  id: PK_ID,
  documentKind: "PERJANJIAN_KERJA",
  documentNumber: "001/PK/YSQ/2027",
  signedOn: "2027-06-20",
  signedYear: 2027,
  externalReference: "Arsip HC lemari 2",
  notes: null,
  pkType: "PK_BARU",
  employeeId: EMPLOYEE_ID,
  contractFrom: "2027-07-01",
  contractTo: "2028-06-30",
  category: "KONTRAK",
  signatoryEmployerLabel: "Ketua Yayasan",
  previousPkId: null,
  skType: null,
  subject: null,
  issuingAuthorityLabel: null,
  effectiveOn: null,
  effectiveTo: null,
  employeeNumber: "YSQ-0001",
  employeeName: "Pegawai Sintetis",
  previousPkNumber: null,
  linkedActionCount: 0,
  createdAt: new Date("2027-06-20T03:00:00Z"),
  updatedAt: new Date("2027-06-20T03:00:00Z"),
};

const PK_BODY = {
  documentKind: "PERJANJIAN_KERJA",
  documentNumber: "001/PK/YSQ/2027",
  signedOn: "2027-06-20",
  pkType: "PK_BARU",
  employeeId: EMPLOYEE_ID,
  contractFrom: "2027-07-01",
  contractTo: "2028-06-30",
  category: "KONTRAK",
};

const SK_BODY = {
  documentKind: "SURAT_KEPUTUSAN",
  documentNumber: "012/SK/YSQ/2027",
  signedOn: "2027-06-25",
  skType: "SK_PENEMPATAN",
  subject: "Penempatan guru semester ganjil 2027/2028",
  issuingAuthorityLabel: "Ketua Yayasan",
  effectiveOn: "2027-07-01",
};

interface PoolOptions {
  mode?: "OFF" | "SHADOW";
  linkedActionCount?: number;
  documentMissing?: boolean;
  numberTaken?: boolean;
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
      const mode = options.mode ?? "SHADOW";
      return mode === "OFF"
        ? { rows: [], rowCount: 0 }
        : { rows: [{ mode, changedAt: new Date("2026-11-01T00:00:00Z") }], rowCount: 1 };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT id FROM employees WHERE id = $1")) return { rows: [{ id: EMPLOYEE_ID }], rowCount: 1 };
    if (sql.includes("count(*)::text AS total")) return { rows: [{ total: "1" }], rowCount: 1 };
    if (sql.includes("FROM employment_decision_documents d")) {
      if (options.documentMissing) return { rows: [], rowCount: 0 };
      return { rows: [{ ...PK_ROW, linkedActionCount: options.linkedActionCount ?? 0 }], rowCount: 1 };
    }
    if (sql.includes("FROM employment_action_documents link")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM employment_decision_document_corrections")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT id FROM employment_decision_documents WHERE id = $1 FOR UPDATE")) {
      return { rows: [{ id: PK_ID }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employment_decision_documents")) {
      if (options.numberTaken) {
        throw Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: "employment_decision_documents_number_idx",
        });
      }
      writes.push("INSERT document");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employment_decision_documents SET")) {
      writes.push("UPDATE document");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employment_decision_document_corrections")) {
      writes.push("INSERT correction");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employment_audit_events")) {
      writes.push("INSERT audit");
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in decision document routes test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, query, writes };
}

async function call(
  persona: Persona,
  method: "GET" | "POST" | "PATCH",
  url: string,
  options: PoolOptions & { payload?: object } = {},
) {
  const { pool, writes, query } = createPool(persona, options);
  const app = Fastify({ logger: false });
  await registerDecisionDocumentRoutes(app, pool, config);
  const response = await app.inject({
    method,
    url,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, writes, query };
}

const READ_ROUTES = ["/admin/decision-documents?kind=PERJANJIAN_KERJA", `/admin/decision-documents/${PK_ID}`];

describe("EMP-010 register authorization", () => {
  it.each(READ_ROUTES)("denies anonymous, ordinary employees, and Super Admin on %s", async (url) => {
    expect((await call("anonymous", "GET", url)).response.statusCode).toBe(401);
    expect((await call("employee", "GET", url)).response.json()).toMatchObject({ code: "EMPLOYMENT_FORBIDDEN" });
    // Legacy Super Admin compatibility never grants employment.* (spec §9).
    expect((await call("super_admin", "GET", url)).response.statusCode).toBe(403);
  }, 20_000);

  it("refuses recording and editing without employment.manage", async () => {
    expect((await call("employee", "POST", "/admin/decision-documents", { payload: PK_BODY })).response.statusCode).toBe(403);
    expect(
      (await call("employee", "PATCH", `/admin/decision-documents/${PK_ID}`, { payload: PK_BODY })).response.statusCode,
    ).toBe(403);
  });

  it("refuses a correction to an account holding only employment.manage", async () => {
    const { response, writes } = await call("hc", "POST", `/admin/decision-documents/${PK_ID}/corrections`, {
      linkedActionCount: 2,
      payload: { ...PK_BODY, documentNumber: "001A/PK/YSQ/2027", reason: "Nomor salah ketik pada arsip" },
    });
    expect(response.statusCode).toBe(403);
    expect(writes).toEqual([]);
  });

  it("authorizes before validating the request", async () => {
    expect((await call("employee", "GET", "/admin/decision-documents?kind=SALAH")).response.statusCode).toBe(403);
    expect((await call("hc", "GET", "/admin/decision-documents?kind=SALAH")).response.statusCode).toBe(400);
  });

  it("is unavailable while the rollout mode is OFF", async () => {
    const read = await call("hc", "GET", READ_ROUTES[0] as string, { mode: "OFF" });
    expect(read.response.json()).toMatchObject({ code: "EMPLOYMENT_HISTORY_DISABLED" });
    const write = await call("hc", "POST", "/admin/decision-documents", { mode: "OFF", payload: PK_BODY });
    expect(write.response.statusCode).toBe(409);
    expect(write.writes).toEqual([]);
  });
});

describe("EMP-010-A recording PK and SK", () => {
  it("records a Perjanjian Kerja with an audit event", async () => {
    const { response, writes } = await call("hc", "POST", "/admin/decision-documents", { payload: PK_BODY });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ documentKind: "PERJANJIAN_KERJA", documentNumber: "001/PK/YSQ/2027", locked: false });
    expect(writes).toEqual(["INSERT document", "INSERT audit"]);
  });

  it("records a Surat Keputusan without an employee", async () => {
    const { response, writes } = await call("hc", "POST", "/admin/decision-documents", { payload: SK_BODY });
    expect(response.statusCode).toBe(201);
    expect(writes).toEqual(["INSERT document", "INSERT audit"]);
  });

  it("rejects a Perjanjian Kerja without a contract end date", async () => {
    const { response, writes } = await call("hc", "POST", "/admin/decision-documents", {
      payload: { ...PK_BODY, contractTo: null },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "DECISION_DOCUMENT_INVALID", field: "contractTo" });
    expect(writes).toEqual([]);
  });

  it("reports a number already used in the same kind and year", async () => {
    const { response } = await call("hc", "POST", "/admin/decision-documents", { numberTaken: true, payload: PK_BODY });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "DECISION_DOCUMENT_NUMBER_TAKEN" });
  });

  it("refuses a previous PK belonging to another employee", async () => {
    const { response, writes } = await call("hc", "POST", "/admin/decision-documents", {
      payload: {
        ...PK_BODY,
        documentNumber: "002/PK/YSQ/2028",
        pkType: "PK_PERPANJANGAN",
        previousPkId: PK_ID,
        employeeId: "10000000-0000-4000-8000-00000000000f",
      },
    });
    expect(response.json()).toMatchObject({ code: "DECISION_DOCUMENT_EMPLOYEE_MISMATCH" });
    expect(writes).toEqual([]);
  });
});

describe("EMP-010-B lock and correction", () => {
  it("edits a document that no action uses yet", async () => {
    const { response, writes } = await call("hc", "PATCH", `/admin/decision-documents/${PK_ID}`, {
      payload: { ...PK_BODY, externalReference: "Arsip HC lemari 3" },
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["UPDATE document", "INSERT audit"]);
  });

  it("locks a document already linked to an action", async () => {
    const { response, writes } = await call("hc", "PATCH", `/admin/decision-documents/${PK_ID}`, {
      linkedActionCount: 1,
      payload: { ...PK_BODY, contractTo: "2028-12-31" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "DECISION_DOCUMENT_LOCKED" });
    expect(writes).toEqual([]);
  });

  it("corrects a locked document and keeps the previous values", async () => {
    const { response, writes } = await call("hc_corrector", "POST", `/admin/decision-documents/${PK_ID}/corrections`, {
      linkedActionCount: 1,
      payload: { ...PK_BODY, contractTo: "2028-12-31", reason: "Masa kontrak pada arsip berbeda" },
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toEqual(["UPDATE document", "INSERT correction", "INSERT audit"]);
  });

  it("requires a reason of at least ten characters for a correction", async () => {
    const { response, writes } = await call("hc_corrector", "POST", `/admin/decision-documents/${PK_ID}/corrections`, {
      linkedActionCount: 1,
      payload: { ...PK_BODY, reason: "salah" },
    });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });

  it("never rewrites the kind or the employee of a Perjanjian Kerja", async () => {
    const kind = await call("hc", "PATCH", `/admin/decision-documents/${PK_ID}`, { payload: SK_BODY });
    expect(kind.response.json()).toMatchObject({ code: "DECISION_DOCUMENT_KIND_INVALID" });
    const employee = await call("hc", "PATCH", `/admin/decision-documents/${PK_ID}`, {
      payload: { ...PK_BODY, employeeId: "10000000-0000-4000-8000-00000000000f" },
    });
    expect(employee.response.json()).toMatchObject({ code: "DECISION_DOCUMENT_EMPLOYEE_MISMATCH" });
    expect(kind.writes).toEqual([]);
    expect(employee.writes).toEqual([]);
  });

  it("answers 404 for a document that does not exist", async () => {
    const { response } = await call("hc", "GET", `/admin/decision-documents/${SK_ID}`, { documentMissing: true });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "DECISION_DOCUMENT_NOT_FOUND" });
  });
});

describe("EMP-010 register listing", () => {
  it("lists one kind at a time with paging", async () => {
    const { response } = await call("hc", "GET", "/admin/decision-documents?kind=PERJANJIAN_KERJA&page=1&pageSize=25");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ kind: "PERJANJIAN_KERJA", page: 1, pageSize: 25, total: 1 });
  });

  it("shows a document used by an action as locked", async () => {
    const { response } = await call("hc", "GET", `/admin/decision-documents/${PK_ID}`, { linkedActionCount: 3 });
    expect(response.json()).toMatchObject({ locked: true, linkedActionCount: 3, links: [], corrections: [] });
  });
});
