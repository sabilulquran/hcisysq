import { createServer, type Server } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/env.js";
import type { BoardAggregates } from "../src/modules/board/aggregates.js";
import {
  buildGovernanceSummary,
  buildHeadcountTrend,
  buildUnitRanking,
  completedMonths,
  headcountAt,
  monthEnd,
  type EmploymentSpan,
} from "../src/modules/governance/summary.js";
import { createGovernanceTokenVerifier } from "../src/modules/governance/token-verifier.js";
import { createOrganizationDirectoryMachineTokenVerifier } from "../src/modules/organization-directory/machine-auth.js";

// ORG-010 §3.2, §4: synthetic data only.

const NOW = new Date("2026-10-17T05:00:00Z");

function unit(name: string, count: number) {
  return { unitName: name, employeeCount: count };
}

function aggregates(overrides: Partial<BoardAggregates> = {}): BoardAggregates {
  return {
    generatedAt: NOW.toISOString(),
    employees: { active: 42, inactive: 3, resigned: 5, total: 50 },
    entitlementGroups: { education: 20, nonEducation: 20, unclassified: 2 },
    approvalReadiness: {
      activeEmployees: 42, withDirectManager: 40, withoutDirectManager: 2,
      activeUnits: 4, unitsWithApprover: 3, unitsWithoutApprover: 1,
    },
    workflow: { leaveInReview: 4, hcValidationPending: 0, attendanceResolutionOpen: 2 },
    movements: { startedThisYear: 6, endedThisYear: 1 },
    unitDistribution: [unit("Unit Alfa", 20), unit("Unit Beta", 15), unit("Tanpa Unit", 5), unit("Unit Gamma", 2)],
    employmentStatus: [{ employmentStatus: "Pegawai Tetap", employeeCount: 42 }],
    ...overrides,
  };
}

function span(startedOn: string | null, endedOn: string | null = null, endBasis: EmploymentSpan["endBasis"] = null, baseline = true): EmploymentSpan {
  return { startedOn, endedOn, endBasis: endedOn ? "RECORDED" : endBasis, baseline };
}

describe("ORG-010-H headcount-by-unit ranking", () => {
  it("folds units under 3 into Lainnya and keeps 'Tanpa Unit' as an ordinary item", () => {
    expect(buildUnitRanking(aggregates().unitDistribution)).toEqual([
      { label: "Unit Alfa", value: 20 },
      { label: "Unit Beta", value: 15 },
      { label: "Tanpa Unit", value: 5 },
      { label: "Lainnya", value: 2 },
    ]);
  });

  it("shows up to 8 units when nothing is folded", () => {
    const rows = Array.from({ length: 8 }, (_, index) => unit(`Unit ${index}`, 20 - index));
    const ranking = buildUnitRanking(rows);
    expect(ranking).toHaveLength(8);
    expect(ranking.map((item) => item.label)).not.toContain("Lainnya");
  });

  it("keeps at most 7 units plus Lainnya once anything is folded, largest first, ties by name", () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, index) => unit(`Unit ${String.fromCharCode(73 - index)}`, 10)),
      unit("Kecil", 1),
    ];
    const ranking = buildUnitRanking(rows);
    expect(ranking).toHaveLength(8);
    expect(ranking.slice(0, 7).map((item) => item.label)).toEqual(["Unit A", "Unit B", "Unit C", "Unit D", "Unit E", "Unit F", "Unit G"]);
    expect(ranking[7]).toEqual({ label: "Lainnya", value: 10 + 10 + 1 });
  });

  it("folds overflow beyond 8 units even when every unit is large", () => {
    const ranking = buildUnitRanking(Array.from({ length: 10 }, (_, index) => unit(`Unit ${index}`, 30 - index)));
    expect(ranking).toHaveLength(8);
    expect(ranking[7]).toEqual({ label: "Lainnya", value: 23 + 22 + 21 });
  });

  it("returns a single Lainnya when every unit is small and nothing when there are no employees", () => {
    expect(buildUnitRanking([unit("A", 2), unit("B", 1)])).toEqual([{ label: "Lainnya", value: 3 }]);
    expect(buildUnitRanking([])).toEqual([]);
  });
});

