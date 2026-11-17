// REWARD-001: rules without a database, the Al-Qur'an scoreboard adapter, the certificate PDF and
// the route guards. Synthetic people only.

import Fastify from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import { pdfSafeText, renderCertificatePdf } from "../src/modules/rewards/certificate-pdf.js";
import {
  categoryLabel,
  dueMonth,
  generateVerificationCode,
  isMonthFinal,
  monthLabel,
  nextRank,
  normalizeVerificationCode,
  parseManualSnapshot,
  selectCandidates,
  type SnapshotRow,
} from "../src/modules/rewards/domain.js";
import { QuranMonthlyScoreboardClient, notConfiguredReader } from "../src/modules/rewards/quran-scoreboard-client.js";
import { registerRewardRoutes } from "../src/modules/rewards/routes.js";

const ISSUER = "https://login.example.test/realms/sq-staff";
const grant = vi.fn();

vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return {
    ...actual,
    discovery: () => Promise.resolve(new actual.Configuration(
      { issuer: ISSUER, token_endpoint: `${ISSUER}/protocol/openid-connect/token` },
      "hcis-quran-scoreboard",
      "synthetic-secret",
    )),
    clientCredentialsGrant: (...args: unknown[]) => grant(...(args as [])),
  };
});

const person = (n: number) => `hcis:employee:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const unit = (n: number) => `hcis:org-node:10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function row(scope: "FOUNDATION" | "UNIT", n: number, rank: number, unitN = 0, pages = 100 - rank): SnapshotRow {
  return {
    scope, unitRef: scope === "UNIT" ? unit(unitN) : "", personRef: person(n), rank, pages, activeDays: 20, khatam: 0, labels: [],
  };
}

describe("REWARD-001 candidate selection", () => {
  it("R-03: top 3 of the foundation and top 1 of each unit", () => {
    const seats = selectCandidates([
      row("FOUNDATION", 1, 1), row("FOUNDATION", 2, 2), row("FOUNDATION", 3, 3), row("FOUNDATION", 4, 4),
      row("UNIT", 5, 1, 1), row("UNIT", 6, 2, 1),
      row("UNIT", 7, 1, 2),
    ]);
    expect(seats.map((seat) => [seat.category, seat.seat, seat.row.personRef])).toEqual([
      ["FOUNDATION", 1, person(1)], ["FOUNDATION", 2, person(2)], ["FOUNDATION", 3, person(3)],
      ["UNIT", 1, person(5)], ["UNIT", 1, person(7)],
    ]);
  });

  it("R-07: a foundation candidate leaves the unit seat to the next rank of that unit", () => {
    const seats = selectCandidates([
      row("FOUNDATION", 1, 1), row("FOUNDATION", 2, 2), row("FOUNDATION", 3, 3),
      row("UNIT", 1, 1, 1), row("UNIT", 9, 2, 1),
    ]);
    expect(seats.filter((seat) => seat.category === "UNIT").map((seat) => seat.row.personRef)).toEqual([person(9)]);
  });

  it("R-11: everyone tied at a seat boundary is a candidate", () => {
    const seats = selectCandidates([
      row("FOUNDATION", 1, 1), row("FOUNDATION", 2, 2), row("FOUNDATION", 3, 3), row("FOUNDATION", 4, 3), row("FOUNDATION", 5, 5),
      row("UNIT", 6, 1, 1), row("UNIT", 7, 1, 1), row("UNIT", 8, 3, 1),
    ]);
    expect(seats.filter((seat) => seat.category === "FOUNDATION").map((seat) => [seat.seat, seat.row.personRef]))
      .toEqual([[1, person(1)], [2, person(2)], [3, person(3)], [3, person(4)]]);
    expect(seats.filter((seat) => seat.category === "UNIT").map((seat) => seat.row.personRef)).toEqual([person(6), person(7)]);
  });

  it("R-15 DRAFT: one candidacy per person; an empty or zero-page board gives no candidate", () => {
    const seats = selectCandidates([
      row("UNIT", 1, 1, 1), row("UNIT", 1, 1, 2), row("UNIT", 2, 2, 2), row("UNIT", 3, 1, 3, 0),
    ]);
    expect(seats.map((seat) => [seat.unitRef, seat.row.personRef])).toEqual([[unit(1), person(1)], [unit(2), person(2)]]);
    expect(selectCandidates([])).toEqual([]);
  });

  it("R-08: the next rank comes from the same board, ties together, skipping existing candidates", () => {
    const board = [row("FOUNDATION", 1, 1), row("FOUNDATION", 2, 2), row("FOUNDATION", 3, 3), row("FOUNDATION", 4, 4), row("FOUNDATION", 5, 4)];
    const taken = new Set([person(1), person(2), person(3)]);
    expect(nextRank(board, taken).map((entry) => entry.personRef)).toEqual([person(4), person(5)]);
    expect(nextRank(board, new Set(board.map((entry) => entry.personRef)))).toEqual([]);
  });
});

