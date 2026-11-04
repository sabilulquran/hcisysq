import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { AuthService, type AuthPrincipal } from "../src/modules/auth/service.js";
import { ADMIN_PERMISSIONS, HC_ADMIN_PERMISSIONS, HC_LEAD_PERMISSIONS, HC_LEAD_ROLE_KEY, HC_OPERATIONAL_PERMISSIONS, hasOrganizationPermission } from "../src/modules/auth/permissions.js";
import { createRoleAssignment, removeRoleAssignment } from "../src/modules/auth/role-assignment.js";
import { OidcLoginService } from "../src/modules/auth/oidc-service.js";
import { PostgresOrganizationRepository } from "../src/modules/organization/repository.js";
import type { OidcProvider } from "../src/modules/auth/oidc-provider.js";
import type { SqHubApplicationAccessClient } from "../src/modules/auth/application-access.js";

const databaseUrl = process.env.HCIS_AUTH011_TEST_DATABASE_URL;
const schema = `auth011_${randomUUID().replaceAll("-", "")}`;
const context = { ipAddress: "127.0.0.1", userAgent: "synthetic-auth011" };
const oidcIssuer = "https://identity.example.invalid/realms/synthetic";

describe.skipIf(!databaseUrl)("AUTH-011 isolated PostgreSQL authorization", () => {
  let pool: Pool;
  let control: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;
  let auth: AuthService;
  const actors = new Map<string, { principal: AuthPrincipal; cookie: string; employeeId: string | null }>();
  let hcRoleId: string;
  let adminRoleId: string;
  let unitId: string;
  let managedBoardId: string;
  let managedEmployeeId: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/hcis_auth011_permissions_test") {
      throw new Error("AUTH-011 integration requires an isolated loopback hcis_auth011_permissions_test database");
    }
    control = new Pool({ connectionString: databaseUrl });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const migrations = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
    const roles = await pool.query<{ id: string; key: string }>("SELECT id, role_key AS key FROM roles");
    hcRoleId = roles.rows.find((row) => row.key === "human_capital")!.id;
    adminRoleId = roles.rows.find((row) => row.key === "human_capital_admin")!.id;
    unitId = randomUUID();
    await pool.query("INSERT INTO organizational_units(id, name, normalized_name) VALUES ($1,'Synthetic Unit','synthetic-unit')", [unitId]);
    auth = new AuthService(pool, "11".repeat(32), 8, true);
    for (const name of ["employee", "hc", "unit_hc", "admin", "board", "legacy", "target", "unit_admin", "delegate", "governance"]) {
      const principalType = name === "board" ? "FOUNDATION_BOARD" : name === "legacy" ? "SUPER_ADMIN" : "EMPLOYEE";
      const id = randomUUID();
      const employeeId = principalType === "EMPLOYEE" ? randomUUID() : null;
      if (employeeId) await pool.query("INSERT INTO employees(id,employee_number,full_name,status) VALUES ($1,$2,'Synthetic Actor','active')", [employeeId, `AUTH011-${id}`]);
      await pool.query(`INSERT INTO accounts(id,employee_id,email,principal_type,status,
        mfa_enabled_at,mfa_secret_ciphertext,mfa_secret_iv,mfa_secret_tag)
        VALUES($1,$2,$3,$4,'active',CASE WHEN $4='SUPER_ADMIN' THEN now() END,
        CASE WHEN $4='SUPER_ADMIN' THEN 'synthetic' END,CASE WHEN $4='SUPER_ADMIN' THEN 'synthetic' END,
        CASE WHEN $4='SUPER_ADMIN' THEN 'synthetic' END)`, [id, employeeId, `${name}@example.invalid`, principalType]);
      const result = await auth.createSessionForAccountId(id, context);
      actors.set(name, { principal: result.session.principal, cookie: result.setCookie.split(";")[0]!, employeeId });
    }
    for (const [name, roleId, scope, unit] of [["hc", hcRoleId, "organization", null], ["unit_hc", hcRoleId, "unit", unitId], ["admin", adminRoleId, "organization", null], ["unit_admin", adminRoleId, "unit", unitId]] as const) {
      await pool.query(`INSERT INTO account_role_assignments(id,account_id,role_id,scope_type,organizational_unit_id)
        VALUES($1,$2,$3,$4,$5)`, [randomUUID(), actors.get(name)!.principal.id, roleId, scope, unit]);
    }
    for (const [name, roleKey, permissions] of [
      ["delegate", "synthetic_account_delegate", ["access.manage", "access.roles.delegate"]],
      ["governance", "synthetic_governance_manager", ["access.manage", "access.governance.manage"]],
    ] as const) {
      const roleId = randomUUID();
      await pool.query("INSERT INTO roles(id,role_key,name) VALUES($1,$2,$2)", [roleId, roleKey]);
      await pool.query(
        "INSERT INTO role_permissions(role_id,permission_key) SELECT $1, unnest($2::text[])",
        [roleId, permissions],
      );
      await pool.query(
        "INSERT INTO account_role_assignments(id,account_id,role_id,scope_type) VALUES($1,$2,$3,'organization')",
        [randomUUID(), actors.get(name)!.principal.id, roleId],
      );
    }
    managedBoardId = randomUUID();
    await pool.query(
      `INSERT INTO accounts(id,email,principal_type,status)
       VALUES($1,'managed-board@example.invalid','FOUNDATION_BOARD','invited')`,
      [managedBoardId],
    );
    const managedEmployeeRecordId = randomUUID();
    managedEmployeeId = randomUUID();
    await pool.query(
      "INSERT INTO employees(id,employee_number,full_name,status) VALUES($1,$2,'Synthetic Managed Employee','active')",
      [managedEmployeeRecordId, `AUTH011-${managedEmployeeRecordId}`],
    );
    await pool.query(
      `INSERT INTO accounts(id,employee_id,email,principal_type,status)
       VALUES($1,$2,'managed-employee@example.invalid','EMPLOYEE','invited')`,
      [managedEmployeeId, managedEmployeeRecordId],
    );
    await pool.query(
      `INSERT INTO account_role_assignments(id,account_id,role_id,scope_type,reason)
       VALUES($1,$2,$3,'organization','Synthetic delegated account management')`,
      [randomUUID(), managedEmployeeId, adminRoleId],
    );
    app = await createApp({ NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: databaseUrl!,
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
      OIDC_ISSUER: `${oidcIssuer}/` }, pool);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (control) {
      await control.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.end();
    }
  });

  async function request(name: string | null, method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", url: string, payload?: object) {
    return app.inject({ method, url, headers: name ? { cookie: actors.get(name)!.cookie } : {}, ...(payload ? { payload } : {}) });
  }

  it("seeds exactly the intended bundle without any identity assignments or implicit approval", async () => {
    const permissions = await auth.getAuthorizationContext(actors.get("admin")!.principal);
    expect(permissions.organizationPermissions.sort()).toEqual([...HC_ADMIN_PERMISSIONS].sort());
    // Owner decision 2026-10-16: only Super Admin grants roles. 0057 removes the HC admin grant;
    // legacy Super Admin compatibility keeps it.
    expect(HC_ADMIN_PERMISSIONS).not.toContain("access.roles.assign");
    expect(ADMIN_PERMISSIONS).toContain("access.roles.assign");
    expect((await auth.getAuthorizationContext(actors.get("legacy")!.principal)).organizationPermissions)
      .toContain("access.roles.assign");
    expect((await pool.query(
      `SELECT role.role_key FROM role_permissions permission JOIN roles role ON role.id = permission.role_id
       WHERE permission.permission_key = 'access.roles.assign'`,
    )).rows).toEqual([]);
    expect((await pool.query("SELECT 1 FROM permissions WHERE permission_key='access.roles.assign'")).rowCount).toBe(1);
    expect((await auth.getAuthorizationContext(actors.get("unit_hc")!.principal)).organizationPermissions).toEqual([]);
    expect((await auth.getAuthorizationContext(actors.get("unit_admin")!.principal)).organizationPermissions).toEqual([]);
    const before = await pool.query("SELECT count(*)::int AS count FROM account_role_assignments");
    await pool.query(await readFile(new URL("../migrations/0045_hcis_human_capital_admin.sql", import.meta.url), "utf8"));
    expect((await pool.query("SELECT count(*)::int AS count FROM account_role_assignments")).rows).toEqual(before.rows);
    // Replaying 0045 re-adds the grant; 0057 removes it again, idempotently, without touching assignments.
    const revoke = await readFile(new URL("../migrations/0057_hc_admin_revoke_role_assign.sql", import.meta.url), "utf8");
    await pool.query(revoke);
    await pool.query(revoke);
    expect((await auth.getAuthorizationContext(actors.get("admin")!.principal)).organizationPermissions.sort())
      .toEqual([...HC_ADMIN_PERMISSIONS].sort());
    expect((await pool.query("SELECT count(*)::int AS count FROM account_role_assignments")).rows).toEqual(before.rows);
  });

  it("lets only Super Admin grant or remove roles; HC and HC admins get 403 and commit nothing", async () => {
    // Owner decision 2026-10-16 (AUTH-011): Human Capital may not delegate its role or permissions.
    const target = actors.get("target")!.principal.id;
    const roles = (await pool.query<{ id: string }>("SELECT id FROM roles ORDER BY role_key")).rows;
    const existing = await createRoleAssignment(pool, actors.get("legacy")!.principal, target,
      { roleId: hcRoleId, scopeType: "unit", organizationalUnitId: unitId, reason: "Synthetic Super Admin grant" });
    const snapshot = async () => (await pool.query(
      `SELECT (SELECT count(*)::int FROM account_role_assignments) AS assignments,
        (SELECT count(*)::int FROM access_audit_events WHERE action LIKE 'role.assignment.%') AS audits`,
    )).rows[0];
    const before = await snapshot();
    for (const name of ["hc", "unit_hc", "admin", "unit_admin", "delegate", "governance", "employee"]) {
      const actor = actors.get(name)!.principal;
      for (const role of roles) {
        for (const body of [
          { roleId: role.id, scopeType: "organization", reason: "Synthetic delegation attempt" },
          { roleId: role.id, scopeType: "unit", organizationalUnitId: unitId, reason: "Synthetic delegation attempt" },
          { roleId: role.id, scopeType: "own" },
        ]) {
          for (const account of [target, actor.id]) {
            const response = await request(name, "POST", `/admin/access/accounts/${account}/role-assignments`, body);
            expect.soft(response.statusCode, `${name} grant ${JSON.stringify(body)}`).toBe(403);
          }
        }
      }
      // Denial precedes input validation and resource lookup.
      expect.soft((await request(name, "POST", `/admin/access/accounts/${target}/role-assignments`, {})).statusCode, name).toBe(403);
      expect.soft((await request(name, "DELETE", `/admin/access/role-assignments/${existing}`)).statusCode, name).toBe(403);
      await expect(createRoleAssignment(pool, actor, target, { roleId: hcRoleId, scopeType: "organization" }))
        .rejects.toMatchObject({ statusCode: 403, code: "ROLE_GRANT_SUPER_ADMIN_ONLY" });
      await expect(removeRoleAssignment(pool, actor, existing))
        .rejects.toMatchObject({ statusCode: 403, code: "ROLE_GRANT_SUPER_ADMIN_ONLY" });
    }
    expect(await snapshot()).toEqual(before);
    expect((await pool.query("SELECT 1 FROM account_role_assignments WHERE id=$1", [existing])).rowCount).toBe(1);
    expect((await request("legacy", "DELETE", `/admin/access/role-assignments/${existing}`)).statusCode).toBe(204);
  }, 120000);

  it("server-authorizes every manifest route per persona independently of navigation", async () => {
    const manifest = JSON.parse(await readFile(new URL("../../../docs/domain/AUTH-011-admin-route-permissions.json", import.meta.url), "utf8")) as
      Array<{ method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT"; url: string;
        access?: "hc-operational" | "self-service" | "super-admin" | "board" | "governance-bearer";
        principals?: string[]; permissions: string[]; executePermissions?: string[] }>;
    // Route completeness against the registered app is enforced by auth011-route-coverage.test.ts.
    expect(manifest.filter((route) => route.access === undefined)).toHaveLength(406);
    expect(manifest.filter((route) => route.access === "super-admin")).toHaveLength(4);
    expect(manifest.filter((route) => route.access === "hc-operational")).toHaveLength(14);
    expect(manifest.filter((route) => route.access === "self-service")).toHaveLength(119);
    expect(manifest.filter((route) => route.access === "board")).toHaveLength(1);
    expect(manifest.filter((route) => route.access === "governance-bearer")).toHaveLength(1);
    // AUTH-014: the SQ Hub channel. No session and no HCIS permission; an anonymous caller still
    // gets 401, because the channel demands both credentials before anything else.
    expect(manifest.filter((route) => route.access === "machine-actor")).toHaveLength(4);
    const personas = ["employee", "hc", "unit_hc", "unit_admin", "board", "admin", "legacy"];
    const granted = new Map<string, string[]>();
    for (const name of personas) {
      granted.set(name, (await auth.getAuthorizationContext(actors.get(name)!.principal)).organizationPermissions);
    }
    // unit_hc and unit_admin hold unit-scoped roles only, which never satisfy organization permissions.
    expect(granted.get("unit_hc")).toEqual([]);
    // HC operational handlers check request shape before the HC permission, so they receive
    // well-formed synthetic IDs and bodies that reach the permission check.
    const hcNote = "Synthetic AUTH-011 matrix";
    const hcPayloads: Record<string, object> = {
      "/leave/hc/tasks/:taskId/decision": { action: "validate" },
      "/leave/hc/tasks/:taskId/administration-decision": { action: "validate_all", note: hcNote },
      "/leave/planned/hc/tasks/:taskId/validation-decision": { action: "validate" },
      "/leave/planned/hc/tasks/:taskId/approval-decision": { decision: "approve" },
      "/leave/hc/critical-reviews/:reviewId/decision": { decision: "approve" },
      "/attendance/resolutions/hc/:caseId/decision": { action: "manual_review", note: hcNote },
    };
    for (const route of manifest) {
      // ORG-010: the bearer-only summary is disabled here (404 for everyone, cookies never count);
      // test/governance-summary.postgres.test.ts covers it enabled.
      if (route.access === "governance-bearer") {
        for (const name of [null, ...personas]) {
          expect.soft((await request(name, route.method, route.url)).statusCode, `${name} ${route.url}`).toBe(404);
        }
        continue;
      }
      // AUTH-014: the SQ Hub channel is not session-authenticated at all. A browser cookie is not
      // a credential here whoever it belongs to, so every persona — signed in or not, privileged
      // or not — gets 401. Asserting that for all of them is the point: it pins down that no
      // session can ever be mistaken for the machine token and actor assertion this channel wants.
      if (route.access === "machine-actor") {
        const url = route.url.replace(/:[A-Za-z]+/g, "invalid-resource-id");
        for (const name of [null, ...personas]) {
          const response = await request(name, route.method, url, route.method === "GET" ? undefined : {});
          expect.soft(response.statusCode, `${name} ${route.method} ${url}`).toBe(401);
        }
        continue;
      }
      const hc = route.access === "hc-operational";
      // Elsewhere an invalid object ID tests that authorization precedes business validation.
      const url = route.url.replace(/:[A-Za-z]+/g, hc ? randomUUID() : "invalid-resource-id");
      const anonymous = await request(null, route.method, url);
      if (route.access === "self-service") expect.soft([401, 403], `anonymous ${route.method} ${url}`).toContain(anonymous.statusCode);
      else expect.soft(anonymous.statusCode, `anonymous ${route.method} ${url}`).toBe(401);
      if (hc && route.method !== "GET") expect(hcPayloads[route.url], route.url).toBeDefined();
      // Physical device commands need the technical permission unless the body requests mode "execute".
      const variants = [{ payload: hc ? hcPayloads[route.url] : undefined, permissions: route.permissions },
        ...(route.executePermissions ? [{ payload: { mode: "execute" }, permissions: route.executePermissions }] : [])];
      for (const variant of variants) {
        for (const name of personas) {
          const { principalType } = actors.get(name)!.principal;
          const allowed = route.access === "board"
            ? principalType === "FOUNDATION_BOARD" || (principalType === "EMPLOYEE" && granted.get(name)!.includes("board.read"))
            : route.access === "self-service"
            ? route.principals!.includes(principalType)
            // HC operational routes require an EMPLOYEE principal; legacy compatibility applies only to admin routes.
            : (route.access !== "hc-operational" || principalType === "EMPLOYEE")
              && (route.access !== "super-admin" || principalType === "SUPER_ADMIN")
              && variant.permissions.every((key) => granted.get(name)!.includes(key));
          const response = await request(name, route.method, url, variant.payload);
          const label = `${name} ${route.method} ${url} ${JSON.stringify(variant.payload ?? {})}: ${response.body.slice(0, 160)}`;
          if (!allowed) expect.soft(response.statusCode, label).toBe(403);
          else if (route.access === "self-service" || route.access === "board") expect.soft(response.statusCode, label).not.toBe(401);
          else expect.soft([401, 403, 500], label).not.toContain(response.statusCode);
        }
      }
    }
  }, 240000);

  it("supports intended admin read surfaces, local context, employee self-service and Board isolation", async () => {
    for (const url of ["/admin/employees", "/admin/access", "/admin/organization", "/admin/leave/configuration", "/admin/leave/calendar", "/admin/payslip-imports"]) {
      expect((await request("admin", "GET", url)).statusCode, url).toBe(200);
    }
    expect((await request("admin", "GET", "/auth/me")).json().authorization.organizationPermissions).toContain("access.manage");
    expect((await request("employee", "GET", "/attendance/me")).statusCode).toBe(200);
    expect((await request("board", "GET", "/board/dashboard")).statusCode).toBe(200);
    expect((await request("admin", "GET", "/board/dashboard")).statusCode).toBe(403);
    expect((await request("legacy", "GET", "/attendance/me")).statusCode).toBe(403);
    expect((await request("admin", "GET", "/leave/planned/hc/approval-queue")).statusCode).toBe(403);
    expect((await request("admin", "GET", "/leave/planned/hc/validation-queue")).statusCode).toBe(200);
  });

  it("honors future, expired, inclusive dates and revoked account/employee state", async () => {
    const id = actors.get("admin")!.principal.id;
    for (const clause of ["starts_on = current_date + 1", "starts_on = NULL, ends_on = current_date - 1"]) {
      await pool.query(`UPDATE account_role_assignments SET ${clause} WHERE account_id=$1`, [id]);
      expect(await hasOrganizationPermission(pool, id, "access.manage")).toBe(false);
    }
    await pool.query("UPDATE account_role_assignments SET starts_on=current_date, ends_on=current_date WHERE account_id=$1", [id]);
    expect(await hasOrganizationPermission(pool, id, "access.manage")).toBe(true);
    for (const status of ["suspended", "inactive"]) {
      await pool.query("UPDATE accounts SET status=$2 WHERE id=$1", [id, status]);
      expect((await request("admin", "GET", "/admin/access")).statusCode).toBe(401);
    }
    await pool.query("UPDATE accounts SET status='active' WHERE id=$1", [id]);
    await pool.query("UPDATE employees SET status='inactive' WHERE id=$1", [actors.get("admin")!.employeeId]);
    expect((await request("admin", "GET", "/admin/access")).statusCode).toBe(403);
    await pool.query("UPDATE employees SET status='active' WHERE id=$1", [actors.get("admin")!.employeeId]);
  });

  it("allows a separately granted technical permission without granting firmware or biometrics", async () => {
    const roleId = randomUUID();
    const assignmentId = randomUUID();
    await pool.query("INSERT INTO roles(id,role_key,name) VALUES($1,'synthetic_configurator','Synthetic Configurator')", [roleId]);
    await pool.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'attendance.devices.configure')", [roleId]);
    await pool.query("INSERT INTO account_role_assignments(id,account_id,role_id,scope_type) VALUES($1,$2,$3,'organization')",
      [assignmentId, actors.get("target")!.principal.id, roleId]);
    expect((await request("target", "POST", "/admin/attendance/adms/devices", {})).statusCode).toBe(400);
    expect((await request("target", "POST", "/admin/attendance/adms/devices/invalid/physical/firmware", {})).statusCode).toBe(403);
    expect((await request("target", "GET", "/admin/attendance/adms/biometric-control-plane")).statusCode).toBe(403);
    await pool.query("DELETE FROM account_role_assignments WHERE id=$1", [assignmentId]);
    await pool.query("DELETE FROM roles WHERE id=$1", [roleId]);
  });

  it("blocks self-elevation, admin delegation, changed role bundles and invalid scopes", async () => {
    const admin = actors.get("admin")!.principal;
    const legacy = actors.get("legacy")!.principal;
    const target = actors.get("target")!.principal.id;
    const api = `/admin/access/accounts/${target}/role-assignments`;
    expect((await request("admin", "POST", `/admin/access/accounts/${admin.id}/role-assignments`, { roleId: hcRoleId, scopeType: "organization" })).statusCode).toBe(403);
    expect((await request("admin", "POST", api, { roleId: adminRoleId, scopeType: "organization", reason: "Synthetic mandate" })).statusCode).toBe(403);
    expect((await request("legacy", "POST", `/admin/access/accounts/${legacy.id}/role-assignments`, { roleId: hcRoleId, scopeType: "organization" })).statusCode).toBe(403);
    expect((await request("legacy", "POST", api, { roleId: hcRoleId, scopeType: "unit" })).statusCode).toBe(400);
    expect((await request("legacy", "POST", api, { roleId: hcRoleId, scopeType: "organization", organizationalUnitId: unitId })).statusCode).toBe(400);
    // A role carrying a permission outside the HCIS allowlist cannot be granted, even by Super Admin.
    await pool.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'leave.governance.approve')", [hcRoleId]);
    expect((await request("legacy", "POST", api, { roleId: hcRoleId, scopeType: "organization" })).statusCode).toBe(403);
    await pool.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_key='leave.governance.approve'", [hcRoleId]);
    const created = await request("legacy", "POST", api, { roleId: hcRoleId, scopeType: "unit", organizationalUnitId: unitId, reason: "Synthetic operation" });
    expect(created.statusCode).toBe(201);
    expect((await request("admin", "DELETE", `/admin/access/role-assignments/${created.json().id}`)).statusCode).toBe(403);
    expect((await request("legacy", "DELETE", `/admin/access/role-assignments/${created.json().id}`)).statusCode).toBe(204);
    expect((await request("legacy", "POST", api, { roleId: adminRoleId, scopeType: "unit", organizationalUnitId: unitId, reason: "Synthetic mandate" })).statusCode).toBe(400);
    const promoted = await request("legacy", "POST", api, { roleId: adminRoleId, scopeType: "organization", reason: "Reviewed synthetic mandate" });
    expect(promoted.statusCode).toBe(201);
    expect((await request("target", "GET", "/auth/me")).json().authorization.organizationPermissions).toContain("access.manage");
    expect((await request("admin", "DELETE", `/admin/access/role-assignments/${promoted.json().id}`)).statusCode).toBe(403);
    await removeRoleAssignment(pool, legacy, promoted.json().id);
  });

  it("does not allow account administration to take over privileged invitations", async () => {
    const target = actors.get("target")!.principal.id;
    const assignment = await createRoleAssignment(pool, actors.get("legacy")!.principal, target,
      { roleId: adminRoleId, scopeType: "organization", reason: "Synthetic invitation protection" });
    await pool.query("UPDATE accounts SET status='invited' WHERE id=$1", [target]);
    expect((await request("admin", "POST", `/admin/access/accounts/${target}/activation`)).statusCode).toBe(403);
    expect((await request("admin", "PATCH", `/admin/access/accounts/${actors.get("board")!.principal.id}/status`, { status: "suspended" })).statusCode).toBe(403);
    expect((await request("admin", "PATCH", `/admin/access/accounts/${actors.get("admin")!.principal.id}/status`, { status: "suspended" })).statusCode).toBe(403);
    await removeRoleAssignment(pool, actors.get("legacy")!.principal, assignment);
    await pool.query("UPDATE accounts SET status='active' WHERE id=$1", [target]);
  });

  it("denies Board activation to a delegate without governance permission and issues no token", async () => {
    const before = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM account_activation_tokens WHERE account_id=$1",
      [managedBoardId],
    );
    const response = await request("delegate", "POST", `/admin/access/accounts/${managedBoardId}/activation`);
    expect(response.statusCode).toBe(403);
    const after = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM account_activation_tokens WHERE account_id=$1",
      [managedBoardId],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("denies Board status changes to a delegate without governance permission", async () => {
    const response = await request(
      "delegate", "PATCH", `/admin/access/accounts/${managedBoardId}/status`, { status: "suspended" },
    );
    expect(response.statusCode).toBe(403);
    expect((await pool.query("SELECT status FROM accounts WHERE id=$1", [managedBoardId])).rows[0].status).toBe("invited");
  });

  it("allows explicit governance account management for a Foundation Board target", async () => {
    const activation = await request("governance", "POST", `/admin/access/accounts/${managedBoardId}/activation`);
    expect(activation.statusCode).toBe(201);
    expect(activation.json().activationPath).toContain("/activate#token=");
    const status = await request(
      "governance", "PATCH", `/admin/access/accounts/${managedBoardId}/status`, { status: "suspended" },
    );
    expect(status.statusCode).toBe(200);
    expect((await pool.query("SELECT status FROM accounts WHERE id=$1", [managedBoardId])).rows[0].status).toBe("suspended");
  });

  it("preserves delegated Employee account management", async () => {
    const activation = await request("delegate", "POST", `/admin/access/accounts/${managedEmployeeId}/activation`);
    expect(activation.statusCode).toBe(201);
    const status = await request(
      "delegate", "PATCH", `/admin/access/accounts/${managedEmployeeId}/status`, { status: "suspended" },
    );
    expect(status.statusCode).toBe(200);
    expect((await pool.query("SELECT status FROM accounts WHERE id=$1", [managedEmployeeId])).rows[0].status).toBe("suspended");
  });

  it("keeps Super Admin outside normal account management", async () => {
    const targetId = actors.get("legacy")!.principal.id;
    expect((await request("delegate", "POST", `/admin/access/accounts/${targetId}/activation`)).statusCode).toBe(403);
    expect((await request("delegate", "PATCH", `/admin/access/accounts/${targetId}/status`, { status: "suspended" })).statusCode).toBe(403);
    expect((await pool.query("SELECT status FROM accounts WHERE id=$1", [targetId])).rows[0].status).toBe("active");
  });

  it("keeps self account management denied for delegated actors", async () => {
    const targetId = actors.get("delegate")!.principal.id;
    const response = await request(
      "delegate", "PATCH", `/admin/access/accounts/${targetId}/status`, { status: "suspended" },
    );
    expect(response.statusCode).toBe(403);
    expect((await pool.query("SELECT status FROM accounts WHERE id=$1", [targetId])).rows[0].status).toBe("active");
  });

  describe("AUTH-002 activation through a mapped Akun SQ identity", () => {
    async function invitedBoard(identity: { issuer: string; subject: string } | null) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO accounts(id,email,principal_type,status,identity_issuer,identity_subject)
         VALUES($1,$2,'FOUNDATION_BOARD','invited',$3,$4)`,
        [id, `board-${id}@example.invalid`, identity?.issuer ?? null, identity?.subject ?? null],
      );
      return id;
    }
    const statusOf = async (id: string) =>
      (await pool.query<{ status: string }>("SELECT status FROM accounts WHERE id=$1", [id])).rows[0]!.status;

    it("lets a governance manager activate an invited Board account mapped to the configured issuer", async () => {
      const id = await invitedBoard({ issuer: oidcIssuer, subject: `opaque:${randomUUID()}` });
      const response = await request("governance", "PATCH", `/admin/access/accounts/${id}/status`, { status: "active" });
      expect(response.statusCode, response.body).toBe(200);
      expect(await statusOf(id)).toBe("active");
      const audit = await pool.query<{ actor: string; payload: { status: string; authenticationMethod: string } }>(
        `SELECT actor_account_id AS actor, payload FROM access_audit_events
         WHERE action='account.status.updated' AND entity_id=$1`, [id]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.actor).toBe(actors.get("governance")!.principal.id);
      expect(audit.rows[0]!.payload).toMatchObject({ status: "active", authenticationMethod: "oidc_identity" });
    });

    it("lets the legacy Super Admin activate it too", async () => {
      const id = await invitedBoard({ issuer: oidcIssuer, subject: `opaque:${randomUUID()}` });
      expect((await request("legacy", "PATCH", `/admin/access/accounts/${id}/status`, { status: "active" })).statusCode).toBe(200);
      expect(await statusOf(id)).toBe("active");
    });

    it("refuses activation without a password or identity mapping", async () => {
      const id = await invitedBoard(null);
      const response = await request("governance", "PATCH", `/admin/access/accounts/${id}/status`, { status: "active" });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("ACCOUNT_ACTIVATION_NOT_READY");
      expect(await statusOf(id)).toBe("invited");
    });

    it("refuses activation when the mapping belongs to another issuer", async () => {
      const id = await invitedBoard({ issuer: "https://other.example.invalid/realms/x", subject: `opaque:${randomUUID()}` });
      const response = await request("governance", "PATCH", `/admin/access/accounts/${id}/status`, { status: "active" });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("OIDC_ISSUER_MISMATCH");
      expect(await statusOf(id)).toBe("invited");
    });

    it("keeps mapped Board activation forbidden without access.governance.manage", async () => {
      const id = await invitedBoard({ issuer: oidcIssuer, subject: `opaque:${randomUUID()}` });
      for (const name of ["delegate", "admin", "hc", "employee", "board"]) {
        const response = await request(name, "PATCH", `/admin/access/accounts/${id}/status`, { status: "active" });
        expect.soft(response.statusCode, name).toBe(403);
      }
      expect(await statusOf(id)).toBe("invited");
    });

    it("keeps self-targeted activation forbidden for a governance manager", async () => {
      const selfId = actors.get("governance")!.principal.id;
      const response = await request("governance", "PATCH", `/admin/access/accounts/${selfId}/status`, { status: "active" });
      expect(response.statusCode).toBe(403);
    });

    it("refuses a mapped Employee account whose employee is no longer active", async () => {
      const employeeId = randomUUID();
      const accountId = randomUUID();
      await pool.query("INSERT INTO employees(id,employee_number,full_name,status) VALUES($1,$2,'Synthetic Resigned','resigned')",
        [employeeId, `AUTH011-${employeeId}`]);
      await pool.query(
        `INSERT INTO accounts(id,employee_id,email,principal_type,status,identity_issuer,identity_subject)
         VALUES($1,$2,$3,'EMPLOYEE','invited',$4,$5)`,
        [accountId, employeeId, `resigned-${accountId}@example.invalid`, oidcIssuer, `opaque:${randomUUID()}`],
      );
      const response = await request("delegate", "PATCH", `/admin/access/accounts/${accountId}/status`, { status: "active" });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("EMPLOYEE_NOT_ACTIVE");
      expect(await statusOf(accountId)).toBe("invited");
    });
  });

  it("rolls back role assignment if the audit insert fails", async () => {
    await pool.query(`CREATE FUNCTION fail_auth011_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER fail_auth011_audit BEFORE INSERT ON access_audit_events FOR EACH ROW EXECUTE FUNCTION fail_auth011_audit()`);
    const before = (await pool.query("SELECT count(*)::int AS count FROM account_role_assignments")).rows;
    await expect(createRoleAssignment(pool, actors.get("legacy")!.principal, actors.get("target")!.principal.id,
      { roleId: hcRoleId, scopeType: "organization" })).rejects.toThrow("synthetic audit failure");
    expect((await pool.query("SELECT count(*)::int AS count FROM account_role_assignments")).rows).toEqual(before);
    await pool.query("DROP TRIGGER fail_auth011_audit ON access_audit_events");
  });

  it("revokes an earlier operational-admin invitation when the target is elevated", async () => {
    const targetId = actors.get("target")!.principal.id;
    await pool.query("UPDATE accounts SET status='invited' WHERE id=$1", [targetId]);
    const issued = await request("admin", "POST", `/admin/access/accounts/${targetId}/activation`);
    expect(issued.statusCode, issued.body).toBe(201);
    const token = issued.json().activationPath.split("#token=")[1];
    const assignmentId = await createRoleAssignment(pool, actors.get("legacy")!.principal, targetId,
      { roleId: adminRoleId, scopeType: "organization", reason: "Synthetic reviewed elevation" });
    expect((await app.inject({ method: "POST", url: "/auth/activation/preview", payload: { token } })).statusCode).toBe(410);
    expect((await pool.query("SELECT revoked_at FROM account_activation_tokens WHERE account_id=$1", [targetId])).rows[0].revoked_at).not.toBeNull();
    await removeRoleAssignment(pool, actors.get("legacy")!.principal, assignmentId);
    await pool.query("UPDATE accounts SET status='active' WHERE id=$1", [targetId]);
  });

  it("resolves an exact OIDC identity into the existing account ID and local RBAC", async () => {
    const principal = actors.get("admin")!.principal;
    const identity = { issuer: "https://identity.example.invalid/realms/synthetic", subject: "opaque:auth011" };
    await pool.query("UPDATE accounts SET identity_issuer=$2, identity_subject=$3 WHERE id=$1", [principal.id, identity.issuer, identity.subject]);
    const state = randomUUID();
    await pool.query("INSERT INTO auth_oidc_transactions(state_hash,code_verifier,nonce,expires_at) VALUES($1,'synthetic','synthetic',now()+interval '1 minute')",
      [createHash("sha256").update(state).digest("hex")]);
    const access = { isAllowed: vi.fn(async () => true) };
    const oidc = new OidcLoginService(pool, { completeAuthorization: vi.fn(async () => identity) } as unknown as OidcProvider,
      access as unknown as SqHubApplicationAccessClient, auth);
    const result = await oidc.complete(new URL(`https://hcis.example.invalid/auth/callback?state=${state}`), context, () => true);
    expect(result.session.principal.id).toBe(principal.id);
    expect(access.isAllowed).toHaveBeenCalledWith(identity);
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: result.setCookie.split(";")[0]! } });
    expect(me.json().authorization.organizationPermissions).toContain("access.manage");
    expect(result.setCookie).toContain("HttpOnly; SameSite=Lax");
    expect(result.setCookie).toContain("Secure");
    expect((await auth.getAuthorizationContext(actors.get("legacy")!.principal)).organizationPermissions).toEqual([...ADMIN_PERMISSIONS]);
  });

  it("ORG-008-8: Super Admin grants Kepala HC only with organization scope and a mandate", async () => {
    // Owner decision 2026-10-24: Kepala HC holds approvals.policy.manage in full, as AUTH-011 defines it.
    // PAY-003 adds the payroll permissions up to submission; approval and payment stay elsewhere.
    const leadRoleId = (await pool.query<{ id: string }>(
      "SELECT id FROM roles WHERE role_key = $1", [HC_LEAD_ROLE_KEY],
    )).rows[0]!.id;
    expect((await pool.query<{ permissionKey: string }>(
      `SELECT permission_key AS "permissionKey" FROM role_permissions WHERE role_id = $1 ORDER BY permission_key`,
      [leadRoleId],
    )).rows.map((row) => row.permissionKey)).toEqual([...HC_LEAD_PERMISSIONS].sort());

    // A fresh account, so earlier cases in this suite cannot colour its permissions.
    const employeeId = randomUUID();
    const accountId = randomUUID();
    await pool.query("INSERT INTO employees(id,employee_number,full_name,status) VALUES ($1,$2,'Synthetic Lead','active')",
      [employeeId, `AUTH011-LEAD-${accountId}`]);
    await pool.query(`INSERT INTO accounts(id,employee_id,email,principal_type,status)
      VALUES($1,$2,$3,'EMPLOYEE','active')`, [accountId, employeeId, `lead-${accountId}@example.invalid`]);
    const legacy = actors.get("legacy")!.principal;

    // A unit-scoped grant would satisfy no organization guard, so it is refused, not stored.
    await expect(createRoleAssignment(pool, legacy, accountId,
      { roleId: leadRoleId, scopeType: "unit", organizationalUnitId: unitId, reason: "Synthetic mandate" }))
      .rejects.toMatchObject({ code: "ADMIN_ORGANIZATION_MANDATE_REQUIRED" });
    await expect(createRoleAssignment(pool, legacy, accountId,
      { roleId: leadRoleId, scopeType: "organization" }))
      .rejects.toMatchObject({ code: "ADMIN_ORGANIZATION_MANDATE_REQUIRED" });

    await createRoleAssignment(pool, legacy, accountId,
      { roleId: leadRoleId, scopeType: "organization", reason: "Synthetic SK Kepala HC" });
    const session = await auth.createSessionForAccountId(accountId, context);
    const granted = await auth.getAuthorizationContext(session.session.principal);
    expect(granted.organizationPermissions.sort()).toEqual([...HC_LEAD_PERMISSIONS].sort());

    // An HC administrator may not grant it, whatever the scope.
    await expect(createRoleAssignment(pool, actors.get("admin")!.principal, accountId,
      { roleId: leadRoleId, scopeType: "organization", reason: "Synthetic delegation attempt" }))
      .rejects.toMatchObject({ code: "ROLE_GRANT_SUPER_ADMIN_ONLY" });
  }, 60000);

  it("§Scope per peran: refuses every assignment whose scope the role cannot use, and offers only the working scopes", async () => {
    const roleIds = new Map((await pool.query<{ id: string; roleKey: string }>(
      `SELECT id, role_key AS "roleKey" FROM roles`,
    )).rows.map((row) => [row.roleKey, row.id] as const));
    const employeeId = randomUUID();
    const accountId = randomUUID();
    await pool.query("INSERT INTO employees(id,employee_number,full_name,status) VALUES ($1,$2,'Synthetic Scope','active')",
      [employeeId, `AUTH011-SCOPE-${accountId}`]);
    await pool.query(`INSERT INTO accounts(id,employee_id,email,principal_type,status)
      VALUES($1,$2,$3,'EMPLOYEE','active')`, [accountId, employeeId, `scope-${accountId}@example.invalid`]);
    const legacy = actors.get("legacy")!.principal;
    const before = (await pool.query("SELECT count(*)::int AS count FROM account_role_assignments WHERE account_id=$1", [accountId])).rows;

    // Organization-only roles: a unit grant would be stored, shown and grant nothing, so it is refused.
    // RPT-001 D-02: finance and management are no longer here; the report routes read unit scope.
    for (const roleKey of ["director", "finance_lead", "finance_officer", "document_corrector"]) {
      await expect(createRoleAssignment(pool, legacy, accountId,
        { roleId: roleIds.get(roleKey)!, scopeType: "unit", organizationalUnitId: unitId, reason: "Synthetic" }), roleKey)
        .rejects.toMatchObject({ statusCode: 400, code: "ROLE_SCOPE_NOT_ALLOWED" });
    }
    // Kepala Unit only names who leads a unit; organization-wide it means nothing.
    await expect(createRoleAssignment(pool, legacy, accountId,
      { roleId: roleIds.get("unit_manager")!, scopeType: "organization", reason: "Synthetic" }))
      .rejects.toMatchObject({ code: "ROLE_SCOPE_NOT_ALLOWED", message: "Peran ini hanya berlaku untuk satu unit." });
    // "own" works for no role.
    await expect(createRoleAssignment(pool, legacy, accountId,
      { roleId: roleIds.get("human_capital")!, scopeType: "own" }))
      .rejects.toMatchObject({ code: "ROLE_SCOPE_NOT_ALLOWED" });
    expect((await pool.query("SELECT count(*)::int AS count FROM account_role_assignments WHERE account_id=$1", [accountId])).rows)
      .toEqual(before);

    // The working scopes still succeed.
    await createRoleAssignment(pool, legacy, accountId,
      { roleId: roleIds.get("director")!, scopeType: "organization", reason: "Synthetic SK Direktur" });
    await createRoleAssignment(pool, legacy, accountId,
      { roleId: roleIds.get("unit_manager")!, scopeType: "unit", organizationalUnitId: unitId, reason: "Synthetic" });
    for (const roleKey of ["finance", "management"]) {
      await createRoleAssignment(pool, legacy, accountId,
        { roleId: roleIds.get(roleKey)!, scopeType: "unit", organizationalUnitId: unitId, reason: "Synthetic RPT-001" });
    }

    // The access screen is told the same policy, so it never offers a scope the API refuses.
    const access = await request("legacy", "GET", "/admin/access");
    expect(access.statusCode, access.body).toBe(200);
    const offered = new Map((access.json().roles as Array<{ roleKey: string; allowedScopes: string[] }>)
      .map((role) => [role.roleKey, role.allowedScopes] as const));
    expect(offered.get("human_capital")).toEqual(["organization", "unit"]);
    expect(offered.get("unit_manager")).toEqual(["unit"]);
    expect(offered.get("director")).toEqual(["organization"]);
    expect(offered.get("finance")).toEqual(["organization", "unit"]);
    expect(offered.get("management")).toEqual(["organization", "unit"]);
    for (const scopes of offered.values()) expect(scopes).not.toContain("own");
  }, 60000);

  it("AUTH-015: a role follows its seat; only Super Admin links; access.* never follows; a loans-only seat sees no pay", async () => {
    const organization = new PostgresOrganizationRepository(pool);
    const legacyId = actors.get("legacy")!.principal.id;
    const employee = actors.get("employee")!;
    const target = actors.get("target")!;
    const seatKey = randomUUID();
    const nodeKey = randomUUID();

    // Publish a structure on a fixed past date: seat "Synthetic Staf Keuangan" held by `employee`.
    async function publish(effectiveOn: string, holderEmployeeId: string, effectiveTo: string | null = null) {
      const draft = await organization.createDraft({ name: `Synthetic AUTH-015 ${effectiveOn}`, effectiveOn, actorAccountId: legacyId });
      if (!draft.nodes.some((node) => node.stableKey === nodeKey)) {
        draft.nodes.push({
          id: randomUUID(), stableKey: nodeKey, name: "Synthetic Keuangan", nodeType: "UNIT", parentNodeKey: null,
          active: true, effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null,
        });
        draft.positions.push({
          id: randomUUID(), stableKey: seatKey, nodeKey, title: "Synthetic Staf Keuangan", parentPositionKey: null,
          singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true, effectiveFrom: "2026-01-01",
          effectiveTo: null, visualRankOffset: 0, holderSource: "EMPLOYEE",
        });
      }
      draft.incumbencies = draft.incumbencies.filter((item) => item.positionKey !== seatKey);
      draft.incumbencies.push({
        id: randomUUID(), positionKey: seatKey, employeeId: holderEmployeeId, accountId: null, kind: "PRIMARY",
        isPrimaryStructural: false, effectiveFrom: effectiveOn, effectiveTo, reason: null,
      });
      await organization.replaceDraftSnapshot(draft);
      await pool.query(
        `UPDATE organization_change_sets SET status = 'PUBLISHED', validated_at = now(), published_at = now(),
           validation_report = '{"valid": true, "issues": []}'::jsonb WHERE id = $1`,
        [draft.changeSet.id],
      );
      return draft.changeSet.id;
    }
    const permissionsOf = async (name: string) =>
      (await auth.getAuthorizationContext(actors.get(name)!.principal)).organizationPermissions;

    await publish("2026-01-01", employee.employeeId!);
    expect(await permissionsOf("employee")).not.toContain("payroll.loans.manage");

    // Linking grants the role to whoever sits there, so everyone but Super Admin is refused first.
    const link = { roleKey: "finance_officer", positionKey: seatKey, reason: "Synthetic owner decision" };
    for (const name of ["admin", "hc", "delegate", "governance", "employee"]) {
      const refused = await request(name, "POST", "/admin/access/role-seat-links", link);
      expect.soft(refused.statusCode, name).toBe(403);
    }
    // A role that administers access can never follow a seat; nor can a unit-only role.
    // management and human_capital can also be granted for one unit; through a seat they would widen to the organization.
    for (const roleKey of ["human_capital_admin", "unit_manager", "governance_leave_approver", "synthetic_account_delegate", "management", "human_capital"]) {
      const refused = await request("legacy", "POST", "/admin/access/role-seat-links", { ...link, roleKey });
      expect.soft(refused.json().code, roleKey).toBe("ROLE_NOT_SEAT_LINKABLE");
    }
    expect((await request("legacy", "POST", "/admin/access/role-seat-links", { ...link, positionKey: randomUUID() })).statusCode).toBe(404);
    expect((await request("legacy", "POST", "/admin/access/role-seat-links", { ...link, reason: " " })).statusCode).toBe(400);
    expect((await pool.query("SELECT 1 FROM access_role_position_links")).rowCount).toBe(0);

    // The grantor sees who the link reaches before saving; a preview writes nothing.
    const preview = await request("legacy", "POST", "/admin/access/role-seat-links", { ...link, preview: true });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().holders).toEqual([expect.objectContaining({
      employeeId: employee.employeeId, kind: "PRIMARY", effectiveFrom: "2026-01-01", effectiveTo: null, accountStatus: "active",
    })]);
    expect((await pool.query("SELECT 1 FROM access_role_position_links")).rowCount).toBe(0);
    const set = await request("legacy", "POST", "/admin/access/role-seat-links", link);
    expect(set.statusCode, set.body).toBe(201);
    expect(set.json().check).toMatchObject({
      roleKey: "finance_officer",
      seats: [{ positionKey: seatKey, title: "Synthetic Staf Keuangan", status: "HELD",
        incumbents: [{ employeeId: employee.employeeId, roleEffective: true }] }],
    });
    expect((await request("legacy", "POST", "/admin/access/role-seat-links", link)).statusCode).toBe(409);
    expect((await pool.query(
      "SELECT payload, actor_source FROM access_audit_events WHERE action = 'role.seat_link.set' ORDER BY occurred_at DESC LIMIT 1",
    )).rows[0]).toMatchObject({
      payload: { roleKey: "finance_officer", positionKey: seatKey, holderEmployeeIds: [employee.employeeId] },
      actor_source: "hcis_break_glass",
    });

    // The seat holder now holds exactly the role's permissions, with no assignment row created.
    const finance = (await pool.query<{ key: string }>(
      `SELECT rp.permission_key AS key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE r.role_key = 'finance_officer' ORDER BY 1`,
    )).rows.map((row) => row.key);
    expect(finance).toEqual(["loans.manage", "loans.read", "payroll.loans.manage"]);
    expect(await permissionsOf("employee")).toEqual(finance);
    expect(await hasOrganizationPermission(pool, employee.principal.id, "payroll.loans.manage")).toBe(true);
    expect((await pool.query(
      "SELECT 1 FROM account_role_assignments WHERE account_id = $1", [employee.principal.id],
    )).rowCount).toBe(0);

    // The Akses screen shows the role apart from direct grants, with the seat it comes from.
    const listed = await request("admin", "GET", `/admin/access?q=${encodeURIComponent("employee@example.invalid")}`);
    expect(listed.statusCode, listed.body).toBe(200);
    const row = (listed.json().accounts as Array<{ id: string; assignments: unknown[]; seatRoles: unknown[] }>)
      .find((item) => item.id === employee.principal.id)!;
    expect(row.assignments).toEqual([]);
    expect(row.seatRoles).toEqual([expect.objectContaining({
      roleKey: "finance_officer", positionKey: seatKey, positionTitle: "Synthetic Staf Keuangan",
      unitName: "Synthetic Keuangan", kind: "PRIMARY", effective: true,
    })]);
    const checks = await request("admin", "GET", "/admin/access/role-seat-checks");
    expect(checks.json().linkableRoles.map((role: { roleKey: string }) => role.roleKey))
      .toEqual(expect.arrayContaining(["finance_officer", "director", "human_capital_lead"]));
    expect(checks.json().linkableRoles.map((role: { roleKey: string }) => role.roleKey))
      .not.toContain("human_capital_admin");

    // "Tidak bisa lihat gaji utuh": a loans-only account reaches the kasbon registers and nothing
    // that carries pay. Each guard runs before the period or employment is looked up.
    const anyId = randomUUID();
    for (const [method, url] of [
      ["GET", "/payroll/periods"],
      ["GET", `/payroll/periods/${anyId}`],
      ["GET", `/payroll/periods/${anyId}/inputs`],
      ["GET", `/payroll/periods/${anyId}/results`],
      ["GET", `/payroll/periods/${anyId}/report`],
      ["GET", `/payroll/periods/${anyId}/transfers`],
      ["GET", `/payroll/periods/${anyId}/variance`],
      ["GET", `/payroll/employments/${anyId}/compensation-profiles`],
      ["GET", "/payroll/policies"],
      ["GET", "/admin/payslip-imports"],
      ["GET", `/admin/payslip-imports/${anyId}`],
      ["GET", "/admin/employees"],
      ["GET", `/admin/employees/${employee.employeeId}`],
    ] as const) {
      const response = await request("employee", method, url);
      expect.soft(response.statusCode, `${method} ${url}`).toBe(403);
    }
    for (const url of ["/payroll/loans", "/admin/loans", "/payroll/employments?q=Synthetic"]) {
      const response = await request("employee", "GET", url);
      expect.soft(response.statusCode, url).toBe(200);
    }
    // The kasbon picker names people and counts profiles; it carries no amount.
    const picker = await request("employee", "GET", "/payroll/employments?q=Synthetic");
    for (const item of picker.json().employments as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(
        ["employeeId", "employeeNumber", "employmentId", "endedOn", "fullName", "profileCount", "startedOn"],
      );
    }

    // The role is in force only for an active account and employee, like a direct grant.
    await pool.query("UPDATE accounts SET status = 'invited' WHERE id = $1", [employee.principal.id]);
    expect(await hasOrganizationPermission(pool, employee.principal.id, "payroll.loans.manage")).toBe(false);
    await pool.query("UPDATE accounts SET status = 'active' WHERE id = $1", [employee.principal.id]);
    await pool.query("UPDATE employees SET status = 'inactive' WHERE id = $1", [employee.employeeId]);
    expect(await hasOrganizationPermission(pool, employee.principal.id, "payroll.loans.manage")).toBe(false);
    await pool.query("UPDATE employees SET status = 'active' WHERE id = $1", [employee.employeeId]);

    // access.* never follows a seat, even if a link to such a role exists in the table.
    await pool.query(
      "INSERT INTO access_role_position_links (role_key, position_key, reason) VALUES ('human_capital_admin', $1, 'Synthetic bypass')",
      [seatKey],
    );
    const withAdmin = await permissionsOf("employee");
    expect(withAdmin).toContain("employees.manage");
    expect(withAdmin.filter((key) => key.startsWith("access."))).toEqual([]);
    expect(await hasOrganizationPermission(pool, employee.principal.id, "access.manage")).toBe(false);
    await pool.query("DELETE FROM access_role_position_links WHERE role_key = 'human_capital_admin'");

    // A publisher cannot seat themselves into a role-linked seat; carrying it over unchanged is fine.
    const selfDraft = await organization.createDraft({ name: "Synthetic AUTH-015 self", effectiveOn: "2026-03-01", actorAccountId: legacyId });
    selfDraft.incumbencies.push({
      id: randomUUID(), positionKey: seatKey, employeeId: actors.get("hc")!.employeeId!, accountId: null, kind: "ACTING",
      isPrimaryStructural: false, effectiveFrom: "2026-03-01", effectiveTo: null, reason: "Synthetic",
    });
    await organization.replaceDraftSnapshot(selfDraft);
    expect(await organization.publisherGainsLinkedSeat(selfDraft.changeSet.id, actors.get("hc")!.principal.id)).toBe(true);
    expect(await organization.publisherGainsLinkedSeat(selfDraft.changeSet.id, employee.principal.id)).toBe(false);
    expect(await organization.publisherGainsLinkedSeat(selfDraft.changeSet.id, legacyId)).toBe(false);
    await pool.query("DELETE FROM organization_change_sets WHERE id = $1", [selfDraft.changeSet.id]);

    // The seat changes hands: the role moves with it at the next request, with no further step.
    await publish("2026-02-01", target.employeeId!);
    expect(await permissionsOf("employee")).toEqual([]);
    expect(await permissionsOf("target")).toEqual(finance);
    // Getting a seat back is a gain too, even with a row identical to one published long ago.
    const regain = await organization.createDraft({ name: "Synthetic AUTH-015 regain", effectiveOn: "2026-02-15", actorAccountId: legacyId });
    regain.incumbencies = regain.incumbencies.filter((item) => item.positionKey !== seatKey);
    regain.incumbencies.push({
      id: randomUUID(), positionKey: seatKey, employeeId: employee.employeeId!, accountId: null, kind: "PRIMARY",
      isPrimaryStructural: false, effectiveFrom: "2026-01-01", effectiveTo: null, reason: null,
    });
    await organization.replaceDraftSnapshot(regain);
    expect(await organization.publisherGainsLinkedSeat(regain.changeSet.id, employee.principal.id)).toBe(true);
    expect(await organization.publisherGainsLinkedSeat(regain.changeSet.id, target.principal.id)).toBe(false);
    expect(await organization.linkedSeatHolderChanges(regain.changeSet.id)).toEqual([
      { roleKey: "finance_officer", positionKey: seatKey, employeeId: employee.employeeId, change: "gained" },
      { roleKey: "finance_officer", positionKey: seatKey, employeeId: target.employeeId, change: "lost" },
    ].sort((left, right) => left.employeeId!.localeCompare(right.employeeId!)));
    await pool.query("DELETE FROM organization_change_sets WHERE id = $1", [regain.changeSet.id]);
    // An incumbency that has ended confers nothing.
    await publish("2026-03-01", target.employeeId!, "2026-03-31");
    expect(await permissionsOf("target")).toEqual([]);
    await publish("2026-04-01", employee.employeeId!);

    // Through the route: a holder of the publish permission who did not compose the change set is
    // still refused when it seats them in a role-linked seat.
    const leadRoleId = (await pool.query("SELECT id FROM roles WHERE role_key = $1", [HC_LEAD_ROLE_KEY])).rows[0].id;
    const leadGrant = randomUUID();
    await pool.query(
      `INSERT INTO account_role_assignments(id, account_id, role_id, scope_type, reason)
       VALUES ($1, $2, $3, 'organization', 'Synthetic publisher')`,
      [leadGrant, actors.get("hc")!.principal.id, leadRoleId],
    );
    const routeDraft = await organization.createDraft({ name: "Synthetic AUTH-015 route", effectiveOn: "2026-05-01", actorAccountId: legacyId });
    routeDraft.incumbencies = routeDraft.incumbencies.filter((item) => item.positionKey !== seatKey);
    routeDraft.incumbencies.push({
      id: randomUUID(), positionKey: seatKey, employeeId: actors.get("hc")!.employeeId!, accountId: null, kind: "PRIMARY",
      isPrimaryStructural: false, effectiveFrom: "2026-05-01", effectiveTo: null, reason: null,
    });
    await organization.replaceDraftSnapshot(routeDraft);
    await pool.query(
      `UPDATE organization_change_sets SET status = 'VALIDATED', validated_at = now(),
         validation_report = '{"valid": true, "issues": []}'::jsonb WHERE id = $1`,
      [routeDraft.changeSet.id],
    );
    const selfPublish = await request("hc", "POST", `/admin/organization/designer/drafts/${routeDraft.changeSet.id}/publish`);
    expect(selfPublish.statusCode, selfPublish.body).toBe(403);
    expect(selfPublish.json().code).toBe("ORGANIZATION_PUBLISH_SELF_ROLE_SEAT");
    expect((await pool.query("SELECT status FROM organization_change_sets WHERE id = $1", [routeDraft.changeSet.id])).rows[0].status)
      .toBe("VALIDATED");
    // Super Admin (no employee, exempt from four eyes) may publish it; the role moving is audited
    // in the access audit, one row per person gaining or losing it.
    const published = await request("legacy", "POST", `/admin/organization/designer/drafts/${routeDraft.changeSet.id}/publish`);
    expect(published.statusCode, published.body).toBe(200);
    const moved = await pool.query(
      `SELECT action, entity_id AS "employeeId", payload FROM access_audit_events
        WHERE action LIKE 'role.seat_holder.%' AND payload->>'changeSetId' = $1 ORDER BY action`,
      [routeDraft.changeSet.id],
    );
    expect(moved.rows).toEqual([
      { action: "role.seat_holder.gained", employeeId: actors.get("hc")!.employeeId, payload: expect.objectContaining({ roleKey: "finance_officer", positionKey: seatKey }) },
      { action: "role.seat_holder.lost", employeeId: employee.employeeId, payload: expect.objectContaining({ roleKey: "finance_officer", positionKey: seatKey }) },
    ]);
    expect(await permissionsOf("hc")).toEqual(expect.arrayContaining(finance));
    await pool.query("DELETE FROM account_role_assignments WHERE id = $1", [leadGrant]);
    await publish("2026-06-01", employee.employeeId!);
    expect(await permissionsOf("employee")).toEqual(finance);

    // Removing the link is audited and removes the role from the seat holder.
    expect((await request("admin", "DELETE", `/admin/access/role-seat-links/finance_officer/${seatKey}`, { reason: "x" })).statusCode).toBe(403);
    expect((await request("legacy", "DELETE", `/admin/access/role-seat-links/finance_officer/${seatKey}`, {})).statusCode).toBe(400);
    const cleared = await request("legacy", "DELETE", `/admin/access/role-seat-links/finance_officer/${seatKey}`, { reason: "Synthetic reset" });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toEqual({ roleKey: "finance_officer", check: null });
    expect((await request("legacy", "DELETE", `/admin/access/role-seat-links/finance_officer/${seatKey}`, { reason: "again" })).statusCode).toBe(404);
    expect((await pool.query("SELECT 1 FROM access_audit_events WHERE action = 'role.seat_link.cleared'")).rowCount).toBe(1);
    expect(await permissionsOf("employee")).toEqual([]);
  }, 120000);

  it("ORG-008-10: counts as composers the creator and every editor, never the checker", async () => {
    const organization = new PostgresOrganizationRepository(pool);
    const creator = actors.get("admin")!.principal.id;
    const editor = actors.get("delegate")!.principal.id;
    const checker = actors.get("hc")!.principal.id;
    const draft = await organization.createDraft({
      name: "Synthetic ORG-008-10", effectiveOn: "2027-03-01", actorAccountId: creator,
    });
    const event = (actor: string, action: string) => pool.query(
      `INSERT INTO organization_audit_events (id, actor_account_id, action, entity_type, entity_id, change_set_id, payload)
       VALUES ($1, $2, $3, 'organization_change_set', $4, $4, '{}'::jsonb)`,
      [randomUUID(), actor, action, draft.changeSet.id],
    );
    await event(editor, "organization.node.updated");
    await event(checker, "organization.draft.validated");
    await event(checker, "organization.draft.reopened");

    expect((await organization.listChangeSetComposers(draft.changeSet.id)).sort()).toEqual([creator, editor].sort());
    await pool.query("UPDATE organization_change_sets SET status = 'DISCARDED' WHERE id = $1", [draft.changeSet.id]);
  }, 60000);

  it("ORG-005-2: device location and the in-use guard run against PostgreSQL", async () => {
    const created = await request("admin", "POST", "/admin/attendance/work-locations",
      { name: "Synthetic Kampus", latitude: -6.2, longitude: 106.8, radiusMeters: 100 });
    expect(created.statusCode, created.body).toBe(201);
    const locationId = created.json().id as string;

    // The device profile reads the location name with a correlated subselect.
    const missing = randomUUID();
    expect((await request("admin", "GET", `/admin/attendance/adms/devices/${missing}/wdms-profile`)).statusCode).toBe(404);
    expect((await request("admin", "PATCH", `/admin/attendance/adms/devices/${missing}/wdms-profile`,
      { workLocationId: locationId })).statusCode).toBe(404);

    // Nothing uses it yet, so it can be switched off; the uses query runs on the real schema.
    const off = await request("admin", "PATCH", `/admin/attendance/work-locations/${locationId}`, { active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect((await pool.query("SELECT active FROM attendance_work_locations WHERE id = $1", [locationId])).rows[0].active).toBe(false);
  }, 60000);
});

