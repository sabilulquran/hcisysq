// EMP-010-A: linking PK/SK to an employment action that is already recorded.
// Domain rules plus the route's gates (permission, mode, self, outside HCIS, audit).
// Fake pool; synthetic ids and numbers only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EMPLOYMENT_POLICY as policy,
  EmploymentDomainError,
  planDocumentLink,
  type DecisionDocumentRef,
  type LinkableAction,
} from "../src/modules/employment/domain/index.js";
import { registerDecisionDocumentRoutes } from "../src/modules/employment/decision-document-routes.js";

const EMPLOYEE = "10000000-0000-4000-8000-000000000001";
const OTHER_EMPLOYEE = "10000000-0000-4000-8000-000000000002";
const ACTION = "20000000-0000-4000-8000-000000000001";
const PK = "30000000-0000-4000-8000-000000000001";
const SK_END = "30000000-0000-4000-8000-000000000002";
const SK_MUTASI = "30000000-0000-4000-8000-000000000003";

const pk = (overrides: Partial<DecisionDocumentRef> = {}): DecisionDocumentRef => ({
  id: PK, kind: "PERJANJIAN_KERJA", pkType: "PK_PERPANJANGAN", skType: null, employeeId: EMPLOYEE,
  contractFrom: "2027-07-01", contractTo: "2028-06-30", category: "KONTRAK", ...overrides,
});
const sk = (id: string, skType: DecisionDocumentRef["skType"]): DecisionDocumentRef => ({
  id, kind: "SURAT_KEPUTUSAN", pkType: null, skType, employeeId: null, contractFrom: null, contractTo: null, category: null,
});
const action = (overrides: Partial<LinkableAction> = {}): LinkableAction => ({
  id: ACTION, employeeId: EMPLOYEE, actionType: "CONTRACT_EXTENSION", state: "RECORDED", reasonCode: null,
  newSnapshot: { category: "KONTRAK", termFrom: "2027-07-01", termTo: "2028-06-30" }, ...overrides,
});
const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof EmploymentDomainError) return error.code;
    throw error;
  }
  return null;
};

