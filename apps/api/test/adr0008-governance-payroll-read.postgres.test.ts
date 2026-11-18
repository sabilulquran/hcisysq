import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GOVERNANCE_PAYROLL_READ_PERMISSION,
  GOVERNANCE_PAYROLL_READER_ROLE_KEY,
  hasOrganizationPermission,
} from "../src/modules/auth/permissions.js";
import { createRoleAssignment } from "../src/modules/auth/role-assignment.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  assertGovernancePayrollReadCapability,
  GovernancePayrollDenied,
} from "../src/modules/governance/payroll-read.js";

// ADR-0008 against real SQL: migration 0180, the grant guard and the capability query. Isolated
// loopback database and a disposable schema; synthetic data only.
const databaseUrl = process.env.HCIS_AUTH011_TEST_DATABASE_URL;
const schema = `adr0008_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!databaseUrl)("ADR-0008 payroll read for Pengurus Yayasan (PostgreSQL)", () => {
  let pool: Pool;
  let control: Pool;
  let readerRoleId: string;
  let viewerRoleId: string;
  let superAdmin: AuthPrincipal;

  async function employee(email: string | null, status = "active") {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO employees(id,employee_number,full_name,status,email) VALUES ($1,$2,'Pegawai Sintetis',$3,$4)",
      [id, `ADR0008-${id}`, status, email],
    );
    return id;
  }

  async function account(input: {
    principalType: "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
    email: string;
    employeeId?: string | null;
  }) {
    const id = randomUUID();
    const isSuper = input.principalType === "SUPER_ADMIN";
    await pool.query(
      `INSERT INTO accounts(id,employee_id,email,principal_type,status,identity_issuer,identity_subject,
         mfa_enabled_at,mfa_secret_ciphertext,mfa_secret_iv,mfa_secret_tag)
       VALUES($1,$2,$3,$4,'active',$5,$6,$7,$8,$8,$8)`,
      [id, input.employeeId ?? null, input.email, input.principalType,
        "https://login.example.invalid/realms/staff", `subject-${id}`,
        isSuper ? new Date() : null, isSuper ? "synthetic" : null],
    );
    return id;
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/hcis_auth011_permissions_test") {
      throw new Error("ADR-0008 integration requires the isolated loopback hcis_auth011_permissions_test database");
    }
    control = new Pool({ connectionString: databaseUrl });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const migrations = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
    const roles = await pool.query<{ id: string; key: string }>("SELECT id, role_key AS key FROM roles");
    readerRoleId = roles.rows.find((row) => row.key === GOVERNANCE_PAYROLL_READER_ROLE_KEY)!.id;
    viewerRoleId = roles.rows.find((row) => row.key === "foundation_board_viewer")!.id;
    superAdmin = { id: await account({ principalType: "SUPER_ADMIN", email: "super@example.invalid" }), principalType: "SUPER_ADMIN" } as AuthPrincipal;
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    if (control) {
      await control.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.end();
    }
  });

  it("creates the role carrying exactly one permission, and gives it to no account", async () => {
    const permissions = await pool.query<{ key: string }>(
      "SELECT permission_key AS key FROM role_permissions WHERE role_id = $1", [readerRoleId],
    );
    expect(permissions.rows.map((row) => row.key)).toEqual([GOVERNANCE_PAYROLL_READ_PERMISSION]);

    const holders = await pool.query("SELECT 1 FROM account_role_assignments WHERE role_id = $1", [readerRoleId]);
    expect(holders.rowCount).toBe(0);

    // No HC bundle, no payroll role and no legacy Super Admin bundle picks the key up.
    const others = await pool.query<{ key: string }>(
      `SELECT role.role_key AS key FROM role_permissions grant_row
       JOIN roles role ON role.id = grant_row.role_id
       WHERE grant_row.permission_key = $1`, [GOVERNANCE_PAYROLL_READ_PERMISSION],
    );
    expect(others.rows.map((row) => row.key)).toEqual([GOVERNANCE_PAYROLL_READER_ROLE_KEY]);
  });

  it("grants the capability to an organ account, and only through an in-date assignment", async () => {
    const organ = await account({ principalType: "FOUNDATION_BOARD", email: "bendahara@example.invalid" });
    await expect(assertGovernancePayrollReadCapability(pool, organ))
      .rejects.toBeInstanceOf(GovernancePayrollDenied);

    const assignment = await createRoleAssignment(pool, superAdmin, organ, {
      roleId: readerRoleId, scopeType: "organization",
      reason: "SK Kepengurusan 001/2026", endsOn: "2030-12-31",
    });
    await expect(assertGovernancePayrollReadCapability(pool, organ)).resolves.toBeUndefined();

    // An assignment whose term has ended confers nothing, as ORG-013-2 requires of a term role.
    await pool.query("UPDATE account_role_assignments SET ends_on = '2026-01-31' WHERE id = $1", [assignment]);
    await expect(assertGovernancePayrollReadCapability(pool, organ))
      .rejects.toMatchObject({ statusCode: 403, code: "PAYROLL_READ_FORBIDDEN" });
  });

  it("refuses the grant without an end date, without a reason, or outside organization scope", async () => {
    const organ = await account({ principalType: "FOUNDATION_BOARD", email: "ketua@example.invalid" });
    const unit = randomUUID();
    await pool.query(
      "INSERT INTO organizational_units(id,name,normalized_name) VALUES ($1,'Unit Sintetis',$2)",
      [unit, `unit-${unit}`],
    );

    await expect(createRoleAssignment(pool, superAdmin, organ, {
      roleId: readerRoleId, scopeType: "organization", reason: "SK 002/2026",
    })).rejects.toMatchObject({ code: "ROLE_END_DATE_REQUIRED" });
    await expect(createRoleAssignment(pool, superAdmin, organ, {
      roleId: readerRoleId, scopeType: "organization", endsOn: "2030-12-31",
    })).rejects.toMatchObject({ code: "ROLE_REASON_REQUIRED" });
    await expect(createRoleAssignment(pool, superAdmin, organ, {
      roleId: readerRoleId, scopeType: "unit", organizationalUnitId: unit,
      reason: "SK 002/2026", endsOn: "2030-12-31",
    })).rejects.toMatchObject({ code: "ROLE_SCOPE_INVALID" });
  });

  it("refuses an employee account, however senior: this role is for organ accounts only", async () => {
    const employeeId = await employee("direktur@example.invalid");
    const staff = await account({ principalType: "EMPLOYEE", email: "direktur@example.invalid", employeeId });
    await expect(createRoleAssignment(pool, superAdmin, staff, {
      roleId: readerRoleId, scopeType: "organization", reason: "SK 003/2026", endsOn: "2030-12-31",
    })).rejects.toMatchObject({ code: "ROLE_TARGET_INVALID" });
  });

  it("leaves a plain foundation_board_viewer with board.read and nothing else", async () => {
    const employeeId = await employee("pengurus-staf@example.invalid");
    const viewer = await account({ principalType: "EMPLOYEE", email: "pengurus-staf@example.invalid", employeeId });
    await createRoleAssignment(pool, superAdmin, viewer, {
      roleId: viewerRoleId, scopeType: "organization", reason: "SK 004/2026",
    });

    await expect(hasOrganizationPermission(pool, viewer, "board.read")).resolves.toBe(true);
    await expect(hasOrganizationPermission(pool, viewer, GOVERNANCE_PAYROLL_READ_PERMISSION)).resolves.toBe(false);
    await expect(hasOrganizationPermission(pool, viewer, "payroll.results.read.organization")).resolves.toBe(false);
    await expect(hasOrganizationPermission(pool, viewer, "payroll.transfers.read.organization")).resolves.toBe(false);
    await expect(assertGovernancePayrollReadCapability(pool, viewer))
      .rejects.toMatchObject({ code: "PAYROLL_READ_FORBIDDEN" });
  });
});
