import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "../migrations");
const MIGRATION = "0110_auth014_module_admin_and_channel_audit.sql";

async function applyMigration(client: Client, file: string) {
  const sql = await readFile(join(migrationsDir, file), "utf8");
  await client.query(sql);
}

// AUTH-014 F2: additive only. The role exists and carries exactly the module-configuration
// permissions; the audit columns accept the channel's provenance and refuse a replayed requestId;
// nothing an existing role carries today is taken away.
describe.skipIf(!databaseUrl)("0110 AUTH-014 module administrator and channel audit", () => {
  it("adds the role and the audit columns without changing anything that exists", async () => {
    const client = new Client({ connectionString: databaseUrl! });
    const schemaName = `auth014_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = `"${schemaName}"`;
    await client.connect();

    try {
      await client.query(`CREATE SCHEMA ${quotedSchema}`);
      await client.query(`SET search_path TO ${quotedSchema}, public`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const upTo = files.filter((file) => file <= MIGRATION);
      expect(upTo.at(-1)).toBe(MIGRATION);

      // Permissions human_capital_admin carries before this migration, to prove none is removed.
      const beforeAll = files.filter((file) => file < MIGRATION);
      for (const file of beforeAll) await applyMigration(client, file);
      const before = await client.query<{ permissionKey: string }>(
        `SELECT permission.permission_key AS "permissionKey"
           FROM roles role JOIN role_permissions permission ON permission.role_id = role.id
          WHERE role.role_key = 'human_capital_admin' ORDER BY 1`,
      );

      await applyMigration(client, MIGRATION);

      const after = await client.query<{ permissionKey: string }>(
        `SELECT permission.permission_key AS "permissionKey"
           FROM roles role JOIN role_permissions permission ON permission.role_id = role.id
          WHERE role.role_key = 'human_capital_admin' ORDER BY 1`,
      );
      expect(after.rows.map((row) => row.permissionKey))
        .toEqual(before.rows.map((row) => row.permissionKey));

      const moduleAdmin = await client.query<{ permissionKey: string }>(
        `SELECT permission.permission_key AS "permissionKey"
           FROM roles role JOIN role_permissions permission ON permission.role_id = role.id
          WHERE role.role_key = 'hcis_module_admin' ORDER BY 1`,
      );
      expect(moduleAdmin.rows.map((row) => row.permissionKey)).toEqual([
        "attendance.calculation.run",
        "attendance.devices.configure",
        "attendance.devices.export",
        "attendance.devices.operate",
        "attendance.devices.read",
        "attendance.devices.technical",
        "attendance.policy.manage",
        "attendance.schedule.manage",
        "attendance.shift_swap.manage",
        "leave.configuration.manage",
        "payroll.periods.manage",
        "payroll.policies.manage",
      ]);

      // §4.3: the module administrator never gets near people, roles or accounts.
      for (const forbidden of [
        "access.roles.assign", "access.roles.delegate", "access.governance.manage",
        "access.manage", "access.accounts.temporary_reactivate",
        "employees.manage", "employees.read.all", "approvals.policy.manage",
        "organization.manage", "payslips.publish", "documents.manage",
        "attendance.devices.destructive", "attendance.devices.biometrics",
        "attendance.devices.firmware", "attendance.records.manage", "board.read",
      ]) {
        expect(moduleAdmin.rows.map((row) => row.permissionKey)).not.toContain(forbidden);
      }

      // Nobody holds the new role: granting is a separate, reviewed action.
      const holders = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM account_role_assignments assignment
           JOIN roles role ON role.id = assignment.role_id
          WHERE role.role_key = 'hcis_module_admin'`,
      );
      expect(holders.rows[0]!.count).toBe("0");

      // The audit columns are nullable, so every existing writer keeps working untouched.
      const legacyEvent = randomUUID();
      await client.query(
        `INSERT INTO access_audit_events (id, action, entity_type, entity_id)
         VALUES ($1, 'role.assignment.created', 'role_assignment', $2)`,
        [legacyEvent, randomUUID()],
      );
      const legacy = await client.query<{ actorSource: string | null; hubRequestId: string | null }>(
        `SELECT actor_source AS "actorSource", hub_request_id AS "hubRequestId"
           FROM access_audit_events WHERE id = $1`, [legacyEvent],
      );
      expect(legacy.rows[0]).toEqual({ actorSource: null, hubRequestId: null });

      // Only the two known provenances are accepted.
      await expect(client.query(
        `INSERT INTO access_audit_events (id, action, entity_type, actor_source)
         VALUES ($1, 'role.assignment.created', 'role_assignment', 'somewhere_else')`,
        [randomUUID()],
      )).rejects.toThrow();

      // §2.3: one SQ Hub request, one HCIS event of that action.
      const requestId = randomUUID();
      await client.query(
        `INSERT INTO access_audit_events (id, action, entity_type, actor_source, hub_request_id)
         VALUES ($1, 'role.assignment.created', 'role_assignment', 'sq_hub', $2)`,
        [randomUUID(), requestId],
      );
      await expect(client.query(
        `INSERT INTO access_audit_events (id, action, entity_type, actor_source, hub_request_id)
         VALUES ($1, 'role.assignment.created', 'role_assignment', 'sq_hub', $2)`,
        [randomUUID(), requestId],
      )).rejects.toThrow();

      // The same requestId may still carry the opposite action, and NULL never collides.
      await client.query(
        `INSERT INTO access_audit_events (id, action, entity_type, actor_source, hub_request_id)
         VALUES ($1, 'role.assignment.removed', 'role_assignment', 'sq_hub', $2)`,
        [randomUUID(), requestId],
      );
      await client.query(
        `INSERT INTO access_audit_events (id, action, entity_type, actor_source)
         VALUES ($1, 'role.assignment.created', 'role_assignment', 'hcis_break_glass')`,
        [randomUUID()],
      );
      await client.query(
        `INSERT INTO access_audit_events (id, action, entity_type, actor_source)
         VALUES ($1, 'role.assignment.created', 'role_assignment', 'hcis_break_glass')`,
        [randomUUID()],
      );

      // Rerunning the migration changes nothing further.
      await applyMigration(client, MIGRATION);
      const rerun = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM role_permissions permission
           JOIN roles role ON role.id = permission.role_id
          WHERE role.role_key = 'hcis_module_admin'`,
      );
      expect(rerun.rows[0]!.count).toBe("12");
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await client.end();
    }
  });
});
