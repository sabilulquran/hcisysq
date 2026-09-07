import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const routes = new URL("../src/modules/attendance/adms/physical-parity-routes.ts", import.meta.url);
const extended = new URL("../src/modules/attendance/adms/physical-parity-extended-routes.ts", import.meta.url);
const registryUser = new URL("../src/modules/attendance/adms/physical-parity-registry-user-routes.ts", import.meta.url);
const observability = new URL("../src/modules/attendance/adms/physical-parity-observability-routes.ts", import.meta.url);

describe("full WDMS route safety", () => {
  it("keeps physical command routes permission-authorized and fail-closed", async () => {
    const source = `${await readFile(routes, "utf8")}\n${await readFile(extended, "utf8")}\n${await readFile(registryUser, "utf8")}`;
    expect(source).toContain('requirePermissionsFromCookie(auth, request.headers.cookie, permission)');
    expect(source).toContain("PHYSICAL_CAPABILITY_NOT_VERIFIED");
    expect(source).toContain("PHYSICAL_CANARY_PENDING");
    expect(source).toContain("PHYSICAL_CONFIRMATION_MISMATCH");
    expect(source).toContain("PHYSICAL_CAPABILITY_BLOCKED");
    expect(source).toContain("SERVER_TARGET_NOT_APPROVED");
    expect(source).toContain("SERVER_TARGET_NOT_CONFIGURED");
    expect(source).toContain("approvedIngressTarget: true");
    expect(source).not.toContain("SERVER_CANARY_MUST_PRESERVE_INGRESS");
    expect(source).toContain("BIOMETRIC_HARDWARE_GATE_CLOSED");
    expect(source).not.toContain("DATA QUERY USERINFO");
    expect(source).not.toMatch(/["'`]DATA DELETE user(?:["'`]|\\|$)/);
    expect(source).toContain('mode: z.enum(["canary", "execute"]).default("canary")');
    expect(source).not.toContain("rawCommand");
  });

  it("keeps attendance-photo canary encrypted and exposes only an approved server target", async () => {
    const source = await readFile(routes, "utf8");
    expect(source).toContain('approvedServerTarget: approvedServerHost ? { host: approvedServerHost, port: 80 } : null');
    expect(source).toContain('await enforceMode(client, device.id, "attendance_photo", "canary")');
    expect(source).toContain("RESTRICTED_MEDIA_KEYRING_NOT_READY");
    expect(source).toContain("encryptedStorageRequired: true");
    expect(source).toContain("rawPhotoStored: false");
  });

  it("keeps observability and exports secret-free", async () => {
    const source = await readFile(observability, "utf8");
    expect(source).not.toContain('wire_command AS "wireCommand"');
    expect(source).not.toContain("payload_ciphertext");
    expect(source).not.toContain("payload_iv");
    expect(source).not.toContain("payload_auth_tag");
    expect(source).toContain("rawWireCommandsReturned: false");
  });
});
