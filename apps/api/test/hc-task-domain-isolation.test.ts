import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { encryptSecret } from "../src/modules/auth/crypto.js";
import { registerAttendanceResolutionRoutes } from "../src/modules/leave/attendance-resolution-routes.js";
import { SUPPORTED_PLANNED_LEAVE_KEYS } from "../src/modules/leave/domain/planned-leave-policy.js";
import { SUPPORTED_SPECIAL_LEAVE_KEYS } from "../src/modules/leave/domain/special-leave-policy.js";
import { registerPlannedLeaveRoutes } from "../src/modules/leave/planned-leave-routes.js";
import { registerSpecialLeaveRoutes } from "../src/modules/leave/special-leave-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://hc-task-domain-isolation-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const ACCOUNT = "00000000-0000-4000-8000-000000000002";
const HC_EMPLOYEE = "00000000-0000-4000-8000-000000000050";
const REQUESTER = "00000000-0000-4000-8000-000000000060";
const REQUEST = "00000000-0000-4000-8000-000000000100";
const TASK = "00000000-0000-4000-8000-000000000110";
const EVIDENCE = "00000000-0000-4000-8000-000000000120";

function sessionRows() {
  return {
    rows: [
      {
        sessionId: "00000000-0000-4000-8000-000000000001",
        accountId: ACCOUNT,
        email: "hc@example.org",
        principalType: "EMPLOYEE",
        expiresAt: new Date("2027-01-01T12:00:00.000Z"),
      },
    ],
    rowCount: 1,
  };
}

function actorRow() {
  return {
    id: HC_EMPLOYEE,
    employeeNumber: "HC-001",
    fullName: "HC Test",
    status: "active",
    unitName: "Human Capital",
    positionName: "HC",
    leaveEntitlementGroup: "non_education",
    startedOn: "2025-01-01",
    directManagerEmployeeId: null,
    directManagerName: null,
    directManagerStatus: null,
  };
}

function encryptedEvidence() {
  const encrypted = encryptSecret(
    Buffer.from("%PDF-domain-isolation", "utf8").toString("base64"),
    config.AUTH_ENCRYPTION_KEY,
  );
  return {
    id: EVIDENCE,
    requestId: REQUEST,
    fileName: "bukti.pdf",
    contentType: "application/pdf" as const,
    byteSize: 21,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.tag,
    createdAt: new Date("2026-08-22T01:00:00.000Z"),
  };
}

function queryAllowsPolicy(sql: string, values: unknown[] | undefined, policyKey: string) {
  if (!sql.includes("policy_key = ANY")) return true;
  return Boolean(
    values?.some(
      (value) => Array.isArray(value) && value.some((candidate) => candidate === policyKey),
    ),
  );
}

function queryAllowsTaskKind(
  sql: string,
  values: unknown[] | undefined,
  taskKind: "validate" | "approve",
) {
  if (sql.includes("task.task_kind = 'validate'")) return taskKind === "validate";
  if (sql.includes("task.task_kind = 'approve'")) return taskKind === "approve";
  if (sql.includes("task.task_kind = $1")) return values?.[0] === taskKind;
  return true;
}

function queueRow(policyKey: string) {
  return {
    taskId: TASK,
    taskStatus: "pending",
    requestId: REQUEST,
    requesterEmployeeId: REQUESTER,
    requesterName: "Pegawai Test",
    employeeNumber: "EMP-001",
    unitName: "Unit Test",
    positionName: "Posisi Test",
    entitlementGroup: "non_education",
    policyKey,
    startOn: "2026-08-24",
    endOn: "2026-08-24",
    workingDays: 1,
    reason: null,
    evidenceRequirement: "required",
    submittedAt: new Date("2026-08-22T01:00:00.000Z"),
    taskNote: null,
    evidence: [],
    validationSummary: {},
  };
}

function taskRow(policyKey: string) {
  return {
    taskId: TASK,
    requestId: REQUEST,
    requesterEmployeeId: REQUESTER,
    taskStatus: "pending",
    requestStatus: "in_review",
    startOn: "2026-08-24",
    endOn: "2026-08-24",
    evidenceRequirement: "required",
    policyKey,
  };
}

