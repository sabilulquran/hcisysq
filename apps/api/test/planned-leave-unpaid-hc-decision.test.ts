// LEAVE-010-F pada Cuti Tanpa Gaji: keputusan akhirnya diambil Human Capital di antrean
// persetujuan, bukan di rute validasi, jadi di sanalah pemohon harus diberi tahu.
//
// Ditemukan review independen PR #412: panggilan `notifyRequesterDecision` semula hanya dipasang
// pada rute validasi, sehingga satu-satunya kebijakan yang keputusan akhirnya memang milik HC —
// Cuti Tanpa Gaji — justru tetap diam, baik ketika disetujui maupun ketika ditolak. Itu persis
// keadaan yang LEAVE-010-F dibuat untuk memperbaiki.
//
// Bentuk ujinya mengikuti `planned-leave-validation.test.ts`: route sungguhan di atas pool palsu
// yang menolak SQL tak terduga, sehingga uji ini juga menjaga agar jalur ini tidak diam-diam
// menambah kueri baru.

import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { registerPlannedLeaveRoutes } from "../src/modules/leave/planned-leave-routes.js";

const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://planned-unpaid-hc-test",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

const REQUEST = "00000000-0000-4000-8000-000000000200";
const TASK = "00000000-0000-4000-8000-000000000210";
const EMPLOYEE = "00000000-0000-4000-8000-000000000020";
const ACCOUNT = "00000000-0000-4000-8000-000000000002";

function createPool() {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: null };
    if (sql.includes("FROM auth_sessions s")) {
      return {
        rows: [{
          sessionId: "00000000-0000-4000-8000-000000000001",
          accountId: ACCOUNT,
          email: "hc@example.org",
          principalType: "EMPLOYEE",
          expiresAt: new Date("2027-01-01T12:00:00.000Z"),
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE auth_sessions SET last_seen_at")) return { rows: [], rowCount: 1 };
    // `leave.validate` dan `leave.hc.approve`: mandat actual approval Human Capital.
    if (sql.includes("JOIN role_permissions role_permission")) return { rows: [{ allowed: true }], rowCount: 1 };
    if (sql.includes("FROM leave_request_hc_tasks task") && sql.includes("task.task_kind = 'approve'")) {
      return {
        rows: [{
          taskId: TASK,
          requestId: REQUEST,
          requesterEmployeeId: EMPLOYEE,
          taskStatus: "pending",
          requestStatus: "in_review",
          policyKey: "unpaid",
        }],
        rowCount: 1,
      };
    }
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
    if (sql.includes("FROM accounts account")) return { rows: [{ accountId: ACCOUNT }], rowCount: 1 };
    if (
      sql.includes("UPDATE leave_request_hc_tasks") ||
      sql.includes("UPDATE leave_requests") ||
      sql.includes("INSERT INTO leave_request_events") ||
      sql.includes("INSERT INTO in_app_notifications") ||
      sql.includes("INSERT INTO leave_notification_outbox")
    ) {
      return { rows: [], rowCount: 1 };
    }
    // Pemberitahuan pengawasan ORG-004 berjalan di savepoint sendiri dan boleh tidak menemukan apa pun.
    if (sql.includes("SAVEPOINT") || sql.includes("organization_")) return { rows: [], rowCount: 0 };
    throw new Error(`Unexpected SQL in unpaid HC decision test: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  return { statements, pool: { query, connect: vi.fn(async () => client) } as unknown as Pool };
}

async function decide(decision: "approve" | "reject") {
  const { pool, statements } = createPool();
  const app = Fastify({ logger: false });
  await registerPlannedLeaveRoutes(app, pool, config);
  const response = await app.inject({
    method: "POST",
    url: `/leave/planned/hc/tasks/${TASK}/approval-decision`,
    headers: { cookie: "hcis_session=test-token" },
    payload: { decision, note: decision === "reject" ? "Beban unit sedang tinggi" : null },
  });
  await app.close();
  const notifications = statements.filter((statement) =>
    statement.sql.includes("INSERT INTO in_app_notifications"));
  return { response, notifications };
}

describe("LEAVE-010-F pada keputusan Human Capital untuk Cuti Tanpa Gaji", () => {
  it("disetujui: pemohon menerima tepat satu notifikasi keputusan", async () => {
    const { response, notifications } = await decide("approve");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ requestId: REQUEST, requestStatus: "approved" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.values).toContain(`leave.request.decided.${REQUEST}`);
    expect(notifications[0]!.values).toContain("Pengajuan cuti Anda disetujui");
  });

  it("ditolak: pemohon tetap menerima tepat satu notifikasi, tanpa catatan penolakannya", async () => {
    const { response, notifications } = await decide("reject");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ requestId: REQUEST, requestStatus: "rejected" });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.values).toContain(`leave.request.decided.${REQUEST}`);
    expect(notifications[0]!.values).toContain("Pengajuan cuti Anda ditolak");
    expect(JSON.stringify(notifications[0]!.values)).not.toContain("Beban unit sedang tinggi");
  });
});
