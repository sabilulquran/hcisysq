import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { encryptSecret } from "../src/modules/auth/crypto.js";
import { registerPlannedLeaveRoutes } from "../src/modules/leave/planned-leave-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://planned-leave-auth-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const ACCOUNT = "00000000-0000-4000-8000-000000000002";
const E = "00000000-0000-4000-8000-000000000010";
const M = "00000000-0000-4000-8000-000000000020";
const U = "00000000-0000-4000-8000-000000000030";
const X = "00000000-0000-4000-8000-000000000040";
const H = "00000000-0000-4000-8000-000000000050";
const REQUEST = "00000000-0000-4000-8000-000000000100";
const TASK = "00000000-0000-4000-8000-000000000110";
const EVIDENCE = "00000000-0000-4000-8000-000000000120";

function sessionRows() {
  return {
    rows: [
      {
        sessionId: "00000000-0000-4000-8000-000000000001",
        accountId: ACCOUNT,
        email: "actor@example.org",
        principalType: "EMPLOYEE",
        expiresAt: new Date("2027-01-01T12:00:00.000Z"),
      },
    ],
    rowCount: 1,
  };
}

function employeeRow(id: string) {
  return {
    id,
    employeeNumber: `EMP-${id.slice(-2)}`,
    fullName: "Actor Test",
    status: "active",
    unitId: "00000000-0000-4000-8000-000000000200",
    unitName: "Unit Test",
    positionName: "Posisi Test",
    directManagerEmployeeId: M,
    unitApproverEmployeeId: U,
  };
}

function encryptedEvidence() {
  const encrypted = encryptSecret(
    Buffer.from("%PDF-private-evidence", "utf8").toString("base64"),
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
  };
}

function createEvidencePool(input: {
  actorEmployeeId: string;
  canValidate?: boolean;
  isHumanCapital?: boolean;
  canHcApprove?: boolean;
}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM auth_sessions s")) return sessionRows();
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM accounts account") && sql.includes("JOIN employees employee")) {
      return { rows: [employeeRow(input.actorEmployeeId)], rowCount: 1 };
    }
    if (sql.includes("JOIN role_permissions role_permission")) {
      const permission = values?.[1];
      return {
        rows: [
          {
            allowed:
              permission === "leave.validate"
                ? Boolean(input.canValidate)
                : permission === "leave.hc.approve"
                  ? Boolean(input.canHcApprove)
                  : false,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("JOIN roles role") && sql.includes("role.role_key = $2")) {
      return { rows: [{ allowed: Boolean(input.isHumanCapital) }], rowCount: 1 };
    }
    if (sql.includes("FROM leave_request_evidence evidence") && sql.includes("request.employee_id = $3")) {
      expect(values?.[2]).toBe(input.actorEmployeeId);
      return {
        rows: input.actorEmployeeId === E ? [encryptedEvidence()] : [],
        rowCount: input.actorEmployeeId === E ? 1 : 0,
      };
    }
    if (sql.includes("FROM leave_request_evidence evidence") && sql.includes("JOIN leave_request_hc_tasks task")) {
      const canReadValidation = values?.[3] === true;
      const canReadApproval = values?.[4] === true;
      return {
        rows: canReadValidation || canReadApproval ? [encryptedEvidence()] : [],
        rowCount: canReadValidation || canReadApproval ? 1 : 0,
      };
    }
    throw new Error(`Unexpected SQL in planned evidence test: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

async function getEvidence(pool: Pool, hc: boolean) {
  const app = Fastify({ logger: false });
  await registerPlannedLeaveRoutes(app, pool, config);
  const response = await app.inject({
    method: "GET",
    url: hc
      ? `/leave/planned/hc/requests/${REQUEST}/evidence/${EVIDENCE}`
      : `/leave/planned/me/requests/${REQUEST}/evidence/${EVIDENCE}`,
    headers: { cookie: "hcis_session=test-token" },
  });
  await app.close();
  return response;
}

describe("planned leave evidence privacy", () => {
  it("allows the owning employee to read encrypted planned-leave evidence", async () => {
    const { pool } = createEvidencePool({ actorEmployeeId: E });
    const response = await getEvidence(pool, false);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toContain("%PDF-private-evidence");
  });

  it("does not expose planned-leave evidence to unrelated employee X who knows requestId and evidenceId", async () => {
    const { pool } = createEvidencePool({ actorEmployeeId: X });
    const response = await getEvidence(pool, false);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
  });

  it("allows an HC validator to read evidence only for a validation task", async () => {
    const { pool } = createEvidencePool({
      actorEmployeeId: H,
      canValidate: true,
      isHumanCapital: true,
      canHcApprove: false,
    });
    const response = await getEvidence(pool, true);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("rejects a line approver from HC evidence access", async () => {
    const { pool, query } = createEvidencePool({ actorEmployeeId: M });
    const response = await getEvidence(pool, true);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "EVIDENCE_FORBIDDEN" });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("FROM leave_request_evidence evidence")),
    ).toBe(false);
  });
});

function createHcDecisionPool(input: {
  canValidate: boolean;
  isHumanCapital: boolean;
  canHcApprove: boolean;
  taskExists?: boolean;
}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: null };
    }
    if (sql.includes("FROM auth_sessions s")) return sessionRows();
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("JOIN role_permissions role_permission")) {
      const permission = values?.[1];
      return {
        rows: [
          {
            allowed:
              permission === "leave.validate"
                ? input.canValidate
                : permission === "leave.hc.approve"
                  ? input.canHcApprove
                  : false,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("JOIN roles role") && sql.includes("role.role_key = $2")) {
      return { rows: [{ allowed: input.isHumanCapital }], rowCount: 1 };
    }
    if (sql.includes("FROM leave_request_hc_tasks task") && sql.includes("task.task_kind = 'validate'")) {
      return {
        rows:
          input.taskExists === false
            ? []
            : [
                {
                  taskId: TASK,
                  requestId: REQUEST,
                  requesterEmployeeId: E,
                  taskStatus: "pending",
                  requestStatus: "in_review",
                  evidenceRequirement: "required",
                  policyKey: "employee_marriage",
                },
              ],
        rowCount: input.taskExists === false ? 0 : 1,
      };
    }
    if (sql.includes("FROM leave_request_hc_tasks task") && sql.includes("task.task_kind = 'approve'")) {
      return {
        rows: [
          {
            taskId: TASK,
            requestId: REQUEST,
            requesterEmployeeId: E,
            taskStatus: "pending",
            requestStatus: "in_review",
            policyKey: "unpaid",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT count(*)::int AS count") && sql.includes("leave_request_evidence")) {
      return { rows: [{ count: 1 }], rowCount: 1 };
    }
    if (
      sql.includes("UPDATE leave_request_hc_tasks") ||
      sql.includes("UPDATE leave_requests") ||
      sql.includes("INSERT INTO leave_request_events") ||
      sql.includes("INSERT INTO leave_notification_outbox")
    ) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in planned HC decision test: ${sql}`);
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

async function postHcDecision(
  pool: Pool,
  kind: "validation" | "approval",
) {
  const app = Fastify({ logger: false });
  await registerPlannedLeaveRoutes(app, pool, config);
  const response = await app.inject({
    method: "POST",
    url:
      kind === "validation"
        ? `/leave/planned/hc/tasks/${TASK}/validation-decision`
        : `/leave/planned/hc/tasks/${TASK}/approval-decision`,
    headers: { cookie: "hcis_session=test-token" },
    payload:
      kind === "validation"
        ? { action: "validate" }
        : { decision: "approve" },
  });
  await app.close();
  return response;
}

describe("planned leave HC semantic authorization", () => {
  it("rejects a line approver from HC validation", async () => {
    const { pool } = createHcDecisionPool({
      canValidate: false,
      isHumanCapital: false,
      canHcApprove: false,
    });
    const response = await postHcDecision(pool, "validation");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "HC_VALIDATION_FORBIDDEN" });
  });

  it("does not let a normal HC validator perform actual unpaid HC approval", async () => {
    const { pool } = createHcDecisionPool({
      canValidate: true,
      isHumanCapital: true,
      canHcApprove: false,
    });
    const response = await postHcDecision(pool, "approval");
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "HC_APPROVAL_FORBIDDEN" });
  });

  it("returns not-found when an authorized validator knows a non-existent taskId", async () => {
    const { pool } = createHcDecisionPool({
      canValidate: true,
      isHumanCapital: true,
      canHcApprove: false,
      taskExists: false,
    });
    const response = await postHcDecision(pool, "validation");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "HC_TASK_NOT_FOUND" });
  });

  it("allows an explicitly authorized HC actual approver to finalize unpaid leave", async () => {
    const { pool } = createHcDecisionPool({
      canValidate: true,
      isHumanCapital: true,
      canHcApprove: true,
    });
    const response = await postHcDecision(pool, "approval");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestStatus: "approved",
      taskStatus: "approved",
    });
  });
});

