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
    expect(manifest.filter((route) => route.access === undefined)).toHaveLength(208);
    expect(manifest.filter((route) => route.access === "super-admin")).toHaveLength(3);
    expect(manifest.filter((route) => route.access === "hc-operational")).toHaveLength(12);
    expect(manifest.filter((route) => route.access === "self-service")).toHaveLength(39);
    expect(manifest.filter((route) => route.access === "board")).toHaveLength(1);
    expect(manifest.filter((route) => route.access === "governance-bearer")).toHaveLength(1);
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

  it("ORG-008-9: compares Kepala HC role holders with the Kepala HC seat, and only Super Admin sets the seat", async () => {
    // Before a seat is chosen there is nothing to compare, and the check says so.
    const before = await request("admin", "GET", "/admin/access/role-seat-checks");
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().items).toMatchObject([{ roleKey: HC_LEAD_ROLE_KEY, status: "SEAT_NOT_SET", mismatches: [] }]);

    // A published structure whose Kepala HC seat is held by the "employee" actor.
    const organization = new PostgresOrganizationRepository(pool);
    const draft = await organization.createDraft({
      name: "Synthetic ORG-008-9", effectiveOn: "2026-01-01", actorAccountId: actors.get("legacy")!.principal.id,
    });
    const seatKey = randomUUID();
    const nodeKey = randomUUID();
    const seatHolder = actors.get("employee")!.employeeId!;
    draft.nodes.push({
      id: randomUUID(), stableKey: nodeKey, name: "Synthetic Human Capital", nodeType: "UNIT", parentNodeKey: null,
      active: true, effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null,
    });
    draft.positions.push({
      id: randomUUID(), stableKey: seatKey, nodeKey, title: "Synthetic Kepala HC", parentPositionKey: null,
      singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true, effectiveFrom: "2026-01-01",
      effectiveTo: null, visualRankOffset: 0, holderSource: "EMPLOYEE",
    });
    draft.incumbencies.push({
      id: randomUUID(), positionKey: seatKey, employeeId: seatHolder, accountId: null, kind: "PRIMARY",
      isPrimaryStructural: false, effectiveFrom: "2026-01-01", effectiveTo: null, reason: null,
    });
    await organization.replaceDraftSnapshot(draft);
    await pool.query(
      `UPDATE organization_change_sets SET status = 'PUBLISHED', validated_at = now(), published_at = now(),
         validation_report = '{"valid": true, "issues": []}'::jsonb WHERE id = $1`,
      [draft.changeSet.id],
    );

    const link = { positionKey: seatKey, reason: "Synthetic SK Kepala HC" };
    // Choosing the seat is part of granting the role: everyone but Super Admin is refused first.
    for (const name of ["admin", "hc", "delegate", "employee"]) {
      const refused = await request(name, "PUT", `/admin/access/role-seat-links/${HC_LEAD_ROLE_KEY}`, link);
      expect.soft(refused.statusCode, name).toBe(403);
    }
    expect((await request("legacy", "PUT", `/admin/access/role-seat-links/${HC_LEAD_ROLE_KEY}`,
      { positionKey: randomUUID(), reason: "Synthetic" })).statusCode).toBe(404);

    const set = await request("legacy", "PUT", `/admin/access/role-seat-links/${HC_LEAD_ROLE_KEY}`, link);
    expect(set.statusCode, set.body).toBe(200);
    const check = set.json();
    expect(check).toMatchObject({ status: "CHECKED", seat: { positionKey: seatKey, title: "Synthetic Kepala HC" } });
    // The seat holder has an account but not the role; nothing was granted to make them match.
    expect(check.mismatches).toContainEqual(expect.objectContaining({
      kind: "SEATED_WITHOUT_ROLE", employeeId: seatHolder, incumbentKind: "PRIMARY", reason: "NO_ROLE",
    }));
    for (const holder of check.holders as Array<{ accountId: string }>) {
      expect(check.mismatches).toContainEqual(expect.objectContaining({ kind: "HOLDER_NOT_SEATED", accountId: holder.accountId }));
    }
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM account_role_assignments ara
       JOIN accounts a ON a.id = ara.account_id JOIN roles r ON r.id = ara.role_id
       WHERE a.employee_id = $1 AND r.role_key = $2`, [seatHolder, HC_LEAD_ROLE_KEY],
    )).rows[0].count).toBe(0);
    expect((await pool.query(
      "SELECT payload FROM access_audit_events WHERE action = 'role.seat_link.set' ORDER BY occurred_at DESC LIMIT 1",
    )).rows[0].payload).toMatchObject({ roleKey: HC_LEAD_ROLE_KEY, positionKey: seatKey });

    // Clearing goes back to "no seat chosen" and is audited too.
    const cleared = await request("legacy", "PUT", `/admin/access/role-seat-links/${HC_LEAD_ROLE_KEY}`,
      { positionKey: null, reason: "Synthetic reset" });
    expect(cleared.json()).toMatchObject({ status: "SEAT_NOT_SET" });
    expect((await pool.query("SELECT 1 FROM access_audit_events WHERE action = 'role.seat_link.cleared'")).rowCount).toBe(1);
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
