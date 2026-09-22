import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../migrations/0055_adms_operational_management.sql", import.meta.url);
const routesUrl = new URL("../src/modules/attendance/adms/management-routes.ts", import.meta.url);

describe("ATT-012 ADMS operational management safety", () => {
  it("adds an explicit retired lifecycle without deleting device evidence", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("active', 'disabled', 'quarantined', 'retired");
    expect(migration).toContain("retired_at");
    expect(migration).toContain("replaced_by_device_id");
    expect(migration).toContain("device_retired");
    expect(migration).not.toMatch(/DELETE FROM attendance_adms_(?:events|request_journal|employee_mappings|commands)/i);
  });

  it("keeps fleet management responses free of raw wire and biometric payload fields", async () => {
    const source = await readFile(routesUrl, "utf8");
    expect(source).toContain("/admin/attendance/adms/management/user-sync");
    expect(source).toContain("/admin/attendance/adms/management/health");
    expect(source).toContain("/admin/attendance/adms/devices/:deviceId/retire");
    expect(source).not.toContain("payload_ciphertext");
    expect(source).not.toContain("payload_auth_tag");
    expect(source).not.toContain("payload_iv");
    expect(source).not.toContain("raw_line");
    expect(source).not.toContain("wire_command AS");
  });

  it("keeps mapping explicit and retirement audited", async () => {
    const source = await readFile(routesUrl, "utf8");
    expect(source).toContain("m.employee_id");
    expect(source).toContain("m.effective_to IS NULL");
    expect(source).toContain("device_retired");
    expect(source).toContain("ADMS_DEVICE_ALREADY_RETIRED");
    expect(source).toContain("ADMS_REPLACEMENT_SELF_REFERENCE");
  });
});
