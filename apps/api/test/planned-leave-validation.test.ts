import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerPlannedLeaveRoutes } from "../src/modules/leave/planned-leave-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://planned-validation-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const REQUEST = "00000000-0000-4000-8000-000000000100";
const TASK = "00000000-0000-4000-8000-000000000110";
const EMPLOYEE = "00000000-0000-4000-8000-000000000010";

function createPool() {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: null };
    }
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [
          {
            sessionId: "00000000-0000-4000-8000-000000000001",
            accountId: "00000000-0000-4000-8000-000000000002",
            email: "hc@example.org",
            principalType: "EMPLOYEE",
            expiresAt: new Date("2027-01-01T12:00:00.000Z"),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("JOIN role_permissions role_permission")) {
      expect(values?.[1]).toBe("leave.validate");
      return { rows: [{ allowed: true }], rowCount: 1 };
    }
    if (sql.includes("FROM leave_request_hc_tasks task") && sql.includes("task.task_kind = 'validate'")) {
      expect(values?.[0]).toBe(TASK);
      return {
        rows: [
          {
            taskId: TASK,
            requestId: REQUEST,
            requesterEmployeeId: EMPLOYEE,
            taskStatus: "pending",
            requestStatus: "in_review",
            evidenceRequirement: "required",
            policyKey: "employee_marriage",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT count(*)::int AS count") && sql.includes("leave_request_evidence")) {
      return { rows: [{ count: 1 }], rowCount: 1 };
    }
    // LEAVE-010-F: HC validation is where a planned leave is finally decided, so it is also where
    // the requester is told. These three rows are that notification's reads and its write.
    if (sql.includes("FROM leave_requests request") && sql.includes("JOIN employees requester")) {
      return {
        rows: [{
          requesterName: "Pegawai Uji",
          policyKey: "employee_marriage",
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
    if (
      sql.includes("UPDATE leave_request_hc_tasks") ||
      sql.includes("UPDATE leave_requests") ||
      sql.includes("INSERT INTO leave_request_events") ||
      sql.includes("INSERT INTO in_app_notifications") ||
      sql.includes("INSERT INTO leave_notification_outbox")
    ) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in planned validation test: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  return {
    statements,
    pool: {
      query,
      connect: vi.fn(async () => client),
    } as unknown as Pool,
  };
}

describe("planned leave HC validation completion", () => {
  it("finalizes a planned leave only when HC validation succeeds", async () => {
    const { pool, statements } = createPool();
    const app = Fastify({ logger: false });
    await registerPlannedLeaveRoutes(app, pool, config);

    const response = await app.inject({
      method: "POST",
      url: `/leave/planned/hc/tasks/${TASK}/validation-decision`,
      headers: { cookie: "hcis_session=test-token" },
      payload: { action: "validate" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requestId: REQUEST,
      requestStatus: "approved",
      taskStatus: "validated",
    });

    // LEAVE-010-F: exactly one requester notification, keyed by the request so a replay adds none.
    const notifications = statements.filter((statement) =>
      statement.sql.includes("INSERT INTO in_app_notifications"));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.values).toContain(`leave.request.decided.${REQUEST}`);
    expect(notifications[0]!.values).toContain("Pengajuan cuti Anda disetujui");

    await app.close();
  });
});
