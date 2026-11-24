// LEAVE-010-F: pemohon diberi tahu keputusan akhir pengajuan cutinya, tepat satu kali.
//
// Audit kesiapan 2026-11-24 (skenario B27) menemukan bahwa pemohon tidak diberi tahu apa pun.
// Setiap penyetuju menerima notifikasi saat langkahnya aktif (LEAVE-010-A/B), sementara orang yang
// mengajukan cuti hanya menemukan hasilnya kalau ia membuka sendiri layar Cuti & Izin berulang
// kali. Niatnya sudah tertulis sejak awal di `annual-leave-vertical-slice.md` ("requester receives
// final approved/rejected intent") dan barisnya memang ditulis — ke `leave_notification_outbox`,
// yang tidak ada pembacanya. Jadi yang hilang bukan keputusannya, melainkan pengirimannya.
//
// "Tepat satu" dijaga oleh `event_key` yang membawa id pengajuan: indeks unik
// (recipient_account_id, event_key) membuat jalur mana pun yang terulang tidak menambah baris.
//
// Semua baris sintetis, satu transaksi per uji yang selalu di-ROLLBACK.

import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/service.js";
import { registerEmployeeLeaveRoutes } from "../src/modules/leave/employee-routes.js";
import { encodeWorkingWeekdays } from "../src/modules/leave/domain/working-calendar.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

