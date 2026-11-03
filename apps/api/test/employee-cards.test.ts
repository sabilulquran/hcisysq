// EMP-012 pure rules and route guards. No database, synthetic data only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  assertIssueReason,
  decodeImage,
  formatCardNumber,
  generateVerifyCode,
  invalidReason,
  ISSUE_REASONS,
  MAX_PHOTO_BYTES,
  normalizeVerifyCode,
  validUntil,
  wibDate,
} from "../src/modules/employee-cards/domain.js";
import { registerEmployeeCardRoutes } from "../src/modules/employee-cards/routes.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

describe("EMP-012 rules", () => {
  it("D-07: verify codes are 10 Crockford base32 characters from the random source", () => {
    const code = generateVerifyCode((size) => Buffer.from(Array.from({ length: size }, (_, index) => index * 37)));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    for (let index = 0; index < 50; index += 1) expect(generateVerifyCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    // Matches the CHECK in migration 0132.
    expect(new Set(Array.from({ length: 200 }, () => generateVerifyCode())).size).toBe(200);
  });

  it("D-07: normalizes what a person may type and refuses anything else", () => {
    expect(normalizeVerifyCode("7q2m-9xpa-4k")).toBe("7Q2M9XPA4K");
    expect(normalizeVerifyCode("O0IL 1abcde")).toBe("00111ABCDE");
    expect(normalizeVerifyCode("7Q2M9XPA4")).toBeNull();
    expect(normalizeVerifyCode("7Q2M9XPA4KZ")).toBeNull();
    expect(normalizeVerifyCode("7Q2M9XPA4U")).toBeNull();
    expect(normalizeVerifyCode("7Q2M9XPA4%")).toBeNull();
  });

  it("D-06: card numbers carry the WIB issue month and a padded running number", () => {
    expect(formatCardNumber("2026-11-03", 123)).toBe("KP-2611-0123");
    expect(formatCardNumber("2027-01-31", 12345)).toBe("KP-2701-12345");
  });

  it("D-04: validity ends on the last day of the month, months after issue", () => {
    expect(validUntil("2026-11-03", 24)).toBe("2028-11-30");
    expect(validUntil("2026-01-31", 25)).toBe("2028-02-29");
    expect(validUntil("2026-12-15", 12)).toBe("2027-12-31");
  });

  it("D-08: a card verifies only when ACTIVE, in date and held by an active employee", () => {
    const card = { status: "ACTIVE" as const, validUntil: "2028-11-30", employeeActive: true };
    expect(invalidReason(card, "2026-11-03")).toBeNull();
    expect(invalidReason(card, "2028-11-30")).toBeNull();
    expect(invalidReason(card, "2028-12-01")).toBe("EXPIRED");
    expect(invalidReason({ ...card, employeeActive: false }, "2026-11-03")).toBe("EMPLOYEE_INACTIVE");
    for (const status of ["REPLACED", "REPORTED_LOST", "REVOKED"] as const) {
      expect(invalidReason({ ...card, status }, "2026-11-03")).toBe(status);
    }
  });

  it("§5.1: NEW only for a first card; a reissue needs an earlier card", () => {
    expect(() => assertIssueReason("NEW", false, false)).not.toThrow();
    expect(() => assertIssueReason("NEW", true, true)).toThrow(expect.objectContaining({ code: "EMPLOYEE_CARD_ALREADY_ACTIVE", statusCode: 409 }));
    expect(() => assertIssueReason("NEW", false, true)).toThrow(expect.objectContaining({ code: "EMPLOYEE_CARD_INVALID_TRANSITION" }));
    expect(() => assertIssueReason("LOST", false, false)).toThrow(expect.objectContaining({ code: "EMPLOYEE_CARD_INVALID_TRANSITION" }));
    expect(() => assertIssueReason("LOST", true, true)).not.toThrow();
    expect(() => assertIssueReason("DAMAGED", false, true)).not.toThrow();
  });

  it("D-03: checks the file signature and the size", () => {
    expect(decodeImage("image/png", PNG.toString("base64"), MAX_PHOTO_BYTES, "Foto")).toEqual(PNG);
    expect(decodeImage("image/jpeg", JPEG.toString("base64"), MAX_PHOTO_BYTES, "Foto")).toEqual(JPEG);
    expect(() => decodeImage("image/jpeg", PNG.toString("base64"), MAX_PHOTO_BYTES, "Foto"))
      .toThrow(expect.objectContaining({ code: "INVALID_EMPLOYEE_CARD_IMAGE", statusCode: 400 }));
    expect(() => decodeImage("image/png", Buffer.from("%PDF-1.7").toString("base64"), MAX_PHOTO_BYTES, "Foto"))
      .toThrow(expect.objectContaining({ code: "INVALID_EMPLOYEE_CARD_IMAGE" }));
    const big = Buffer.concat([PNG, Buffer.alloc(16)]);
    expect(() => decodeImage("image/png", big.toString("base64"), 16, "Tanda tangan"))
      .toThrow(expect.objectContaining({ code: "EMPLOYEE_CARD_IMAGE_TOO_LARGE", statusCode: 413 }));
  });

  it("uses the WIB calendar date", () => {
    expect(wibDate(new Date("2026-11-03T16:59:59Z"))).toBe("2026-11-03");
    expect(wibDate(new Date("2026-11-03T17:00:00Z"))).toBe("2026-11-04");
  });

  it("the issue reasons match the database CHECK in migration 0132", async () => {
    const sql = await readFile(new URL("../migrations/0132_employee_cards.sql", import.meta.url), "utf8");
    const check = /issue_reason text NOT NULL CHECK \(issue_reason IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    expect(check.match(/'[A-Z_]+'/g)?.map((value) => value.slice(1, -1))).toEqual([...ISSUE_REASONS]);
  });
});

describe("EMP-012 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerEmployeeCardRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
    return app;
  }

  const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
  const id = "not-a-uuid";
  const adminRoutes: Array<{ method: "GET" | "POST" | "PUT"; url: string }> = [
    { method: "GET", url: "/admin/employee-cards" },
    { method: "GET", url: `/admin/employee-cards/employees/${id}` },
    { method: "GET", url: `/admin/employee-cards/employees/${id}/photo` },
    { method: "PUT", url: `/admin/employee-cards/employees/${id}/photo` },
    { method: "POST", url: `/admin/employee-cards/employees/${id}/cards` },
    { method: "POST", url: `/admin/employee-cards/cards/${id}/revoke` },
    { method: "GET", url: `/admin/employee-cards/cards/${id}/photo` },
    { method: "GET", url: "/admin/employee-cards/print?cardIds=x" },
    { method: "POST", url: "/admin/employee-cards/print" },
    { method: "GET", url: "/admin/employee-cards/settings" },
    { method: "PUT", url: "/admin/employee-cards/settings" },
    { method: "GET", url: "/admin/employee-cards/settings/signature" },
    { method: "PUT", url: "/admin/employee-cards/settings/signature" },
    { method: "GET", url: "/admin/employee-cards/audit-events" },
  ];

  it("answers 401 without a session and 403 to a non-employee on /me routes", async () => {
    const anonymous = await appFor(null);
    for (const route of [...adminRoutes, { method: "GET" as const, url: "/me/employee-card" }, { method: "POST" as const, url: "/me/employee-card/report-lost" }]) {
      expect((await anonymous.inject({ ...route, ...(route.method === "GET" ? {} : { payload: {} }) })).statusCode, route.url).toBe(401);
    }
    for (const principalType of ["SUPER_ADMIN", "FOUNDATION_BOARD"] as const) {
      const other = await appFor({ id: "x", email: "x@example.invalid", principalType });
      expect((await other.inject({ method: "GET", url: "/me/employee-card" })).statusCode).toBe(403);
      expect((await other.inject({ method: "POST", url: "/me/employee-card/report-lost" })).statusCode).toBe(403);
    }
  });

  it("EMP-012-A: every admin route needs employee_cards.manage before validating anything", async () => {
    // HC permissions that are not employee_cards.manage do not open the card admin.
    const none = await appFor(employee, ["employees.manage", "documents.manage", "help.manage"]);
    for (const route of adminRoutes) {
      const response = await none.inject({ ...route, ...(route.method === "GET" ? {} : { payload: {} }) });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json().code).toBe("EMPLOYEE_CARD_FORBIDDEN");
    }
    const manager = await appFor(employee, ["employee_cards.manage"]);
    for (const route of adminRoutes.filter((entry) => entry.method !== "GET" || entry.url.includes(id) || entry.url.includes("print"))) {
      const response = await manager.inject({ ...route, ...(route.method === "GET" ? {} : { payload: {} }) });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(400);
    }
  });

  it("refuses invalid filters, print batches and settings before touching the database", async () => {
    const manager = await appFor(employee, ["employee_cards.manage"]);
    const many = Array.from({ length: 51 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const twice = "00000000-0000-4000-8000-000000000001";
    for (const url of [
      "/admin/employee-cards?filter=LOST",
      "/admin/employee-cards?pageSize=101",
      "/admin/employee-cards?q=a",
      "/admin/employee-cards?q=ab%00",
      `/admin/employee-cards/print?cardIds=${many.join(",")}`,
      `/admin/employee-cards/print?cardIds=${twice},${twice}`,
    ]) {
      expect((await manager.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
    const settings = (payload: unknown) => manager.inject({ method: "PUT", url: "/admin/employee-cards/settings", payload: payload as object });
    expect((await settings({ signerTitle: "Ketua Yayasan", signerName: "Nama", validityMonths: 6 })).statusCode).toBe(400);
    expect((await settings({ signerTitle: "Ketua Yayasan", signerName: "", validityMonths: 24 })).statusCode).toBe(400);
    expect((await settings({ signerTitle: "Ketua\u0000", signerName: "Nama", validityMonths: 24 })).statusCode).toBe(400);
    const valid = "00000000-0000-4000-8000-000000000001";
    expect((await manager.inject({ method: "POST", url: `/admin/employee-cards/employees/${valid}/cards`, payload: { reason: "STOLEN" } })).statusCode).toBe(400);
    expect((await manager.inject({ method: "POST", url: `/admin/employee-cards/cards/${valid}/revoke`, payload: { reason: "abc" } })).statusCode).toBe(400);
    expect((await manager.inject({ method: "PUT", url: "/admin/employee-cards/settings/signature", payload: { contentType: "image/jpeg", contentBase64: "AAAA" } })).statusCode).toBe(400);
  });

  it("§5.3: the public check page rejects an unknown-shaped code without a query and rate limits per address", async () => {
    const app = await appFor(null);
    const first = await app.inject({ method: "GET", url: "/public/employee-cards/too-short" });
    expect(first.statusCode).toBe(404);
    expect(first.headers["cache-control"]).toBe("no-store");
    let last = 0;
    for (let index = 0; index < 30; index += 1) {
      last = (await app.inject({ method: "GET", url: "/public/employee-cards/too-short", remoteAddress: "198.51.100.7" })).statusCode;
    }
    expect(last).toBe(404);
    const limited = await app.inject({ method: "GET", url: "/public/employee-cards/too-short/photo", remoteAddress: "198.51.100.7" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("RATE_LIMITED");
    // Another address is not affected.
    expect((await app.inject({ method: "GET", url: "/public/employee-cards/too-short", remoteAddress: "198.51.100.8" })).statusCode).toBe(404);
  });
});
