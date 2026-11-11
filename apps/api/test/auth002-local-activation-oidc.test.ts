import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAccountActivationRoutes } from "../src/modules/auth/activation-routes.js";
import { localActivationLinkRefusal } from "../src/modules/auth/admin-account-activation-routes.js";

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
    const response = await instance.inject({ method: "POST", url: "/auth/activation/preview", payload: { token } });
    expect(response.json()).not.toMatchObject({ code: "ACTIVATION_USES_AKUN_SQ" });
    expect(query).toHaveBeenCalled();
  });

  it("refuses an admin-issued local link for every account type in oidc mode", () => {
    expect(localActivationLinkRefusal("oidc", "EMPLOYEE")?.code).toBe("ACTIVATION_USES_INVITATION");
    expect(localActivationLinkRefusal("oidc", "FOUNDATION_BOARD")?.code).toBe("ACTIVATION_USES_AKUN_SQ");
    expect(localActivationLinkRefusal("oidc", undefined)?.code).toBe("ACTIVATION_USES_AKUN_SQ");
    expect(localActivationLinkRefusal("local", "EMPLOYEE")).toBeNull();
    expect(localActivationLinkRefusal("local", "FOUNDATION_BOARD")).toBeNull();
  });
});
