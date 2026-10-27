// EMP-005 S5 contract actions: permissions, the AUTHORITATIVE gate, idempotent
// replay, the self-action guard, and that a refused action writes nothing.
// Fake pool; synthetic employment only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerEmploymentActionRoutes } from "../src/modules/employment/action-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://employment-actions-test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const EMPLOYEE_ID = "10000000-0000-4000-8000-000000000001";
const EMPLOYMENT_ID = "40000000-0000-4000-8000-000000000001";
const UNIT_ID = "20000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const EXISTING_ACTION_ID = "50000000-0000-4000-8000-000000000001";

type Persona = "anonymous" | "employee" | "hc" | "super_admin";

const PERMISSIONS: Record<Persona, string[]> = {
  anonymous: [],
  employee: [],
  hc: ["employees.read.all", "employment.read", "employment.manage"],
  super_admin: [],
};

const PK_ID = "30000000-0000-4000-8000-000000000001";
const SK_ID = "30000000-0000-4000-8000-000000000002";
const PK_BARU_ID = "30000000-0000-4000-8000-000000000003";
const SK_PENGANGKATAN_ID = "30000000-0000-4000-8000-000000000004";
const SK_MUTASI_ID = "30000000-0000-4000-8000-000000000005";
const SK_PROMOSI_ID = "30000000-0000-4000-8000-000000000006";
const SK_DEMOSI_ID = "30000000-0000-4000-8000-000000000007";
const UNIT_TUJUAN_ID = "20000000-0000-4000-8000-000000000002";

/** The extension and its Perjanjian Kerja state the same period and category. */
const EXTENSION = {
  actionType: "CONTRACT_EXTENSION",
  effectiveOn: "2027-10-01",
  termEndOn: "2028-09-30",
  documentIds: [PK_ID],
};

const TERMINATION = {
  actionType: "TERMINATION",
  lastDayOn: "2027-09-30",
  reasonCode: "KONTRAK_BERAKHIR",
  documentIds: [SK_ID],
};

const DOCUMENTS = [
  {
    id: PK_ID, kind: "PERJANJIAN_KERJA", pkType: "PK_PERPANJANGAN", skType: null, employeeId: EMPLOYEE_ID,
    contractFrom: "2027-10-01", contractTo: "2028-09-30", category: "KONTRAK",
  },
  {
    id: PK_BARU_ID, kind: "PERJANJIAN_KERJA", pkType: "PK_BARU", skType: null, employeeId: EMPLOYEE_ID,
    contractFrom: "2027-10-01", contractTo: "2028-09-30", category: "KONTRAK",
  },
  {
    id: SK_PENGANGKATAN_ID, kind: "SURAT_KEPUTUSAN", pkType: null, skType: "SK_PENGANGKATAN", employeeId: null,
    contractFrom: null, contractTo: null, category: null,
  },
  {
    id: SK_MUTASI_ID, kind: "SURAT_KEPUTUSAN", pkType: null, skType: "SK_MUTASI", employeeId: null,
    contractFrom: null, contractTo: null, category: null,
  },
  {
    id: SK_PROMOSI_ID, kind: "SURAT_KEPUTUSAN", pkType: null, skType: "SK_PROMOSI", employeeId: null,
    contractFrom: null, contractTo: null, category: null,
  },
  {
    id: SK_DEMOSI_ID, kind: "SURAT_KEPUTUSAN", pkType: null, skType: "SK_DEMOSI", employeeId: null,
    contractFrom: null, contractTo: null, category: null,
  },
  {
    id: SK_ID, kind: "SURAT_KEPUTUSAN", pkType: null, skType: "SK_PEMBERHENTIAN", employeeId: null,
    contractFrom: null, contractTo: null, category: null,
  },
];

interface PoolOptions {
  mode?: "OFF" | "SHADOW" | "AUTHORITATIVE";
  /** The account acts as this employee (self-action guard). */
  actorEmployeeId?: string | null;
  noHistory?: boolean;
  replayActionId?: string | null;
  /** The employee the replayed key belongs to; defaults to the one in the URL. */
  replayEmployeeId?: string;
  /** The stored optimistic token, when it no longer matches the planned one. */
  storedVersion?: number;
  /** SQLSTATE the action insert raises, to exercise the refusal mapping. */
  insertSqlState?: string;
  employeeRemoved?: boolean;
}

