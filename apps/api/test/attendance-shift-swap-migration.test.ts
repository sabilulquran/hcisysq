import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("0048 ATT-008 shift exchange migration", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl! });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates the shift exchange workflow tables and HC permission", async () => {
    const tables = await pool.query<{ tableName: string }>(
      `SELECT table_name AS "tableName"
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'attendance_shift_swap_requests',
           'attendance_shift_swap_events'
         )
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.tableName)).toEqual([
      "attendance_shift_swap_events",
      "attendance_shift_swap_requests",
    ]);

    const permission = await pool.query<{ permissionKey: string }>(
      `SELECT permission_key AS "permissionKey"
       FROM permissions
       WHERE permission_key = 'attendance.shift_swap.manage'`,
    );
    expect(permission.rows).toEqual([
      { permissionKey: "attendance.shift_swap.manage" },
    ]);

    const rolePermissions = await pool.query<{ roleKey: string }>(
      `SELECT role.role_key AS "roleKey"
       FROM role_permissions role_permission
       JOIN roles role ON role.id = role_permission.role_id
       WHERE role_permission.permission_key = 'attendance.shift_swap.manage'
         AND role.role_key IN ('human_capital', 'human_capital_admin')
       ORDER BY role.role_key`,
    );
    expect(rolePermissions.rows.map((row) => row.roleKey)).toEqual([
      "human_capital",
      "human_capital_admin",
    ]);
  });

  it("constrains request states and keeps lifecycle events append-only", async () => {
    const statusConstraint = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'attendance_shift_swap_requests'::regclass
         AND contype = 'c'`,
    );
    const definitions = statusConstraint.rows.map((row) => row.definition).join("\n");
    expect(definitions).toContain("awaiting_counterpart");
    expect(definitions).toContain("awaiting_hc");
    expect(definitions).toContain("rejected_by_counterpart");
    expect(definitions).toContain("rejected_by_hc");
    expect(definitions).toContain("published_roster_id");

    const immutable = await pool.query<{ triggerName: string }>(
      `SELECT tgname AS "triggerName"
       FROM pg_trigger
       WHERE tgrelid = 'attendance_shift_swap_events'::regclass
         AND tgname = 'attendance_shift_swap_events_immutable'
         AND NOT tgisinternal`,
    );
    expect(immutable.rows).toEqual([
      { triggerName: "attendance_shift_swap_events_immutable" },
    ]);
  });
});
