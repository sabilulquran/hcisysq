// HELP-001 pure rules and route guards. No database, synthetic data only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  articleEdit,
  assertArchivable,
  assertEditable,
  assertFreshVersion,
  assertPublishable,
  assertRestorable,
  contactInput,
  HELP_TOPICS,
  searchClause,
  searchPatterns,
} from "../src/modules/help/domain.js";
import { registerHelpRoutes } from "../src/modules/help/routes.js";

describe("HELP-001 rules", () => {
  it("D-06: escapes LIKE wildcards and keeps at most eight words", () => {
    expect(searchPatterns("  slip   gaji ")).toEqual(["%slip%", "%gaji%"]);
    expect(searchPatterns("100% hadir_ok a\\b")).toEqual(["%100\\%%", "%hadir\\_ok%", "%a\\\\b%"]);
    expect(searchPatterns("a b c d e f g h i j")).toHaveLength(8);
    expect(searchPatterns(undefined)).toEqual([]);
  });

  it("D-06: every word must match the title or the body; title hits rank first", () => {
    const clause = searchClause("article", ["%cuti%", "%sakit%"], 3);
    expect(clause.where).toEqual([
      "(article.title ILIKE $3 ESCAPE '\\' OR article.body ILIKE $3 ESCAPE '\\')",
      "(article.title ILIKE $4 ESCAPE '\\' OR article.body ILIKE $4 ESCAPE '\\')",
    ]);
    expect(clause.titleRank).toBe("(article.title ILIKE $3 ESCAPE '\\')::int + (article.title ILIKE $4 ESCAPE '\\')::int");
    expect(searchClause("article", [], 1)).toEqual({ where: [], titleRank: "", values: [] });
  });

  it("D-02/§5.1: allows only the documented transitions", () => {
    expect(() => assertEditable("DRAFT")).not.toThrow();
    expect(() => assertEditable("PUBLISHED")).not.toThrow();
    expect(() => assertEditable("ARCHIVED")).toThrow(expect.objectContaining({ code: "HELP_ARTICLE_ARCHIVED", statusCode: 409 }));
    expect(() => assertPublishable("DRAFT")).not.toThrow();
    for (const status of ["PUBLISHED", "ARCHIVED"] as const) {
      expect(() => assertPublishable(status)).toThrow(expect.objectContaining({ code: "HELP_ARTICLE_NOT_PUBLISHABLE" }));
    }
    expect(() => assertArchivable("ARCHIVED")).toThrow(expect.objectContaining({ code: "HELP_ARTICLE_ALREADY_ARCHIVED" }));
    expect(() => assertRestorable("DRAFT")).toThrow(expect.objectContaining({ code: "HELP_ARTICLE_NOT_ARCHIVED" }));
    expect(() => assertRestorable("ARCHIVED")).not.toThrow();
  });

  it("D-04: a stale version is refused", () => {
    expect(() => assertFreshVersion(3, 3)).not.toThrow();
    expect(() => assertFreshVersion(4, 3)).toThrow(expect.objectContaining({ code: "HELP_ARTICLE_STALE", statusCode: 409 }));
  });

  it("D-05: validates article length and kind/topic vocabulary", () => {
    const base = { kind: "FAQ", topic: "LEAVE", title: "Bagaimana cara cuti?", body: "Buka menu Cuti & Izin lalu ajukan.", version: 1 };
    expect(articleEdit.safeParse(base).success).toBe(true);
    expect(articleEdit.safeParse({ ...base, topic: "PAYROLL" }).success).toBe(false);
    expect(articleEdit.safeParse({ ...base, kind: "NEWS" }).success).toBe(false);
    expect(articleEdit.safeParse({ ...base, body: "pendek" }).success).toBe(false);
    expect(articleEdit.safeParse({ ...base, body: "x".repeat(8001) }).success).toBe(false);
    expect(articleEdit.safeParse({ ...base, changeNote: "x".repeat(301) }).success).toBe(false);
  });

  it("D-09: validates contact values per channel", () => {
    const contact = (channel: string, value: string) => contactInput.safeParse({ label: "Layanan HC", channel, value });
    expect(contact("WHATSAPP", "+62 812-0000-0000").success).toBe(true);
    expect(contact("WHATSAPP", "hubungi kami").success).toBe(false);
    expect(contact("PHONE", "0274 000000").success).toBe(true);
    expect(contact("EMAIL", "hc@example.invalid").success).toBe(true);
    expect(contact("EMAIL", "bukan-email").success).toBe(false);
    expect(contact("OFFICE", "Ruang HC, gedung utama").success).toBe(true);
    expect(contact("FAX", "0274").success).toBe(false);
  });

  it("D-01: the topic list matches the database CHECK in migration 0130", async () => {
    const sql = await readFile(new URL("../migrations/0130_help_center.sql", import.meta.url), "utf8");
    const check = /topic text NOT NULL CHECK \(topic IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    expect(check.match(/'[A-Z]+'/g)?.map((value) => value.slice(1, -1))).toEqual([...HELP_TOPICS]);
  });
});

describe("HELP-001 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerHelpRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
    return app;
  }

  it("answers 401 without a session and 403 to a non-employee on reader routes", async () => {
    const anonymous = await appFor(null);
    for (const url of ["/help/overview", "/help/articles", "/admin/help/articles"]) {
      expect((await anonymous.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    for (const principalType of ["SUPER_ADMIN", "FOUNDATION_BOARD"] as const) {
      const other = await appFor({ id: "x", email: "x@example.invalid", principalType });
      expect((await other.inject({ method: "GET", url: "/help/articles" })).statusCode).toBe(403);
    }
  });

  it("HELP-001-B: every admin route needs help.manage before validating anything", async () => {
    const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
    // HC permissions that are not help.manage do not open the help admin.
    const none = await appFor(employee, ["announcements.manage", "training.manage", "employees.manage"]);
    const id = "not-a-uuid";
    const routes: Array<{ method: "GET" | "POST" | "PUT" | "DELETE"; url: string }> = [
      { method: "GET", url: "/admin/help/articles" },
      { method: "POST", url: "/admin/help/articles" },
      { method: "GET", url: `/admin/help/articles/${id}` },
      { method: "PUT", url: `/admin/help/articles/${id}` },
      { method: "POST", url: `/admin/help/articles/${id}/publish` },
      { method: "POST", url: `/admin/help/articles/${id}/archive` },
      { method: "POST", url: `/admin/help/articles/${id}/restore` },
      { method: "GET", url: `/admin/help/articles/${id}/revisions` },
      { method: "GET", url: "/admin/help/contacts" },
      { method: "POST", url: "/admin/help/contacts" },
      { method: "PUT", url: `/admin/help/contacts/${id}` },
      { method: "DELETE", url: `/admin/help/contacts/${id}` },
      { method: "GET", url: "/admin/help/audit-events" },
    ];
    for (const route of routes) {
      const response = await none.inject({ ...route, ...(route.method === "GET" || route.method === "DELETE" ? {} : { payload: {} }) });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json().code).toBe("HELP_FORBIDDEN");
    }
    const manager = await appFor(employee, ["help.manage"]);
    expect((await manager.inject({ method: "PUT", url: `/admin/help/articles/${id}`, payload: {} })).statusCode).toBe(400);
    expect((await manager.inject({ method: "POST", url: "/admin/help/articles", payload: { kind: "FAQ" } })).statusCode).toBe(400);
  });

  it("refuses an invalid search or filter before touching the database", async () => {
    const employee = await appFor({ id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" });
    for (const url of ["/help/articles?q=a", "/help/articles?topic=PAYROLL", "/help/articles?pageSize=101", `/help/articles?q=${"x".repeat(101)}`]) {
      expect((await employee.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
    // A malformed id is simply not found for a reader.
    expect((await employee.inject({ method: "GET", url: "/help/articles/not-a-uuid" })).statusCode).toBe(404);
  });
});