function savepointPool(client: PoolClient): Pool {
  let depth = 0;
  const run = async (text: string, values?: unknown[]) => {
    const statement = String(text).trim().toUpperCase().replace(/;$/, "").trim();
    if (statement === "BEGIN") return client.query(`SAVEPOINT notify_sp_${++depth}`);
    if (statement === "COMMIT") {
      const name = `notify_sp_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement === "ROLLBACK") {
      const name = `notify_sp_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return client.query(text, values);
  };
  const handle = { query: run, release: () => {} };
  return { query: run, connect: async () => handle } as unknown as Pool;
}

const PEOPLE = ["guru", "kepala", "kabid"] as const;
type Person = (typeof PEOPLE)[number];
const NOW = new Date("2099-01-05T01:00:00.000Z");
const FIRST = { startOn: "2099-02-02", endOn: "2099-02-03" };
const SECOND = { startOn: "2099-05-04", endOn: "2099-05-05" };

describe.skipIf(!allowed)("LEAVE-010-F: pemohon diberi tahu keputusan akhir (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  const people = {} as Record<Person, { employeeId: string; accountId: string; cookie: string }>;

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  function call(who: Person, method: "GET" | "POST", url: string, payload?: object) {
    return app.inject({
      method, url, headers: { cookie: people[who].cookie }, ...(payload ? { payload } : {}),
    });
  }

  async function submitAnnual(dates: { startOn: string; endOn: string }) {
    const response = await call("guru", "POST", "/leave/me/annual/submit", {
      ...dates, reason: "Keperluan keluarga sintetis", idempotencyKey: randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(201);
    return (response.json() as { id: string }).id;
  }

  async function decideAll(requestId: string, decision: "approve" | "reject") {
    for (const who of ["kepala", "kabid"] as const) {
      const inbox = (await call(who, "GET", "/leave/approvals")).json() as {
        items: Array<{ stepId: string; requestId: string }>;
      };
      const step = inbox.items.find((item) => item.requestId === requestId);
      if (!step) continue;
      const response = await call(who, "POST", `/leave/approvals/${step.stepId}/decision`, {
        decision, note: decision === "reject" ? "Bertepatan dengan kegiatan unit" : undefined,
      });
      expect(response.statusCode, response.body).toBe(200);
      if (decision === "reject") break;
    }
  }

  /** Notifikasi dalam aplikasi milik seseorang, untuk keputusan akhir pengajuan ini. */
  async function decisionNotifications(who: Person, requestId: string) {
    const rows = await client.query<{ title: string; body: string; href: string; eventKey: string }>(
      `SELECT title, body, href, event_key AS "eventKey" FROM in_app_notifications
        WHERE recipient_account_id = $1 AND event_key = $2`,
      [people[who].accountId, `leave.request.decided.${requestId}`],
    );
    return rows.rows;
  }

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    client = await pool.connect();
    await client.query("BEGIN");
    const transactionPool = savepointPool(client);

    const unitId = randomUUID();
    await client.query(
      "INSERT INTO organizational_units(id, normalized_name, name) VALUES ($1,$2,'Unit Uji LEAVE-010-F')",
      [unitId, `leave010f-${unitId}`],
    );
    await client.query(
      `INSERT INTO leave_calendar_settings(singleton, timezone, working_weekday_mask)
       VALUES (true, 'Asia/Jakarta', $1)
       ON CONFLICT (singleton) DO UPDATE SET working_weekday_mask = EXCLUDED.working_weekday_mask`,
      [encodeWorkingWeekdays([1, 2, 3, 4, 5])],
    );
    await client.query(
      "DELETE FROM leave_calendar_exceptions WHERE calendar_date BETWEEN '2099-01-01' AND '2099-12-31'",
    );
    await client.query("DELETE FROM organization_rollout_settings");
    await client.query(
      "UPDATE leave_critical_periods SET is_active = false WHERE starts_on <= '2099-12-31' AND ends_on >= '2099-01-01'",
    );

    const config = {
      NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
    } as ApiConfig;
    const auth = new AuthService(transactionPool, config.AUTH_ENCRYPTION_KEY!, 8, false);
    for (const who of PEOPLE) {
      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees(id, employee_number, full_name, status, started_on,
                               organizational_unit_id, leave_entitlement_group, management_scope)
         VALUES ($1,$2,$3,'active','2020-01-06',$4,'non_education','MANAGED')`,
        [employeeId, `L010F-${employeeId.slice(0, 8)}`, `Pegawai ${who}`, unitId],
      );
      const accountId = randomUUID();
      await client.query(
        `INSERT INTO accounts(id, employee_id, email, principal_type, status)
         VALUES ($1,$2,$3,'EMPLOYEE','active')`,
        [accountId, employeeId, `leave010f-${accountId}@example.invalid`],
      );
      const session = await auth.createSessionForAccountId(accountId, {
        ipAddress: "127.0.0.1", userAgent: "rollback-only-leave010f-test",
      });
      people[who] = { employeeId, accountId, cookie: session.setCookie.split(";")[0]! };
    }
    await client.query("UPDATE employees SET direct_manager_employee_id = $2 WHERE id = $1",
      [people.guru.employeeId, people.kepala.employeeId]);
    await client.query("UPDATE organizational_units SET leave_approver_employee_id = $2 WHERE id = $1",
      [unitId, people.kabid.employeeId]);

    app = Fastify({ logger: false });
    await registerEmployeeLeaveRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    try { await app?.close(); } finally {
      if (client) { await client.query("ROLLBACK"); client.release(); }
      vi.useRealTimers();
    }
  });

  it("disetujui: pemohon menerima tepat satu notifikasi, dengan tautan ke Cuti & Izin", async () => {
    const requestId = await submitAnnual(FIRST);
    expect(await decisionNotifications("guru", requestId)).toHaveLength(0);

    await decideAll(requestId, "approve");

    const notifications = await decisionNotifications("guru", requestId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe("Pengajuan cuti Anda disetujui");
    expect(notifications[0]!.href).toBe("/app/leave");
    expect(notifications[0]!.body).toContain("Cuti Tahunan");
  });

  it("ditolak: pemohon menerima tepat satu notifikasi, tanpa catatan penolakannya", async () => {
    const requestId = await submitAnnual(FIRST);
    await decideAll(requestId, "reject");

    const notifications = await decisionNotifications("guru", requestId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe("Pengajuan cuti Anda ditolak");
    // Catatan penolakan hanya ada di layar Cuti & Izin, bukan di ringkasan lonceng.
    expect(notifications[0]!.body).not.toContain("Bertepatan dengan kegiatan unit");
    expect(notifications[0]!.body).toContain("Buka Cuti & Izin");
  });

  it("langkah atasan yang baru satu dari dua belum memberi tahu pemohon", async () => {
    const requestId = await submitAnnual(FIRST);
    const inbox = (await call("kepala", "GET", "/leave/approvals")).json() as {
      items: Array<{ stepId: string; requestId: string }>;
    };
    const step = inbox.items.find((item) => item.requestId === requestId)!;
    await call("kepala", "POST", `/leave/approvals/${step.stepId}/decision`, { decision: "approve" });

    expect(await decisionNotifications("guru", requestId)).toHaveLength(0);
  });

  it("penyetuju tidak menerima notifikasi keputusan milik pemohon", async () => {
    const requestId = await submitAnnual(FIRST);
    await decideAll(requestId, "approve");

    expect(await decisionNotifications("kepala", requestId)).toHaveLength(0);
    expect(await decisionNotifications("kabid", requestId)).toHaveLength(0);
  });

  it("dua pengajuan menghasilkan dua notifikasi yang berbeda, satu untuk masing-masing", async () => {
    const first = await submitAnnual(FIRST);
    await decideAll(first, "approve");
    const second = await submitAnnual(SECOND);
    await decideAll(second, "reject");

    expect(await decisionNotifications("guru", first)).toHaveLength(1);
    expect(await decisionNotifications("guru", second)).toHaveLength(1);
    const all = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM in_app_notifications
        WHERE recipient_account_id = $1 AND event_key LIKE 'leave.request.decided.%'`,
      [people.guru.accountId],
    );
    expect(all.rows[0]!.count).toBe("2");
  });

  it("intent di outbox tetap ditulis, jadi jalur pengiriman lain tidak ikut hilang", async () => {
    const requestId = await submitAnnual(FIRST);
    await decideAll(requestId, "approve");
    const outbox = await client.query<{ eventType: string }>(
      `SELECT event_type AS "eventType" FROM leave_notification_outbox
        WHERE leave_request_id = $1 AND target_type = 'employee' AND target_key = $2`,
      [requestId, people.guru.employeeId],
    );
    expect(outbox.rows.map((row) => row.eventType)).toContain("leave.request.approved");
  });
});
