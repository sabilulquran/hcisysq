import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { registerAccountActivationRoutes } from "../src/modules/auth/activation-routes.js";
import {
  localActivationLinkRefusal,
  registerAccountActivationAdminRoutes,
} from "../src/modules/auth/admin-account-activation-routes.js";

vi.mock("../src/modules/auth/authorization.js", async (original) => ({
  ...(await original<typeof import("../src/modules/auth/authorization.js")>()),
  requirePermissionsFromCookie: vi.fn(async () => ({
    id: "00000000-0000-4000-8000-0000000000aa",
    email: "admin@example.invalid",
    principalType: "EMPLOYEE",
  })),
}));
vi.mock("../src/config/env.js", async (original) => ({
  ...(await original<typeof import("../src/config/env.js")>()),
  getOidcRuntimeConfig: () => ({
    issuer: "https://login.example.test/realms/sq-staff",
    machineClientId: "synthetic-client",
    machineClientSecret: "synthetic-secret",
  }),
}));

// AUTH-002 closing note (docs/domain/account-activation.md): with Akun SQ (AUTH_MODE=oidc)
// the local password activation path is closed for every account type.
const token = "a".repeat(43);

async function app(authMode: "local" | "oidc") {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const pool = { query, connect: vi.fn() } as unknown as Pool;
  const instance = Fastify();
  await registerAccountActivationRoutes(instance, pool, { AUTH_MODE: authMode });
  return { instance, query };
}

describe("AUTH-002 local activation in Akun SQ mode", () => {
  const opened: Array<Awaited<ReturnType<typeof app>>["instance"]> = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((instance) => instance.close()));
  });

  it("refuses the public preview and completion without touching the database", async () => {
    const { instance, query } = await app("oidc");
    opened.push(instance);
    for (const url of ["/auth/activation/preview", "/auth/activation/complete"]) {
      const response = await instance.inject({ method: "POST", url, payload: { token, password: "long-enough-password" } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "ACTIVATION_USES_AKUN_SQ" });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps the local path in local mode", async () => {
    const { instance, query } = await app("local");
    opened.push(instance);
    for (const url of ["/auth/activation/preview", "/auth/activation/complete"]) {
      const response = await instance.inject({ method: "POST", url, payload: { token, password: "long-enough-password" } });
      expect(response.json()).not.toMatchObject({ code: "ACTIVATION_USES_AKUN_SQ" });
    }
    expect(query).toHaveBeenCalled();
  });

  it("refuses the admin link over HTTP before any token or audit row is written", async () => {
    const accountId = "00000000-0000-4000-8000-0000000000bb";
    for (const [principalType, code, status] of [
      ["FOUNDATION_BOARD", "ACTIVATION_USES_AKUN_SQ", 409],
      ["EMPLOYEE", "ACTIVATION_USES_INVITATION", 409],
      [null, "ACCOUNT_NOT_FOUND", 404],
    ] as const) {
      const query = vi.fn(async (sql: string) =>
        sql.includes("SELECT principal_type")
          ? { rows: principalType ? [{ principalType }] : [], rowCount: principalType ? 1 : 0 }
          : { rows: [], rowCount: 0 });
      const pool = { query, connect: vi.fn() } as unknown as Pool;
      const instance = Fastify();
      opened.push(instance);
      await registerAccountActivationAdminRoutes(instance, pool, {
        AUTH_MODE: "oidc",
        AUTH_ENCRYPTION_KEY: "k".repeat(64),
        AUTH_SESSION_TTL_HOURS: 8,
        NODE_ENV: "test",
      } as unknown as ApiConfig);
      const response = await instance.inject({ method: "POST", url: `/admin/access/accounts/${accountId}/activation` });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code });
      expect(response.headers["cache-control"]).toBe("no-store");
      const written = query.mock.calls.map(([sql]) => String(sql));
      expect(written.some((sql) => sql.includes("account_activation_tokens"))).toBe(false);
      expect(written.some((sql) => sql.includes("INSERT INTO"))).toBe(false);
    }
  });

  it("refuses an admin-issued local link for every account type in oidc mode", () => {
    expect(localActivationLinkRefusal("oidc", "EMPLOYEE")?.code).toBe("ACTIVATION_USES_INVITATION");
    expect(localActivationLinkRefusal("oidc", "FOUNDATION_BOARD")?.code).toBe("ACTIVATION_USES_AKUN_SQ");
    expect(localActivationLinkRefusal("oidc", undefined)?.code).toBe("ACTIVATION_USES_AKUN_SQ");
    expect(localActivationLinkRefusal("local", "EMPLOYEE")).toBeNull();
    expect(localActivationLinkRefusal("local", "FOUNDATION_BOARD")).toBeNull();
  });
});
