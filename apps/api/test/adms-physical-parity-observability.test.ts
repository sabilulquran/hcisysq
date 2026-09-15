import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const sourceUrl = new URL("../src/modules/attendance/adms/physical-parity-observability-routes.ts", import.meta.url);
const workCodeMigrationUrl = new URL("../migrations/0036_attendance_adms_wave3_operations.sql", import.meta.url);
const physicalParityMigrationUrl = new URL("../migrations/0037_attendance_adms_full_physical_parity.sql", import.meta.url);

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

  it("derives the Work Code export command from physical-operation history", async () => {
    const [source, workCodeMigration, physicalParityMigration] = await Promise.all([
      readFile(sourceUrl, "utf8"),
      readFile(workCodeMigrationUrl, "utf8"),
      readFile(physicalParityMigrationUrl, "utf8"),
    ]);

    expect(workCodeMigration).not.toContain("last_command_id");
    expect(physicalParityMigration).toContain("physical_operation_id uuid NULL");
    expect(source).not.toContain("t.last_command_id");
    expect(source).toContain("LEFT JOIN LATERAL");
    expect(source).toContain("c.physical_operation_id = o.id");
    expect(source).toContain("o.safe_metadata ->> 'workCodeId' = t.work_code_id::text");
    expect(source).toContain("latest.last_command_id");
  });

  it("does not expose queued wire commands or biometric secrets", async () => {
    const source = await readFile(sourceUrl, "utf8");
    expect(source).not.toMatch(/SELECT[^;]*\bwire_command\b/is);
    expect(source).not.toContain("payload_ciphertext");
    expect(source).not.toContain("payload_iv");
    expect(source).not.toContain("payload_auth_tag");
    expect(source).not.toContain("encryption_key_id");
    expect(source).not.toContain("DATA QUERY USERINFO");
  });
});