describe("REWARD-001 calendar and wording", () => {
  it("a month is final on the 3rd of the next month at 00:00 WIB; the round is due at 06:00 WIB", () => {
    expect(isMonthFinal("2026-10", new Date("2026-11-02T16:59:59Z"))).toBe(false);
    expect(isMonthFinal("2026-10", new Date("2026-11-02T17:00:00Z"))).toBe(true);
    expect(isMonthFinal("2026-12", new Date("2027-01-02T17:00:00Z"))).toBe(true);
    expect(dueMonth(new Date("2026-11-02T22:59:00Z"))).toBeNull();
    expect(dueMonth(new Date("2026-11-02T23:00:00Z"))).toBe("2026-10");
    expect(dueMonth(new Date("2027-01-20T00:00:00Z"))).toBe("2026-12");
  });

  it("labels categories and months in Indonesian", () => {
    expect(monthLabel("2026-11")).toBe("November 2026");
    expect(categoryLabel("FOUNDATION", 1, null)).toBe("Terbaik Tilawah Yayasan — Peringkat 1");
    expect(categoryLabel("UNIT", 1, "SMPIT")).toBe("Terbaik Tilawah SMPIT");
  });

  it("verification codes carry at least 128 random bits and read back normalized", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateVerificationCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const code = [...codes][0]!;
    expect(normalizeVerificationCode(` ${code.toLowerCase()} `)).toBe(code);
    expect(normalizeVerificationCode("too-short")).toBeNull();
  });

  it("renders a one-page PDF with the code and no score", () => {
    const pdf = renderCertificatePdf({
      recipientName: "Siti Aminah", categoryLabel: categoryLabel("FOUNDATION", 2, null), monthLabel: "Oktober 2026",
      issuerName: "Ahmad Fauzi", verificationCode: "0123456789ABCDEFGHJKMNPQRS", verifyUrl: "https://hcis.example.test/verifikasi/penghargaan/0123456789ABCDEFGHJKMNPQRS",
    });
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("(Siti Aminah)");
    expect(text).toContain("Peringkat 2");
    expect(text).toContain("0123456789ABCDEFGHJKMNPQRS");
    // The xref offsets point at the objects.
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    expect(pdfSafeText("Zahrá (أ)")).toBe("Zahra (?)");
  });
});

