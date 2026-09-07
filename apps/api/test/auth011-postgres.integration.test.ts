import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { AuthService, type AuthPrincipal } from "../src/modules/auth/service.js";
import { ADMIN_PERMISSIONS, HC_ADMIN_PERMISSIONS, hasOrganizationPermission } from "../src/modules/auth/permissions.js";
import { createRoleAssignment, removeRoleAssignment } from "../src/modules/auth/role-assignment.js";
import { OidcLoginService } from "../src/modules/auth/oidc-service.js";
import type { OidcProvider } from "../src/modules/auth/oidc-provider.js";
import type { SqHubApplicationAccessClient } from "../src/modules/auth/application-access.js";

const databaseUrl = process.env.HCIS_AUTH011_TEST_DATABASE_URL;
const schema = `auth011_${randomUUID().replaceAll("-", "")}`;
const context = { ipAddress: "127.0.0.1", userAgent: "synthetic-auth011" };

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
    for (const name of ["employee", "unit_hc", "admin", "board", "legacy", "target", "unit_admin", "delegate", "governance"]) {
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
    for (const [name, roleId, scope, unit] of [["unit_hc", hcRoleId, "unit", unitId], ["admin", adminRoleId, "organization", null], ["unit_admin", adminRoleId, "unit", unitId]] as const) {
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
      AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8 }, pool);
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
    expect((await auth.getAuthorizationContext(actors.get("unit_hc")!.principal)).organizationPermissions).toEqual([]);
    expect((await auth.getAuthorizationContext(actors.get("unit_admin")!.principal)).organizationPermissions).toEqual([]);
    const before = await pool.query("SELECT count(*)::int AS count FROM account_role_assignments");
    await pool.query(await readFile(new URL("../migrations/0045_hcis_human_capital_admin.sql", import.meta.url), "utf8"));
    expect((await pool.query("SELECT count(*)::int AS count FROM account_role_assignments")).rows).toEqual(before.rows);
  });

  it("server-authorizes all 137 transitional administrative routes independently of navigation", async () => {
    const manifest = JSON.parse(await readFile(new URL("../../../docs/domain/AUTH-011-admin-route-permissions.json", import.meta.url), "utf8")) as
      Array<{ method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT"; url: string; permissions: string[] }>;
    const routes = manifest.flatMap((route) => route.url.includes("${spec.path}")
      ? ["clear-attendance", "clear-photo", "clear-all"].map((path) => ({ ...route, url: route.url.replace("${spec.path}", path) })) : [route]);
    expect(routes).toHaveLength(137);
    for (const route of routes) {
      // An invalid object ID tests that authorization precedes business validation.
      const url = route.url.replace(/:[A-Za-z]+/g, "invalid-resource-id");
      for (const name of [null, "employee", "unit_hc", "unit_admin", "board"]) {
        const response = await request(name, route.method, url);
        expect(response.statusCode, `${name} ${route.method} ${url}`).toBe(name ? 403 : 401);
      }
      const allowed = route.permissions.every((key) => (HC_ADMIN_PERMISSIONS as readonly string[]).includes(key));
      const admin = await request("admin", route.method, url);
      if (!allowed) expect(admin.statusCode, `admin ${url}`).toBe(403);
      else expect([401, 403, 500].includes(admin.statusCode), `admin ${route.method} ${url}: ${admin.body}`).toBe(false);
      const legacy = await request("legacy", route.method, url);
      expect([401, 403, 500].includes(legacy.statusCode), `legacy ${route.method} ${url}: ${legacy.body}`).toBe(false);
    }
  }, 60000);

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
    const target = actors.get("target")!.principal.id;
    const api = `/admin/access/accounts/${target}/role-assignments`;
    expect((await request("admin", "POST", `/admin/access/accounts/${admin.id}/role-assignments`, { roleId: hcRoleId, scopeType: "organization" })).statusCode).toBe(403);
    expect((await request("admin", "POST", api, { roleId: adminRoleId, scopeType: "organization", reason: "Synthetic mandate" })).statusCode).toBe(403);
    const special = await pool.query("SELECT id FROM roles WHERE role_key='special_approver'");
    expect((await request("admin", "POST", api, { roleId: special.rows[0].id, scopeType: "organization" })).statusCode).toBe(403);
    expect((await request("admin", "POST", api, { roleId: hcRoleId, scopeType: "unit" })).statusCode).toBe(400);
    expect((await request("admin", "POST", api, { roleId: hcRoleId, scopeType: "organization", organizationalUnitId: unitId })).statusCode).toBe(400);
    await pool.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'attendance.devices.destructive')", [hcRoleId]);
    expect((await request("admin", "POST", api, { roleId: hcRoleId, scopeType: "organization" })).statusCode).toBe(403);
    await pool.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_key='attendance.devices.destructive'", [hcRoleId]);
    const created = await request("admin", "POST", api, { roleId: hcRoleId, scopeType: "unit", organizationalUnitId: unitId, reason: "Synthetic operation" });
    expect(created.statusCode).toBe(201);
    expect((await request("admin", "DELETE", `/admin/access/role-assignments/${created.json().id}`)).statusCode).toBe(204);
    expect((await request("legacy", "POST", api, { roleId: adminRoleId, scopeType: "unit", organizationalUnitId: unitId, reason: "Synthetic mandate" })).statusCode).toBe(400);
    const promoted = await request("legacy", "POST", api, { roleId: adminRoleId, scopeType: "organization", reason: "Reviewed synthetic mandate" });
    expect(promoted.statusCode).toBe(201);
    expect((await request("target", "GET", "/auth/me")).json().authorization.organizationPermissions).toContain("access.manage");
    expect((await request("admin", "DELETE", `/admin/access/role-assignments/${promoted.json().id}`)).statusCode).toBe(403);
    await removeRoleAssignment(pool, actors.get("legacy")!.principal, promoted.json().id);
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

  it("rolls back role assignment if the audit insert fails", async () => {
    await pool.query(`CREATE FUNCTION fail_auth011_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
      CREATE TRIGGER fail_auth011_audit BEFORE INSERT ON access_audit_events FOR EACH ROW EXECUTE FUNCTION fail_auth011_audit()`);
    const before = (await pool.query("SELECT count(*)::int AS count FROM account_role_assignments")).rows;
    await expect(createRoleAssignment(pool, actors.get("admin")!.principal, actors.get("target")!.principal.id,
      { roleId: hcRoleId, scopeType: "organization" })).rejects.toThrow("synthetic audit failure");
    expect((await pool.query("SELECT count(*)::int AS count FROM account_role_assignments")).rows).toEqual(before);
    await pool.query("DROP TRIGGER fail_auth011_audit ON access_audit_events");
  });

  it("revokes an earlier operational-admin invitation when the target is elevated", async () => {
    const targetId = actors.get("target")!.principal.id;
    await pool.query("UPDATE accounts SET status='invited' WHERE id=$1", [targetId]);
    const issued = await request("admin", "POST", `/admin/access/accounts/${targetId}/activation`);
    expect(issued.statusCode).toBe(201);
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
    const result = await oidc.complete(new URL(`https://hcis.example.invalid/auth/callback?state=${state}`), context);
    expect(result.session.principal.id).toBe(principal.id);
    expect(access.isAllowed).toHaveBeenCalledWith(identity);
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: result.setCookie.split(";")[0]! } });
    expect(me.json().authorization.organizationPermissions).toContain("access.manage");
    expect(result.setCookie).toContain("HttpOnly; SameSite=Lax");
    expect(result.setCookie).toContain("Secure");
    expect((await auth.getAuthorizationContext(actors.get("legacy")!.principal)).organizationPermissions).toEqual([...ADMIN_PERMISSIONS]);
  });
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

    // Production retained this role from the historical 0023_leave_approval_principals.sql migration,
    // whose source commit is not an ancestor of the current main migration chain.
    await pool.query(
      "INSERT INTO permissions(permission_key,description) VALUES('leave.governance.approve','Synthetic historical permission')",
    );
    await pool.query(
      `INSERT INTO roles(id,role_key,name,description,is_system)
       VALUES($1,'governance_leave_approver','Governance Leave Approver','Synthetic historical role',true)`,
      [governanceRoleId],
    );
    await pool.query(
      "INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'leave.governance.approve')",
      [governanceRoleId],
    );

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
    expect(adminPermissions).toEqual([...HC_ADMIN_PERMISSIONS].sort());
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