function createHcTaskPool(input: {
  policyKey: string;
  taskKind?: "validate" | "approve";
}) {
  const taskKind = input.taskKind ?? "validate";
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: null };
    }
    if (sql.includes("FROM auth_sessions s")) return sessionRows();
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM accounts account") && sql.includes("JOIN employees employee")) {
      return { rows: [actorRow()], rowCount: 1 };
    }
    if (sql.includes("FROM accounts a") && sql.includes("JOIN employees e")) {
      return { rows: [actorRow()], rowCount: 1 };
    }
    if (sql.includes("JOIN role_permissions role_permission")) {
      return { rows: [{ allowed: true }], rowCount: 1 };
    }
    if (sql.includes("FROM account_role_assignments assignment") && sql.includes("JOIN roles role")) {
      return { rows: [{ allowed: true }], rowCount: 1 };
    }
    if (sql.includes("FROM leave_calendar_settings")) {
      return { rows: [{ workingWeekdayMask: 31 }], rowCount: 1 };
    }
    if (sql.includes("FROM leave_calendar_exceptions")) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("FROM leave_request_hc_tasks task") &&
      !sql.includes("FOR UPDATE OF task")
    ) {
      const allowed =
        queryAllowsTaskKind(sql, values, taskKind) &&
        queryAllowsPolicy(sql, values, input.policyKey);
      return {
        rows: allowed ? [queueRow(input.policyKey)] : [],
        rowCount: allowed ? 1 : 0,
      };
    }
    if (
      sql.includes("FROM leave_request_hc_tasks task") &&
      sql.includes("FOR UPDATE OF task")
    ) {
      const allowedByKind = queryAllowsTaskKind(sql, values, taskKind);
      const allowedByFamily = queryAllowsPolicy(sql, values, input.policyKey);
      const allowedByUnpaid =
        !sql.includes("request.policy_key = 'unpaid'") || input.policyKey === "unpaid";
      const allowed = allowedByKind && allowedByFamily && allowedByUnpaid;
      return {
        rows: allowed ? [taskRow(input.policyKey)] : [],
        rowCount: allowed ? 1 : 0,
      };
    }
    if (
      sql.includes("FROM leave_request_evidence evidence") &&
      sql.includes("JOIN leave_request_hc_tasks task")
    ) {
      const allowed =
        queryAllowsTaskKind(sql, values, taskKind) &&
        queryAllowsPolicy(sql, values, input.policyKey);
      return {
        rows: allowed ? [encryptedEvidence()] : [],
        rowCount: allowed ? 1 : 0,
      };
    }
    if (sql.includes("SELECT count(*)::int AS count") && sql.includes("leave_request_evidence")) {
      return { rows: [{ count: 1 }], rowCount: 1 };
    }
    if (
      sql.includes("UPDATE leave_request_hc_tasks") ||
      sql.includes("UPDATE leave_requests") ||
      sql.includes("INSERT INTO leave_request_validation_days") ||
      sql.includes("INSERT INTO attendance_resolution_cases") ||
      sql.includes("INSERT INTO attendance_resolution_days") ||
      sql.includes("INSERT INTO leave_request_events") ||
      sql.includes("INSERT INTO in_app_notifications") ||
      sql.includes("INSERT INTO leave_notification_outbox")
    ) {
      return { rows: [], rowCount: 1 };
    }
    // LEAVE-010-F (2026-11-24): keputusan akhir memberi tahu pemohon, jadi jalur ini kini membaca
    // fakta pengajuannya dan akun pemohon sebelum menulis notifikasi.
    if (sql.includes("FROM leave_requests request") && sql.includes("JOIN employees requester")) {
      return {
        rows: [{
          requesterName: "Pegawai Uji",
          policyKey: "unpaid",
          startOn: "2099-02-02",
          endOn: "2099-02-03",
          workingDays: 2,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM accounts account")) {
      return { rows: [{ accountId: "00000000-0000-4000-8000-000000000002" }], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in HC task domain isolation test: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  return {
    pool: {
      query,
      connect: vi.fn(async () => client),
    } as unknown as Pool,
    query,
  };
}

function domainMutationSql(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls
    .map((call) => String(call[0]))
    .filter(
      (sql) =>
        sql.includes("UPDATE leave_request_hc_tasks") ||
        sql.includes("UPDATE leave_requests") ||
        sql.includes("INSERT INTO leave_request_validation_days") ||
        sql.includes("INSERT INTO attendance_resolution_cases") ||
        sql.includes("INSERT INTO attendance_resolution_days") ||
        sql.includes("INSERT INTO leave_request_events") ||
        sql.includes("INSERT INTO leave_notification_outbox"),
    );
}

async function withAttendanceRoutes<T>(pool: Pool, run: (app: FastifyInstance) => Promise<T>) {
  const app = Fastify({ logger: false });
  await registerAttendanceResolutionRoutes(app, pool, config);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

async function withSpecialRoutes<T>(pool: Pool, run: (app: FastifyInstance) => Promise<T>) {
  const app = Fastify({ logger: false });
  await registerSpecialLeaveRoutes(app, pool, config);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

async function withPlannedRoutes<T>(pool: Pool, run: (app: FastifyInstance) => Promise<T>) {
  const app = Fastify({ logger: false });
  await registerPlannedLeaveRoutes(app, pool, config);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

describe("HC task domain isolation", () => {
  it("does not expose planned validation tasks in either legacy HC queue", async () => {
    const attendancePool = createHcTaskPool({ policyKey: "employee_marriage" });
    const administrationResponse = await withAttendanceRoutes(attendancePool.pool, (app) =>
      app.inject({
        method: "GET",
        url: "/leave/hc/administration-queue",
        headers: { cookie: "hcis_session=test-token" },
      }),
    );
    expect(administrationResponse.statusCode).toBe(200);
    expect(administrationResponse.json().items).toEqual([]);
    const administrationQueueCall = attendancePool.query.mock.calls.find(([sql]) =>
      String(sql).includes("requester.leave_entitlement_group AS \"entitlementGroup\""),
    );
    expect(String(administrationQueueCall?.[0])).toContain("leave_request.policy_key = ANY");
    expect(administrationQueueCall?.[1]).toEqual([[...SUPPORTED_SPECIAL_LEAVE_KEYS]]);

    const specialPool = createHcTaskPool({ policyKey: "employee_marriage" });
    const legacyValidationResponse = await withSpecialRoutes(specialPool.pool, (app) =>
      app.inject({
        method: "GET",
        url: "/leave/hc/validation-queue",
        headers: { cookie: "hcis_session=test-token" },
      }),
    );
    expect(legacyValidationResponse.statusCode).toBe(200);
    expect(legacyValidationResponse.json().items).toEqual([]);
  });

  it("rejects a planned task in administration-decision before domain mutation", async () => {
    const { pool, query } = createHcTaskPool({ policyKey: "employee_marriage" });
    const response = await withAttendanceRoutes(pool, (app) =>
      app.inject({
        method: "POST",
        url: `/leave/hc/tasks/${TASK}/administration-decision`,
        headers: { cookie: "hcis_session=test-token" },
        payload: { action: "not_validated", note: "Tidak berlaku untuk planned leave" },
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "HC_TASK_NOT_FOUND" });
    expect(domainMutationSql(query)).toEqual([]);
  });

  it("rejects a planned task in the legacy special decision route before domain mutation", async () => {
    const { pool, query } = createHcTaskPool({ policyKey: "employee_marriage" });
    const response = await withSpecialRoutes(pool, (app) =>
      app.inject({
        method: "POST",
        url: `/leave/hc/tasks/${TASK}/decision`,
        headers: { cookie: "hcis_session=test-token" },
        payload: { action: "request_correction", note: "Wrong workflow" },
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "HC_TASK_NOT_FOUND" });
    expect(domainMutationSql(query)).toEqual([]);
  });

  it("does not expose planned evidence through the legacy special HC evidence route", async () => {
    const { pool } = createHcTaskPool({ policyKey: "employee_marriage" });
    const response = await withSpecialRoutes(pool, (app) =>
      app.inject({
        method: "GET",
        url: `/leave/hc/requests/${REQUEST}/evidence/${EVIDENCE}`,
        headers: { cookie: "hcis_session=test-token" },
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
  });

  it("keeps legitimate Special Leave available to the administration workflow", async () => {
    const queuePool = createHcTaskPool({ policyKey: "sick" });
    const queueResponse = await withAttendanceRoutes(queuePool.pool, (app) =>
      app.inject({
        method: "GET",
        url: "/leave/hc/administration-queue",
        headers: { cookie: "hcis_session=test-token" },
      }),
    );
    expect(queueResponse.statusCode).toBe(200);
    expect(queueResponse.json().items).toHaveLength(1);
    expect(queueResponse.json().items[0]).toMatchObject({
      taskId: TASK,
      policyKey: "sick",
    });

    const decisionPool = createHcTaskPool({ policyKey: "sick" });
    const decisionResponse = await withAttendanceRoutes(decisionPool.pool, (app) =>
      app.inject({
        method: "POST",
        url: `/leave/hc/tasks/${TASK}/administration-decision`,
        headers: { cookie: "hcis_session=test-token" },
        payload: { action: "validate_all" },
      }),
    );
    expect(decisionResponse.statusCode).toBe(200);
    expect(decisionResponse.json()).toMatchObject({
      requestStatus: "approved",
      taskStatus: "validated",
      resolutionCaseId: null,
    });
    const mutations = domainMutationSql(decisionPool.query);
    expect(mutations.some((sql) => sql.includes("UPDATE leave_request_hc_tasks"))).toBe(true);
    expect(mutations.some((sql) => sql.includes("UPDATE leave_requests"))).toBe(true);
    expect(mutations.some((sql) => sql.includes("INSERT INTO leave_request_validation_days"))).toBe(true);
    expect(mutations.some((sql) => sql.includes("INSERT INTO attendance_resolution_cases"))).toBe(false);
  });

  it("keeps the planned validation task available through the planned-specific HC queue", async () => {
    const { pool, query } = createHcTaskPool({ policyKey: "employee_marriage" });
    const response = await withPlannedRoutes(pool, (app) =>
      app.inject({
        method: "GET",
        url: "/leave/planned/hc/validation-queue",
        headers: { cookie: "hcis_session=test-token" },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0]).toMatchObject({
      taskId: TASK,
      policyKey: "employee_marriage",
    });
    const queueCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("request.validation_summary AS \"validationSummary\""),
    );
    expect(queueCall?.[1]).toEqual(["validate", [...SUPPORTED_PLANNED_LEAVE_KEYS]]);
  });

  it("keeps unpaid approve tasks isolated to the planned actual HC approval flow", async () => {
    const legacyPool = createHcTaskPool({ policyKey: "unpaid", taskKind: "approve" });
    const legacyResponse = await withSpecialRoutes(legacyPool.pool, (app) =>
      app.inject({
        method: "POST",
        url: `/leave/hc/tasks/${TASK}/decision`,
        headers: { cookie: "hcis_session=test-token" },
        payload: { action: "validate" },
      }),
    );
    expect(legacyResponse.statusCode).toBe(404);
    expect(legacyResponse.json()).toMatchObject({ code: "HC_TASK_NOT_FOUND" });
    expect(domainMutationSql(legacyPool.query)).toEqual([]);

    const approvalPool = createHcTaskPool({ policyKey: "unpaid", taskKind: "approve" });
    const approvalResponse = await withPlannedRoutes(approvalPool.pool, (app) =>
      app.inject({
        method: "POST",
        url: `/leave/planned/hc/tasks/${TASK}/approval-decision`,
        headers: { cookie: "hcis_session=test-token" },
        payload: { decision: "approve" },
      }),
    );
    expect(approvalResponse.statusCode).toBe(200);
    expect(approvalResponse.json()).toMatchObject({
      requestStatus: "approved",
      taskStatus: "approved",
    });
  });
});
