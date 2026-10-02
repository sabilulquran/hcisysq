import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { registerStaffIdentityRoutes } from "../src/modules/employees/staff-identity-routes.js";
import { OrganizationDirectoryMachineAuthError } from "../src/modules/organization-directory/machine-auth.js";

const config = (enabled: boolean) => loadConfig({
  DATABASE_URL: "postgresql://example.invalid/test",
  STAFF_IDENTITY_VERIFY_ENABLED: enabled ? "1" : "0",
  STAFF_IDENTITY_TOKEN_ISSUER: "https://identity.example.test/realms/sq-staff",
  STAFF_IDENTITY_TOKEN_AUDIENCE: "hcis-staff-identity",
  STAFF_IDENTITY_ALLOWED_CLIENTS: "sq-hub-staff-lifecycle",
});

describe("HCIS-ID-001 staff verification", () => {
  it("requires machine-auth configuration when the gate is enabled", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgresql://example.invalid/test", STAFF_IDENTITY_VERIFY_ENABLED: "1" })).toThrow();
    expect(loadConfig({ DATABASE_URL: "postgresql://example.invalid/test", STAFF_IDENTITY_VERIFY_ENABLED: "0" }).STAFF_IDENTITY_VERIFY_ENABLED).toBe("0");
  });
  it("fails closed when disabled", async () => {
    const app = Fastify();
    registerStaffIdentityRoutes(app, {} as Pool, config(false));
    const response = await app.inject({
      method: "POST", url: "/internal/v1/staff-identity/verify-employee",
      headers: { authorization: "Bearer synthetic" }, payload: { employeeNumber: "NIP-001" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("returns one minimal current employee to an authorized machine", async () => {
    const query = vi.fn(async () => ({ rowCount: 1, rows: [{
      id: "00000000-0000-4000-8000-000000000001",
      employee_number: "NIP-001", full_name: "Pegawai Sintetis",
      email: "staff@example.test", status: "active",
    }] }));
    const app = Fastify();
    registerStaffIdentityRoutes(app, { query } as unknown as Pool, config(true), async () => ({ clientId: "sq-hub-staff-lifecycle" }));
    const response = await app.inject({
      method: "POST", url: "/internal/v1/staff-identity/verify-employee",
      headers: { authorization: "Bearer synthetic" }, payload: { employeeNumber: "NIP-001" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      employeeId: "hcis:employee:00000000-0000-4000-8000-000000000001",
      employeeNumber: "NIP-001", displayName: "Pegawai Sintetis", email: "staff@example.test", status: "active",
    });
    expect(response.json()).not.toHaveProperty("nik");
    expect(query).toHaveBeenCalledOnce();
    await app.close();
  });

  it("does not query the employee table without a valid machine token", async () => {
    const query = vi.fn();
    const app = Fastify();
    registerStaffIdentityRoutes(app, { query } as unknown as Pool, config(true), async () => {
      throw new OrganizationDirectoryMachineAuthError("INVALID_TOKEN", "invalid");
    });
    const response = await app.inject({
      method: "POST", url: "/internal/v1/staff-identity/verify-employee",
      headers: { authorization: "Bearer synthetic" }, payload: { employeeNumber: "NIP-001" },
    });
    expect(response.statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns no employee data for an absent or removed NIP", async () => {
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const app = Fastify();
    registerStaffIdentityRoutes(app, { query } as unknown as Pool, config(true), async () => ({ clientId: "sq-hub-staff-lifecycle" }));
    const response = await app.inject({
      method: "POST", url: "/internal/v1/staff-identity/verify-employee",
      headers: { authorization: "Bearer synthetic" }, payload: { employeeNumber: "NIP-ABSENT" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("NIP-ABSENT");
    expect(String(query.mock.calls[0]?.[0])).toContain("removed_at IS NULL");
    await app.close();
  });
});