function createPool(persona: Persona, options: PoolOptions = {}) {
  const writes: string[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM auth_sessions s")) {
      if (persona === "anonymous") return { rows: [], rowCount: 0 };
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000100",
          accountId: ACCOUNT_ID,
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
      const mode = options.mode ?? "AUTHORITATIVE";
      return { rows: [{ mode, changedAt: new Date("2026-11-01T00:00:00Z") }], rowCount: 1 };
    }
    if (sql.includes("FROM employment_actions WHERE idempotency_key")) {
      return options.replayActionId
        ? {
            rows: [{
              id: options.replayActionId,
              employeeId: options.replayEmployeeId ?? EMPLOYEE_ID,
              actionType: "CONTRACT_EXTENSION",
              effectiveOn: "2027-10-01",
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT id FROM employees WHERE id = $1")) {
      return options.employeeRemoved ? { rows: [], rowCount: 0 } : { rows: [{ id: EMPLOYEE_ID }], rowCount: 1 };
    }
    if (sql.includes("FROM accounts WHERE id = $1 AND employee_id IS NOT NULL")) {
      return options.actorEmployeeId
        ? { rows: [{ employeeId: options.actorEmployeeId }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT version FROM employments WHERE id = $1 FOR UPDATE")) {
      return { rows: [{ version: options.storedVersion ?? 3 }], rowCount: 1 };
    }
    if (sql.includes("FROM employments WHERE")) {
      if (options.noHistory) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: EMPLOYMENT_ID, employeeId: EMPLOYEE_ID, legalEntityKey: null, staffType: "PENDIDIK",
          startedOn: "2026-07-01", startBasis: "RECORDED", serviceStartOn: "2026-07-01", endedOn: null,
          endBasis: null, endPrecision: null, endReason: null, voided: false, version: 3,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employment_terms t")) {
      if (options.noHistory) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: "t1", employmentId: EMPLOYMENT_ID, employeeId: EMPLOYEE_ID, sequence: 1, category: "KONTRAK",
          effectiveFrom: "2026-10-01", effectiveTo: "2027-09-30", contractReference: null, voided: false,
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
        rows: [{
          id: EXISTING_ACTION_ID, employeeId: EMPLOYEE_ID, employmentId: EMPLOYMENT_ID, actionType: "BASELINE",
          effectiveOn: null, state: "RECORDED", reversesActionId: null,
          recordedAtDate: new Date("2026-10-01T00:00:00Z"), rowChanges: [],
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM employment_decision_documents WHERE id = ANY")) {
      const ids = (params?.[0] as string[] | undefined) ?? [];
      const rows = DOCUMENTS.filter((document) => ids.includes(document.id));
      return { rows, rowCount: rows.length };
    }
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO employment_actions")) {
      if (options.insertSqlState) throw Object.assign(new Error("constraint"), { code: options.insertSqlState });
      writes.push("INSERT action");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employments ")) {
      writes.push("INSERT employment");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employment_placements")) {
      writes.push("INSERT placement");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT id FROM employees WHERE id = $1 FOR UPDATE")) {
      return { rows: [{ id: EMPLOYEE_ID }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employment_terms")) {
      writes.push("INSERT term");
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
    if (sql.includes("INSERT INTO employment_action_documents")) {
      writes.push("LINK document");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO employment_audit_events")) {
      writes.push("INSERT audit");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employment_terms SET") || sql.includes("UPDATE employment_placements SET")) {
      writes.push("CLOSE row");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE employments SET ended_on")) {
      writes.push("END employment");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('functional_position AS "functionalPosition"')) {
      return { rows: [{ functionalPosition: "Guru Kelas", structuralPosition: null }], rowCount: 1 };
    }
    if (sql.includes("FROM employment_placements WHERE id = $1")) {
      return { rows: [{ functionalLabel: null, structuralLabel: null }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in employment action routes test: ${sql}`);
  });
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, writes };
}

async function call(
  persona: Persona,
  url: string,
  options: PoolOptions & { payload?: object; idempotencyKey?: string | null } = {},
) {
  const { pool, writes } = createPool(persona, options);
  const app = Fastify({ logger: false });
  await registerEmploymentActionRoutes(app, pool, config);
  const headers: Record<string, string> = {};
  if (persona !== "anonymous") headers.cookie = "hcis_session=test-token";
  if (options.idempotencyKey !== null) headers["idempotency-key"] = options.idempotencyKey ?? "uji-sintetis-0001";
  const response = await app.inject({
    method: "POST",
    url,
    headers,
    ...(options.payload ? { payload: options.payload } : {}),
  });
  await app.close();
  return { response, writes };
}

const PREVIEW_URL = `/admin/employees/${EMPLOYEE_ID}/employment-actions/preview`;
const RECORD_URL = `/admin/employees/${EMPLOYEE_ID}/employment-actions`;

describe("EMP-005 action authorization", () => {
  it.each([PREVIEW_URL, RECORD_URL])("denies anonymous, ordinary employees and Super Admin on %s", async (url) => {
    expect((await call("anonymous", url, { payload: EXTENSION })).response.statusCode).toBe(401);
    expect((await call("employee", url, { payload: EXTENSION })).response.json()).toMatchObject({ code: "EMPLOYMENT_FORBIDDEN" });
    // Legacy Super Admin compatibility never grants employment.* (spec §9).
    expect((await call("super_admin", url, { payload: EXTENSION })).response.statusCode).toBe(403);
  }, 20_000);

  it("refuses to record an action against the actor's own employee record", async () => {
    const { response, writes } = await call("hc", RECORD_URL, { actorEmployeeId: EMPLOYEE_ID, payload: EXTENSION });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_SELF_ACTION_FORBIDDEN" });
    expect(writes).toEqual([]);
  });
});

describe("EMP-005 actions exist only in AUTHORITATIVE", () => {
  it.each(["OFF", "SHADOW"] as const)("refuses preview and record in mode %s", async (mode) => {
    const preview = await call("hc", PREVIEW_URL, { mode, payload: EXTENSION });
    expect(preview.response.statusCode).toBe(409);
    expect(preview.response.json()).toMatchObject({ code: "EMPLOYMENT_HISTORY_DISABLED" });
    const record = await call("hc", RECORD_URL, { mode, payload: EXTENSION });
    expect(record.response.statusCode).toBe(409);
    expect(record.writes).toEqual([]);
  });
});

describe("EMP-005 contract extension", () => {
  it("previews the change without writing anything", async () => {
    const { response, writes } = await call("hc", PREVIEW_URL, { payload: EXTENSION });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      actionType: "CONTRACT_EXTENSION",
      effectiveOn: "2027-10-01",
      next: { termTo: "2028-09-30" },
      expectedVersion: 3,
    });
    expect(writes).toEqual([]);
  });

  it("records the action, the new term, the version bump and the projection in one transaction", async () => {
    const { response, writes } = await call("hc", RECORD_URL, { payload: EXTENSION });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ replayed: false });
    expect(writes).toContain("INSERT action");
    expect(writes).toContain("INSERT term");
    expect(writes).toContain("BUMP version");
    expect(writes).toContain("PROJECT employee");
    expect(writes).toContain("LINK document");
    expect(writes).toContain("INSERT audit");
  });

  it("requires an Idempotency-Key and replays the first result", async () => {
    const missing = await call("hc", RECORD_URL, { idempotencyKey: null, payload: EXTENSION });
    expect(missing.response.statusCode).toBe(400);
    expect(missing.response.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    expect(missing.writes).toEqual([]);

    const replay = await call("hc", RECORD_URL, { replayActionId: EXISTING_ACTION_ID, payload: EXTENSION });
    expect(replay.response.statusCode).toBe(200);
    expect(replay.response.json()).toEqual({ actionId: EXISTING_ACTION_ID, replayed: true });
    expect(replay.writes).toEqual([]);
  });

  it("refuses an extension whose contract ends before it starts", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      payload: { ...EXTENSION, termEndOn: "2027-09-01" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_TERM_INVALID" });
    expect(writes).toEqual([]);
  });

  it("refuses an extension whose Perjanjian Kerja states another period", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      payload: { ...EXTENSION, termEndOn: "2028-12-31" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "PK_TERM_MISMATCH" });
    expect(writes).toEqual([]);
  });

  it("refuses to record a contract extension without its Perjanjian Kerja", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      payload: { ...EXTENSION, documentIds: [] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "DECISION_DOCUMENT_REQUIRED" });
    expect(writes).toEqual([]);
    // The same action previews fine: the document check belongs to recording.
    const preview = await call("hc", PREVIEW_URL, { payload: { ...EXTENSION, documentIds: [] } });
    expect(preview.response.statusCode).toBe(200);
  });

  it("refuses a contract action for an employee without history", async () => {
    const { response, writes } = await call("hc", RECORD_URL, { noHistory: true, payload: EXTENSION });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_BASELINE_MISSING" });
    expect(writes).toEqual([]);
  });
});

describe("EMP-005 hire", () => {
  const HIRE = {
    actionType: "HIRE",
    effectiveOn: "2027-10-01",
    category: "KONTRAK",
    termEndOn: "2028-09-30",
    staffType: "PENDIDIK",
    placement: { unitId: UNIT_ID, jobTitleLabel: "Guru Kelas" },
    documentIds: [PK_BARU_ID],
  };

  it("opens the employment, its term and its primary placement", async () => {
    const { response, writes } = await call("hc", RECORD_URL, { noHistory: true, payload: HIRE });
    expect(response.statusCode).toBe(201);
    expect(writes).toContain("INSERT employment");
    expect(writes).toContain("INSERT action");
    expect(writes).toContain("INSERT term");
    expect(writes).toContain("INSERT placement");
    // The fake pool serves a fixed history, so the projection it would compute
    // after the insert is covered by the extension and termination cases.
  });

  it("refuses a hire while an employment is still effective", async () => {
    const { response, writes } = await call("hc", RECORD_URL, { payload: HIRE });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_ALREADY_ACTIVE" });
    expect(writes).toEqual([]);
  });

  it("refuses an ORG-004 placement key: Package 1 records legacy units", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      noHistory: true,
      payload: { ...HIRE, placement: { unitKey: UNIT_ID, jobTitleLabel: "Guru Kelas" } },
    });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });

  it("refuses an action on a record removed from the master", async () => {
    const { response, writes } = await call("hc", RECORD_URL, { employeeRemoved: true, noHistory: true, payload: HIRE });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "EMPLOYEE_NOT_FOUND" });
    expect(writes).toEqual([]);
  });
});

describe("EMP-005 category change", () => {
  it("appoints a contract employee as permanent with an SK Pengangkatan", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      payload: {
        actionType: "CATEGORY_CHANGE",
        effectiveOn: "2027-10-01",
        category: "TETAP",
        documentIds: [SK_PENGANGKATAN_ID],
      },
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toContain("INSERT term");
    expect(writes).toContain("PROJECT employee");
  });

  it("refuses a permanent appointment carried by a Perjanjian Kerja", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      payload: { actionType: "CATEGORY_CHANGE", effectiveOn: "2027-10-01", category: "TETAP", documentIds: [PK_ID] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "DECISION_DOCUMENT_KIND_INVALID" });
    expect(writes).toEqual([]);
  });
});

describe("EMP-005 concurrency and replay", () => {
  it("refuses a stale optimistic token", async () => {
    const { response, writes } = await call("hc", RECORD_URL, { storedVersion: 9, payload: EXTENSION });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_VERSION_CONFLICT" });
    expect(writes).toEqual([]);
  });

  it("turns an exclusion-constraint violation into a refusal, not a server error", async () => {
    const { response } = await call("hc", RECORD_URL, { insertSqlState: "23P01", payload: EXTENSION });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_OVERLAP" });
  });

  it("never answers a replay to an unauthenticated caller", async () => {
    const { response } = await call("anonymous", RECORD_URL, { replayActionId: EXISTING_ACTION_ID, payload: EXTENSION });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a key already used for another employee instead of dropping the action", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      replayActionId: EXISTING_ACTION_ID,
      replayEmployeeId: "10000000-0000-4000-8000-00000000000f",
      payload: EXTENSION,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(writes).toEqual([]);
  });
});

describe("EMP-005 termination", () => {
  it("closes the employment, its term and its placement, then re-projects", async () => {
    const { response, writes } = await call("hc", RECORD_URL, { payload: TERMINATION });
    expect(response.statusCode).toBe(201);
    expect(writes).toContain("END employment");
    expect(writes).toContain("CLOSE row");
    expect(writes).toContain("PROJECT employee");
  });

  it("requires a reason the policy knows", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      payload: { ...TERMINATION, reasonCode: "LAINNYA_DARI_MASTER" },
    });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });
});

describe("EMP-006 career actions", () => {
  const TRANSFER = {
    actionType: "TRANSFER",
    effectiveOn: "2027-10-01",
    placement: { unitId: UNIT_TUJUAN_ID, jobTitleLabel: "Guru Kelas" },
    documentIds: [SK_MUTASI_ID],
  };

  it("moves the primary placement and says the structure does not follow", async () => {
    const preview = await call("hc", PREVIEW_URL, { payload: TRANSFER });
    expect(preview.response.statusCode).toBe(200);
    expect(preview.response.json()).toMatchObject({
      actionType: "TRANSFER",
      structureNote: "Penempatan ini tidak mengubah Struktur Organisasi maupun kewenangan approval.",
      next: { placement: { jobTitleLabel: "Guru Kelas" } },
    });

    const { response, writes } = await call("hc", RECORD_URL, { payload: TRANSFER });
    expect(response.statusCode).toBe(201);
    expect(writes).toContain("INSERT placement");
    expect(writes).toContain("CLOSE row");
    expect(writes).toContain("PROJECT employee");
  });

  it("refuses a move to the unit and position the employee already holds", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      payload: { ...TRANSFER, placement: { unitId: UNIT_ID, jobTitleLabel: "Guru Kelas" } },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_REFERENCE_INVALID" });
    expect(writes).toEqual([]);
  });

  it("asks each career move for its own SK", async () => {
    const wrongKind = await call("hc", RECORD_URL, { payload: { ...TRANSFER, documentIds: [SK_PROMOSI_ID] } });
    expect(wrongKind.response.json()).toMatchObject({ code: "DECISION_DOCUMENT_KIND_INVALID" });
    const missing = await call("hc", RECORD_URL, { payload: { ...TRANSFER, documentIds: [] } });
    expect(missing.response.json()).toMatchObject({ code: "DECISION_DOCUMENT_REQUIRED" });
    expect(wrongKind.writes).toEqual([]);
    expect(missing.writes).toEqual([]);
  });

  it("records a promotion with its SK Promosi", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      payload: { ...TRANSFER, actionType: "PROMOTION", documentIds: [SK_PROMOSI_ID] },
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toContain("INSERT placement");
  });

  it("refuses a demotion without a reason", async () => {
    const withoutReason = await call("hc", RECORD_URL, {
      payload: { ...TRANSFER, actionType: "DEMOTION", documentIds: [SK_DEMOSI_ID] },
    });
    expect(withoutReason.response.statusCode).toBe(400);
    expect(withoutReason.response.json()).toMatchObject({ code: "EMPLOYMENT_REASON_REQUIRED" });
    expect(withoutReason.writes).toEqual([]);

    const withReason = await call("hc", RECORD_URL, {
      payload: { ...TRANSFER, actionType: "DEMOTION", documentIds: [SK_DEMOSI_ID], reasonCode: "KINERJA" },
    });
    expect(withReason.response.statusCode).toBe(201);
  });

  it("adds an additional duty without touching the primary placement", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      payload: {
        actionType: "PLACEMENT",
        effectiveOn: "2027-10-01",
        placement: { unitId: UNIT_ID, jobTitleLabel: "Koordinator Tahfidz", kind: "ADDITIONAL" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(writes).toContain("INSERT placement");
    expect(writes).not.toContain("CLOSE row");
  });

  it("refuses a second primary placement and points at the career actions", async () => {
    const { response } = await call("hc", RECORD_URL, {
      payload: { actionType: "PLACEMENT", effectiveOn: "2027-10-01", placement: { unitId: UNIT_TUJUAN_ID, jobTitleLabel: "Guru Kelas" } },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "EMPLOYMENT_OVERLAP" });
  });

  it("refuses to end an additional duty that is not running", async () => {
    const { response, writes } = await call("hc", RECORD_URL, {
      payload: { actionType: "PLACEMENT_END", effectiveOn: "2027-10-01", placementId: "p9" },
    });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
  });
});

describe("EMP-005 request validation", () => {
  it("authorizes before validating the body", async () => {
    expect((await call("employee", RECORD_URL, { payload: { actionType: "SALAH" } })).response.statusCode).toBe(403);
    const invalid = await call("hc", RECORD_URL, { payload: { actionType: "SALAH" } });
    expect(invalid.response.statusCode).toBe(400);
    expect(invalid.writes).toEqual([]);
  });

  it("rejects a career move without a destination unit", async () => {
    const { response } = await call("hc", RECORD_URL, {
      payload: { actionType: "TRANSFER", effectiveOn: "2027-10-01", placement: { jobTitleLabel: "Guru" } },
    });
    expect(response.statusCode).toBe(400);
  });
});
