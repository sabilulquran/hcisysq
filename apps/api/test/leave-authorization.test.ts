import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://leave-auth-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const E = "00000000-0000-4000-8000-000000000010";
const M = "00000000-0000-4000-8000-000000000020";
const U = "00000000-0000-4000-8000-000000000030";
const X = "00000000-0000-4000-8000-000000000040";
const H = "00000000-0000-4000-8000-000000000050";
const REQUEST = "00000000-0000-4000-8000-000000000100";
const DM_STEP = "00000000-0000-4000-8000-000000000110";
const UNIT_STEP = "00000000-0000-4000-8000-000000000120";
const HC_TASK = "00000000-0000-4000-8000-000000000130";
const ACTOR_ACCOUNT = "00000000-0000-4000-8000-000000000002";
const OTHER_BOARD_ACCOUNT = "00000000-0000-4000-8000-000000000003";

type HcHandling = "notify" | "validate" | "approve" | "none";

function authRows(
  principalType: "EMPLOYEE" | "SUPER_ADMIN" | "FOUNDATION_BOARD" = "EMPLOYEE",
) {
  return {
    rows: [
      {
        sessionId: "00000000-0000-4000-8000-000000000001",
        accountId: ACTOR_ACCOUNT,
        email: "actor@example.org",
        principalType,
        expiresAt: new Date("2026-08-22T12:00:00.000Z"),
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
    startedOn: "2024-01-01",
    leaveEntitlementGroup: "non_education",
    unitId: "00000000-0000-4000-8000-000000000200",
    unitName: "Unit Test",
    positionName: "Posisi Test",
    directManagerEmployeeId: M,
    unitApproverEmployeeId: U,
  };
}

function createDecisionPool(input: {
  actorEmployeeId?: string;
  requestedStepId: string;
  stepApproverEmployeeId: string | null;
  stepApproverAccountId?: string | null;
  stepStatus: "waiting" | "pending" | "approved" | "rejected";
  principalType?: "EMPLOYEE" | "SUPER_ADMIN" | "FOUNDATION_BOARD";
  governanceAllowed?: boolean;
  hcHandling?: HcHandling;
  steps?: Array<{
    id: string;
    order: number;
    status: "waiting" | "pending" | "approved" | "rejected";
  }>;
}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: null };
    }
    if (sql.includes("FROM auth_sessions s")) {
      return authRows(input.principalType ?? "EMPLOYEE");
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM accounts a") && sql.includes("JOIN employees e")) {
      return { rows: [employeeRow(input.actorEmployeeId ?? M)], rowCount: 1 };
    }
    if (sql.includes("FROM leave_request_approval_steps s") && sql.includes("FOR UPDATE OF s, r")) {
      expect(values?.[0]).toBe(input.requestedStepId);
      return {
        rows: [
          {
            id: input.requestedStepId,
            requestId: REQUEST,
            requesterEmployeeId: E,
            approverEmployeeId: input.stepApproverEmployeeId,
            approverAccountId: input.stepApproverAccountId ?? null,
            status: input.stepStatus,
            requestStatus: "in_review",
            hcHandling: input.hcHandling ?? "notify",
            policyKey: "annual",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("leave.governance.approve") && sql.includes("account_role_assignments")) {
      return { rows: [{ allowed: input.governanceAllowed ?? false }], rowCount: 1 };
    }
    if (sql.includes("FROM leave_request_approval_steps") && sql.includes("ORDER BY step_order ASC")) {
      return {
        rows:
          input.steps ?? [
            { id: DM_STEP, order: 1, status: "pending" },
            { id: UNIT_STEP, order: 2, status: "waiting" },
          ],
        rowCount: input.steps?.length ?? 2,
      };
    }
    if (sql.includes("UPDATE leave_request_approval_steps") && sql.includes("SET status = $2")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("UPDATE leave_request_approval_steps") && sql.includes("SET status = 'pending'")) {
      return { rows: [{ approverEmployeeId: U, approverAccountId: null }], rowCount: 1 };
    }
    if (sql.includes("UPDATE leave_request_hc_tasks") && sql.includes("status = 'pending'")) {
      expect(values?.[0]).toBe(REQUEST);
      return { rows: [{ id: HC_TASK }], rowCount: 1 };
    }
    if (sql.includes("UPDATE leave_requests") || sql.includes("INSERT INTO leave_request_events")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO leave_notification_outbox")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in leave authorization test: ${sql}`);
  });

  const client = { query, release: vi.fn() };
  const pool = {
    query,
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, query };
}

async function decide(pool: Pool, stepId: string) {
  const app = Fastify({ logger: false });
  await registerEmployeeLeaveRoutes(app, pool, config);
  const response = await app.inject({
    method: "POST",
    url: `/leave/approvals/${stepId}/decision`,
    headers: { cookie: "hcis_session=test-token" },
    payload: { decision: "approve" },
  });
  await app.close();
  return response;
}

function createReadIsolationPool(actorEmployeeId: string) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM auth_sessions s")) return authRows("EMPLOYEE");
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("FROM accounts a") && sql.includes("JOIN employees e")) {
      return { rows: [employeeRow(actorEmployeeId)], rowCount: 1 };
    }
    if (sql.includes("FROM leave_requests r") && sql.includes("WHERE r.employee_id = $1")) {
      expect(values?.[0]).toBe(actorEmployeeId);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM leave_request_approval_steps s") && sql.includes("WHERE s.approver_employee_id = $1")) {
      expect(values?.[0]).toBe(actorEmployeeId);
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected SQL in leave read-isolation test: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

describe("leave employee read isolation", () => {
  it("self request list is always scoped to the authenticated employee", async () => {
    const { pool, query } = createReadIsolationPool(E);
    const app = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(app, pool, config);
    const response = await app.inject({
      method: "GET",
      url: "/leave/me/requests",
      headers: { cookie: "hcis_session=test-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ requests: [] });
    expect(
      query.mock.calls.some(
        ([sql, values]) =>
          String(sql).includes("WHERE r.employee_id = $1") && values?.[0] === E,
      ),
    ).toBe(true);
    await app.close();
  });

  it("approval inbox is always scoped to the authenticated approver", async () => {
    const { pool, query } = createReadIsolationPool(M);
    const app = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(app, pool, config);
    const response = await app.inject({
      method: "GET",
      url: "/leave/approvals",
      headers: { cookie: "hcis_session=test-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
    expect(
      query.mock.calls.some(
        ([sql, values]) =>
          String(sql).includes("s.approver_employee_id = $1 OR s.approver_account_id = $2")
          && values?.[0] === M
          && values?.[1] === null,
      ),
    ).toBe(true);
    await app.close();
  });
});

describe("leave approval multi-account authorization", () => {
  it("allows M to approve only M's active Direct Manager step", async () => {
    const { pool } = createDecisionPool({
      actorEmployeeId: M,
      requestedStepId: DM_STEP,
      stepApproverEmployeeId: M,
      stepStatus: "pending",
    });
    const response = await decide(pool, DM_STEP);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestStatus: "in_review",
      stepStatus: "approved",
      nextPendingStepId: UNIT_STEP,
    });
  });

  it("allows U to approve U's step only after the Direct Manager step is approved", async () => {
    const { pool } = createDecisionPool({
      actorEmployeeId: U,
      requestedStepId: UNIT_STEP,
      stepApproverEmployeeId: U,
      stepStatus: "pending",
      steps: [
        { id: DM_STEP, order: 1, status: "approved" },
        { id: UNIT_STEP, order: 2, status: "pending" },
      ],
    });
    const response = await decide(pool, UNIT_STEP);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestStatus: "approved",
      stepStatus: "approved",
      nextPendingStepId: null,
      hcHandling: "notify",
      hcTaskStatus: null,
    });
  });

  it("moves final line approval to HC validation instead of final approval", async () => {
    const { pool } = createDecisionPool({
      actorEmployeeId: U,
      requestedStepId: UNIT_STEP,
      stepApproverEmployeeId: U,
      stepStatus: "pending",
      hcHandling: "validate",
      steps: [
        { id: DM_STEP, order: 1, status: "approved" },
        { id: UNIT_STEP, order: 2, status: "pending" },
      ],
    });
    const response = await decide(pool, UNIT_STEP);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestStatus: "in_review",
      stepStatus: "approved",
      hcHandling: "validate",
      hcTaskStatus: "pending",
    });
  });

  it("moves final organizational approval to HC actual approval for unpaid leave", async () => {
    const { pool } = createDecisionPool({
      actorEmployeeId: U,
      requestedStepId: UNIT_STEP,
      stepApproverEmployeeId: U,
      stepStatus: "pending",
      hcHandling: "approve",
      steps: [{ id: UNIT_STEP, order: 1, status: "pending" }],
    });
    const response = await decide(pool, UNIT_STEP);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestStatus: "in_review",
      stepStatus: "approved",
      hcHandling: "approve",
      hcTaskStatus: "pending",
    });
  });

  it("rejects unrelated employee X even when X knows the active step id", async () => {
    const { pool } = createDecisionPool({
      actorEmployeeId: X,
      requestedStepId: DM_STEP,
      stepApproverEmployeeId: M,
      stepStatus: "pending",
    });
    const response = await decide(pool, DM_STEP);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "APPROVAL_FORBIDDEN" });
  });

  it("rejects requester E from approving the requester's own active step", async () => {
    const { pool } = createDecisionPool({
      actorEmployeeId: E,
      requestedStepId: DM_STEP,
      stepApproverEmployeeId: M,
      stepStatus: "pending",
    });
    const response = await decide(pool, DM_STEP);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "APPROVAL_FORBIDDEN" });
  });

  it("does not let Human Capital H take a line-approval step just because H is privileged elsewhere", async () => {
    const { pool } = createDecisionPool({
      actorEmployeeId: H,
      requestedStepId: DM_STEP,
      stepApproverEmployeeId: M,
      stepStatus: "pending",
    });
    const response = await decide(pool, DM_STEP);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "APPROVAL_FORBIDDEN" });
  });

  it("allows the exact snapshotted Foundation Board account only with explicit governance capability", async () => {
    const { pool, query } = createDecisionPool({
      requestedStepId: UNIT_STEP,
      stepApproverEmployeeId: null,
      stepApproverAccountId: ACTOR_ACCOUNT,
      stepStatus: "pending",
      principalType: "FOUNDATION_BOARD",
      governanceAllowed: true,
      steps: [{ id: UNIT_STEP, order: 1, status: "pending" }],
    });
    const response = await decide(pool, UNIT_STEP);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestStatus: "approved",
      stepStatus: "approved",
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("leave.governance.approve"),
    )).toBe(true);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO account_role_assignments")
      || String(sql).includes("INSERT INTO role_permissions"),
    )).toBe(false);
  });

  it("rejects a snapshotted Foundation Board account without the explicit governance capability", async () => {
    const { pool } = createDecisionPool({
      requestedStepId: UNIT_STEP,
      stepApproverEmployeeId: null,
      stepApproverAccountId: ACTOR_ACCOUNT,
      stepStatus: "pending",
      principalType: "FOUNDATION_BOARD",
      governanceAllowed: false,
      steps: [{ id: UNIT_STEP, order: 1, status: "pending" }],
    });
    const response = await decide(pool, UNIT_STEP);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "APPROVAL_FORBIDDEN" });
  });

  it("rejects a different Foundation Board account even when it has governance capability", async () => {
    const { pool } = createDecisionPool({
      requestedStepId: UNIT_STEP,
      stepApproverEmployeeId: null,
      stepApproverAccountId: OTHER_BOARD_ACCOUNT,
      stepStatus: "pending",
      principalType: "FOUNDATION_BOARD",
      governanceAllowed: true,
      steps: [{ id: UNIT_STEP, order: 1, status: "pending" }],
    });
    const response = await decide(pool, UNIT_STEP);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "APPROVAL_FORBIDDEN" });
  });

  it("rejects SUPER_ADMIN from the employee approval endpoint", async () => {
    const { pool, query } = createDecisionPool({
      actorEmployeeId: M,
      requestedStepId: DM_STEP,
      stepApproverEmployeeId: M,
      stepStatus: "pending",
      principalType: "SUPER_ADMIN",
    });
    const response = await decide(pool, DM_STEP);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("FROM leave_request_approval_steps s")),
    ).toBe(false);
  });

  it("does not let direct manager M run the unit approver U step", async () => {
    const { pool } = createDecisionPool({
      actorEmployeeId: M,
      requestedStepId: UNIT_STEP,
      stepApproverEmployeeId: U,
      stepStatus: "waiting",
    });
    const response = await decide(pool, UNIT_STEP);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "APPROVAL_FORBIDDEN" });
  });

  it("does not let U decide the snapshotted unit step before it becomes active", async () => {
    const { pool } = createDecisionPool({
      actorEmployeeId: U,
      requestedStepId: UNIT_STEP,
      stepApproverEmployeeId: U,
      stepStatus: "waiting",
    });
    const response = await decide(pool, UNIT_STEP);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "STEP_NOT_PENDING" });
  });

  it("rejects a second decision after M's step has already been acted", async () => {
    const { pool } = createDecisionPool({
      actorEmployeeId: M,
      requestedStepId: DM_STEP,
      stepApproverEmployeeId: M,
      stepStatus: "approved",
      steps: [
        { id: DM_STEP, order: 1, status: "approved" },
        { id: UNIT_STEP, order: 2, status: "pending" },
      ],
    });
    const response = await decide(pool, DM_STEP);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "STEP_NOT_PENDING" });
  });
});