const migrationCompatibilitySchema = `auth011_migration_${randomUUID().replaceAll("-", "")}`;
const governanceRoleId = "10000000-0000-4000-8000-000000000006";
const humanCapitalAdminRoleId = "f0d1fad8-bbbf-49b8-a42f-f534ce14da27";
const sensitiveDevicePermissions = [
  "attendance.devices.read",
  "attendance.devices.configure",
  "attendance.devices.operate",
  "attendance.devices.export",
  "attendance.devices.destructive",
  "attendance.devices.firmware",
  "attendance.devices.biometrics",
];

describe.skipIf(!databaseUrl)("AUTH-011 migration 0045 production compatibility", () => {
  let pool: Pool;
  let control: Pool;
  let migrationSql: string;
  let governanceAssignmentId: string;
  let ordinaryHumanCapitalPermissions: string[];

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/hcis_auth011_permissions_test") {
      throw new Error("AUTH-011 migration integration requires an isolated loopback hcis_auth011_permissions_test database");
    }

    control = new Pool({ connectionString: databaseUrl });
    await control.query(`CREATE SCHEMA ${migrationCompatibilitySchema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${migrationCompatibilitySchema},public` });

    const migrations = new URL("../migrations/", import.meta.url);
    const files = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort();
    const priorMigrations = files.filter((name) => name < "0045_hcis_human_capital_admin.sql");
    for (const file of priorMigrations) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
    migrationSql = await readFile(new URL("0045_hcis_human_capital_admin.sql", migrations), "utf8");
    await pool.query(`CREATE TABLE schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query("INSERT INTO schema_migrations(name) SELECT unnest($1::text[])", [priorMigrations]);

    // Production retained this role from 0023_leave_approval_principals.sql, which is part of the
    // main migration chain again since PR #59; the prior migrations above must have seeded it.
    expect(
      (await pool.query(
        `SELECT role.id FROM roles role JOIN role_permissions grant_row ON grant_row.role_id = role.id
         WHERE role.role_key='governance_leave_approver' AND grant_row.permission_key='leave.governance.approve'`,
      )).rows,
    ).toEqual([{ id: governanceRoleId }]);

    const employeeId = randomUUID();
    const accountId = randomUUID();
    governanceAssignmentId = randomUUID();
    await pool.query(
      "INSERT INTO employees(id,employee_number,full_name,status) VALUES($1,$2,'Synthetic Governance Assignee','active')",
      [employeeId, `AUTH011-MIGRATION-${employeeId}`],
    );
    await pool.query(
      "INSERT INTO accounts(id,employee_id,email,principal_type,status) VALUES($1,$2,$3,'EMPLOYEE','active')",
      [accountId, employeeId, `${accountId}@example.invalid`],
    );
    await pool.query(
      `INSERT INTO account_role_assignments(id,account_id,role_id,scope_type,reason)
       VALUES($1,$2,$3,'organization','Synthetic pre-0045 governance assignment')`,
      [governanceAssignmentId, accountId, governanceRoleId],
    );
    ordinaryHumanCapitalPermissions = (
      await pool.query<{ permissionKey: string }>(
        `SELECT permission_key AS "permissionKey" FROM role_permissions
         WHERE role_id=(SELECT id FROM roles WHERE role_key='human_capital') ORDER BY permission_key`,
      )
    ).rows.map((row) => row.permissionKey);
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    if (control) {
      await control.query(`DROP SCHEMA ${migrationCompatibilitySchema} CASCADE`);
      await control.end();
    }
  });

  async function runPending0045() {
    const recorded = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name='0045_hcis_human_capital_admin.sql'",
    );
    if (recorded.rowCount) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migrationSql);
      await client.query("INSERT INTO schema_migrations(name) VALUES('0045_hcis_human_capital_admin.sql')");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("preserves the existing governance role and assignment while applying 0045 exactly once", async () => {
    expect(
      (await pool.query("SELECT id FROM roles WHERE role_key='governance_leave_approver'")).rows,
    ).toEqual([{ id: governanceRoleId }]);

    await runPending0045();
    await runPending0045();

    expect(
      (await pool.query("SELECT id FROM roles WHERE role_key='governance_leave_approver'")).rows,
    ).toEqual([{ id: governanceRoleId }]);
    expect(
      (await pool.query("SELECT id,role_id FROM account_role_assignments WHERE id=$1", [governanceAssignmentId])).rows,
    ).toEqual([{ id: governanceAssignmentId, role_id: governanceRoleId }]);
    expect(
      (await pool.query("SELECT id FROM roles WHERE role_key='human_capital_admin'")).rows,
    ).toEqual([{ id: humanCapitalAdminRoleId }]);

    const adminPermissions = (
      await pool.query<{ permissionKey: string }>(
        `SELECT permission_key AS "permissionKey" FROM role_permissions
         WHERE role_id=$1 ORDER BY permission_key`,
        [humanCapitalAdminRoleId],
      )
    ).rows.map((row) => row.permissionKey);
    // 0045's own bundle; 0046-0050 extend it to HC_ADMIN_PERMISSIONS, asserted by the suite above.
    expect(adminPermissions).toEqual([...HC_OPERATIONAL_PERMISSIONS, "organization.manage", "access.manage",
      "access.roles.assign", "leave.configuration.manage", "attendance.records.manage"].sort());
    expect(adminPermissions.filter((permission) => sensitiveDevicePermissions.includes(permission))).toEqual([]);
    expect(adminPermissions.filter((permission) => [
      "leave.approve", "leave.hc.approve", "leave.governance.approve",
    ].includes(permission))).toEqual([]);

    expect(
      (
        await pool.query<{ permissionKey: string }>(
          `SELECT permission_key AS "permissionKey" FROM role_permissions
           WHERE role_id=(SELECT id FROM roles WHERE role_key='human_capital') ORDER BY permission_key`,
        )
      ).rows.map((row) => row.permissionKey),
    ).toEqual(ordinaryHumanCapitalPermissions);
    expect(
      (await pool.query(
        "SELECT count(*)::int AS count FROM schema_migrations WHERE name='0045_hcis_human_capital_admin.sql'",
      )).rows,
    ).toEqual([{ count: 1 }]);
  }, 60000);
});
