// ORG-012 pure rules and route guards. No database, synthetic data only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  activateInput,
  activationProblems,
  assertFreshVersion,
  assertOpen,
  assertStatus,
  cancelInput,
  COMMITTEE_CATEGORIES,
  COMMITTEE_ROLES,
  committeeInput,
  CommitteeError,
  committeeSigner,
  joinDate,
  leaveDate,
  likePattern,
  lockedFieldChanges,
  memberAdd,
} from "../src/modules/committees/domain.js";
import { registerCommitteeRoutes } from "../src/modules/committees/routes.js";

const base = { name: "Panitia PPDB 2027", category: "ADMISSION", startOn: "2026-12-01", endOn: "2027-07-31" };
const someId = "00000000-0000-4000-8000-000000000001";

describe("ORG-012 rules", () => {
  it("D-04: the period ends on or after its start and lasts at most 366 days", () => {
    expect(committeeInput.safeParse(base).success).toBe(true);
    expect(committeeInput.safeParse({ ...base, endOn: "2026-11-30" }).success).toBe(false);
    expect(committeeInput.safeParse({ ...base, startOn: "2027-01-01", endOn: "2027-12-31" }).success).toBe(true);
    expect(committeeInput.safeParse({ ...base, startOn: "2027-01-01", endOn: "2028-01-01" }).success).toBe(true);
    expect(committeeInput.safeParse({ ...base, startOn: "2027-01-01", endOn: "2028-01-02" }).success).toBe(false);
    expect(committeeInput.safeParse({ ...base, startOn: "2027-02-30" }).success).toBe(false);
  });

  it("D-01/§5.2: validates name, category and optional text", () => {
    expect(committeeInput.safeParse({ ...base, category: "PAYROLL" }).success).toBe(false);
    expect(committeeInput.safeParse({ ...base, name: "  ab  " }).success).toBe(false);
    expect(committeeInput.safeParse({ ...base, name: "Panitia\u0000Wisuda" }).success).toBe(false);
    expect(committeeInput.safeParse({ ...base, description: "x".repeat(2001) }).success).toBe(false);
    // An empty optional field from a form is "none", not a too-short value.
    const parsed = committeeInput.parse({ ...base, organizer: "  ", description: "" });
    expect(parsed.organizer).toBeNull();
    expect(parsed.description).toBeNull();
  });

  it("D-05: a section coordinator needs a section; the role list matches the database CHECK", async () => {
    const member = { employeeId: someId, version: 1 };
    expect(memberAdd.safeParse({ ...member, role: "SECTION_COORDINATOR" }).success).toBe(false);
    expect(memberAdd.safeParse({ ...member, role: "SECTION_COORDINATOR", section: "Seksi Acara" }).success).toBe(true);
    expect(memberAdd.safeParse({ ...member, role: "MEMBER" }).success).toBe(true);
    expect(memberAdd.safeParse({ ...member, role: "PATRON" }).success).toBe(false);
    const sql = await readFile(new URL("../migrations/0134_committees.sql", import.meta.url), "utf8");
    const roles = /role text NOT NULL CHECK \(role IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    expect(roles.match(/'[A-Z_]+'/g)?.map((value) => value.slice(1, -1))).toEqual([...COMMITTEE_ROLES]);
    const categories = /category text NOT NULL CHECK \(category IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    expect(categories.match(/'[A-Z_]+'/g)?.map((value) => value.slice(1, -1))).toEqual([...COMMITTEE_CATEGORIES]);
  });

  it("D-07: activation needs exactly one chair, two members and only active employees", () => {
    const chair = { role: "CHAIR" as const, employeeActive: true };
    const member = { role: "MEMBER" as const, employeeActive: true };
    expect(activationProblems([chair, member])).toEqual([]);
    expect(activationProblems([member, member])).toHaveLength(1);
    expect(activationProblems([chair])).toHaveLength(1);
    expect(activationProblems([chair, chair])).toHaveLength(1);
    expect(activationProblems([chair, { ...member, employeeActive: false }])).toHaveLength(1);
    expect(activationProblems([])).toHaveLength(2);
  });

  it("D-08: a decree is issued in HCIS or recorded with its number and date", () => {
    expect(activateInput.safeParse({ version: 1, decree: { mode: "ISSUE" } }).success).toBe(true);
    expect(activateInput.safeParse({ version: 1, decree: { mode: "EXTERNAL", number: "012/SK/2026", date: "2026-11-03" } }).success).toBe(true);
    expect(activateInput.safeParse({ version: 1, decree: { mode: "EXTERNAL", number: "12" , date: "2026-11-03" } }).success).toBe(false);
    expect(activateInput.safeParse({ version: 1, decree: { mode: "EXTERNAL", number: "012/SK/2026" } }).success).toBe(false);
    expect(activateInput.safeParse({ version: 1, decree: { mode: "PAPER" } }).success).toBe(false);
  });

  it("D-09: the SK is signed by the Ketua Yayasan by default or the Direktur, never the Kepala HCM", () => {
    const parsed = activateInput.parse({ version: 1, decree: { mode: "ISSUE" } });
    expect(parsed.decree).toEqual({ mode: "ISSUE", signer: "FOUNDATION_CHAIR" });
    expect(activateInput.parse({ version: 1, decree: { mode: "ISSUE", signer: "DIRECTOR", signerName: " " } }).decree)
      .toEqual({ mode: "ISSUE", signer: "DIRECTOR", signerName: null });
    expect(activateInput.safeParse({ version: 1, decree: { mode: "ISSUE", signer: "HCM_HEAD" } }).success).toBe(false);
    expect(activateInput.safeParse({ version: 1, decree: { mode: "ISSUE", signerName: "x".repeat(121) } }).success).toBe(false);

    const chair = someId;
    const refused = (run: () => unknown) => {
      try { run(); } catch (error) { return error as CommitteeError; }
      throw new Error("expected a refusal");
    };
    expect(refused(() => committeeSigner("FOUNDATION_CHAIR", null, chair, "Nama")))
      .toMatchObject({ statusCode: 409, code: "DOCUMENT_SIGNER_UNAVAILABLE" });
    expect(refused(() => committeeSigner("DIRECTOR", { employeeId: chair, name: "Ketua Panitia" }, chair, null)))
      .toMatchObject({ statusCode: 409, code: "DOCUMENT_SIGNER_UNAVAILABLE" });
    // An Organ Yayasan account has no name in HCIS: HC types it, and it is required.
    expect(refused(() => committeeSigner("FOUNDATION_CHAIR", { employeeId: null, name: null }, chair, null)))
      .toMatchObject({ statusCode: 400, code: "INVALID_COMMITTEE" });
    expect(committeeSigner("FOUNDATION_CHAIR", { employeeId: null, name: null }, chair, "Ketua Sintetis"))
      .toEqual({ title: "Ketua Yayasan", name: "Ketua Sintetis" });
    // An employee holder's own name wins over anything typed.
    expect(committeeSigner("DIRECTOR", { employeeId: "e-direktur", name: "Direktur Sintetis" }, chair, "Nama Lain"))
      .toEqual({ title: "Direktur", name: "Direktur Sintetis" });
  });

  it("D-12: cancelling needs a 10–500 character reason", () => {
    expect(cancelInput.safeParse({ version: 1, reason: "Batal" }).success).toBe(false);
    expect(cancelInput.safeParse({ version: 1, reason: "Kegiatan ditiadakan yayasan." }).success).toBe(true);
    expect(cancelInput.safeParse({ version: 1, reason: "x".repeat(501) }).success).toBe(false);
  });

  it("§5.1/D-10/D-19: final states refuse writes, locked fields stay locked, stale versions lose", () => {
    expect(() => assertOpen("DRAFT")).not.toThrow();
    expect(() => assertOpen("ACTIVE")).not.toThrow();
    for (const status of ["COMPLETED", "CANCELLED"] as const) {
      expect(() => assertOpen(status)).toThrow(expect.objectContaining({ code: "COMMITTEE_CLOSED", statusCode: 409 }));
    }
    expect(() => assertStatus("ACTIVE", "DRAFT", "x")).toThrow(expect.objectContaining({ code: "COMMITTEE_STATE" }));
    expect(() => assertFreshVersion(2, 1)).toThrow(expect.objectContaining({ code: "COMMITTEE_STALE" }));
    const current = { name: "A", category: "EXAM", startOn: "2026-12-01" };
    expect(lockedFieldChanges("DRAFT", current, { ...current, name: "B" })).toEqual([]);
    expect(lockedFieldChanges("ACTIVE", current, { ...current, name: "B", startOn: "2026-12-02" })).toEqual(["name", "startOn"]);
    expect(lockedFieldChanges("ACTIVE", current, current)).toEqual([]);
  });

  it("D-11/D-12: join and leave dates", () => {
    expect(joinDate("DRAFT", "2026-12-01", "2026-12-31", "2026-11-03")).toBe("2026-12-01");
    expect(joinDate("ACTIVE", "2026-12-01", "2026-12-31", "2026-11-03")).toBe("2026-12-01");
    expect(joinDate("ACTIVE", "2026-10-01", "2026-12-31", "2026-11-03")).toBe("2026-11-03");
    // D-04: a past committee recorded late keeps its members inside its own period.
    expect(joinDate("ACTIVE", "2025-03-01", "2025-03-10", "2026-11-03")).toBe("2025-03-10");
    expect(leaveDate("2026-12-01", "2026-11-03")).toBe("2026-12-01");
    expect(leaveDate("2026-10-01", "2026-11-03")).toBe("2026-11-03");
    expect(leaveDate("2026-10-01", "2026-11-03", "2026-10-20")).toBe("2026-10-20");
  });

  it("escapes LIKE wildcards", () => {
    expect(likePattern("100%_a\\b")).toBe("%100\\%\\_a\\\\b%");
  });
});

describe("ORG-012 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerCommitteeRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
    return app;
  }
  const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
  const id = someId;
  const readRoutes = [
    "/admin/committees", `/admin/committees/${id}`, `/admin/committees/${id}/history`,
    "/admin/committees/participation", `/admin/committees/participation/${id}`,
  ];
  const writeRoutes: Array<{ method: "GET" | "POST" | "PATCH"; url: string }> = [
    { method: "GET", url: "/admin/committees/employee-options?q=ab" },
    { method: "POST", url: "/admin/committees" },
    { method: "PATCH", url: `/admin/committees/${id}` },
    { method: "POST", url: `/admin/committees/${id}/members` },
    { method: "PATCH", url: `/admin/committees/${id}/members/${id}` },
    { method: "POST", url: `/admin/committees/${id}/members/${id}/end` },
    { method: "POST", url: `/admin/committees/${id}/activate` },
    { method: "POST", url: `/admin/committees/${id}/complete` },
    { method: "POST", url: `/admin/committees/${id}/cancel` },
  ];

  it("answers 401 without a session", async () => {
    const anonymous = await appFor(null);
    for (const url of ["/me/committees", "/me/committees/meeting-groups", "/admin/committees"]) {
      expect((await anonymous.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });

  it("ORG-012-A: reads need committees.read, writes need committees.manage; other HC permissions open nothing", async () => {
    const none = await appFor(employee, ["training.manage", "employees.manage", "organization.manage", "help.manage"]);
    for (const url of readRoutes) {
      const response = await none.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(403);
      expect(response.json().code).toBe("COMMITTEE_FORBIDDEN");
    }
    for (const route of writeRoutes) {
      const response = await none.inject({ ...route, ...(route.method === "GET" ? {} : { payload: {} }) });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
    // committees.read alone does not write.
    const reader = await appFor(employee, ["committees.read"]);
    for (const route of writeRoutes) {
      const response = await reader.inject({ ...route, ...(route.method === "GET" ? {} : { payload: {} }) });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
    // committees.manage passes the guard and is then refused on its input.
    const manager = await appFor(employee, ["committees.manage"]);
    expect((await manager.inject({ method: "POST", url: "/admin/committees", payload: { name: "x" } })).statusCode).toBe(400);
    expect((await manager.inject({ method: "GET", url: "/admin/committees/employee-options?q=a" })).statusCode).toBe(400);
    expect((await manager.inject({ method: "POST", url: `/admin/committees/${id}/cancel`, payload: { version: 1, reason: "pendek" } })).statusCode).toBe(400);
  });

  it("Super Admin legacy and the board are not employees and get no committee data", async () => {
    for (const principalType of ["SUPER_ADMIN", "FOUNDATION_BOARD"] as const) {
      const other = await appFor({ id: "x", email: "x@example.invalid", principalType });
      expect((await other.inject({ method: "GET", url: "/me/committees" })).statusCode).toBe(403);
      expect((await other.inject({ method: "GET", url: "/admin/committees" })).statusCode).toBe(403);
    }
  });

  it("refuses invalid filters before touching the database", async () => {
    const reader = await appFor(employee, ["committees.read"]);
    for (const url of ["/admin/committees?status=OPEN", "/admin/committees?pageSize=101", "/admin/committees?q=a", "/admin/committees?year=1999",
      "/admin/committees/participation?year=abc", `/admin/committees/${id}/history?page=0`]) {
      expect((await reader.inject({ method: "GET", url })).statusCode, url).toBe(400);
    }
    expect((await reader.inject({ method: "GET", url: "/admin/committees/not-a-uuid" })).statusCode).toBe(404);
  });
});