describe("EMP-010-A planDocumentLink", () => {
  it("links a matching PK to a contract extension and skips one already linked", () => {
    expect(planDocumentLink(action(), [pk()], [], policy)).toEqual({ link: [PK], alreadyLinked: [] });
    expect(planDocumentLink(action(), [pk()], [PK], policy)).toEqual({ link: [], alreadyLinked: [PK] });
  });

  it("refuses a PK whose term differs from the recorded term, and another employee's PK", () => {
    expect(code(() => planDocumentLink(action(), [pk({ contractTo: "2028-12-31" })], [], policy))).toBe("PK_TERM_MISMATCH");
    expect(code(() => planDocumentLink(action(), [pk({ employeeId: OTHER_EMPLOYEE })], [], policy)))
      .toBe("DECISION_DOCUMENT_EMPLOYEE_MISMATCH");
  });

  it("enforces the required kind (D-08)", () => {
    expect(code(() => planDocumentLink(action(), [sk(SK_END, "SK_PEMBERHENTIAN")], [], policy))).toBe("DECISION_DOCUMENT_KIND_INVALID");
    const transfer = action({ actionType: "TRANSFER", newSnapshot: null });
    expect(planDocumentLink(transfer, [sk(SK_MUTASI, "SK_MUTASI")], [], policy).link).toEqual([SK_MUTASI]);
    expect(code(() => planDocumentLink(transfer, [sk(SK_END, "SK_PEMBERHENTIAN")], [], policy))).toBe("DECISION_DOCUMENT_KIND_INVALID");
  });

  it("lets a resignation take only SK Pemberhentian, a placement any SK, the baseline a PK or SK", () => {
    const resign = action({ actionType: "TERMINATION", reasonCode: "RESIGN", newSnapshot: null });
    expect(planDocumentLink(resign, [sk(SK_END, "SK_PEMBERHENTIAN")], [], policy).link).toEqual([SK_END]);
    expect(code(() => planDocumentLink(resign, [sk(SK_MUTASI, "SK_MUTASI")], [], policy))).toBe("DECISION_DOCUMENT_KIND_INVALID");
    const placement = action({ actionType: "PLACEMENT", newSnapshot: null });
    expect(code(() => planDocumentLink(placement, [pk()], [], policy))).toBe("DECISION_DOCUMENT_KIND_INVALID");
    const baseline = action({ actionType: "BASELINE", newSnapshot: null });
    expect(planDocumentLink(baseline, [pk(), sk(SK_MUTASI, "SK_MUTASI")], [], policy).link).toEqual([PK, SK_MUTASI]);
  });

  it("matches HIRE and CATEGORY_CHANGE terms, and asks SK Pengangkatan for a permanent appointment", () => {
    const hire = action({ actionType: "HIRE" });
    expect(planDocumentLink(hire, [pk({ pkType: "PK_BARU" })], [], policy).link).toEqual([PK]);
    expect(code(() => planDocumentLink(hire, [pk({ pkType: "PK_PERPANJANGAN" })], [], policy))).toBe("DECISION_DOCUMENT_KIND_INVALID");
    expect(code(() => planDocumentLink(hire, [pk({ pkType: "PK_BARU", category: "MAGANG" })], [], policy))).toBe("PK_TERM_MISMATCH");
    const permanent = action({ actionType: "CATEGORY_CHANGE", newSnapshot: { category: "TETAP", termFrom: "2027-07-01", termTo: null } });
    expect(planDocumentLink(permanent, [sk(SK_END, "SK_PENGANGKATAN")], [], policy).link).toEqual([SK_END]);
    expect(code(() => planDocumentLink(permanent, [pk()], [], policy))).toBe("DECISION_DOCUMENT_KIND_INVALID");
  });

  it("treats death like resignation and requires SK Pemberhentian for other terminations", () => {
    const death = action({ actionType: "TERMINATION", reasonCode: "MENINGGAL_DUNIA", newSnapshot: null });
    expect(planDocumentLink(death, [sk(SK_END, "SK_PEMBERHENTIAN")], [], policy).link).toEqual([SK_END]);
    const dismissal = action({ actionType: "TERMINATION", reasonCode: "PEMBERHENTIAN", newSnapshot: null });
    expect(planDocumentLink(dismissal, [sk(SK_END, "SK_PEMBERHENTIAN")], [], policy).link).toEqual([SK_END]);
    expect(code(() => planDocumentLink(dismissal, [sk(SK_MUTASI, "SK_MUTASI")], [], policy))).toBe("DECISION_DOCUMENT_KIND_INVALID");
  });

  it("refuses a reversed action and a reversal", () => {
    expect(code(() => planDocumentLink(action({ state: "REVERSED" }), [pk()], [], policy))).toBe("DECISION_DOCUMENT_LINK_NOT_ALLOWED");
    expect(code(() => planDocumentLink(action({ actionType: "REVERSAL" }), [pk()], [], policy))).toBe("DECISION_DOCUMENT_LINK_NOT_ALLOWED");
  });
});

// ---- route ----

const config = {
  NODE_ENV: "test" as const, HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: "postgres://document-links-test",
  AUTH_MODE: "local" as const, AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
};

type Persona = "anonymous" | "reader" | "hc" | "super_admin";
const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [], reader: ["employment.read"], hc: ["employment.read", "employment.manage"], super_admin: [],
};

interface Options { mode?: "OFF" | "SHADOW" | "AUTHORITATIVE"; actorEmployeeId?: string | null; outside?: boolean; actionMissing?: boolean; linked?: string[]; reversed?: boolean; actionId?: string }

