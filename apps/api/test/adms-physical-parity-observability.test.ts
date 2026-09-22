import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { queuePhysicalOperation } from "../src/modules/attendance/adms/physical-parity-service.js";

const sourceUrl = new URL("../src/modules/attendance/adms/physical-parity-observability-routes.ts", import.meta.url);
const databaseUrl = process.env.DATABASE_URL;

function workCodeExportRoute(source: string) {
  const startMarker = 'app.get("/admin/attendance/adms/devices/:deviceId/work-codes/export.csv"';
  const endMarker = 'app.get("/admin/attendance/adms/devices/:deviceId/physical/operations/export.csv"';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error("Work Code export route source was not found");
  return source.slice(start, end);
}

function workCodeExportSql(routeSource: string) {
  const match = routeSource.match(/const result = await pool\.query\(\s*`([\s\S]*?)`,\s*\[params\.data\.deviceId\],\s*\);/);
  if (!match?.[1]) throw new Error("Work Code export SQL was not found");
  return match[1];
}

async function completeOperation(client: PoolClient, operationId: string, commandId: string, minutesAgo: number) {
  await client.query(
    `UPDATE attendance_adms_commands
     SET status = 'succeeded', completed_at = now(), return_code = 0, result_command = 'DATA',
         created_at = now() - ($2::text || ' minutes')::interval
     WHERE id = $1`,
    [commandId, String(minutesAgo)],
  );
  await client.query(
    `UPDATE attendance_adms_physical_operations
     SET status = 'succeeded', completed_at = now(),
         created_at = now() - ($2::text || ' minutes')::interval
     WHERE id = $1`,
    [operationId, String(minutesAgo)],
  );
}

describe("WDMS physical parity observability", () => {
  it("exposes passive evidence, history, and policy-neutral exports", async () => {
    const source = await readFile(sourceUrl, "utf8");
    expect(source).toContain("/wdms-evidence");
    expect(source).toContain("/physical/operations");
    expect(source).toContain("/mappings/export.csv");
    expect(source).toContain("/work-codes/export.csv");
    expect(source).toContain("/physical/operations/export.csv");
    expect(source).toContain("/physical/audit/export.csv");
    expect(source).toContain("/attendance/export.csv");
    expect(source).toContain('baseTransferFlags: ["TransData", "AttLog"]');
    expect(source).toContain("activeUserInfoReadsRetired: true");
    expect(source).toContain("arbitraryCommandEnabled: false");
  });

  it("keeps Work Code export permission and CSV safety unchanged", async () => {
    const source = await readFile(sourceUrl, "utf8");
    const route = workCodeExportRoute(source);
    expect(route).toContain('authenticate(auth, request, reply, ["attendance.devices.technical", "attendance.devices.export"])');
    expect(route).toContain('sendCsv(reply, `adms-work-codes-${params.data.deviceId}.csv`');
    expect(source).toContain('reply.header("Cache-Control", "no-store")');
    expect(source).toContain('reply.header("Pragma", "no-cache")');
    expect(source).toContain('reply.header("X-Content-Type-Options", "nosniff")');
    expect(source).not.toMatch(/SELECT[^;]*\bwire_command\b/is);
    expect(source).not.toContain("payload_ciphertext");
    expect(source).not.toContain("payload_iv");
    expect(source).not.toContain("payload_auth_tag");
    expect(source).not.toContain("encryption_key_id");
    expect(source).not.toContain("DATA QUERY USERINFO");
  });
});

describe.skipIf(!databaseUrl)("Work Code export PostgreSQL regression", () => {
  it("uses migrated schema and returns only the latest related command", async () => {
    const parsed = new URL(databaseUrl!);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
      throw new Error("Work Code export integration test requires a loopback PostgreSQL database");
    }

    const source = await readFile(sourceUrl, "utf8");
    const sql = workCodeExportSql(workCodeExportRoute(source));
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    const actorId = randomUUID();
    const deviceId = randomUUID();
    const workCodeId = randomUUID();
    const otherWorkCodeId = randomUUID();

    await client.query("BEGIN");
    try {
      const schemaColumn = await client.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'attendance_adms_work_code_targets'
           AND column_name = 'last_command_id'`,
      );
      expect(schemaColumn.rows).toHaveLength(0);

      await client.query(
        `INSERT INTO accounts(id, email, principal_type, status)
         VALUES ($1, $2, 'FOUNDATION_BOARD', 'active')`,
        [actorId, `work-code-export-${actorId}@example.invalid`],
      );
      await client.query(
        `INSERT INTO attendance_adms_devices(id, serial_number, lifecycle)
         VALUES ($1, $2, 'active')`,
        [deviceId, `SYN-${deviceId}`],
      );
      await client.query(
        `INSERT INTO attendance_adms_work_codes(id, code, name, created_by_account_id)
         VALUES ($1, '101', 'Synthetic Work Code', $3),
                ($2, '102', 'Synthetic Other Work Code', $3)`,
        [workCodeId, otherWorkCodeId, actorId],
      );
      await client.query(
        `INSERT INTO attendance_adms_work_code_targets(
           work_code_id, device_id, desired_state, delivery_state, updated_by_account_id
         ) VALUES ($1, $2, 'present', 'not_verified', $3)`,
        [workCodeId, deviceId, actorId],
      );

      const beforeOperation = await client.query<{ last_command_id: string | null }>(sql, [deviceId]);
      expect(beforeOperation.rows).toHaveLength(1);
      expect(beforeOperation.rows[0]?.last_command_id).toBeNull();

      const first = await queuePhysicalOperation(client, {
        deviceId,
        capabilityKey: "work_code_delivery",
        operationKey: "synthetic-work-code-first",
        mode: "execute",
        requestedByAccountId: actorId,
        commands: [{ commandType: "physical_work_code", wireCommand: "DATA UPDATE WORKCODE CODE=101\tName=Synthetic Work Code" }],
        safeMetadata: { workCodeId, desiredState: "present" },
      });
      await completeOperation(client, first.operationId, first.commandIds[0]!, 3);

      const latestRelated = await queuePhysicalOperation(client, {
        deviceId,
        capabilityKey: "work_code_delivery",
        operationKey: "synthetic-work-code-latest",
        mode: "execute",
        requestedByAccountId: actorId,
        commands: [{ commandType: "physical_work_code", wireCommand: "DATA UPDATE WORKCODE CODE=101\tName=Synthetic Work Code" }],
        safeMetadata: { workCodeId, desiredState: "present" },
      });
      await completeOperation(client, latestRelated.operationId, latestRelated.commandIds[0]!, 2);

      const unrelated = await queuePhysicalOperation(client, {
        deviceId,
        capabilityKey: "work_code_delivery",
        operationKey: "synthetic-other-work-code-newer",
        mode: "execute",
        requestedByAccountId: actorId,
        commands: [{ commandType: "physical_work_code", wireCommand: "DATA UPDATE WORKCODE CODE=102\tName=Synthetic Other Work Code" }],
        safeMetadata: { workCodeId: otherWorkCodeId, desiredState: "present" },
      });
      await completeOperation(client, unrelated.operationId, unrelated.commandIds[0]!, 1);

      const afterOperations = await client.query<{ last_command_id: string | null }>(sql, [deviceId]);
      expect(afterOperations.rows).toHaveLength(1);
      expect(afterOperations.rows[0]?.last_command_id).toBe(latestRelated.commandIds[0]);
      expect(afterOperations.rows[0]?.last_command_id).not.toBe(unrelated.commandIds[0]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  }, 60_000);
});