describe("ORG-010-G monthly active-headcount trend", () => {
  it("uses only the last 12 completed months in Asia/Jakarta, oldest first", () => {
    expect(completedMonths(NOW)).toEqual([
      "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03",
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
    ]);
    // 31 Oct 2026 20:00 UTC is already 1 Nov in Jakarta: October is then complete.
    expect(completedMonths(new Date("2026-10-31T20:00:00Z")).at(-1)).toBe("2026-10");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
  });

  it("counts employments active at each month end", () => {
    const spans = [span("2020-01-01"), span("2026-03-15"), span("2020-01-01", "2026-05-31")];
    expect(headcountAt(spans, "2026-02-28")).toBe(2);
    expect(headcountAt(spans, "2026-03-31")).toBe(3);
    expect(headcountAt(spans, "2026-05-31")).toBe(2);
  });

  it("gives null, never zero, when an unknown basis could change the month", () => {
    const unknownStart = [span("2020-01-01"), span(null)];
    expect(headcountAt(unknownStart, "2026-01-31")).toBeNull();
    // An unknown end only blurs months after the known start.
    const unknownEnd = [span("2020-01-01"), span("2026-04-01", null, "UNKNOWN")];
    expect(headcountAt(unknownEnd, "2026-03-31")).toBe(1);
    expect(headcountAt(unknownEnd, "2026-04-30")).toBeNull();
    // A recorded end before the month makes an unknown start irrelevant.
    expect(headcountAt([span("2020-01-01"), { startedOn: null, endedOn: "2025-01-31", endBasis: "RECORDED", baseline: true }], "2026-01-31")).toBe(1);
  });

  it("gives null for months ending before the earliest recorded start among active baseline rows", () => {
    const spans = [span("2026-06-01"), span("2026-07-10"), span("2026-01-01", null, null, false)];
    expect(headcountAt(spans, "2026-05-31")).toBeNull();
    expect(headcountAt(spans, "2026-06-30")).toBe(2);
  });

  it("appears only in AUTHORITATIVE mode", () => {
    const spans = [span("2020-01-01"), span("2021-01-01")];
    expect(buildHeadcountTrend(spans, "OFF", NOW)).toBeNull();
    expect(buildHeadcountTrend(spans, "SHADOW", NOW)).toBeNull();
    expect(buildHeadcountTrend(spans, null, NOW)).toBeNull();
    const trend = buildHeadcountTrend(spans, "AUTHORITATIVE", NOW)!;
    expect(trend.periods).toHaveLength(12);
    expect(trend.values).toEqual(Array(12).fill(2));
    expect(trend.trend.change).toEqual({ value: 0, unit: "orang", direction: "flat" });
    expect(trend.trend.change).not.toHaveProperty("good");
  });

  it("is omitted with fewer than 6 known points and kept with exactly 6", () => {
    // Earliest active baseline start mid-window: earlier months are null.
    expect(buildHeadcountTrend([span("2026-05-01")], "AUTHORITATIVE", NOW)).toBeNull();
    const six = buildHeadcountTrend([span("2026-04-01")], "AUTHORITATIVE", NOW)!;
    expect(six.values.filter((value) => value !== null)).toHaveLength(6);
    expect(six.values.slice(0, 6)).toEqual(Array(6).fill(null));
    // The point 12 months before the last is unknown, so there is no change.
    expect(six.trend.change).toBeUndefined();
  });

  it("compares the last point with the point 12 months earlier", () => {
    const spans = [span("2020-01-01"), span("2025-10-01"), span("2026-02-01"), span("2020-01-01", "2026-08-15")];
    const trend = buildHeadcountTrend(spans, "AUTHORITATIVE", NOW)!;
    // 2025-09: 2 active; 2026-09: 3 active.
    expect(trend.trend.change).toEqual({ value: 1, unit: "orang", direction: "up" });
  });
});

