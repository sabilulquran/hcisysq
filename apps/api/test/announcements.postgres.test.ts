// NOTIF-002 Package 1 acceptance against a real schema.
// Synthetic employees only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { registerAnnouncementRoutes } from "../src/modules/announcements/routes.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The routes own their transactions; map them onto savepoints of the outer one. */
function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase();
    if (statement.startsWith("BEGIN")) return client.query(`SAVEPOINT test_sp_${++depth}`);
    if (statement.startsWith("COMMIT")) {
      const name = `test_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement.startsWith("ROLLBACK")) {
      const name = `test_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

describe.skipIf(!allowed)("NOTIF-002 announcements", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let unitA: string;
  let unitB: string;
  let employeeA: string;
  let employeeB: string;
  let accountA: string;
  let permissions: string[];
  let principal: AuthPrincipal;

  async function insertUnit(name: string) {
    const id = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1,$2,$3)",
      [id, `ann-${id}`, name],
    );
    return id;
  }

  async function insertEmployee(name: string, unitId: string | null) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, organizational_unit_id)
       VALUES ($1,$2,$3,'active',$4)`,
      [id, `ANN-${id.slice(0, 8)}`, name, unitId],
    );
    return id;
  }

  async function draft(payload: Record<string, unknown>) {
    const response = await app.inject({ method: "POST", url: "/admin/announcements", payload });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    unitA = await insertUnit("Unit Pengumuman A");
    unitB = await insertUnit("Unit Pengumuman B");
    employeeA = await insertEmployee("Pegawai Unit A", unitA);
    employeeB = await insertEmployee("Pegawai Unit B", unitB);
    accountA = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status)
       VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [accountA, employeeA, `ann-${accountA}@example.invalid`],
    );
    principal = { id: accountA, email: "ann@example.invalid", principalType: "EMPLOYEE" };
    permissions = ["announcements.read", "announcements.manage"];

    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    app = Fastify({ logger: false });
    await registerAnnouncementRoutes(app, savepointPool(client), config, {
      getSession: async () => ({ principal, expiresAt: "2099-01-01T00:00:00Z" }),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
    }
  });

  async function publish(id: string) {
    return app.inject({ method: "POST", url: `/admin/announcements/${id}/publish`, payload: {} });
  }

  it("NOTIF-002-A: a unit announcement reaches only that unit", async () => {
    const id = await draft({
      title: "Rapat unit A", body: "Rapat unit A diadakan pekan depan.",
      audiences: [{ kind: "UNIT", organizationalUnitId: unitA }],
    });
    const published = await publish(id);
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().reach).toBe(1);

    const recipients = await client.query<{ employeeId: string }>(
      `SELECT employee_id AS "employeeId" FROM announcement_recipients WHERE announcement_id = $1`,
      [id],
    );
    expect(recipients.rows.map((row) => row.employeeId)).toEqual([employeeA]);

    const mine = await app.inject({ method: "GET", url: "/announcements/me" });
    expect(mine.statusCode, mine.body).toBe(200);
    expect((mine.json().items as Array<{ id: string }>).map((item) => item.id)).toEqual([id]);

    // The employee of unit B is not a recipient, so the row simply does not exist for them.
    const otherRows = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM announcement_recipients
        WHERE announcement_id = $1 AND employee_id = $2`,
      [id, employeeB],
    );
    expect(otherRows.rows[0]?.total).toBe(0);
  });

  it("NOTIF-002-B: re-publishing duplicates neither recipients nor notifications", async () => {
    const id = await draft({
      title: "Pengumuman seluruh pegawai", body: "Isi pengumuman sintetis untuk pengujian.",
      audiences: [{ kind: "ALL_EMPLOYEES" }],
    });
    const first = await publish(id);
    expect(first.statusCode, first.body).toBe(200);
    const reach = first.json().reach as number;
    // ALL_EMPLOYEES covers whatever else lives in this database, so the counts are compared
    // against each other rather than against an absolute number.
    expect(reach).toBeGreaterThanOrEqual(2);

    const countRecipients = async () => (await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM announcement_recipients WHERE announcement_id = $1`,
      [id],
    )).rows[0]!.total;
    const countNotifications = async () => (await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM in_app_notifications WHERE event_key = $1`,
      [`announcement.${id}`],
    )).rows[0]!.total;

    const recipientsAfterFirst = await countRecipients();
    const notificationsAfterFirst = await countNotifications();
    expect(recipientsAfterFirst).toBe(reach);
    // Both synthetic employees are in the snapshot; only employee A has an account.
    const synthetic = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM announcement_recipients
        WHERE announcement_id = $1 AND employee_id = ANY($2::uuid[])`,
      [id, [employeeA, employeeB]],
    );
    expect(synthetic.rows[0]?.total).toBe(2);

    // The second attempt is refused; the first already took effect, and nothing is added.
    const second = await publish(id);
    expect(second.statusCode, second.body).toBe(409);
    expect(await countRecipients()).toBe(recipientsAfterFirst);
    expect(await countNotifications()).toBe(notificationsAfterFirst);
  });

  it("NOTIF-002-C: moving an employee afterwards does not change the frozen reach", async () => {
    const id = await draft({
      title: "Rapat unit A", body: "Rapat unit A diadakan pekan depan.",
      audiences: [{ kind: "UNIT", organizationalUnitId: unitA }],
    });
    expect((await publish(id)).statusCode).toBe(200);
    await client.query("UPDATE employees SET organizational_unit_id = $2 WHERE id = $1", [employeeA, unitB]);
    await client.query("UPDATE employees SET organizational_unit_id = $2 WHERE id = $1", [employeeB, unitA]);

    const rows = await client.query<{ employeeId: string }>(
      `SELECT employee_id AS "employeeId" FROM announcement_recipients WHERE announcement_id = $1`,
      [id],
    );
    expect(rows.rows.map((row) => row.employeeId)).toEqual([employeeA]);
    const mine = await app.inject({ method: "GET", url: "/announcements/me" });
    expect((mine.json().items as Array<{ id: string }>).map((item) => item.id)).toEqual([id]);
  });

  it("NOTIF-002-D: only a PENTING announcement asks for confirmation, and only the recipient can give it", async () => {
    const normal = await draft({
      title: "Pengumuman biasa", body: "Isi pengumuman sintetis untuk pengujian.",
      audiences: [{ kind: "ALL_EMPLOYEES" }],
    });
    expect((await publish(normal)).statusCode).toBe(200);
    const refused = await app.inject({ method: "POST", url: `/announcements/me/${normal}/acknowledge` });
    expect(refused.statusCode, refused.body).toBe(404);

    const important = await draft({
      title: "Pengumuman penting", body: "Isi pengumuman penting sintetis.",
      level: "PENTING", audiences: [{ kind: "ALL_EMPLOYEES" }],
    });
    expect((await publish(important)).statusCode).toBe(200);
    const accepted = await app.inject({ method: "POST", url: `/announcements/me/${important}/acknowledge` });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().acknowledgedAt).toBeTruthy();

    // Employee B's own row is untouched: the update is filtered by the session's employee.
    const other = await client.query<{ acknowledgedAt: Date | null }>(
      `SELECT acknowledged_at AS "acknowledgedAt" FROM announcement_recipients
        WHERE announcement_id = $1 AND employee_id = $2`,
      [important, employeeB],
    );
    expect(other.rows[0]?.acknowledgedAt).toBeNull();

    // From employee B own session the update lands on B row, never on A row.
    const accountB = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status)
       VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [accountB, employeeB, `ann-${accountB}@example.invalid`],
    );
    principal = { id: accountB, email: "ann-b@example.invalid", principalType: "EMPLOYEE" };
    const asB = await app.inject({ method: "POST", url: `/announcements/me/${important}/acknowledge` });
    expect(asB.statusCode, asB.body).toBe(200);
    const rows = await client.query<{ acknowledgedAt: Date | null }>(
      `SELECT acknowledged_at AS "acknowledgedAt"
         FROM announcement_recipients WHERE announcement_id = $1 ORDER BY employee_id`,
      [important],
    );
    expect(rows.rows.every((row) => row.acknowledgedAt)).toBe(true);
  });

  it("NOTIF-002-E: a published announcement cannot be edited; a correction supersedes it", async () => {
    const id = await draft({
      title: "Pengumuman awal", body: "Isi pengumuman sintetis untuk pengujian.",
      audiences: [{ kind: "ALL_EMPLOYEES" }],
    });
    expect((await publish(id)).statusCode).toBe(200);
    const edit = await app.inject({
      method: "PUT",
      url: `/admin/announcements/${id}`,
      payload: { title: "Pengumuman diubah", body: "Isi yang diubah diam-diam.", audiences: [{ kind: "ALL_EMPLOYEES" }] },
    });
    expect(edit.statusCode, edit.body).toBe(409);

    const correction = await app.inject({
      method: "POST",
      url: `/admin/announcements/${id}/correction`,
      payload: {
        title: "Pengumuman ralat", body: "Isi ralat sintetis untuk pengujian.",
        audiences: [{ kind: "ALL_EMPLOYEES" }], reason: "Tanggal rapat salah tulis",
      },
    });
    expect(correction.statusCode, correction.body).toBe(201);
    const old = await client.query<{ status: string }>("SELECT status FROM announcements WHERE id = $1", [id]);
    expect(old.rows[0]?.status).toBe("SUPERSEDED");
  });

  it("NOTIF-002-F: an unpublished announcement reaches nobody", async () => {
    // N-07 (revised): a planned time is recorded, but publication stays an explicit act, so
    // until it happens there are no recipient rows at all and nothing can leak.
    const scheduled = await draft({
      title: "Pengumuman terjadwal", body: "Isi pengumuman sintetis untuk pengujian.",
      audiences: [{ kind: "ALL_EMPLOYEES" }], publishAt: "2099-01-01T00:00:00.000Z",
    });
    const stored = await client.query<{ status: string }>("SELECT status FROM announcements WHERE id = $1", [scheduled]);
    expect(stored.rows[0]?.status).toBe("SCHEDULED");

    const drafted = await draft({
      title: "Pengumuman draf", body: "Isi draf sintetis untuk pengujian.",
      audiences: [{ kind: "ALL_EMPLOYEES" }],
    });

    const rows = await client.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM announcement_recipients WHERE announcement_id = ANY($1::uuid[])",
      [[scheduled, drafted]],
    );
    expect(rows.rows[0]?.total).toBe(0);
    const mine = await app.inject({ method: "GET", url: "/announcements/me" });
    expect(mine.json().items).toHaveLength(0);
  });

  it("NOTIF-002-G: the body is stored and returned as text, never as markup", async () => {
    const body = "Baris satu.\n\n<script>alert(1)</script>";
    const id = await draft({ title: "Pengumuman teks", body, audiences: [{ kind: "ALL_EMPLOYEES" }] });
    expect((await publish(id)).statusCode).toBe(200);
    const mine = await app.inject({ method: "GET", url: "/announcements/me" });
    const item = (mine.json().items as Array<{ body: string }>)[0]!;
    expect(item.body).toBe(body);
  });

  it("NOTIF-002-H: the display window archives without a scheduled job", async () => {
    const id = await draft({
      title: "Pengumuman kedaluwarsa", body: "Isi pengumuman sintetis untuk pengujian.",
      audiences: [{ kind: "ALL_EMPLOYEES" }], displayUntil: "2020-01-06",
    });
    expect((await publish(id)).statusCode).toBe(200);
    const mine = await app.inject({ method: "GET", url: "/announcements/me" });
    expect((mine.json().items as Array<{ visibility: string }>)[0]!.visibility).toBe("ARCHIVED");
  });

  it("NOTIF-002-I: a published correction reaches exactly the original recipients", async () => {
    const original = await draft({
      title: "Rapat unit A", body: "Rapat unit A diadakan pekan depan.",
      audiences: [{ kind: "UNIT", organizationalUnitId: unitA }],
    });
    expect((await publish(original)).statusCode).toBe(200);

    const correction = await app.inject({
      method: "POST",
      url: `/admin/announcements/${original}/correction`,
      payload: {
        title: "Ralat rapat unit A", body: "Tanggal rapat berubah.",
        audiences: [{ kind: "ALL_EMPLOYEES" }], reason: "Tanggal rapat salah tulis",
      },
    });
    expect(correction.statusCode, correction.body).toBe(201);
    const correctionId = correction.json().id as string;

    // N-06: the original stays published while the correction is still a draft.
    const beforePublish = await client.query<{ status: string }>(
      "SELECT status FROM announcements WHERE id = $1", [original],
    );
    expect(beforePublish.rows[0]?.status).toBe("PUBLISHED");

    expect((await publish(correctionId)).statusCode).toBe(200);
    const afterPublish = await client.query<{ status: string }>(
      "SELECT status FROM announcements WHERE id = $1", [original],
    );
    expect(afterPublish.rows[0]?.status).toBe("SUPERSEDED");

    // A wider audience on the correction must not widen who receives it.
    const recipients = await client.query<{ employeeId: string }>(
      `SELECT employee_id AS "employeeId" FROM announcement_recipients WHERE announcement_id = $1`,
      [correctionId],
    );
    expect(recipients.rows.map((row) => row.employeeId)).toEqual([employeeA]);
  });

  it("NOTIF-002-J: a passed schedule publishes nothing on its own", async () => {
    const id = await draft({
      title: "Pengumuman jatuh tempo", body: "Isi pengumuman sintetis untuk pengujian.",
      audiences: [{ kind: "ALL_EMPLOYEES" }], publishAt: "2020-01-06T00:00:00.000Z",
    });
    const listed = await app.inject({ method: "GET", url: "/admin/announcements" });
    const row = (listed.json().items as Array<{ id: string; visibility: string; reach: number }>)
      .find((item) => item.id === id);
    expect(row?.visibility).toBe("DUE");
    expect(row?.reach).toBe(0);

    const notifications = await client.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM in_app_notifications WHERE event_key = $1",
      [`announcement.${id}`],
    );
    expect(notifications.rows[0]?.total).toBe(0);
    const mine = await app.inject({ method: "GET", url: "/announcements/me" });
    expect(mine.json().items).toHaveLength(0);
  });

  it("rejects an audience naming a unit that does not exist", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/admin/announcements",
      payload: {
        title: "Pengumuman unit hantu", body: "Isi pengumuman sintetis untuk pengujian.",
        audiences: [{ kind: "UNIT", organizationalUnitId: randomUUID() }],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("ANNOUNCEMENT_UNIT_NOT_FOUND");
  });

  it("refuses every admin route without announcements.*", async () => {
    const id = await draft({
      title: "Pengumuman penjaga izin", body: "Isi pengumuman sintetis untuk pengujian.",
      audiences: [{ kind: "ALL_EMPLOYEES" }],
    });
    permissions = [];
    for (const [method, url] of [
      ["GET", "/admin/announcements"],
      ["GET", `/admin/announcements/${id}`],
      ["POST", "/admin/announcements"],
      ["PUT", `/admin/announcements/${id}`],
      ["POST", `/admin/announcements/${id}/publish`],
      ["POST", `/admin/announcements/${id}/correction`],
      ["POST", `/admin/announcements/${id}/archive`],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("grants announcements.read and announcements.manage to Human Capital Admin only", async () => {
    const rows = await client.query<{ roleKey: string; permissionKey: string }>(
      `SELECT role.role_key AS "roleKey", role_permission.permission_key AS "permissionKey"
         FROM role_permissions role_permission
         JOIN roles role ON role.id = role_permission.role_id
        WHERE role_permission.permission_key LIKE 'announcements.%'
        ORDER BY role.role_key, role_permission.permission_key`,
    );
    expect(rows.rows.map((row) => `${row.roleKey}:${row.permissionKey}`)).toEqual([
      "human_capital_admin:announcements.manage",
      "human_capital_admin:announcements.read",
    ]);
  });
});
