import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { Writable } from "node:stream";

import Fastify from "fastify";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { ApiConfig } from "../src/config/env.js";
import { ApplicationAccessError } from "../src/modules/auth/application-access.js";
import type { SqHubApplicationAccessClient } from "../src/modules/auth/application-access.js";
import { OidcIdentityMappingService } from "../src/modules/auth/oidc-identity-mapping.js";
import type { OidcProvider } from "../src/modules/auth/oidc-provider.js";
import { OidcLoginService } from "../src/modules/auth/oidc-service.js";
import { ADMIN_PERMISSIONS, EMPLOYMENT_PERMISSIONS, HC_ADMIN_PERMISSIONS } from "../src/modules/auth/permissions.js";
import { AuthService, type AuthPrincipal } from "../src/modules/auth/service.js";
import { registerGovernanceSummaryRoutes } from "../src/modules/governance/routes.js";
import { createGovernanceTokenVerifier } from "../src/modules/governance/token-verifier.js";

// ORG-010 §11 "Tests required". Isolated loopback database and a disposable schema; synthetic data only.
const databaseUrl = process.env.HCIS_AUTH011_TEST_DATABASE_URL;
const schema = `org010_${randomUUID().replaceAll("-", "")}`;
const context = { ipAddress: "127.0.0.1", userAgent: "synthetic-org010" };
const AUDIENCE = "hcis-web";
const HUB_CLIENT = "sq-hub";
const KID = "org010-key";

type Actor = { principal: AuthPrincipal; cookie: string; employeeId: string | null; subject: string };

