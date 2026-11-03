// EMP-012 Package 1 acceptance against a real schema.
// Synthetic employees and images only; every test runs inside one rolled-back transaction.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { registerEmployeeCardRoutes } from "../src/modules/employee-cards/routes.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The routes own their transactions; BEGIN/COMMIT/ROLLBACK become savepoints of the test's. */
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

const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
const PHOTO_2 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]).toString("base64");
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 5, 5]).toString("base64");
const HC = ["employee_cards.manage"];

describe.skipIf(!allowed)("EMP-012 employee cards", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let principal: AuthPrincipal | null;
  let permissions: string[];
  let clock: Date;
  const people = {} as Record<"hc" | "aisyah" | "bilal", { employeeId: string; accountId: string }>;

  async function insertEmployee(name: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO employees(id, employee_number, full_name, status, started_on) VALUES ($1,$2,$3,'active','2020-01-06')`,
      [id, `KP-${id.slice(0, 8)}`, name],
    );
    return id;
  }

  async function insertAccount(employeeId: string) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO accounts(id, employee_id, email, principal_type, status) VALUES ($1,$2,$3,'EMPLOYEE','active')`,
      [id, employeeId, `card-${id}@example.invalid`],
    );
    return id;
  }

  function actAs(who: keyof typeof people | null, granted: string[] = []) {
    principal = who ? { id: people[who].accountId, email: `${who}@example.invalid`, principalType: "EMPLOYEE" } : null;
    permissions = granted;
  }

  async function call(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
    return app.inject({ method, url, payload: payload as never });
  }

  async function ready(who: keyof typeof people = "aisyah") {
    actAs("hc", HC);
    expect((await call("PUT", "/admin/employee-cards/settings", { signerTitle: "Ketua Yayasan", signerName: "Ketua Sintetis", validityMonths: 24 })).statusCode).toBe(200);
    const upload = await call("PUT", `/admin/employee-cards/employees/${people[who].employeeId}/photo`, { contentType: "image/jpeg", contentBase64: PHOTO });
    expect(upload.statusCode, upload.body).toBe(200);
  }

  async function issue(who: keyof typeof people, reason = "NEW") {
    actAs("hc", HC);
    return call("POST", `/admin/employee-cards/employees/${people[who].employeeId}/cards`, { reason });
  }

  async function events(type: string) {
    return (await client.query<{ actor: string | null; metadata: Record<string, unknown> }>(
      `SELECT actor_account_id AS actor, metadata FROM employee_card_audit_events WHERE event_type = $1 ORDER BY occurred_at`, [type],
    )).rows;
  }

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    for (const key of ["hc", "aisyah", "bilal"] as const) {
      const employeeId = await insertEmployee(`Pegawai ${key}`);
      people[key] = { employeeId, accountId: await insertAccount(employeeId) };
    }
    clock = new Date("2026-11-03T03:00:00Z");
    const config = { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 } as ApiConfig;
    const auth = {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    };
    app = Fastify({ logger: false });
    await registerEmployeeCardRoutes(app, savepointPool(client), config, auth as never, () => clock);
  });

  afterEach(async () => {
    await app?.close();
    await client.query("ROLLBACK");
    client.release();
  });

  it("EMP-012-B: refuses to issue without a photo, without a signer, or for an inactive employee", async () => {
    actAs("hc", HC);
    await client.query("UPDATE employee_card_settings SET signer_name = NULL WHERE id = 1");
    expect((await issue("aisyah")).json().code).toBe("EMPLOYEE_CARD_PHOTO_MISSING");
    await call("PUT", `/admin/employee-cards/employees/${people.aisyah.employeeId}/photo`, { contentType: "image/jpeg", contentBase64: PHOTO });
    expect((await issue("aisyah")).json().code).toBe("EMPLOYEE_CARD_SIGNER_MISSING");
    await ready("bilal");
    await client.query("UPDATE employees SET status = 'resigned' WHERE id = $1", [people.bilal.employeeId]);
    const inactive = await issue("bilal");
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json().code).toBe("EMPLOYEE_CARD_EMPLOYEE_INACTIVE");
    expect((await client.query("SELECT count(*)::int AS n FROM employee_cards")).rows[0].n).toBe(0);
  });

  it("issues a card with frozen data, number, validity and a check code", async () => {
    await ready();
    const issued = await issue("aisyah");
    expect(issued.statusCode, issued.body).toBe(201);
    const card = issued.json();
    expect(card.cardNumber).toMatch(/^KP-2611-\d{4,}$/);
    expect(card).toMatchObject({ edition: 1, status: "ACTIVE", validUntil: "2028-11-30" });
    expect((await issue("aisyah")).json().code).toBe("EMPLOYEE_CARD_ALREADY_ACTIVE");

    actAs("aisyah");
    const mine = await call("GET", "/me/employee-card");
    expect(mine.statusCode).toBe(200);
    expect(mine.json().card).toMatchObject({ cardNumber: card.cardNumber, fullName: "Pegawai aisyah", signerName: "Ketua Sintetis", invalidReason: null });
    const photo = await call("GET", "/me/employee-card/photo");
    expect(photo.statusCode).toBe(200);
    expect(photo.headers["cache-control"]).toBe("private, no-store");
    expect(photo.rawPayload).toEqual(Buffer.from(PHOTO, "base64"));
    expect((await events("employee_card.issued"))[0]).toMatchObject({ actor: people.hc.accountId });
  });

  it("EMP-012-C/F: reissue replaces the active card in one step and keeps the old photo on the old card", async () => {
    await ready();
    const first = (await issue("aisyah")).json();
    await call("PUT", `/admin/employee-cards/employees/${people.aisyah.employeeId}/photo`, { contentType: "image/jpeg", contentBase64: PHOTO_2 });
    const oldPhoto = await call("GET", `/admin/employee-cards/cards/${first.id}/photo`);
    expect(oldPhoto.rawPayload).toEqual(Buffer.from(PHOTO, "base64"));

    expect((await issue("aisyah", "LOST")).statusCode).toBe(201);
    const detail = (await call("GET", `/admin/employee-cards/employees/${people.aisyah.employeeId}`)).json();
    expect(detail.cards.map((card: { edition: number; status: string }) => [card.edition, card.status])).toEqual([[2, "ACTIVE"], [1, "REPLACED"]]);
    expect(detail.cards[0].verifyCode).not.toBe(detail.cards[1].verifyCode);
    expect(detail.cards[0].cardNumber).not.toBe(detail.cards[1].cardNumber);
    expect((await client.query(
      "SELECT count(*)::int AS n FROM employee_cards WHERE employee_id = $1 AND status = 'ACTIVE'", [people.aisyah.employeeId],
    )).rows[0].n).toBe(1);
    expect(await events("employee_card.replaced")).toHaveLength(1);
    const newPhoto = await call("GET", `/admin/employee-cards/cards/${detail.cards[0].id}/photo`);
    expect(newPhoto.rawPayload).toEqual(Buffer.from(PHOTO_2, "base64"));
  });

  it("EMP-012-D/E: the public page shows a valid card without NIP and hides name and photo once invalid", async () => {
    await ready();
    await issue("aisyah");
    const code = (await client.query<{ code: string }>("SELECT verify_code AS code FROM employee_cards")).rows[0]!.code;
    actAs(null);
    const valid = await call("GET", `/public/employee-cards/${code.toLowerCase().slice(0, 5)}-${code.slice(5)}`);
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ valid: true, fullName: "Pegawai aisyah", edition: 1 });
    const publicBody = valid.body;
    for (const forbidden of ["employeeNumber", "employeeId", "KP-" + people.aisyah.employeeId.slice(0, 8), people.aisyah.employeeId, "verifyCode"]) {
      expect(publicBody).not.toContain(forbidden);
    }
    expect((await call("GET", `/public/employee-cards/${code}/photo`)).statusCode).toBe(200);

    // The holder reports it lost: invalid at once.
    actAs("aisyah");
    expect((await call("POST", "/me/employee-card/report-lost")).statusCode).toBe(200);
    expect((await call("POST", "/me/employee-card/report-lost")).statusCode).toBe(409);
    actAs(null);
    const lost = await call("GET", `/public/employee-cards/${code}`);
    expect(lost.json()).toMatchObject({ valid: false, reason: "REPORTED_LOST" });
    expect(lost.body).not.toContain("Pegawai aisyah");
    expect((await call("GET", `/public/employee-cards/${code}/photo`)).statusCode).toBe(404);
    expect((await call("GET", "/public/employee-cards/0000000000")).statusCode).toBe(404);
  });

  it("D-08: expiry and leaving employment are computed when read", async () => {
    await ready();
    await issue("aisyah");
    const code = (await client.query<{ code: string }>("SELECT verify_code AS code FROM employee_cards")).rows[0]!.code;
    actAs(null);
    clock = new Date("2028-11-30T16:00:00Z");
    expect((await call("GET", `/public/employee-cards/${code}`)).json().valid).toBe(true);
    clock = new Date("2028-11-30T17:00:00Z");
    expect((await call("GET", `/public/employee-cards/${code}`)).json()).toMatchObject({ valid: false, reason: "EXPIRED" });
    clock = new Date("2026-12-01T03:00:00Z");
    await client.query("UPDATE employees SET status = 'resigned' WHERE id = $1", [people.aisyah.employeeId]);
    expect((await call("GET", `/public/employee-cards/${code}`)).json()).toMatchObject({ valid: false, reason: "EMPLOYEE_INACTIVE" });
  });

  it("revokes, prints and lists with filters", async () => {
    await ready();
    await ready("bilal");
    const aisyah = (await issue("aisyah")).json();
    const bilal = (await issue("bilal")).json();

    const print = await call("GET", `/admin/employee-cards/print?cardIds=${bilal.id},${aisyah.id}`);
    expect(print.json().items.map((card: { id: string }) => card.id)).toEqual([bilal.id, aisyah.id]);
    expect((await call("POST", "/admin/employee-cards/print", { cardIds: [aisyah.id, bilal.id] })).statusCode).toBe(200);
    expect(await events("employee_card.printed")).toHaveLength(2);

    const revoke = await call("POST", `/admin/employee-cards/cards/${bilal.id}/revoke`, { reason: "Pegawai pindah tugas ke yayasan lain" });
    expect(revoke.statusCode).toBe(200);
    expect((await call("POST", `/admin/employee-cards/cards/${bilal.id}/revoke`, { reason: "Kedua kalinya" })).json().code)
      .toBe("EMPLOYEE_CARD_INVALID_TRANSITION");
    const afterRevoke = await call("GET", `/admin/employee-cards/print?cardIds=${bilal.id}`);
    expect(afterRevoke.json()).toMatchObject({ items: [], unavailableCardIds: [bilal.id] });
    expect((await call("POST", "/admin/employee-cards/print", { cardIds: [aisyah.id, bilal.id] })).statusCode).toBe(409);

    const needs = (await call("GET", "/admin/employee-cards?filter=NEEDS_REISSUE&q=Pegawai")).json();
    expect(needs.items.map((item: { employeeId: string }) => item.employeeId)).toEqual([people.bilal.employeeId]);
    expect(needs.items[0].card).toMatchObject({ status: "REVOKED", invalidReason: "REVOKED" });
    const active = (await call("GET", "/admin/employee-cards?filter=ACTIVE&q=Pegawai")).json();
    expect(active.items.map((item: { employeeId: string }) => item.employeeId)).toEqual([people.aisyah.employeeId]);
    const noPhoto = (await call("GET", "/admin/employee-cards?filter=NO_PHOTO&q=Pegawai%20hc")).json();
    expect(noPhoto.pagination.total).toBe(1);

    const audit = (await call("GET", `/admin/employee-cards/audit-events?employeeId=${people.bilal.employeeId}`)).json();
    expect(audit.items.map((event: { eventType: string }) => event.eventType)).toEqual([
      "employee_card.revoked", "employee_card.printed", "employee_card.issued", "employee_card.photo.uploaded",
    ]);
  });

  it("EMP-012-H: an employee reads only their own card; settings and signature are audited", async () => {
    await ready();
    await issue("aisyah");
    actAs("bilal");
    expect((await call("GET", "/me/employee-card")).json()).toMatchObject({ card: null });
    expect((await call("GET", "/me/employee-card/photo")).statusCode).toBe(404);
    expect((await call("POST", "/me/employee-card/report-lost")).statusCode).toBe(409);

    actAs("hc", HC);
    expect((await call("PUT", "/admin/employee-cards/settings/signature", { contentType: "image/png", contentBase64: SIGNATURE })).statusCode).toBe(200);
    expect((await call("GET", "/admin/employee-cards/settings")).json()).toMatchObject({ hasSignature: true, validityMonths: 24 });
    actAs("aisyah");
    const signature = await call("GET", "/me/employee-card/signature");
    expect(signature.rawPayload).toEqual(Buffer.from(SIGNATURE, "base64"));
    expect(await events("employee_card.settings.updated")).toHaveLength(1);
    expect(await events("employee_card.signature.uploaded")).toHaveLength(1);
  });
});