async function call(persona: Persona, documentIds: string[], options: Options = {}) {
  const writes: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100", accountId: "00000000-0000-4000-8000-000000000001",
          email: "persona@example.org", principalType: persona === "super_admin" ? "SUPER_ADMIN" : "EMPLOYEE",
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
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM employment_actions a JOIN employees e")) {
      if (options.actionMissing) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: ACTION, employeeId: EMPLOYEE, actionType: "TERMINATION", state: options.reversed ? "REVERSED" : "RECORDED", reasonCode: "RESIGN",
          newSnapshot: null, outside: options.outside ?? false,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT employee_id AS \"employeeId\" FROM accounts")) {
      const id = options.actorEmployeeId === undefined ? OTHER_EMPLOYEE : options.actorEmployeeId;
      return id ? { rows: [{ employeeId: id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FOR UPDATE") && sql.includes("employment_decision_documents")) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM employment_decision_documents WHERE id = ANY")) {
      const known = [sk(SK_END, "SK_PEMBERHENTIAN"), sk(SK_MUTASI, "SK_MUTASI")];
      return { rows: known.filter((row) => documentIds.includes(row.id)), rowCount: 1 };
    }
    if (sql.includes("FROM employment_action_documents WHERE action_id")) {
      return { rows: (options.linked ?? []).map((documentId) => ({ documentId })), rowCount: 0 };
    }
    if (sql.includes("INSERT INTO employment_action_documents")) {
      writes.push("link");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employment_audit_events")) {
      writes.push("audit");
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in document link test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  const app = Fastify({ logger: false });
  await registerDecisionDocumentRoutes(app, pool, config);
  const response = await app.inject({
    method: "POST",
    url: `/admin/employment-actions/${options.actionId ?? ACTION}/documents`,
    headers: persona === "anonymous" ? {} : { cookie: "hcis_session=test-token" },
    payload: { documentIds },
  });
  await app.close();
  const auditPayloads = query.mock.calls
    .filter(([sql]) => String(sql).includes("INSERT INTO employment_audit_events"))
    .map((call) => JSON.parse(String((call as unknown as [string, unknown[]])[1][6])));
  return { response, writes, auditPayloads };
}

describe("EMP-010-A POST /admin/employment-actions/{actionId}/documents", () => {
  it("links an SK Pemberhentian to a recorded resignation and audits it with ids only", async () => {
    const { response, writes, auditPayloads } = await call("hc", [SK_END]);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ actionId: ACTION, linkedDocumentIds: [SK_END], alreadyLinkedDocumentIds: [] });
    expect(writes).toEqual(["link", "audit"]);
    expect(auditPayloads).toEqual([{ documentId: SK_END, actionId: ACTION, actionType: "TERMINATION", after: "RECORDED" }]);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("answers 200 and writes nothing when the document is already linked", async () => {
    const { response, writes } = await call("hc", [SK_END], { linked: [SK_END] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ linkedDocumentIds: [], alreadyLinkedDocumentIds: [SK_END] });
    expect(writes).toEqual([]);
  });

  it("refuses without employment.manage, including Super Admin", async () => {
    expect((await call("anonymous", [SK_END])).response.statusCode).toBe(401);
    expect((await call("reader", [SK_END])).response.json()).toMatchObject({ code: "EMPLOYMENT_FORBIDDEN" });
    expect((await call("super_admin", [SK_END])).response.statusCode).toBe(403);
  });

  it("refuses outside AUTHORITATIVE, on one's own record, and on a record outside HCIS", async () => {
    expect((await call("hc", [SK_END], { mode: "SHADOW" })).response.json()).toMatchObject({ code: "EMPLOYMENT_HISTORY_DISABLED" });
    const self = await call("hc", [SK_END], { actorEmployeeId: EMPLOYEE });
    expect(self.response.statusCode).toBe(403);
    expect(self.response.json()).toMatchObject({ code: "EMPLOYMENT_SELF_ACTION_FORBIDDEN" });
    expect(self.writes).toEqual([]);
    const outside = await call("hc", [SK_END], { outside: true });
    expect(outside.response.json()).toMatchObject({ code: "EMPLOYEE_OUTSIDE_HCIS_READ_ONLY" });
    expect(outside.writes).toEqual([]);
  });

  it("refuses a wrong kind, an unknown document and an unknown action without writing", async () => {
    const wrong = await call("hc", [SK_MUTASI]);
    expect(wrong.response.statusCode).toBe(422);
    expect(wrong.response.json()).toMatchObject({ code: "DECISION_DOCUMENT_KIND_INVALID" });
    expect(wrong.writes).toEqual([]);
    const unknown = await call("hc", ["30000000-0000-4000-8000-0000000000ff"]);
    expect(unknown.response.json()).toMatchObject({ code: "DECISION_DOCUMENT_NOT_FOUND" });
    const missing = await call("hc", [SK_END], { actionMissing: true });
    expect(missing.response.statusCode).toBe(404);
    expect((await call("hc", [])).response.statusCode).toBe(400);
  });

  it("refuses a reversed action with 409 and a malformed action id with 400, writing nothing", async () => {
    const reversed = await call("hc", [SK_END], { reversed: true });
    expect(reversed.response.statusCode).toBe(409);
    expect(reversed.response.json()).toMatchObject({ code: "DECISION_DOCUMENT_LINK_NOT_ALLOWED" });
    expect(reversed.writes).toEqual([]);
    const malformed = await call("hc", [SK_END], { actionId: "not-a-uuid" });
    expect(malformed.response.statusCode).toBe(400);
    expect(malformed.response.json()).toMatchObject({ code: "INVALID_EMPLOYMENT_REQUEST" });
  });
});