function createUnpaidPreviewPool() {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM auth_sessions s")) return sessionRows();
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM accounts account") && sql.includes("JOIN employees employee")) {
      return { rows: [employeeRow(E)], rowCount: 1 };
    }
    if (sql.includes("FROM leave_calendar_settings")) {
      return { rows: [{ workingWeekdayMask: 31 }], rowCount: 1 };
    }
    if (sql.includes("FROM leave_calendar_exceptions")) {
      return { rows: [], rowCount: 0 };
    }
    // LEAVE-009: unpaid leave only records a matching critical period; none here.
    if (sql.includes("FROM leave_critical_periods")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM organization_change_sets")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM organization_rollout_settings")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM employees employee") && sql.includes("employee.id = ANY")) {
      expect(values?.[0]).toEqual([U]);
      return {
        rows: [
          {
            id: U,
            fullName: "Kepala Satuan Kerja",
            status: "active",
            accountId: "00000000-0000-4000-8000-000000000300",
            accountStatus: "active",
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected SQL in unpaid preview test: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

describe("unpaid organizational approval routing", () => {
  it("uses Unit Approver only and does not insert the Direct Manager into unpaid approval", async () => {
    const { pool } = createUnpaidPreviewPool();
    const app = Fastify({ logger: false });
    await registerPlannedLeaveRoutes(app, pool, config);
    const response = await app.inject({
      method: "POST",
      url: "/leave/planned/me/preview",
      headers: { cookie: "hcis_session=test-token" },
      payload: {
        policyKey: "unpaid",
        startOn: "2027-01-11",
        endOn: "2027-01-13",
        hasEvidence: false,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().approvalChain).toEqual([
      {
        employeeId: U,
        name: "Kepala Satuan Kerja",
        sources: ["UNIT_APPROVER"],
      },
    ]);
    await app.close();
  });
});
