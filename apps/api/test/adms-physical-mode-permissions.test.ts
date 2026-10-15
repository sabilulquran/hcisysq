import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminPermission } from "../src/modules/auth/permissions.js";

// Every request authenticates as one synthetic account whose organization
// permissions are set per test. Everything else in the auth module is real.
const granted = { permissions: [] as AdminPermission[] };

vi.mock("../src/modules/auth/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/service.js")>();
  class FakeAuthService {
    async getSession(token: string | null) {
      if (!token) return null;
      return {
        principal: {
          id: "00000000-0000-4000-8000-000000009001",
          email: "operator@example.invalid",
          principalType: "SUPER_ADMIN",
        },
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      };
    }
    async getAuthorizationContext() {
      return { organizationPermissions: [...granted.permissions] };
    }
  }
  return { ...actual, AuthService: FakeAuthService };
});

const { physicalModePermissions } = await import("../src/modules/attendance/adms/physical-mode-permissions.js");
const { registerAdmsPhysicalParityRoutes } = await import("../src/modules/attendance/adms/physical-parity-routes.js");
const { registerAdmsPhysicalParityExtendedRoutes } = await import("../src/modules/attendance/adms/physical-parity-extended-routes.js");
const { registerAdmsPhysicalParityRegistryUserRoutes } = await import("../src/modules/attendance/adms/physical-parity-registry-user-routes.js");

const deviceId = "00000000-0000-4000-8000-000000009002";
const config = {
  NODE_ENV: "test" as const,
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://physical-mode-permission-test",
  ADMS_INGRESS_HOST: "attendance.example.test",
  AUTH_MODE: "local" as const,
  AUTH_ENCRYPTION_KEY: "72".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
};

// Any database access means the request got past authorization; the test only
// needs to know that, so the pool fails loudly instead of emulating SQL.
const databaseReached = vi.fn();
const pool = {
  query: vi.fn(async () => {
    databaseReached();
    throw new Error("database reached");
  }),
  connect: vi.fn(async () => {
    databaseReached();
    throw new Error("database reached");
  }),
} as unknown as Pool;

async function post(path: string, payload: Record<string, unknown> | undefined, cookie = true) {
  const app = Fastify({ logger: false });
  await registerAdmsPhysicalParityRoutes(app, pool, config);
  await registerAdmsPhysicalParityExtendedRoutes(app, pool, config);
  await registerAdmsPhysicalParityRegistryUserRoutes(app, pool, config);
  const response = await app.inject({
    method: "POST",
    url: `/admin/attendance/adms/devices/${deviceId}/physical/${path}`,
    headers: cookie ? { cookie: "hcis_session=test-token" } : {},
    ...(payload ? { payload } : {}),
  });
  await app.close();
  return response;
}

const PASSED_AUTHORIZATION = (status: number) => status !== 401 && status !== 403;

beforeEach(() => {
  granted.permissions = [];
  databaseReached.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("physicalModePermissions", () => {
  it("adds the technical permission unless the body explicitly asks for execute", () => {
    expect(physicalModePermissions({ mode: "execute" }, "attendance.devices.operate")).toEqual(["attendance.devices.operate"]);
    expect(physicalModePermissions({ mode: "canary" }, "attendance.devices.operate"))
      .toEqual(["attendance.devices.technical", "attendance.devices.operate"]);
    for (const body of [undefined, null, "execute", {}, { mode: "EXECUTE" }, { mode: ["execute"] }]) {
      expect(physicalModePermissions(body, "attendance.devices.configure"))
        .toEqual(["attendance.devices.technical", "attendance.devices.configure"]);
    }
    expect(physicalModePermissions({ mode: "canary" }, ["attendance.devices.technical", "attendance.devices.destructive"]))
      .toEqual(["attendance.devices.technical", "attendance.devices.destructive"]);
  });
});

describe("ATT-012 physical route permissions are enforced before validation", () => {
  it("rejects anonymous callers with 401 before looking at the body", async () => {
    for (const [path, payload] of [
      ["reboot", undefined],
      ["reboot", { mode: "execute" }],
      ["clear-all", { nonsense: true }],
      ["time-sync", undefined],
      ["ntp", { mode: "execute" }],
    ] as const) {
      const response = await post(path, payload, false);
      expect(response.statusCode, path).toBe(401);
    }
    expect(databaseReached).not.toHaveBeenCalled();
  });

  it("lets an operator reboot in execute mode but not run a reboot canary", async () => {
    granted.permissions = ["attendance.devices.read", "attendance.devices.operate"];
    expect(PASSED_AUTHORIZATION((await post("reboot", { mode: "execute", confirmation: "REBOOT X" })).statusCode)).toBe(true);
    expect((await post("reboot", { mode: "canary", confirmation: "REBOOT X" })).statusCode).toBe(403);
    // A missing mode defaults to canary and an invalid body must not reach 400 first.
    expect((await post("reboot", { confirmation: "REBOOT X" })).statusCode).toBe(403);
    expect((await post("reboot", { mode: "bogus" })).statusCode).toBe(403);
  });

  it("does not let destructive alone clear device data in any mode (owner decision 2026-10-16)", async () => {
    granted.permissions = ["attendance.devices.read", "attendance.devices.operate", "attendance.devices.destructive"];
    for (const path of ["clear-attendance", "clear-photo", "clear-all"]) {
      expect((await post(path, { mode: "execute", confirmation: "CLEAR" })).statusCode, path).toBe(403);
      expect((await post(path, { mode: "canary", confirmation: "CLEAR" })).statusCode, path).toBe(403);
    }
    expect(databaseReached).not.toHaveBeenCalled();
  });

  it("lets technical plus destructive reach clear-all execution", async () => {
    granted.permissions = ["attendance.devices.technical", "attendance.devices.destructive"];
    expect(PASSED_AUTHORIZATION((await post("clear-all", { mode: "execute", confirmation: "CLEAR ALL DATA X" })).statusCode)).toBe(true);
    expect(PASSED_AUTHORIZATION((await post("clear-all", { mode: "canary", confirmation: "CLEAR ALL DATA X" })).statusCode)).toBe(true);
  });

  it("keeps canary behind the technical permission for configure and operate routes", async () => {
    granted.permissions = ["attendance.devices.read", "attendance.devices.configure", "attendance.devices.operate"];
    for (const path of ["ntp", "user-profile", "user-enabled", "duplicate-punch", "work-code", "message", "time-sync"]) {
      expect((await post(path, { mode: "canary" })).statusCode, path).toBe(403);
      expect(PASSED_AUTHORIZATION((await post(path, { mode: "execute" })).statusCode), path).toBe(true);
    }
  });

  it("requires the route's own permission for execute", async () => {
    granted.permissions = ["attendance.devices.read", "attendance.devices.operate"];
    for (const path of ["ntp", "user-profile", "user-enabled", "duplicate-punch"]) {
      expect((await post(path, { mode: "execute" })).statusCode, path).toBe(403);
    }
    granted.permissions = ["attendance.devices.read", "attendance.devices.configure"];
    for (const path of ["reboot", "work-code", "message", "time-sync"]) {
      expect((await post(path, { mode: "execute" })).statusCode, path).toBe(403);
    }
  });

  it("returns 400 for an invalid body only after authorization passes", async () => {
    granted.permissions = ["attendance.devices.operate"];
    const response = await post("reboot", { mode: "execute" });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_REBOOT");
    expect(databaseReached).not.toHaveBeenCalled();
  });
});
