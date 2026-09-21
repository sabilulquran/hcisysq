import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { registerNotificationRoutes } from "../src/modules/notifications/routes.js";
import { notifyAccount } from "../src/modules/notifications/service.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

describe.skipIf(!allowed)("NOTIF-004 recipient-owned notifications", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let primaryAccountId: string;
  let otherAccountId: string;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    primaryAccountId = randomUUID();
    otherAccountId = randomUUID();
    const primaryEmployee = randomUUID();
    const otherEmployee = randomUUID();
    await client.query(
      "INSERT INTO employees(id,employee_number,full_name,status) VALUES ($1,$2,'Notification Primary','active'), ($3,$4,'Notification Other','active')",
      [primaryEmployee, "NOTIF-" + primaryEmployee, otherEmployee, "NOTIF-" + otherEmployee],
    );
    await client.query(
      "INSERT INTO accounts(id,employee_id,email,principal_type,status) VALUES ($1,$2,$3,'EMPLOYEE','active'), ($4,$5,$6,'EMPLOYEE','active')",
      [
        primaryAccountId, primaryEmployee, "notif-" + primaryAccountId + "@example.invalid",
        otherAccountId, otherEmployee, "notif-" + otherAccountId + "@example.invalid",
      ],
    );

    const transactionPool = {
      query: (text: string, values?: unknown[]) => client.query(text, values),
    } as unknown as Pool;
    const config = {
      NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    app = Fastify({ logger: false });
    await registerNotificationRoutes(app, transactionPool, config, {
      getSession: async () => ({
        principal: { id: primaryAccountId, email: "primary@example.invalid", principalType: "EMPLOYEE" as const },
        expiresAt: new Date("2099-01-01T00:00:00Z"),
      }),
    });
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  it("deduplicates stable event keys and never lists another account notification", async () => {
    await notifyAccount(client, {
      recipientAccountId: primaryAccountId, eventKey: "synthetic:one", category: "system",
      title: "Primary", body: "Primary notification", href: "/app/notifications",
    });
    await notifyAccount(client, {
      recipientAccountId: primaryAccountId, eventKey: "synthetic:one", category: "system",
      title: "Duplicate", body: "Should not duplicate", href: "/app/notifications",
    });
    await notifyAccount(client, {
      recipientAccountId: otherAccountId, eventKey: "synthetic:other", category: "system",
      title: "Other", body: "Other account", href: "/app/notifications",
    });

    const response = await app.inject({ method: "GET", url: "/notifications/me?state=all" });
    expect(response.statusCode, response.body).toBe(200);
    const payload = response.json();
    expect(payload.unreadCount).toBe(1);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].title).toBe("Primary");
  });

  it("cannot mark another account notification as read", async () => {
    const otherId = randomUUID();
    await client.query(
      "INSERT INTO in_app_notifications(id,recipient_account_id,event_key,category,title,body) VALUES($1,$2,'synthetic:other:read','system','Other','Other')",
      [otherId, otherAccountId],
    );
    const response = await app.inject({ method: "POST", url: "/notifications/" + otherId + "/read" });
    expect(response.statusCode, response.body).toBe(404);
    const row = await client.query<{ readAt: Date | null }>(
      'SELECT read_at AS "readAt" FROM in_app_notifications WHERE id=$1',
      [otherId],
    );
    expect(row.rows[0]?.readAt).toBeNull();
  });

  it("marks own notification and all remaining own notifications without touching other recipients", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const other = randomUUID();
    await client.query(
      "INSERT INTO in_app_notifications(id,recipient_account_id,event_key,category,title,body) VALUES ($1,$2,'synthetic:first','system','First','First'), ($3,$2,'synthetic:second','system','Second','Second'), ($4,$5,'synthetic:other','system','Other','Other')",
      [first, primaryAccountId, second, other, otherAccountId],
    );
    const one = await app.inject({ method: "POST", url: "/notifications/" + first + "/read" });
    expect(one.statusCode, one.body).toBe(200);
    const all = await app.inject({ method: "POST", url: "/notifications/read-all" });
    expect(all.statusCode, all.body).toBe(200);
    expect(all.json().updated).toBe(1);
    const rows = await client.query<{ recipientAccountId: string; readAt: Date | null }>(
      'SELECT recipient_account_id AS "recipientAccountId", read_at AS "readAt" FROM in_app_notifications WHERE id = ANY($1::uuid[]) ORDER BY recipient_account_id',
      [[first, second, other]],
    );
    expect(rows.rows.filter((row) => row.recipientAccountId === primaryAccountId).every((row) => row.readAt)).toBe(true);
    expect(rows.rows.find((row) => row.recipientAccountId === otherAccountId)?.readAt).toBeNull();
  });

  it("grants only standard non-destructive ADMS permissions to Human Capital Admin", async () => {
    const result = await client.query<{ permissionKey: string }>(
      "SELECT role_permission.permission_key AS \"permissionKey\" FROM role_permissions role_permission JOIN roles role ON role.id = role_permission.role_id WHERE role.role_key = 'human_capital_admin' AND role_permission.permission_key LIKE 'attendance.devices.%' ORDER BY role_permission.permission_key",
    );
    expect(result.rows.map((row) => row.permissionKey)).toEqual([
      "attendance.devices.configure",
      "attendance.devices.export",
      "attendance.devices.operate",
      "attendance.devices.read",
    ]);
  });
});
