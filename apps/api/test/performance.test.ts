import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import { HC_ADMIN_PERMISSIONS, PERFORMANCE_PERMISSIONS } from "../src/modules/auth/permissions.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  canRaterReview,
  DEFAULT_RUBRIC,
  finalScore,
  PerformancePolicyError,
  predicateFor,
  statusOnClose,
  validateCyclePeriod,
  validateRubric,
  validateScores,
  type Rubric,
} from "../src/modules/performance/domain.js";
import { registerPerformanceRoutes } from "../src/modules/performance/routes.js";

const all = (score: number) => Object.fromEntries(DEFAULT_RUBRIC.indicators.map((item) => [item.code, score]));

describe("PERF-001 domain rules", () => {
  it("accepts the default rubric and orders predicates highest first", () => {
    const rubric = validateRubric(DEFAULT_RUBRIC);
    expect(rubric.indicators.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
    expect(rubric.predicates.map((item) => item.code)).toEqual(["A", "B", "C", "D"]);
  });

  it("PERF-001-E: refuses weights that do not add up to 100 and predicates without a floor of 1", () => {
    const heavy: Rubric = { ...DEFAULT_RUBRIC, indicators: DEFAULT_RUBRIC.indicators.map((item) => ({ ...item, weight: item.weight + 1 })) };
    expect(() => validateRubric(heavy)).toThrow(expect.objectContaining({ code: "PERFORMANCE_RUBRIC_INVALID" }));
    const noFloor: Rubric = { ...DEFAULT_RUBRIC, predicates: DEFAULT_RUBRIC.predicates.filter((item) => item.code !== "D") };
    expect(() => validateRubric(noFloor)).toThrow(PerformancePolicyError);
    const duplicate: Rubric = { ...DEFAULT_RUBRIC, indicators: [...DEFAULT_RUBRIC.indicators, { ...DEFAULT_RUBRIC.indicators[0]!, weight: 0 }] };
    expect(() => validateRubric(duplicate)).toThrow(PerformancePolicyError);
    const threeDecimals: Rubric = { ...DEFAULT_RUBRIC, predicates: [{ code: "A", label: "A", minScore: 3.125 }, { code: "D", label: "D", minScore: 1 }] };
    expect(() => validateRubric(threeDecimals)).toThrow(PerformancePolicyError);
  });

  it("PERF-001-D: scores every indicator exactly once with a whole number 1..4", () => {
    expect(validateScores(DEFAULT_RUBRIC, all(3))).toEqual(all(3));
    expect(() => validateScores(DEFAULT_RUBRIC, { ...all(3), EXTRA: 2 })).toThrow(expect.objectContaining({ code: "PERFORMANCE_SCORES_INVALID" }));
    const { TASK_RESULT: _dropped, ...missing } = all(3);
    void _dropped;
    expect(() => validateScores(DEFAULT_RUBRIC, missing)).toThrow(PerformancePolicyError);
    expect(() => validateScores(DEFAULT_RUBRIC, { ...all(3), TASK_RESULT: 5 })).toThrow(PerformancePolicyError);
    expect(() => validateScores(DEFAULT_RUBRIC, { ...all(3), TASK_RESULT: 2.5 })).toThrow(PerformancePolicyError);
  });

  it("computes the legacy weighted average exactly and maps it to the legacy grade bands (D-05, D-06)", () => {
    expect(finalScore(DEFAULT_RUBRIC, all(4))).toBe(4);
    expect(finalScore(DEFAULT_RUBRIC, all(1))).toBe(1);
    // 30×4 + 20×3 + 20×4 + 15×3 + 15×3 = 350 → 3.50, exactly the A boundary.
    const mixed = { TASK_RESULT: 4, DISCIPLINE: 3, AKHLAK: 4, TEAMWORK: 3, INITIATIVE: 3 };
    expect(finalScore(DEFAULT_RUBRIC, mixed)).toBe(3.5);
    expect(predicateFor(DEFAULT_RUBRIC, 3.5).code).toBe("A");
    expect(predicateFor(DEFAULT_RUBRIC, 3.49).code).toBe("B");
    expect(predicateFor(DEFAULT_RUBRIC, 2.5).code).toBe("B");
    expect(predicateFor(DEFAULT_RUBRIC, 1.5).code).toBe("C");
    expect(predicateFor(DEFAULT_RUBRIC, 1.49).code).toBe("D");
    // The legacy test case: (3×40 + 4×60) / 100 = 3.6 → A.
    const legacy: Rubric = {
      indicators: [{ code: "X", label: "X", description: "", weight: 40 }, { code: "Y", label: "Y", description: "", weight: 60 }],
      predicates: DEFAULT_RUBRIC.predicates,
    };
    expect(finalScore(legacy, { X: 3, Y: 4 })).toBe(3.6);
  });

  it("D-02: a monthly cycle is one calendar month, an annual cycle one academic year", () => {
    expect(() => validateCyclePeriod({ kind: "MONTHLY", periodStart: "2026-02-01", periodEnd: "2026-02-28", selfDueOn: "2026-02-25", reviewDueOn: "2026-03-05" })).not.toThrow();
    expect(() => validateCyclePeriod({ kind: "MONTHLY", periodStart: "2026-02-01", periodEnd: "2026-03-01", selfDueOn: "2026-02-25", reviewDueOn: "2026-03-05" }))
      .toThrow(expect.objectContaining({ code: "PERFORMANCE_PERIOD_INVALID" }));
    expect(() => validateCyclePeriod({ kind: "ANNUAL", periodStart: "2026-07-01", periodEnd: "2027-06-30", selfDueOn: "2027-06-15", reviewDueOn: "2027-06-30" })).not.toThrow();
    expect(() => validateCyclePeriod({ kind: "ANNUAL", periodStart: "2026-01-01", periodEnd: "2026-12-31", selfDueOn: "2026-12-15", reviewDueOn: "2026-12-31" }))
      .toThrow(PerformancePolicyError);
    expect(() => validateCyclePeriod({ kind: "MONTHLY", periodStart: "2026-02-01", periodEnd: "2026-02-28", selfDueOn: "2026-03-05", reviewDueOn: "2026-03-01" }))
      .toThrow(PerformancePolicyError);
  });

  it("D-08: the rater waits for the self-assessment or its deadline", () => {
    expect(canRaterReview({ status: "SELF_ASSESSMENT", selfDueOn: "2026-11-25", today: "2026-11-25" })).toBe(false);
    expect(canRaterReview({ status: "SELF_ASSESSMENT", selfDueOn: "2026-11-25", today: "2026-11-26" })).toBe(true);
    expect(canRaterReview({ status: "MANAGER_REVIEW", selfDueOn: "2026-11-25", today: "2026-11-01" })).toBe(true);
    expect(canRaterReview({ status: "HC_VALIDATION", selfDueOn: "2026-11-25", today: "2026-12-01" })).toBe(false);
  });

  it("D-10: closing leaves unfinished reviews without a predicate", () => {
    expect(statusOnClose("SELF_ASSESSMENT")).toBe("UNRATED");
    expect(statusOnClose("MANAGER_REVIEW")).toBe("UNRATED");
    expect(statusOnClose("FINALIZED")).toBe("FINALIZED");
  });

  it("D-13: performance.* rides on the HC admin bundle", () => {
    for (const permission of PERFORMANCE_PERMISSIONS) expect(HC_ADMIN_PERMISSIONS).toContain(permission);
  });
});

describe("PERF-001 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerPerformanceRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
    return app;
  }

  it("answers 401 without a session and 403 to a non-employee on self and rater routes", async () => {
    const anonymous = await appFor(null);
    expect((await anonymous.inject({ method: "GET", url: "/performance/me" })).statusCode).toBe(401);
    const board = await appFor({ id: "b", email: "b@example.invalid", principalType: "FOUNDATION_BOARD" });
    expect((await board.inject({ method: "GET", url: "/performance/team" })).statusCode).toBe(403);
    const legacy = await appFor({ id: "s", email: "s@example.invalid", principalType: "SUPER_ADMIN" });
    expect((await legacy.inject({ method: "POST", url: "/performance/team/x/rating", payload: {} })).statusCode).toBe(403);
  });

  it("PERF-001-H: admin routes need performance.read or performance.manage before validating anything", async () => {
    const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
    const none = await appFor(employee, ["trips.manage", "employees.manage"]);
    expect((await none.inject({ method: "GET", url: "/admin/performance/cycles" })).statusCode).toBe(403);
    expect((await none.inject({ method: "GET", url: "/admin/performance/reviews/not-a-uuid" })).statusCode).toBe(403);
    expect((await none.inject({ method: "POST", url: "/admin/performance/cycles", payload: {} })).statusCode).toBe(403);
    const reader = await appFor(employee, ["performance.read"]);
    for (const url of [
      "/admin/performance/cycles/not-a-uuid/open",
      "/admin/performance/cycles/not-a-uuid/close",
      "/admin/performance/cycles/not-a-uuid/participants",
      "/admin/performance/reviews/not-a-uuid/finalize",
      "/admin/performance/reviews/not-a-uuid/return",
      "/admin/performance/reviews/not-a-uuid/rater",
      "/admin/performance/reviews/not-a-uuid/remove",
    ]) {
      expect((await reader.inject({ method: "POST", url, payload: {} })).statusCode, url).toBe(403);
    }
    expect((await reader.inject({ method: "PATCH", url: "/admin/performance/cycles/not-a-uuid", payload: {} })).statusCode).toBe(403);
    expect((await reader.inject({ method: "GET", url: "/admin/performance/reviews/not-a-uuid" })).statusCode).toBe(400);
    const manager = await appFor(employee, ["performance.manage"]);
    expect((await manager.inject({ method: "GET", url: "/admin/performance/cycles" })).statusCode).toBe(403);
    expect((await manager.inject({ method: "POST", url: "/admin/performance/cycles", payload: { name: "x" } })).statusCode).toBe(400);
  });
});