describe("ORG-010-F governance summary contract v1", () => {
  const base = {
    aggregates: aggregates(),
    employmentMode: "SHADOW" as const,
    employmentSpans: [],
    applicationKey: "hcis",
    publicOrigin: "https://hcis.example.invalid",
    now: NOW,
  };

  it("returns the HUB-IMPL-021 v1 shape with fixed labels and configured key and links", () => {
    const summary = buildGovernanceSummary(base);
    expect(summary).toMatchObject({
      contractVersion: 1, applicationKey: "hcis", title: "SDM", dataAsOf: NOW.toISOString(),
      detailUrl: "https://hcis.example.invalid/board",
    });
    expect(summary.metrics.map((metric) => [metric.key, metric.label, metric.value])).toEqual([
      ["active_employees", "Pegawai aktif", 42],
      ["started_this_year", "Pegawai masuk tahun ini", 6],
      ["ended_this_year", "Pegawai keluar tahun ini", 1],
      ["without_direct_manager", "Pegawai aktif tanpa atasan langsung", 2],
      ["units_without_approver", "Unit tanpa penyetuju cuti", 1],
      ["leave_in_review", "Pengajuan cuti dalam proses", 4],
    ]);
    expect(summary.metrics.filter((metric) => metric.headline).map((metric) => metric.key)).toEqual(["active_employees"]);
    expect(summary.metrics.find((metric) => metric.key === "without_direct_manager")?.tone).toBe("attention");
    expect(summary.metrics.find((metric) => metric.key === "leave_in_review")).not.toHaveProperty("tone");
    expect(summary.attention).toEqual([
      { label: "Unit tanpa penyetuju cuti", count: 1, href: "https://hcis.example.invalid/board" },
      { label: "Kasus presensi belum selesai", count: 2, href: "https://hcis.example.invalid/board" },
    ]);
    // Not AUTHORITATIVE: only the ranking chart, no trend.
    expect(summary.charts?.map((chart) => chart.kind)).toEqual(["ranking"]);
    expect(summary.metrics[0]).not.toHaveProperty("trend");
    expect(summary).not.toHaveProperty("actor");
  });

  it("omits attention and tone when every workload count is zero", () => {
    const summary = buildGovernanceSummary({
      ...base,
      aggregates: aggregates({
        approvalReadiness: { activeEmployees: 1, withDirectManager: 1, withoutDirectManager: 0, activeUnits: 1, unitsWithApprover: 1, unitsWithoutApprover: 0 },
        workflow: { leaveInReview: 0, hcValidationPending: 0, attendanceResolutionOpen: 0 },
        unitDistribution: [],
      }),
    });
    expect(summary).not.toHaveProperty("attention");
    expect(summary).not.toHaveProperty("charts");
    expect(summary.metrics.some((metric) => "tone" in metric)).toBe(false);
  });

  it("adds the trend metric and trend chart in AUTHORITATIVE mode", () => {
    const summary = buildGovernanceSummary({ ...base, employmentMode: "AUTHORITATIVE", employmentSpans: [span("2020-01-01")] });
    expect(summary.metrics[0].trend?.points).toHaveLength(12);
    expect(summary.charts?.map((chart) => [chart.kind, chart.key])).toEqual([
      ["trend", "active_headcount_monthly"], ["ranking", "active_headcount_by_unit"],
    ]);
    const chart = summary.charts![0];
    expect(chart.kind === "trend" && chart.series[0].values.length === chart.periods.length).toBe(true);
    expect(chart.kind === "trend" && chart.periods).not.toContain("2026-10");
  });
});

