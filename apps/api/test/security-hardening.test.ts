import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createApp, logUrl } from "../src/app.js";
import { type ApiConfig, loadConfig } from "../src/config/env.js";
import { quoteCsvCell } from "../src/lib/csv.js";
import { ADMS_HARD_MAX_BODY_BYTES } from "../src/modules/attendance/adms/protocol.js";
import { registerAdmsIngressRoutes } from "../src/modules/attendance/adms/routes.js";

// SEC-REV-2026-10-16: SEC-07 (API headers), SEC-09 (log URL), SEC-10 (generic 5xx), SEC-11 (ADMS hard body cap),
// SEC-13 (CSV formula neutralizing), SEC-15 (explicit AUTH_MODE in production).
const baseConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3001,
  DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unused",
  AUTH_MODE: "local",
  AUTH_ENCRYPTION_KEY: "11".repeat(32),
  AUTH_SESSION_TTL_HOURS: 8,
} as ApiConfig;

async function appWithBoom(config: ApiConfig) {
  const app = await createApp(config, {} as Pool);
  app.get("/synthetic/boom", async () => {
    throw new Error("relation \"secret_table\" does not exist");
  });
  app.get("/synthetic/bad-request", async () => {
    throw Object.assign(new Error("Tanggal tidak valid."), { statusCode: 400, code: "SYNTHETIC_INVALID" });
  });
  app.get("/synthetic/own-headers", async (_request, reply) => {
    reply.header("X-Frame-Options", "SAMEORIGIN");
    return { ok: true };
  });
  await app.ready();
  return app;
}

describe("SEC-07 API security headers", () => {
  it("sends the baseline headers on every response and keeps a route's own value", async () => {
    const app = await appWithBoom(baseConfig);
    for (const url of ["/health", "/synthetic/boom", "/does-not-exist"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.headers["x-content-type-options"], url).toBe("nosniff");
      expect(response.headers["referrer-policy"], url).toBe("no-referrer");
      expect(response.headers["x-frame-options"], url).toBe("DENY");
      expect(response.headers["content-security-policy"], url).toBe("frame-ancestors 'none'");
      expect(response.headers["strict-transport-security"], url).toBeUndefined();
    }
    const own = await app.inject({ method: "GET", url: "/synthetic/own-headers" });
    expect(own.headers["x-frame-options"]).toBe("SAMEORIGIN");
    await app.close();
  });

  it("adds HSTS only in production", async () => {
    const app = await appWithBoom({ ...baseConfig, NODE_ENV: "production" });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["strict-transport-security"]).toBe("max-age=31536000");
    await app.close();
  });
});

describe("SEC-10 generic 5xx body", () => {
  it("never echoes the internal error message", async () => {
    const app = await appWithBoom(baseConfig);
    const response = await app.inject({ method: "GET", url: "/synthetic/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR", message: "Terjadi kesalahan pada server. Coba lagi beberapa saat." });
    expect(response.body).not.toContain("secret_table");
    await app.close();
  });

  it("keeps 4xx errors unchanged", async () => {
    const app = await appWithBoom(baseConfig);
    const response = await app.inject({ method: "GET", url: "/synthetic/bad-request" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "SYNTHETIC_INVALID", message: "Tanggal tidak valid." });
    await app.close();
  });
});

describe("SEC-11 ADMS hard body cap", () => {
  it("rejects a body above the hard cap with 413 before any handler runs", async () => {
    const app = Fastify({ logger: false });
    await registerAdmsIngressRoutes(app, {} as Pool, { ...baseConfig, ADMS_INGRESS_HOST: "adms.test.local" });
    const response = await app.inject({
      method: "POST",
      url: "/iclock/cdata?SN=SYNTH-HARD-CAP&table=ATTLOG&Stamp=1",
      headers: { host: "adms.test.local", "content-type": "text/plain" },
      payload: Buffer.alloc(ADMS_HARD_MAX_BODY_BYTES + 1, 0x41),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "ADMS_BODY_TOO_LARGE" });
    await app.close();
  });
});

describe("SEC-13 CSV formula neutralizing", () => {
  it("prefixes formula-like text and keeps plain numbers and normal text", () => {
    expect(quoteCsvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(quoteCsvCell("+62812")).toBe("\"'+62812\"");
    expect(quoteCsvCell("@SUM(A1)")).toBe("\"'@SUM(A1)\"");
    expect(quoteCsvCell("-1+2")).toBe("\"'-1+2\"");
    expect(quoteCsvCell("\t=1")).toBe("\"'\t=1\"");
    expect(quoteCsvCell("-15")).toBe("\"-15\"");
    expect(quoteCsvCell("-1.5")).toBe("\"-1.5\"");
    expect(quoteCsvCell("Budi")).toBe("\"Budi\"");
    expect(quoteCsvCell("")).toBe("\"\"");
  });
});

describe("SEC-15 explicit AUTH_MODE in production", () => {
  const productionEnv = { NODE_ENV: "production", DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unused" };

  it("refuses to start production without AUTH_MODE", () => {
    expect(() => loadConfig(productionEnv)).toThrow("AUTH_MODE must be set explicitly when NODE_ENV=production");
  });

  it("still defaults to local outside production", () => {
    expect(loadConfig({ DATABASE_URL: productionEnv.DATABASE_URL }).AUTH_MODE).toBe("local");
  });
});

describe("SEC-09 request log URL", () => {
  it("drops query strings except on device ingress", () => {
    expect(logUrl("/admin/employees?q=Budi%20Santoso")).toBe("/admin/employees");
    expect(logUrl("/auth/me")).toBe("/auth/me");
    expect(logUrl("/iclock/cdata?SN=ABC&table=ATTLOG")).toBe("/iclock/cdata?SN=ABC&table=ATTLOG");
  });
});