describe("REWARD-001 manual CSV snapshot (R-14 DRAFT)", () => {
  const header = "cakupan,peringkat,nip,halaman,hari_aktif,khatam,label";

  it("reads foundation and unit boards with labels and decimal commas", () => {
    const parsed = parseManualSnapshot([
      header,
      "YAYASAN,1,NIP-001,120.5,25,1,otomatis|mandiri",
      "Yayasan,2,NIP-002,\"98,0\",20,0,",
      "SMPIT,1,NIP-003,80,18,0,mandiri",
    ].join("\r\n"));
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows.map((entry) => [entry.scopeToken, entry.rank, entry.employeeNumber, entry.pages, entry.labels])).toEqual([
      ["YAYASAN", 1, "NIP-001", 120.5, ["AUTO", "SELF_REPORTED"]],
      ["YAYASAN", 2, "NIP-002", 98, []],
      ["SMPIT", 1, "NIP-003", 80, ["SELF_REPORTED"]],
    ]);
  });

  it("refuses the whole file with line numbers when anything is wrong", () => {
    expect(parseManualSnapshot("nama,skor\nA,1").problems[0]!.line).toBe(1);
    const parsed = parseManualSnapshot([
      header,
      "YAYASAN,0,NIP-001,12.55,40,1,lainnya",
      "YAYASAN,1,NIP-002,10,1,0,",
      "YAYASAN,2,NIP-002,9,1,0,",
    ].join("\n"));
    expect(parsed.rows).toEqual([]);
    expect(parsed.problems.map((problem) => problem.line)).toEqual([2, 4]);
    expect(parseManualSnapshot(`${header}\nSMPIT,1,NIP-1,5,1,0,`).problems[0]!.message).toContain("YAYASAN");
  });
});

describe("REWARD-001 Al-Qur'an scoreboard adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    grant.mockReset();
  });

  const snapshot = {
    schemaVersion: 1,
    month: "2026-10",
    snapshotVersion: "quran-snap-2026-10-v1",
    finalizedAt: "2026-11-02T17:00:00.000Z",
    directory: { version: "sha256:abc", asOf: "2026-11-02T16:00:00.000Z", stale: false },
    scopes: [
      { scope: "FOUNDATION", unitId: null, entries: [
        { personId: person(1), unitId: unit(1), rank: 1, pages: 120.5, activeDays: 25, khatam: 1, labels: ["AUTO"] },
      ] },
      { scope: "UNIT", unitId: unit(1), entries: [] },
    ],
  };

  function client() {
    grant.mockResolvedValue({ access_token: "synthetic-token", expires_in: 300 });
    return new QuranMonthlyScoreboardClient(ISSUER, "hcis-quran-scoreboard", "synthetic-secret", "https://hub.example.test", "sq-hub-quran");
  }

  it("asks for the month with a scoped machine token and accepts the v1 contract", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await client().read("2026-10");
    expect(result.status).toBe("AVAILABLE");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hub.example.test/internal/quran/v1/scoreboards/monthly?month=2026-10");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer synthetic-token");
    expect(grant.mock.calls[0]![1]).toEqual({ scope: "quran.scoreboard.read", audience: "sq-hub-quran" });
  });

  it("waits on 409 period_not_final, and never turns a bad answer into candidates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "period_not_final" }), { status: 409 })));
    expect(await client().read("2026-10")).toEqual({ status: "NOT_FINAL" });

    for (const body of [
      { ...snapshot, month: "2026-09" },
      { ...snapshot, extra: true },
      { ...snapshot, scopes: [] },
      { ...snapshot, scopes: [{ ...snapshot.scopes[0], entries: [
        { personId: person(1), unitId: null, rank: 2, pages: 10, activeDays: 1, khatam: 0, labels: [] },
        { personId: person(2), unitId: null, rank: 1, pages: 12, activeDays: 1, khatam: 0, labels: [] },
      ] }] },
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
      expect(await client().read("2026-10")).toMatchObject({ status: "UNAVAILABLE", failure: "INVALID_RESPONSE" });
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    expect(await client().read("2026-10")).toMatchObject({ status: "UNAVAILABLE", failure: "HTTP_ERROR", httpStatus: 503 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("connect ECONNREFUSED"); }));
    expect(await client().read("2026-10")).toMatchObject({ status: "UNAVAILABLE", failure: "UNREACHABLE" });
    grant.mockReset();
    grant.mockRejectedValue(new Error("invalid_client"));
    const failing = new QuranMonthlyScoreboardClient(ISSUER, "hcis-quran-scoreboard", "bad", "https://hub.example.test", "sq-hub-quran");
    expect(await failing.read("2026-10")).toMatchObject({ status: "UNAVAILABLE", failure: "TOKEN_FAILED" });
  });

  it("answers NOT_CONFIGURED without settings", async () => {
    expect(await notConfiguredReader.read("2026-10")).toEqual({ status: "NOT_CONFIGURED" });
  });
});