describe("ORG-010 §3.2 exchanged token verifier", () => {
  let server: Server;
  let issuer: string;
  let closedIssuer: string;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  const kid = "governance-test-key";
  const audience = "hcis-web";
  const hubClient = "sq-hub";

  beforeAll(async () => {
    keys = await generateKeyPair("RS256", { extractable: true });
    otherKeys = await generateKeyPair("RS256", { extractable: true });
    const jwk = { ...(await exportJWK(keys.publicKey)), kid, alg: "RS256", use: "sig" };
    server = createServer((request, response) => {
      if (request.url?.endsWith("/protocol/openid-connect/certs")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    issuer = `http://127.0.0.1:${address.port}/realms/staff`;
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedAddress = closed.address();
    if (!closedAddress || typeof closedAddress === "string") throw new Error("closed server did not bind");
    closedIssuer = `http://127.0.0.1:${closedAddress.port}/realms/staff`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function sign(claims: Record<string, unknown> = {}, options: { iss?: string; exp?: string | number; key?: "other"; alg?: string } = {}) {
    return new SignJWT({ typ: "Bearer", azp: hubClient, aud: [audience, "account"], ...claims })
      .setProtectedHeader({ alg: options.alg ?? "RS256", kid })
      .setIssuer(options.iss ?? issuer)
      .setSubject(typeof claims.sub === "string" ? claims.sub : "synthetic-subject")
      .setIssuedAt()
      .setExpirationTime(options.exp ?? "5m")
      .sign(options.key === "other" ? otherKeys.privateKey : keys.privateKey);
  }

  const verifier = () => createGovernanceTokenVerifier({ issuer, audience, allowedClients: new Set([hubClient]) });

  it("accepts a token exchanged by SQ Hub for the HCIS audience and returns only iss + sub", async () => {
    await expect(verifier()(await sign())).resolves.toEqual({ issuer, subject: "synthetic-subject" });
  });

  it.each([
    ["bad signature", () => sign({}, { key: "other" }), "INVALID_TOKEN", 401],
    ["wrong issuer", () => sign({}, { iss: "https://identity.example.invalid/realms/staff" }), "INVALID_TOKEN", 401],
    ["expired", () => sign({}, { exp: Math.floor(Date.now() / 1000) - 120 }), "INVALID_TOKEN", 401],
    ["ID token", () => sign({ typ: "ID" }), "INVALID_TOKEN", 401],
    ["refresh token", () => sign({ typ: "Refresh" }), "INVALID_TOKEN", 401],
    ["aud without HCIS", () => sign({ aud: "account" }), "FORBIDDEN_AUDIENCE", 403],
    ["aud of another app", () => sign({ aud: "aset-sq" }), "FORBIDDEN_AUDIENCE", 403],
    ["azp not allowlisted", () => sign({ azp: "aset-sq" }), "FORBIDDEN_CLIENT", 403],
    ["azp missing", () => sign({ azp: undefined }), "FORBIDDEN_CLIENT", 403],
    ["subject too long", () => sign({ sub: "s".repeat(513) }), "INVALID_TOKEN", 401],
    ["malformed", async () => "not-a-jwt", "INVALID_TOKEN", 401],
  ])("refuses %s", async (_label, make, code, statusCode) => {
    await expect(verifier()(await make())).rejects.toMatchObject({ code, statusCode });
  });

  it("refuses a token issued in the future beyond the 30-second skew", async () => {
    const token = await new SignJWT({ typ: "Bearer", azp: hubClient, aud: audience })
      .setProtectedHeader({ alg: "RS256", kid }).setIssuer(issuer).setSubject("s")
      .setIssuedAt(Math.floor(Date.now() / 1000) + 300).setExpirationTime("10m").sign(keys.privateKey);
    await expect(verifier()(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("returns 503 JWKS_UNAVAILABLE when the signing keys are unreachable (D9)", async () => {
    const unreachable = createGovernanceTokenVerifier({ issuer: closedIssuer, audience, allowedClients: new Set([hubClient]) });
    await expect(unreachable(await sign({}, { iss: closedIssuer }))).rejects.toMatchObject({ code: "JWKS_UNAVAILABLE", statusCode: 503 });
  });

  it("refuses machine tokens here and the exchanged token on the machine routes", async () => {
    const directoryAudience = "hcis-organization-directory";
    const machine = await new SignJWT({ typ: "Bearer", azp: "sq-hub-organization-directory", scope: "organization-directory.read" })
      .setProtectedHeader({ alg: "RS256", kid }).setIssuer(issuer).setAudience(directoryAudience)
      .setSubject("service-account").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    await expect(verifier()(machine)).rejects.toMatchObject({ code: "FORBIDDEN_AUDIENCE" });
    const staffIdentity = await sign({ aud: "hcis-staff-identity", azp: "sq-hub-staff-identity" });
    await expect(verifier()(staffIdentity)).rejects.toMatchObject({ code: "FORBIDDEN_AUDIENCE" });

    for (const machineAudience of [directoryAudience, "hcis-staff-identity"]) {
      const directory = createOrganizationDirectoryMachineTokenVerifier({
        issuer, audience: machineAudience, allowedClients: new Set(["sq-hub-organization-directory", hubClient]),
        requiredScope: "organization-directory.read",
      });
      await expect(directory(await sign())).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    }
  });
});

describe("ORG-010 §9 configuration", () => {
  const base = { DATABASE_URL: "postgres://synthetic@127.0.0.1:1/unused" };
  const oidc = {
    AUTH_MODE: "oidc", OIDC_ISSUER: "https://identity.example.invalid/realms/staff", OIDC_CLIENT_ID: "hcis-web",
    OIDC_CLIENT_SECRET: "synthetic", OIDC_REDIRECT_URI: "https://hcis.example.invalid/api/auth/callback",
    OIDC_POST_LOGOUT_REDIRECT_URI: "https://hcis.example.invalid/", SQ_HUB_APPLICATION_ACCESS_URL: "https://hub.example.invalid/access",
    SQ_HUB_MACHINE_CLIENT_ID: "hcis-machine", SQ_HUB_MACHINE_CLIENT_SECRET: "synthetic",
  };
  const governance = {
    GOVERNANCE_SUMMARY_ENABLED: "true", GOVERNANCE_SUMMARY_AUDIENCE: "hcis-web",
    GOVERNANCE_SUMMARY_ALLOWED_CLIENTS: "sq-hub", GOVERNANCE_SUMMARY_APPLICATION_KEY: "hcis",
  };

  it("is disabled by default", () => {
    expect(loadConfig(base).GOVERNANCE_SUMMARY_ENABLED).toBe("false");
  });

  it("requires OIDC login and every governance setting when enabled", () => {
    expect(() => loadConfig({ ...base, ...governance })).toThrow(/requires AUTH_MODE=oidc/);
    expect(() => loadConfig({ ...base, ...oidc, GOVERNANCE_SUMMARY_ENABLED: "true" })).toThrow(/GOVERNANCE_SUMMARY_AUDIENCE is required/);
    expect(loadConfig({ ...base, ...oidc, ...governance }).GOVERNANCE_SUMMARY_APPLICATION_KEY).toBe("hcis");
  });

  it("fails startup when the governance audience equals a machine-token audience", () => {
    expect(() => loadConfig({ ...base, ...oidc, ...governance, ORG_DIRECTORY_TOKEN_AUDIENCE: "hcis-web" }))
      .toThrow(/must differ from ORG_DIRECTORY_TOKEN_AUDIENCE/);
    expect(() => loadConfig({ ...base, ...oidc, ...governance, STAFF_IDENTITY_TOKEN_AUDIENCE: "hcis-web" }))
      .toThrow(/must differ from STAFF_IDENTITY_TOKEN_AUDIENCE/);
  });
});