describe.skipIf(!databaseUrl)("ORG-010 board view and governance summary (PostgreSQL)", () => {
  let pool: Pool;
  let control: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;
  let auth: AuthService;
  let jwks: Server;
  let issuer: string;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let viewerRoleId: string;
  let hcRoleId: string;
  let adminRoleId: string;
  let unitId: string;
  const actors = new Map<string, Actor>();
  const assignments = new Map<string, string>();

  const baseConfig = {
    NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl ?? "",
    AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
  } as ApiConfig;

  async function addActor(name: string, principalType: AuthPrincipal["principalType"], employeeStatus = "active") {
    const id = randomUUID();
    const employeeId = principalType === "EMPLOYEE" ? randomUUID() : null;
    if (employeeId) {
      await pool.query("INSERT INTO employees(id,employee_number,full_name,status) VALUES ($1,$2,$3,$4)",
        [employeeId, `ORG010-${id}`, `Nama Rahasia ${name}`, employeeStatus]);
    }
    const subject = `subject-${name}`;
    await pool.query(`INSERT INTO accounts(id,employee_id,email,principal_type,status,identity_issuer,identity_subject,
        mfa_enabled_at,mfa_secret_ciphertext,mfa_secret_iv,mfa_secret_tag)
      VALUES($1,$2,$3,$4,'active',$5,$6,CASE WHEN $4='SUPER_ADMIN' THEN now() END,
        CASE WHEN $4='SUPER_ADMIN' THEN 'synthetic' END,CASE WHEN $4='SUPER_ADMIN' THEN 'synthetic' END,
        CASE WHEN $4='SUPER_ADMIN' THEN 'synthetic' END)`,
    [id, employeeId, `${name}@example.invalid`, principalType, issuer, subject]);
    const session = await auth.createSessionForAccountId(id, context);
    const actor = { principal: session.session.principal, cookie: session.setCookie.split(";")[0]!, employeeId, subject };
    actors.set(name, actor);
    return actor;
  }

  async function grant(name: string, roleId: string, extra: { startsOn?: string; endsOn?: string; scope?: string } = {}) {
    const id = randomUUID();
    await pool.query(`INSERT INTO account_role_assignments(id,account_id,role_id,scope_type,starts_on,ends_on,reason)
      VALUES($1,$2,$3,$4,$5,$6,'Synthetic SK 001/2026')`,
    [id, actors.get(name)!.principal.id, roleId, extra.scope ?? "organization", extra.startsOn ?? null, extra.endsOn ?? null]);
    assignments.set(name, id);
    return id;
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/hcis_auth011_permissions_test") {
      throw new Error("ORG-010 integration requires the isolated loopback hcis_auth011_permissions_test database");
    }
    keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: "RS256", use: "sig" };
    jwks = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: request.url?.endsWith("/certs") ? [jwk] : [] }));
    });
    await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
    const address = jwks.address();
    if (!address || typeof address === "string") throw new Error("JWKS server did not bind");
    issuer = `http://127.0.0.1:${address.port}/realms/staff`;

    control = new Pool({ connectionString: databaseUrl });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const migrations = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
    const roles = await pool.query<{ id: string; key: string }>("SELECT id, role_key AS key FROM roles");
    viewerRoleId = roles.rows.find((row) => row.key === "foundation_board_viewer")!.id;
    hcRoleId = roles.rows.find((row) => row.key === "human_capital")!.id;
    adminRoleId = roles.rows.find((row) => row.key === "human_capital_admin")!.id;
    unitId = randomUUID();
    await pool.query("INSERT INTO organizational_units(id,name,normalized_name) VALUES ($1,'Unit Sintetis','unit-sintetis')", [unitId]);
    auth = new AuthService(pool, "11".repeat(32), 8, true);

    await addActor("board", "FOUNDATION_BOARD");
    await addActor("super", "SUPER_ADMIN");
    for (const name of ["viewer", "plain", "future", "expired", "suspended", "resigned_viewer", "hc", "hc_admin", "assigner", "delegate", "governance", "target", "unmapped_target"]) {
      await addActor(name, "EMPLOYEE");
    }
    for (const name of ["viewer", "suspended", "resigned_viewer"]) await grant(name, viewerRoleId);
    await grant("future", viewerRoleId, { startsOn: "2999-01-01" });
    await grant("expired", viewerRoleId, { endsOn: "2000-01-01" });
    await grant("hc", hcRoleId);
    await grant("hc_admin", adminRoleId);
    for (const [name, permissions] of [
      ["assigner", ["access.manage", "access.roles.assign"]],
      ["delegate", ["access.manage", "access.roles.delegate"]],
      ["governance", ["access.manage", "access.governance.manage"]],
    ] as const) {
      const roleId = randomUUID();
      await pool.query("INSERT INTO roles(id,role_key,name) VALUES($1,$2,$2)", [roleId, `synthetic_${name}`]);
      await pool.query("INSERT INTO role_permissions(role_id,permission_key) SELECT $1, unnest($2::text[])", [roleId, permissions]);
      await grant(name, roleId);
    }
    app = await createApp(baseConfig, pool);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (control) {
      await control.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.end();
    }
    if (jwks) await new Promise<void>((resolve) => jwks.close(() => resolve()));
  });

  async function get(name: string | null, url: string, headers: Record<string, string> = {}) {
    return app.inject({ method: "GET", url, headers: { ...(name ? { cookie: actors.get(name)!.cookie } : {}), ...headers } });
  }

  async function token(claims: Record<string, unknown> = {}) {
    return new SignJWT({ typ: "Bearer", azp: HUB_CLIENT, aud: [AUDIENCE, "account"], ...claims })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(issuer)
      .setSubject(typeof claims.sub === "string" ? claims.sub : actors.get("board")!.subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
  }

  describe("ORG-010-A/B board access", () => {
    it("seeds board.read only on foundation_board_viewer, outside HC bundles and legacy compatibility, with no assignment", async () => {
      const carriers = await pool.query<{ key: string }>(
        `SELECT role.role_key AS key FROM role_permissions permission JOIN roles role ON role.id = permission.role_id
         WHERE permission.permission_key = 'board.read'`);
      expect(carriers.rows).toEqual([{ key: "foundation_board_viewer" }]);
      expect((await pool.query("SELECT permission_key FROM role_permissions WHERE role_id=$1", [viewerRoleId])).rows)
        .toEqual([{ permission_key: "board.read" }]);
      expect((await pool.query("SELECT name, is_system FROM roles WHERE id=$1", [viewerRoleId])).rows)
        .toEqual([{ name: "Panel Organ Yayasan", is_system: true }]);
      for (const bundle of [HC_ADMIN_PERMISSIONS, ADMIN_PERMISSIONS, EMPLOYMENT_PERMISSIONS] as readonly (readonly string[])[]) {
        expect(bundle).not.toContain("board.read");
      }
      expect((await get("super", "/auth/me")).json().authorization.organizationPermissions).not.toContain("board.read");
    });

    it("re-applying the migration is idempotent and seeds no assignment", async () => {
      const before = (await pool.query("SELECT count(*)::int AS count FROM account_role_assignments")).rows;
      const sql = await readFile(new URL("../migrations/0059_board_read_permission.sql", import.meta.url), "utf8");
      await pool.query(sql);
      await pool.query(sql);
      expect((await pool.query("SELECT count(*)::int AS count FROM account_role_assignments")).rows).toEqual(before);
      expect((await pool.query("SELECT count(*)::int AS count FROM roles WHERE role_key='foundation_board_viewer'")).rows).toEqual([{ count: 1 }]);
    });

    it("allows FOUNDATION_BOARD and an EMPLOYEE with effective board.read, and nobody else", async () => {
      expect((await get("board", "/board/dashboard")).statusCode).toBe(200);
      expect((await get("viewer", "/board/dashboard")).statusCode).toBe(200);
      for (const name of ["plain", "future", "expired", "super", "hc", "hc_admin", "governance"]) {
        expect((await get(name, "/board/dashboard")).statusCode, name).toBe(403);
      }
      expect((await get(null, "/board/dashboard")).statusCode).toBe(401);
    });

    it("drops board access on the next request when the account or employee is no longer active", async () => {
      const suspended = actors.get("suspended")!;
      expect((await get("suspended", "/board/dashboard")).statusCode).toBe(200);
      await pool.query("UPDATE accounts SET status='suspended' WHERE id=$1", [suspended.principal.id]);
      // The cookie session itself ends with the account.
      expect((await get("suspended", "/board/dashboard")).statusCode).toBe(401);

      const resigned = actors.get("resigned_viewer")!;
      expect((await get("resigned_viewer", "/board/dashboard")).statusCode).toBe(200);
      for (const status of ["inactive", "resigned"]) {
        await pool.query("UPDATE employees SET status=$2 WHERE id=$1", [resigned.employeeId, status]);
        expect((await get("resigned_viewer", "/board/dashboard")).statusCode, status).toBe(403);
      }
    });

    it("no longer returns actor.email (D7)", async () => {
      for (const [name, principalType] of [["board", "FOUNDATION_BOARD"], ["viewer", "EMPLOYEE"]] as const) {
        const body = (await get(name, "/board/dashboard")).json();
        expect(body.actor).toEqual({ principalType });
        expect(JSON.stringify(body)).not.toContain("@example.invalid");
      }
    });

    it("lists board.read in /auth/me only when effective and adds no admin capability", async () => {
      expect((await get("viewer", "/auth/me")).json().authorization.organizationPermissions).toEqual(["board.read"]);
      for (const name of ["plain", "future", "expired"]) {
        expect((await get(name, "/auth/me")).json().authorization.organizationPermissions, name).not.toContain("board.read");
      }
      expect((await get("viewer", "/attendance/me")).statusCode).not.toBe(403);
      for (const url of ["/admin/access", "/admin/employees", "/admin/organization"]) {
        expect((await get("viewer", url)).statusCode, url).toBe(403);
      }
      const mutation = await app.inject({ method: "POST", url: `/admin/access/accounts/${actors.get("plain")!.principal.id}/role-assignments`,
        headers: { cookie: actors.get("viewer")!.cookie }, payload: { roleId: viewerRoleId, scopeType: "organization", reason: "x" } });
      expect(mutation.statusCode).toBe(403);
    });

    it("keeps FOUNDATION_BOARD out of /app and /admin", async () => {
      expect((await get("board", "/attendance/me")).statusCode).toBe(403);
      expect((await get("board", "/admin/access")).statusCode).toBe(403);
    });
  });

  describe("ENG-LIST-001 account paging on /admin/access", () => {
    it("pages and searches accounts in SQL and keeps the summary global", async () => {
      const first = await get("super", "/admin/access?pageSize=1");
      expect(first.statusCode, first.body).toBe(200);
      const body = first.json();
      expect(body.accounts).toHaveLength(1);
      expect(body.pagination).toMatchObject({ page: 1, pageSize: 1 });
      expect(body.pagination.total).toBeGreaterThanOrEqual(15);
      expect(body.pagination.pageCount).toBe(body.pagination.total);
      expect(body.summary.accounts).toBeGreaterThanOrEqual(body.pagination.total);

      const second = (await get("super", "/admin/access?pageSize=1&page=2")).json();
      expect(second.accounts[0].id).not.toBe(body.accounts[0].id);

      // Assignments travel only with the accounts on the page, current and ended alike.
      const expired = actors.get("expired")!.principal;
      const found = (await get("super", "/admin/access?q=expired%40example.invalid")).json();
      expect(found.accounts.map((account: { id: string }) => account.id)).toEqual([expired.id]);
      expect(found.accounts[0].assignments.map((assignment: { roleId: string }) => assignment.roleId)).toEqual([viewerRoleId]);
      expect(found.pagination.total).toBe(1);

      expect((await get("super", "/admin/access?pageSize=101")).statusCode).toBe(400);
      expect((await get("super", "/admin/access?includeInactive=maybe")).statusCode).toBe(400);
    });
  });

  describe("ORG-010-C role grant", () => {
    const snapshot = async () => (await pool.query(
      `SELECT (SELECT count(*)::int FROM account_role_assignments) AS assignments,
        (SELECT count(*)::int FROM access_audit_events WHERE action LIKE 'role.assignment.%') AS audits`)).rows[0];
    const post = (name: string, accountId: string, payload: object) => app.inject({
      method: "POST", url: `/admin/access/accounts/${accountId}/role-assignments`,
      headers: { cookie: actors.get(name)!.cookie }, payload,
    });

    it("lets Super Admin grant and remove the role, each with one audit event", async () => {
      const target = actors.get("target")!.principal.id;
      const before = await snapshot();
      const created = await post("super", target, { roleId: viewerRoleId, scopeType: "organization", endsOn: "2030-12-31", reason: "SK Pengurus 001/2026" });
      expect(created.statusCode, created.body).toBe(201);
      expect(await snapshot()).toEqual({ assignments: before.assignments + 1, audits: before.audits + 1 });
      const event = await pool.query("SELECT actor_account_id, payload FROM access_audit_events WHERE entity_id=$1", [created.json().id]);
      expect(event.rows[0].actor_account_id).toBe(actors.get("super")!.principal.id);
      expect(event.rows[0].payload).toMatchObject({ accountId: target, roleId: viewerRoleId, scopeType: "organization", endsOn: "2030-12-31" });
      expect((await app.inject({ method: "GET", url: "/board/dashboard", headers: { cookie: actors.get("target")!.cookie } })).statusCode).toBe(200);

      const removed = await app.inject({ method: "DELETE", url: `/admin/access/role-assignments/${created.json().id}`, headers: { cookie: actors.get("super")!.cookie } });
      expect(removed.statusCode).toBe(204);
      expect(await snapshot()).toEqual({ assignments: before.assignments, audits: before.audits + 2 });
      expect((await app.inject({ method: "GET", url: "/board/dashboard", headers: { cookie: actors.get("target")!.cookie } })).statusCode).toBe(403);
    });

    it("refuses every other grantor with ROLE_GRANT_SUPER_ADMIN_ONLY and writes nothing", async () => {
      const target = actors.get("target")!.principal.id;
      const before = await snapshot();
      for (const name of ["hc", "hc_admin", "assigner", "delegate", "governance", "viewer", "board"]) {
        const response = await post(name, target, { roleId: viewerRoleId, scopeType: "organization", reason: "SK" });
        expect(response.statusCode, name).toBe(403);
        expect(response.json().code, name).toBe("ROLE_GRANT_SUPER_ADMIN_ONLY");
        const removal = await app.inject({ method: "DELETE", url: `/admin/access/role-assignments/${assignments.get("viewer")}`, headers: { cookie: actors.get(name)!.cookie } });
        expect(removal.statusCode, name).toBe(403);
      }
      expect(await snapshot()).toEqual(before);
    });

    it("requires organization scope and a reason, refuses self-grant and non-EMPLOYEE targets", async () => {
      const target = actors.get("target")!.principal.id;
      const before = await snapshot();
      const unit = await post("super", target, { roleId: viewerRoleId, scopeType: "unit", organizationalUnitId: unitId, reason: "SK" });
      expect([unit.statusCode, unit.json().code]).toEqual([400, "ROLE_SCOPE_INVALID"]);
      const own = await post("super", target, { roleId: viewerRoleId, scopeType: "own", reason: "SK" });
      expect([own.statusCode, own.json().code]).toEqual([400, "ROLE_SCOPE_INVALID"]);
      for (const reason of [undefined, "   "]) {
        const missing = await post("super", target, { roleId: viewerRoleId, scopeType: "organization", ...(reason === undefined ? {} : { reason }) });
        expect([missing.statusCode, missing.json().code]).toEqual([400, "ROLE_REASON_REQUIRED"]);
      }
      expect((await post("super", actors.get("super")!.principal.id, { roleId: viewerRoleId, scopeType: "organization", reason: "SK" })).statusCode).toBe(403);
      expect((await post("super", actors.get("board")!.principal.id, { roleId: viewerRoleId, scopeType: "organization", reason: "SK" })).statusCode).toBe(403);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("ORG-010-D..M GET /governance/summary", () => {
    let summary: ReturnType<typeof Fastify>;
    let logs: string[];
    let access: { isAllowed: ReturnType<typeof vi.fn> };
    const enabledConfig = { ...baseConfig, GOVERNANCE_SUMMARY_ENABLED: "true" } as ApiConfig;

    beforeAll(async () => {
      logs = [];
      access = { isAllowed: vi.fn(async () => true) };
      const stream = new Writable({ write(chunk, _encoding, done) { logs.push(String(chunk)); done(); } });
      summary = Fastify({ logger: { level: "trace", stream } });
      registerGovernanceSummaryRoutes(summary, pool, enabledConfig, {
        verifyToken: createGovernanceTokenVerifier({ issuer, audience: AUDIENCE, allowedClients: new Set([HUB_CLIENT]) }),
        applicationAccess: access as unknown as Pick<SqHubApplicationAccessClient, "isAllowed">,
        applicationKey: "hcis",
        publicOrigin: "https://hcis.example.invalid",
      });
      await summary.ready();
    });

    afterAll(async () => { await summary?.close(); });
    beforeEach(() => { access.isAllowed.mockReset(); access.isAllowed.mockResolvedValue(true); });

    const call = (headers: Record<string, string | string[]> = {}) =>
      summary.inject({ method: "GET", url: "/governance/summary", headers });
    const lastAudit = async () => (await pool.query(
      `SELECT account_id, event_type, reason_code, email FROM auth_audit_events
       WHERE event_type LIKE 'governance.summary.%' ORDER BY occurred_at DESC, id LIMIT 1`)).rows[0];

    it("serves contract v1 to a FOUNDATION_BOARD account and to an EMPLOYEE with board.read", async () => {
      for (const name of ["board", "viewer"]) {
        const bearer = await token({ sub: actors.get(name)!.subject });
        const response = await call({ authorization: `Bearer ${bearer}` });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers["cache-control"]).toBe("private, no-store");
        expect(response.headers["set-cookie"]).toBeUndefined();
        const body = response.json();
        expect(body).toMatchObject({ contractVersion: 1, applicationKey: "hcis", title: "SDM", detailUrl: "https://hcis.example.invalid/board" });
        expect(body.metrics.map((metric: { key: string }) => metric.key)).toEqual([
          "active_employees", "started_this_year", "ended_this_year", "without_direct_manager", "units_without_approver", "leave_in_review",
        ]);
        const text = JSON.stringify(body);
        expect(text).not.toContain("Nama Rahasia");
        expect(text).not.toContain("@example.invalid");
        expect(text).not.toContain("ORG010-");
        expect(body).not.toHaveProperty("actor");
        expect(access.isAllowed).toHaveBeenLastCalledWith({ issuer, subject: actors.get(name)!.subject });
        expect(await lastAudit()).toEqual({ account_id: actors.get(name)!.principal.id, event_type: "governance.summary.served", reason_code: null, email: null });
      }
      expect((await pool.query("SELECT count(*)::int AS count FROM auth_sessions WHERE user_agent IS NULL")).rows).toEqual([{ count: 0 }]);
    });

    it.each([
      ["no token", async () => ({}), 401, "UNAUTHENTICATED"],
      ["malformed header", async () => ({ authorization: "Basic abc" }), 401, "UNAUTHENTICATED"],
      ["several tokens in one header", async () => ({ authorization: `Bearer ${await token()} ${await token()}` }), 401, "UNAUTHENTICATED"],
      ["several authorization headers", async () => ({ authorization: [`Bearer ${await token()}`, `Bearer ${await token()}`] }), 401, "UNAUTHENTICATED"],
      ["wrong issuer", async () => ({ authorization: `Bearer ${await new SignJWT({ typ: "Bearer", azp: HUB_CLIENT, aud: AUDIENCE })
        .setProtectedHeader({ alg: "RS256", kid: KID }).setIssuer("https://identity.example.invalid/realms/staff")
        .setSubject("subject-board").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey)}` }), 401, "INVALID_TOKEN"],
      ["ID token", async () => ({ authorization: `Bearer ${await token({ typ: "ID" })}` }), 401, "INVALID_TOKEN"],
      ["aud without HCIS", async () => ({ authorization: `Bearer ${await token({ aud: "account" })}` }), 403, "FORBIDDEN_AUDIENCE"],
      ["azp not allowlisted", async () => ({ authorization: `Bearer ${await token({ azp: "aset-sq" })}` }), 403, "FORBIDDEN_CLIENT"],
      ["unmapped sub", async () => ({ authorization: `Bearer ${await token({ sub: "subject-nobody" })}` }), 403, "OIDC_ACCOUNT_NOT_MAPPED"],
      ["no board access", async () => ({ authorization: `Bearer ${await token({ sub: "subject-plain" })}` }), 403, "BOARD_ACCESS_REQUIRED"],
      ["Super Admin", async () => ({ authorization: `Bearer ${await token({ sub: "subject-super" })}` }), 403, "BOARD_ACCESS_REQUIRED"],
      ["expired assignment", async () => ({ authorization: `Bearer ${await token({ sub: "subject-expired" })}` }), 403, "BOARD_ACCESS_REQUIRED"],
      ["inactive account", async () => ({ authorization: `Bearer ${await token({ sub: "subject-suspended" })}` }), 403, "ACCOUNT_INACTIVE"],
      ["a session cookie alone", async () => ({ cookie: actors.get("board")!.cookie }), 401, "UNAUTHENTICATED"],
    ])("refuses %s and audits the reason", async (_label, headers, statusCode, code) => {
      const response = await call(await headers());
      expect(response.statusCode).toBe(statusCode);
      expect(response.json().code).toBe(code);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("subject-");
      const event = await lastAudit();
      expect([event.event_type, event.reason_code]).toEqual(["governance.summary.denied", code]);
      const mapped = ["BOARD_ACCESS_REQUIRED", "ACCOUNT_INACTIVE"].includes(code);
      expect(event.account_id === null).toBe(!mapped);
    });

    it("re-checks SQ Hub Application Access (D3)", async () => {
      access.isAllowed.mockResolvedValue(false);
      const denied = await call({ authorization: `Bearer ${await token()}` });
      expect([denied.statusCode, denied.json().code]).toEqual([403, "HCIS_ACCESS_DENIED"]);
      access.isAllowed.mockRejectedValue(new ApplicationAccessError("synthetic outage"));
      const unavailable = await call({ authorization: `Bearer ${await token()}` });
      expect([unavailable.statusCode, unavailable.json().code]).toEqual([503, "APPLICATION_ACCESS_UNAVAILABLE"]);
      expect((await lastAudit()).account_id).toBe(actors.get("board")!.principal.id);
    });

    it("returns 503 JWKS_UNAVAILABLE when signing keys are unreachable (D9)", async () => {
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
      const port = (closed.address() as { port: number }).port;
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      const offline = Fastify();
      registerGovernanceSummaryRoutes(offline, pool, enabledConfig, {
        verifyToken: createGovernanceTokenVerifier({ issuer: `http://127.0.0.1:${port}/realms/staff`, audience: AUDIENCE, allowedClients: new Set([HUB_CLIENT]) }),
        applicationAccess: access as unknown as Pick<SqHubApplicationAccessClient, "isAllowed">,
        applicationKey: "hcis", publicOrigin: "https://hcis.example.invalid",
      });
      const response = await offline.inject({ method: "GET", url: "/governance/summary", headers: { authorization: `Bearer ${await token()}` } });
      expect([response.statusCode, response.json().code]).toEqual([503, "JWKS_UNAVAILABLE"]);
      await offline.close();
    });

    it("is 404 when GOVERNANCE_SUMMARY_ENABLED is false (default)", async () => {
      const response = await app.inject({ method: "GET", url: "/governance/summary", headers: { authorization: `Bearer ${await token()}` } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("is refused by every cookie route (ORG-010-E)", async () => {
      const bearer = { authorization: `Bearer ${await token()}` };
      for (const url of ["/board/dashboard", "/auth/me", "/attendance/me", "/admin/access", "/admin/employees"]) {
        expect((await get(null, url, bearer)).statusCode, url).toBe(401);
      }
    });

    it("includes the trend only in AUTHORITATIVE mode, with completed months only", async () => {
      const bearer = { authorization: `Bearer ${await token()}` };
      expect((await call(bearer)).json().metrics[0]).not.toHaveProperty("trend");
      await pool.query(`INSERT INTO employment_rollout_settings(id,mode,reason) VALUES(1,'SHADOW','Synthetic')
        ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode`);
      expect((await call(bearer)).json().charts.map((chart: { kind: string }) => chart.kind)).toEqual(["ranking"]);
      await pool.query("UPDATE employment_rollout_settings SET mode='AUTHORITATIVE' WHERE id=1");
      const body = (await call(bearer)).json();
      expect(body.metrics[0].trend.points).toHaveLength(12);
      const trend = body.charts.find((chart: { kind: string }) => chart.kind === "trend");
      expect(trend.key).toBe("active_headcount_monthly");
      const currentMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit" }).format(new Date());
      expect(trend.periods).not.toContain(currentMonth);
      await pool.query("UPDATE employment_rollout_settings SET mode='OFF' WHERE id=1");
    });

    it("never logs the token, its claims, or the response body", async () => {
      const bearer = await token();
      logs.length = 0;
      await call({ authorization: `Bearer ${bearer}` });
      await call({ authorization: `Bearer ${await token({ sub: "subject-nobody" })}` });
      const output = logs.join("\n");
      expect(output.length).toBeGreaterThan(0);
      for (const secret of [bearer, bearer.split(".")[1]!, "subject-board", "subject-nobody", "Pegawai aktif", "contractVersion"]) {
        expect(output).not.toContain(secret);
      }
      const stored = JSON.stringify((await pool.query("SELECT * FROM auth_audit_events WHERE event_type LIKE 'governance.%'")).rows);
      expect(stored).not.toContain(bearer.split(".")[1]!);
      expect(stored).not.toContain("subject-");
    });
  });

  describe("ORG-010-I identity hand-over", () => {
    async function inTransaction<T>(operation: (service: OidcIdentityMappingService) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation(new OidcIdentityMappingService(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }

    it("refuses a target that is not an active EMPLOYEE, already mapped, or a source without identity", async () => {
      const member = await addActor("member_refusals", "FOUNDATION_BOARD");
      const inactiveEmployee = await addActor("inactive_employee", "EMPLOYEE", "resigned");
      const unmappedEmployee = actors.get("unmapped_target")!;
      await pool.query("UPDATE accounts SET identity_issuer=NULL, identity_subject=NULL WHERE id=$1", [unmappedEmployee.principal.id]);
      await pool.query("UPDATE accounts SET identity_issuer=NULL, identity_subject=NULL WHERE id=$1", [inactiveEmployee.principal.id]);
      const service = new OidcIdentityMappingService(pool);
      const cases: Array<[string, string, string]> = [
        [member.principal.id, actors.get("viewer")!.principal.id, "TARGET_ALREADY_MAPPED"],
        [member.principal.id, inactiveEmployee.principal.id, "TARGET_NOT_ELIGIBLE"],
        [member.principal.id, actors.get("super")!.principal.id, "TARGET_ALREADY_MAPPED"],
        [unmappedEmployee.principal.id, member.principal.id, "SOURCE_HAS_NO_IDENTITY"],
        [member.principal.id, member.principal.id, "SAME_ACCOUNT"],
      ];
      for (const [from, to, code] of cases) {
        await expect(service.handOver({ fromAccountId: from, toAccountId: to, apply: false }), code).rejects.toMatchObject({ code });
      }
      await pool.query("UPDATE accounts SET status='suspended' WHERE id=$1", [unmappedEmployee.principal.id]);
      await expect(service.handOver({ fromAccountId: member.principal.id, toAccountId: unmappedEmployee.principal.id, apply: false }))
        .rejects.toMatchObject({ code: "TARGET_NOT_ELIGIBLE" });
      await pool.query("UPDATE accounts SET status='active' WHERE id=$1", [unmappedEmployee.principal.id]);
    });

    it("previews without writing, then moves the identity, deactivates the old account and ends its sessions with one audit event", async () => {
      const member = await addActor("member", "FOUNDATION_BOARD");
      const employee = actors.get("unmapped_target")!;
      const state = async () => (await pool.query(
        `SELECT id, status, identity_subject FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id`, [[member.principal.id, employee.principal.id]])).rows;
      const before = await state();
      const auditsBefore = (await pool.query("SELECT count(*)::int AS count FROM auth_audit_events")).rows[0].count;
      const preview = await inTransaction((service) => service.handOver({ fromAccountId: member.principal.id, toAccountId: employee.principal.id, apply: false }));
      expect(preview.status).toBe("would_hand_over");
      expect(await state()).toEqual(before);
      expect((await pool.query("SELECT count(*)::int AS count FROM auth_audit_events")).rows[0].count).toBe(auditsBefore);

      const applied = await inTransaction((service) => service.handOver({ fromAccountId: member.principal.id, toAccountId: employee.principal.id, apply: true }));
      expect(applied).toMatchObject({ status: "handed_over", identity: { issuer, subject: member.subject }, from: { accountStatus: "inactive" } });
      const after = await pool.query("SELECT id, status, identity_issuer, identity_subject FROM accounts WHERE id = ANY($1::uuid[])",
        [[member.principal.id, employee.principal.id]]);
      expect(after.rows.find((row) => row.id === member.principal.id)).toMatchObject({ status: "inactive", identity_issuer: null, identity_subject: null });
      expect(after.rows.find((row) => row.id === employee.principal.id)).toMatchObject({ status: "active", identity_issuer: issuer, identity_subject: member.subject });
      expect((await pool.query("SELECT count(*)::int AS count FROM auth_sessions WHERE account_id=$1 AND revoked_at IS NULL", [member.principal.id])).rows[0].count).toBe(0);
      expect((await get("member", "/board/dashboard")).statusCode).toBe(401);
      const events = await pool.query("SELECT account_id, related_account_id, user_agent FROM auth_audit_events WHERE event_type='auth.oidc.identity_handed_over'");
      expect(events.rows).toEqual([{ account_id: employee.principal.id, related_account_id: member.principal.id, user_agent: "operator-cli:map-oidc-identity" }]);
      // D8: no role is granted by the hand-over.
      expect((await pool.query("SELECT count(*)::int AS count FROM account_role_assignments WHERE account_id=$1", [employee.principal.id])).rows[0].count).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS count FROM accounts WHERE id=$1", [member.principal.id])).rows[0].count).toBe(1);

      // After the hand-over, OIDC login lands the person on their EMPLOYEE account.
      const stateValue = randomUUID();
      await pool.query("INSERT INTO auth_oidc_transactions(state_hash,code_verifier,nonce,expires_at) VALUES($1,'synthetic','synthetic',now()+interval '1 minute')",
        [createHash("sha256").update(stateValue).digest("hex")]);
      const login = new OidcLoginService(pool,
        { completeAuthorization: vi.fn(async () => ({ issuer, subject: member.subject })) } as unknown as OidcProvider,
        { isAllowed: vi.fn(async () => true) } as unknown as SqHubApplicationAccessClient, auth);
      const result = await login.complete(new URL(`https://hcis.example.invalid/auth/callback?state=${stateValue}`), context, () => true);
      expect(result.session.principal).toMatchObject({ id: employee.principal.id, principalType: "EMPLOYEE" });
    });
  });
});
