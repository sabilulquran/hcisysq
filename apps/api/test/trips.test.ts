import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  canCancelTrip,
  canCompleteTrip,
  isCalendarDate,
  tripDays,
  TripPolicyError,
  validateTripDates,
} from "../src/modules/trips/domain.js";
import { registerTripRoutes } from "../src/modules/trips/routes.js";

describe("TRIP-001 domain rules", () => {
  it("counts days inclusively and accepts exactly 30 (D-03)", () => {
    expect(tripDays("2026-11-02", "2026-11-02")).toBe(1);
    expect(validateTripDates({ startOn: "2026-11-02", endOn: "2026-12-01", today: "2026-11-02" }).days).toBe(30);
    expect(() => validateTripDates({ startOn: "2026-11-02", endOn: "2026-12-02", today: "2026-11-02" }))
      .toThrow(expect.objectContaining({ code: "TRIP_TOO_LONG" }));
  });

  it("refuses a start before today in Jakarta (D-04) and a reversed or impossible range", () => {
    expect(() => validateTripDates({ startOn: "2026-11-01", endOn: "2026-11-03", today: "2026-11-02" }))
      .toThrow(expect.objectContaining({ code: "TRIP_START_IN_PAST" }));
    expect(() => validateTripDates({ startOn: "2026-11-05", endOn: "2026-11-04", today: "2026-11-02" }))
      .toThrow(TripPolicyError);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(() => validateTripDates({ startOn: "2026-02-30", endOn: "2026-03-01", today: "2026-01-01" }))
      .toThrow(expect.objectContaining({ code: "TRIP_DATE_RANGE" }));
  });

  it("lets the employee cancel only before the letter is issued; HC also after (D-08)", () => {
    expect(canCancelTrip("IN_REVIEW", "employee")).toBe(true);
    expect(canCancelTrip("APPROVED", "employee")).toBe(true);
    expect(canCancelTrip("ISSUED", "employee")).toBe(false);
    expect(canCancelTrip("ISSUED", "hc")).toBe(true);
    for (const terminal of ["REJECTED", "CANCELLED", "COMPLETED"] as const) {
      expect(canCancelTrip(terminal, "hc")).toBe(false);
    }
  });

  it("completes only an issued trip on or after its return date (D-10)", () => {
    expect(canCompleteTrip("ISSUED", "2026-11-05", "2026-11-04")).toBe(false);
    expect(canCompleteTrip("ISSUED", "2026-11-05", "2026-11-05")).toBe(true);
    expect(canCompleteTrip("APPROVED", "2026-11-05", "2026-11-06")).toBe(false);
  });
});

describe("TRIP-001 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerTripRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
    return app;
  }

  it("answers 401 without a session and 403 to a non-employee on self routes", async () => {
    const anonymous = await appFor(null);
    expect((await anonymous.inject({ method: "GET", url: "/trips/me" })).statusCode).toBe(401);
    const board = await appFor({ id: "b", email: "b@example.invalid", principalType: "FOUNDATION_BOARD" });
    expect((await board.inject({ method: "GET", url: "/trips/approvals" })).statusCode).toBe(403);
    const legacy = await appFor({ id: "s", email: "s@example.invalid", principalType: "SUPER_ADMIN" });
    expect((await legacy.inject({ method: "POST", url: "/trips/me", payload: {} })).statusCode).toBe(403);
  });

  it("TRIP-001-J: admin routes need trips.read or trips.manage before validating anything", async () => {
    const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
    const none = await appFor(employee, ["documents.manage"]);
    expect((await none.inject({ method: "GET", url: "/admin/trips" })).statusCode).toBe(403);
    expect((await none.inject({ method: "POST", url: "/admin/trips/not-a-uuid/issue", payload: {} })).statusCode).toBe(403);
    const reader = await appFor(employee, ["trips.read"]);
    expect((await reader.inject({ method: "POST", url: "/admin/trips/not-a-uuid/cancel", payload: {} })).statusCode).toBe(403);
    expect((await reader.inject({ method: "GET", url: "/admin/trips/not-a-uuid" })).statusCode).toBe(400);
  });
});
