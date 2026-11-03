import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRoleAssignment } from "../src/modules/auth/role-assignment.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { governanceActorIsRequester } from "../src/modules/leave/organization-authority.js";
import { LEAVE_GOVERNANCE_CAPABILITY, PostgresOrganizationRepository } from "../src/modules/organization/index.js";

// ORG-012 against real SQL. Isolated loopback database and a disposable schema; synthetic data only.
const databaseUrl = process.env.HCIS_AUTH011_TEST_DATABASE_URL;
const schema = `org012_${randomUUID().replaceAll("-", "")}`;
const today = "2026-11-03";

describe.skipIf(!databaseUrl)("ORG-012 organ account approver (PostgreSQL)", () => {
  let pool: Pool;
  let control: Pool;
  let repository: PostgresOrganizationRepository;
  let governanceRoleId: string;
  let viewerRoleId: string;
  let superAdmin: AuthPrincipal;

  async function employee(email: string | null, status = "active") {
    const id = randomUUID();
    await pool.query("INSERT INTO employees(id,employee_number,full_name,status,email) VALUES ($1,$2,'Pegawai Sintetis',$3,$4)",
      [id, `ORG012-${id}`, status, email]);
    return id;
  }

  async function account(input: {
    principalType: "EMPLOYEE" | "FOUNDATION_BOARD" | "SUPER_ADMIN";
    email: string;
    employeeId?: string | null;
    status?: string;
    identity?: boolean;
  }) {
    const id = randomUUID();
    const identity = input.identity ?? true;
    const superAdmin = input.principalType === "SUPER_ADMIN";
    await pool.query(`INSERT INTO accounts(id,employee_id,email,principal_type,status,identity_issuer,identity_subject,
        mfa_enabled_at,mfa_secret_ciphertext,mfa_secret_iv,mfa_secret_tag)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)`,
    [id, input.employeeId ?? null, input.email, input.principalType, input.status ?? "active",
      identity ? "https://login.example.invalid/realms/staff" : null, identity ? `subject-${id}` : null,
      superAdmin ? new Date() : null, superAdmin ? "synthetic" : null]);
    return id;
  }

  async function grantGovernance(accountId: string, endsOn: string | null = "2030-12-31") {
    await pool.query(`INSERT INTO account_role_assignments(id,account_id,role_id,scope_type,ends_on,reason)
      VALUES($1,$2,$3,'organization',$4,'Synthetic SK 001/2026')`, [randomUUID(), accountId, governanceRoleId, endsOn]);
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/hcis_auth011_permissions_test") {
      throw new Error("ORG-012 integration requires the isolated loopback hcis_auth011_permissions_test database");
    }
    control = new Pool({ connectionString: databaseUrl });
    await control.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const migrations = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
    const roles = await pool.query<{ id: string; key: string }>("SELECT id, role_key AS key FROM roles");
    governanceRoleId = roles.rows.find((row) => row.key === "governance_leave_approver")!.id;
    viewerRoleId = roles.rows.find((row) => row.key === "foundation_board_viewer")!.id;
    repository = new PostgresOrganizationRepository(pool);
    const superId = await account({ principalType: "SUPER_ADMIN", email: "super@example.invalid" });
    superAdmin = { id: superId, principalType: "SUPER_ADMIN" } as AuthPrincipal;
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    if (control) {
      await control.query(`DROP SCHEMA ${schema} CASCADE`);
      await control.end();
    }
  });

  const context = { effectiveDate: today, requiredCapability: LEAVE_GOVERNANCE_CAPABILITY };

  describe("validateAccount (ORG-012-1)", () => {
    it("accepts an active, mapped organ account that holds the capability", async () => {
      const id = await account({ principalType: "FOUNDATION_BOARD", email: "sekretaris@example.invalid" });
      await grantGovernance(id);
      await expect(repository.validateAccount(id, context)).resolves.toEqual({ kind: "ACCOUNT" });
    });

    it("treats a missing or expired capability as ineligible, and needs none for oversight", async () => {
      const missing = await account({ principalType: "FOUNDATION_BOARD", email: "tanpa-peran@example.invalid" });
      await expect(repository.validateAccount(missing, context))
        .resolves.toEqual({ kind: "INELIGIBLE", reason: "CAPABILITY_MISSING" });
      await expect(repository.validateAccount(missing, { effectiveDate: today, requiredCapability: null }))
        .resolves.toEqual({ kind: "ACCOUNT" });

      const expired = await account({ principalType: "FOUNDATION_BOARD", email: "kedaluwarsa@example.invalid" });
      await grantGovernance(expired, "2026-01-31");
      await expect(repository.validateAccount(expired, context))
        .resolves.toEqual({ kind: "INELIGIBLE", reason: "CAPABILITY_MISSING" });
    });

    it("treats a suspended account as ineligible", async () => {
      const id = await account({ principalType: "FOUNDATION_BOARD", email: "ditangguhkan@example.invalid", status: "suspended" });
      await grantGovernance(id);
      await expect(repository.validateAccount(id, context))
        .resolves.toEqual({ kind: "INELIGIBLE", reason: "ACCOUNT_NOT_ACTIVE" });
    });

    it("refuses an organ account whose e-mail belongs to an active employee, ignoring case and spaces", async () => {
      await employee("Ketua.Merangkap@example.invalid");
      const id = await account({ principalType: "FOUNDATION_BOARD", email: " ketua.merangkap@EXAMPLE.invalid " });
      await grantGovernance(id);
      await expect(repository.validateAccount(id, context))
        .resolves.toEqual({ kind: "CONFLICT", reason: "ACCOUNT_PERSON_IS_EMPLOYEE" });
    });

    it("ignores a resigned employee with the same e-mail", async () => {
      await employee("mantan@example.invalid", "resigned");
      const id = await account({ principalType: "FOUNDATION_BOARD", email: "mantan@example.invalid" });
      await grantGovernance(id);
      await expect(repository.validateAccount(id, context)).resolves.toEqual({ kind: "ACCOUNT" });
    });

    it("refuses an organ account without a mapped identity", async () => {
      const id = await account({ principalType: "FOUNDATION_BOARD", email: "belum-terpetakan@example.invalid", identity: false });
      await grantGovernance(id);
      await expect(repository.validateAccount(id, context))
        .resolves.toEqual({ kind: "CONFLICT", reason: "ACCOUNT_IDENTITY_MISSING" });
    });

    it("routes an employee account to its employee and rejects other shapes", async () => {
      const employeeId = await employee("staf@example.invalid");
      const staff = await account({ principalType: "EMPLOYEE", email: "staf@example.invalid", employeeId });
      await expect(repository.validateAccount(staff, context)).resolves.toEqual({ kind: "EMPLOYEE", employeeId });

      const admin = await account({ principalType: "SUPER_ADMIN", email: "admin2@example.invalid" });
      await expect(repository.validateAccount(admin, context)).resolves.toEqual({ kind: "INVALID" });
      await expect(repository.validateAccount(randomUUID(), context)).resolves.toEqual({ kind: "INVALID" });
    });
  });

  describe("grant channel (ORG-012-2)", () => {
    const input = (overrides: Record<string, unknown> = {}) => ({
      roleId: governanceRoleId, scopeType: "organization" as const,
      reason: "SK 001/2026, bukan pegawai", endsOn: "2030-12-31", ...overrides,
    });

    it("grants the governance Leave approver to an organ account with a reason and an end date", async () => {
      const id = await account({ principalType: "FOUNDATION_BOARD", email: "penerima@example.invalid" });
      await expect(createRoleAssignment(pool, superAdmin, id, input())).resolves.toEqual(expect.any(String));
    });

    it("requires the end date and the reason", async () => {
      const id = await account({ principalType: "FOUNDATION_BOARD", email: "syarat@example.invalid" });
      await expect(createRoleAssignment(pool, superAdmin, id, input({ endsOn: null })))
        .rejects.toMatchObject({ code: "ROLE_END_DATE_REQUIRED" });
      await expect(createRoleAssignment(pool, superAdmin, id, input({ reason: " " })))
        .rejects.toMatchObject({ code: "ROLE_REASON_REQUIRED" });
    });

    it("refuses an organ account whose e-mail belongs to an active employee", async () => {
      await employee("rangkap@example.invalid");
      const id = await account({ principalType: "FOUNDATION_BOARD", email: "rangkap@example.invalid" });
      await expect(createRoleAssignment(pool, superAdmin, id, input()))
        .rejects.toMatchObject({ code: "ORGAN_ACCOUNT_IS_EMPLOYEE" });
    });

    it("never gives the role to an employee, nor any other role to an organ account", async () => {
      const employeeId = await employee("pegawai-target@example.invalid");
      const staff = await account({ principalType: "EMPLOYEE", email: "pegawai-target@example.invalid", employeeId });
      await expect(createRoleAssignment(pool, superAdmin, staff, input()))
        .rejects.toMatchObject({ code: "ROLE_TARGET_INVALID" });

      const organ = await account({ principalType: "FOUNDATION_BOARD", email: "organ-lain@example.invalid" });
      await expect(createRoleAssignment(pool, superAdmin, organ, input({ roleId: viewerRoleId })))
        .rejects.toMatchObject({ code: "ROLE_TARGET_INVALID" });
    });
  });

  describe("decision-time self check (ORG-012-1 butir 5)", () => {
    it("matches the requester by e-mail and treats an e-mail-less actor as a match", async () => {
      const requester = await employee("pemohon@example.invalid");
      const same = await account({ principalType: "FOUNDATION_BOARD", email: "PEMOHON@example.invalid" });
      const other = await account({ principalType: "FOUNDATION_BOARD", email: "lain@example.invalid" });
      await expect(governanceActorIsRequester(pool, same, requester)).resolves.toBe(true);
      await expect(governanceActorIsRequester(pool, other, requester)).resolves.toBe(false);
    });
  });
});