describe("REWARD-001 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerRewardRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      reader: null,
      auth: {
        getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
        getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
      } as never,
    });
    return app;
  }
  const employee = { id: "00000000-0000-4000-8000-0000000000aa", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
  const id = "00000000-0000-4000-8000-000000000001";

  it("answers 401 without a session", async () => {
    const app = await appFor(null);
    for (const url of ["/admin/rewards/rounds", "/rewards/recipients", "/me/rewards"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
  });

  it("refuses the admin screens to an ordinary employee and to legacy Super Admin", async () => {
    for (const app of [await appFor(employee, ["leave.approve"]), await appFor({ ...employee, principalType: "SUPER_ADMIN" }, ["employees.manage", "access.manage"])]) {
      for (const url of ["/admin/rewards/source", "/admin/rewards/rounds", `/admin/rewards/rounds/${id}`, `/admin/rewards/rounds/${id}/events`]) {
        expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(403);
      }
      for (const url of [
        "/admin/rewards/rounds", "/admin/rewards/imports", `/admin/rewards/candidates/${id}/award`, `/admin/rewards/candidates/${id}/decline`,
        `/admin/rewards/candidates/${id}/next-rank`, `/admin/rewards/rounds/${id}/publish`, `/admin/rewards/rounds/${id}/cancel`,
        `/admin/rewards/awards/${id}/revoke`, `/admin/rewards/outbox/${id}/retry`,
      ]) {
        expect((await app.inject({ method: "POST", url, payload: {} })).statusCode, url).toBe(403);
      }
    }
  });

  it("keeps reading, importing and managing apart", async () => {
    const reader = await appFor(employee, ["reward.read", "reward.import"]);
    for (const url of ["/admin/rewards/rounds", `/admin/rewards/candidates/${id}/next-rank`, `/admin/rewards/rounds/${id}/publish`]) {
      expect((await reader.inject({ method: "POST", url, payload: { month: "2026-10" } })).statusCode, url).toBe(403);
    }
    const manager = await appFor(employee, ["reward.read", "reward.manage"]);
    expect((await manager.inject({ method: "POST", url: "/admin/rewards/imports", payload: {} })).statusCode).toBe(403);
  });

  it("validates input after the guard", async () => {
    const manager = await appFor(employee, ["reward.read", "reward.manage", "reward.import"]);
    expect((await manager.inject({ method: "POST", url: "/admin/rewards/rounds", payload: { month: "2026-13" } })).statusCode).toBe(400);
    expect((await manager.inject({ method: "POST", url: `/admin/rewards/rounds/${id}/cancel`, payload: { reason: "x" } })).statusCode).toBe(400);
    expect((await manager.inject({ method: "POST", url: "/admin/rewards/candidates/not-a-uuid/award" })).statusCode).toBe(400);
    expect((await manager.inject({ method: "GET", url: "/admin/rewards/rounds?pageSize=500" })).statusCode).toBe(400);
  });

  it("the public check refuses a malformed code without reading anything and is rate limited", async () => {
    const app = await appFor(null);
    expect((await app.inject({ method: "GET", url: "/public/rewards/verify/abc" })).statusCode).toBe(404);
    let last = 0;
    for (let index = 0; index < 31; index += 1) {
      last = (await app.inject({ method: "GET", url: "/public/rewards/verify/abc", remoteAddress: "198.51.100.7" })).statusCode;
    }
    expect(last).toBe(429);
  });
});
