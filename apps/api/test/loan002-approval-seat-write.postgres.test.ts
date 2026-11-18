// LOAN-002 / APR-002: Pengaturan > Kursi persetujuan — the write path for the approval seat
// registry, against the real schema. Synthetic rows only; every test runs inside one rolled-back
// transaction.

import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";

const databaseUrl = process.env.DATABASE_URL;
const allowed = (() => {
  if (!databaseUrl || process.env.NODE_ENV !== "test") return false;
  const url = new URL(databaseUrl);
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/hcis_pr";
})();

/** The cookie carries the account id; permissions are granted per account below. */
const grants = new Map<string, string[]>();

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: { id: token, email: `${token}@example.invalid`, principalType: "EMPLOYEE" },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext(principal: { id: string }) {
      return { organizationPermissions: grants.get(principal.id) ?? [] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { registerOrganizationAdminRoutes } = await import("../src/modules/organization/admin-routes.js");

const config = {
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: "postgres://unused",
  AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

describe.skipIf(!allowed)("LOAN-002 approval seat write path (PostgreSQL)", () => {
  let pool: Pool;
  let client: PoolClient;
  let app: ReturnType<typeof Fastify>;
  let hcAccount = "";
  let plainAccount = "";
  /** The employee-held seat HC would map to Kepala Keuangan, and the account-held Ketua seat. */
  const financePosition = randomUUID();
  const chairPosition = randomUUID();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());

  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 1 }); });
  afterAll(async () => { await pool?.end(); });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    const stack: string[] = [];
    let sequence = 0;
    const query = async (text: string, values?: unknown[]) => {
      const command = text.trim().toUpperCase();
      if (command === "BEGIN") {
        const savepoint = `seat_${++sequence}`;
        stack.push(savepoint);
        return client.query(`SAVEPOINT ${savepoint}`);
      }
      if (command === "COMMIT" || command === "ROLLBACK") {
        const savepoint = stack.pop();
        if (!savepoint) throw new Error("Unbalanced test transaction");
        if (command === "ROLLBACK") await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return client.query(text, values);
    };
    const transactionPool = {
      query, connect: async () => ({ query, release: () => undefined }),
    } as unknown as Pool;

    grants.clear();
    for (const [name, permissions] of [["hc", ["organization.manage"]], ["plain", []]] as const) {
      const employeeId = randomUUID();
      const accountId = randomUUID();
      await client.query(
        `INSERT INTO employees (id, employee_number, full_name, status, started_on)
         VALUES ($1, $2, $3, 'active', '2026-01-01')`,
        [employeeId, `SEAT-${employeeId.slice(0, 8)}`, `Synthetic ${name}`],
      );
      await client.query(
        "INSERT INTO accounts (id, employee_id, email, principal_type, status) VALUES ($1, $2, $3, 'EMPLOYEE', 'active')",
        [accountId, employeeId, `seat-${accountId}@example.invalid`],
      );
      grants.set(accountId, [...permissions]);
      if (name === "hc") hcAccount = accountId; else plainAccount = accountId;
    }

    // A published structure in force today: one unit holding an employee seat and an account seat.
    const changeSet = randomUUID();
    const nodeKey = randomUUID();
    await client.query(
      `INSERT INTO organization_change_sets (id, name, effective_on, status, created_by_account_id, validated_at, published_at)
       VALUES ($1, 'Struktur uji kursi', '2026-01-01'::date, 'PUBLISHED', $2, now(), now())`,
      [changeSet, hcAccount],
    );
    await client.query(
      `INSERT INTO organization_nodes (id, change_set_id, stable_key, name, node_type, parent_node_key, effective_from)
       VALUES ($1, $2, $3, 'Yayasan Uji', 'UNIT', NULL, '2026-01-01')`,
      [randomUUID(), changeSet, nodeKey],
    );
    await client.query(
      `INSERT INTO organization_positions (id, change_set_id, stable_key, node_key, title, effective_from, holder_source)
       VALUES ($1, $2, $3, $4, 'Kepala Bagian Keuangan', '2026-01-01', 'EMPLOYEE'),
              ($5, $2, $6, $4, 'Ketua Pengurus', '2026-01-01', 'ACCOUNT')`,
      [randomUUID(), changeSet, financePosition, nodeKey, randomUUID(), chairPosition],
    );

    app = Fastify({ logger: false });
    await registerOrganizationAdminRoutes(app, transactionPool, config);
  });

  afterEach(async () => {
    await app?.close();
    await client.query("ROLLBACK");
    client.release();
  });

  const as = (account: string) =>
    (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
      app.inject({ method, url, headers: { cookie: `hcis_session=${account}` }, ...(payload ? { payload } : {}) });
  const hc = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) => as(hcAccount)(method, url, payload);
  const map = (body: Record<string, unknown>) => hc("POST", "/admin/organization/approval-seats", {
    seatKey: "KEPALA_KEUANGAN", positionKey: financePosition, effectiveFrom: today, ...body,
  });

  it("needs organization.manage on every route, read and write alike", async () => {
    for (const [method, url, payload] of [
      ["GET", "/admin/organization/approval-seats", undefined],
      ["GET", "/admin/organization/approval-seats/targets", undefined],
      ["POST", "/admin/organization/approval-seats", { seatKey: "DIREKTUR", positionKey: financePosition, effectiveFrom: today }],
      ["POST", `/admin/organization/approval-seats/${randomUUID()}/end`, { reason: "Uji" }],
    ] as const) {
      const response = await as(plainAccount)(method, url, payload as Record<string, unknown> | undefined);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    // Nothing was written on the way to those refusals.
    expect((await client.query("SELECT count(*)::int AS n FROM organization_approval_seats")).rows[0].n).toBe(0);
  });

  it("ships with all five seats unmapped and says so by name", async () => {
    const response = await hc("GET", "/admin/organization/approval-seats");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.ready).toBe(false);
    expect(body.items).toHaveLength(5);
    expect(body.items.every((item: { state: string }) => item.state === "UNMAPPED")).toBe(true);
    // The opening state in production, named rather than inferred from a short list.
    expect(body.neverMapped).toEqual([
      "KEPALA_KEUANGAN", "DIREKTUR", "KETUA_YAYASAN", "BENDAHARA_YAYASAN", "PEMBINA",
    ]);
    expect(body.history).toEqual([]);
  });

  it("offers the positions of the structure in force, with their holder kind", async () => {
    const response = await hc("GET", "/admin/organization/approval-seats/targets?q=Ketua");
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.structurePublished).toBe(true);
    expect(body.items).toEqual([
      { key: chairPosition, label: "Ketua Pengurus", detail: "Yayasan Uji", holderSource: "ACCOUNT" },
    ]);
  });

  it("derives the stored label from the structure and refuses a caller-supplied one", async () => {
    // AUTH-010-K: the whole prohibition on reading job-title text collapses if a label can be posted.
    const supplied = await map({ seatLabel: "Kepala Keuangan buatan sendiri" });
    expect(supplied.statusCode, supplied.body).toBe(400);
    expect((await client.query("SELECT count(*)::int AS n FROM organization_approval_seats")).rows[0].n).toBe(0);

    const created = await map({});
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().seatLabel).toBe("Kepala Bagian Keuangan — Yayasan Uji");
    const stored = await client.query<{ seatLabel: string; positionKey: string }>(
      `SELECT seat_label AS "seatLabel", position_key::text AS "positionKey"
         FROM organization_approval_seats WHERE seat_key = 'KEPALA_KEUANGAN'`,
    );
    expect(stored.rows[0]).toEqual({ seatLabel: "Kepala Bagian Keuangan — Yayasan Uji", positionKey: financePosition });
  });

  it("DRAFT: a mapping never starts in the past, and its target must be in the structure", async () => {
    const backdated = await map({ effectiveFrom: addDays(today, -1) });
    expect(backdated.statusCode, backdated.body).toBe(422);
    expect(backdated.json().code).toBe("APPROVAL_SEAT_DATE_IN_PAST");

    const unknownPosition = await map({ positionKey: randomUUID() });
    expect(unknownPosition.statusCode, unknownPosition.body).toBe(422);
    expect(unknownPosition.json().code).toBe("APPROVAL_SEAT_TARGET_NOT_FOUND");

    const unknownSeat = await map({ seatKey: "KEPALA_HCM" });
    expect(unknownSeat.statusCode, unknownSeat.body).toBe(400);
    expect((await client.query("SELECT count(*)::int AS n FROM organization_approval_seats")).rows[0].n).toBe(0);
  });

  it("holds one open mapping per seat and audits the mapping", async () => {
    expect((await map({})).statusCode).toBe(201);
    const second = await map({ positionKey: chairPosition });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().code).toBe("APPROVAL_SEAT_ALREADY_MAPPED");

    const audits = await client.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM access_audit_events
        WHERE entity_type = 'organization_approval_seat' ORDER BY occurred_at`,
    );
    expect(audits.rows.map((row) => row.action)).toEqual(["organization.approval_seat.mapped"]);
    expect(audits.rows[0]!.payload).toMatchObject({ seatKey: "KEPALA_KEUANGAN", positionKey: financePosition });
  });

  it("ends a mapping once, with a reason, and warns that kasbon stops until it is mapped again", async () => {
    const created = await map({});
    const id = created.json().id as string;

    const tooEarly = await hc("POST", `/admin/organization/approval-seats/${id}/end`, {
      lastDay: addDays(today, -5), reason: "Terlalu mundur",
    });
    expect(tooEarly.statusCode, tooEarly.body).toBe(422);
    expect(tooEarly.json().code).toBe("APPROVAL_SEAT_END_TOO_EARLY");

    const ended = await hc("POST", `/admin/organization/approval-seats/${id}/end`, { reason: "Pergantian jabatan" });
    expect(ended.statusCode, ended.body).toBe(200);
    // D-18: it warns, it does not block. HC decides; the system makes sure they know.
    expect(ended.json().stopsEmployeeLoans).toBe(true);
    expect(ended.json().readiness.neverMapped).toContain("KEPALA_KEUANGAN");

    const again = await hc("POST", `/admin/organization/approval-seats/${id}/end`, { reason: "Sekali lagi" });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().code).toBe("APPROVAL_SEAT_ALREADY_ENDED");

    const audits = await client.query<{ action: string }>(
      `SELECT action FROM access_audit_events
        WHERE entity_type = 'organization_approval_seat' ORDER BY occurred_at`,
    );
    expect(audits.rows.map((row) => row.action))
      .toEqual(["organization.approval_seat.mapped", "organization.approval_seat.ended"]);

    // The ended mapping stays in the history; it is never deleted.
    const history = (await hc("GET", "/admin/organization/approval-seats")).json().history;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ seatKey: "KEPALA_KEUANGAN", endReason: "Pergantian jabatan" });
  });

  it("a seat whose position is in force but vacant reads VACANT, not UNMAPPED", async () => {
    expect((await map({})).statusCode).toBe(201);
    const body = (await hc("GET", "/admin/organization/approval-seats")).json();
    const seat = body.items.find((item: { seatKey: string }) => item.seatKey === "KEPALA_KEUANGAN");
    expect(seat).toMatchObject({ state: "VACANT", positionTitle: "Kepala Bagian Keuangan", unitName: "Yayasan Uji" });
    expect(body.neverMapped).not.toContain("KEPALA_KEUANGAN");
    expect(body.ready).toBe(false);
  });
});
