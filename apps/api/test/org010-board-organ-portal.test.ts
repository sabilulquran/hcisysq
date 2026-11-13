import Fastify from "fastify";
import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { loadConfig } from "../src/config/env.js";
import { AuthError } from "../src/modules/auth/service.js";

// ORG-010 amendment 2026-11-13: with ORGAN_PORTAL_URL set, /board/dashboard refuses an organ
// account before any aggregate query. The guard and the aggregates are stubbed; synthetic data.
const guard = vi.hoisted(() => ({ principalType: "FOUNDATION_BOARD" as string | null }));
const aggregates = vi.hoisted(() => vi.fn(async () => ({ generatedAt: "2026-11-13T00:00:00.000Z" })));

vi.mock("../src/modules/auth/authorization.js", () => ({
  requireBoardAccessFromCookie: vi.fn(async () => {
    if (!guard.principalType) throw new AuthError(401, "UNAUTHENTICATED", "Sesi tidak ditemukan atau sudah berakhir.");
    return { id: "00000000-0000-4000-8000-000000000001", email: "x@example.invalid", principalType: guard.principalType };
  }),
}));
vi.mock("../src/modules/board/aggregates.js", () => ({ loadBoardAggregates: aggregates }));

const { registerBoardDashboardRoutes } = await import("../src/modules/board/dashboard-routes.js");

const PORTAL = "https://organ.example.invalid";
const baseConfig = {
  NODE_ENV: "test", HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: "postgres://org010-portal-test",
  AUTH_MODE: "local", AUTH_ENCRYPTION_KEY: "11".repeat(32), AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

async function dashboard(principalType: string | null, organPortalUrl?: string) {
  guard.principalType = principalType;
  const app = Fastify();
  await registerBoardDashboardRoutes(app, {} as Pool, { ...baseConfig, ORGAN_PORTAL_URL: organPortalUrl });
  const response = await app.inject({ method: "GET", url: "/board/dashboard", headers: { cookie: "hcis_session=x" } });
  await app.close();
  return response;
}

describe("ORG-010 /board/dashboard with the Portal Organ Yayasan", () => {
  beforeEach(() => aggregates.mockClear());

  it("refuses an organ account with ORGAN_PORTAL_ONLY and the portal URL, before loading data", async () => {
    const response = await dashboard("FOUNDATION_BOARD", PORTAL);
    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      code: "ORGAN_PORTAL_ONLY",
      message: "Ringkasan dan data pegawai untuk Organ Yayasan ada di Portal Organ Yayasan.",
      organPortalUrl: PORTAL,
    });
    expect(aggregates).not.toHaveBeenCalled();
  });

  it("serves an organ account as before when the portal is not configured", async () => {
    const response = await dashboard("FOUNDATION_BOARD");
    expect(response.statusCode).toBe(200);
    expect(response.json().actor).toEqual({ principalType: "FOUNDATION_BOARD" });
    expect(aggregates).toHaveBeenCalledOnce();
  });

  it("keeps serving an Employee with board.read when the portal is configured", async () => {
    const response = await dashboard("EMPLOYEE", PORTAL);
    expect(response.statusCode).toBe(200);
    expect(response.json().actor).toEqual({ principalType: "EMPLOYEE" });
  });

  it("answers the guard's 401 first, without revealing the portal", async () => {
    const response = await dashboard(null, PORTAL);
    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toHaveProperty("organPortalUrl");
  });
});

describe("ORGAN_PORTAL_URL configuration", () => {
  const env = { DATABASE_URL: "postgres://x", NODE_ENV: "test" };

  it("is optional and accepts an https URL", () => {
    expect(loadConfig(env).ORGAN_PORTAL_URL).toBeUndefined();
    expect(loadConfig({ ...env, ORGAN_PORTAL_URL: "" }).ORGAN_PORTAL_URL).toBeUndefined();
    expect(loadConfig({ ...env, ORGAN_PORTAL_URL: PORTAL }).ORGAN_PORTAL_URL).toBe(PORTAL);
  });

  it.each(["http://organ.example.invalid", "https://organ.example.invalid/?a=1", "https://organ.example.invalid/#x", "not a url"])(
    "rejects %s", (value) => {
      expect(() => loadConfig({ ...env, ORGAN_PORTAL_URL: value })).toThrow();
    },
  );
});
