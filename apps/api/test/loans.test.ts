import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  addMonths,
  assertPaymentFits,
  buildInstalmentSchedule,
  canCancelLoan,
  formatRupiah,
  instalmentStanding,
  repaymentStatus,
  resolveFirstDueMonth,
  rupiahToJson,
  toRupiah,
  validateLoanTerms,
} from "../src/modules/loans/domain.js";
import { registerLoanRoutes } from "../src/modules/loans/routes.js";

const sum = (rows: Array<{ amount: bigint }>) => rows.reduce((total, row) => total + row.amount, 0n);

describe("LOAN-001 money rules", () => {
  it("D-07: splits evenly by the thousand and puts the remainder on the last instalment", () => {
    const schedule = buildInstalmentSchedule({ principal: 1_000_000n, tenorMonths: 3, firstDueMonth: "2026-12" });
    expect(schedule.map((row) => row.amount)).toEqual([333_000n, 333_000n, 334_000n]);
    expect(schedule.map((row) => row.dueMonth)).toEqual(["2026-12", "2027-01", "2027-02"]);
    expect(sum(schedule)).toBe(1_000_000n);
  });

  it("D-07: always sums to the principal exactly, rupiah by rupiah", () => {
    for (const principal of [100_000n, 100_001n, 999_999n, 1_234_567n, 7_777_777n, 10_000_000n]) {
      for (const tenorMonths of [3, 6, 12]) {
        const schedule = buildInstalmentSchedule({ principal, tenorMonths, firstDueMonth: "2026-01" });
        expect(schedule).toHaveLength(tenorMonths);
        expect(sum(schedule)).toBe(principal);
        expect(schedule.every((row) => row.amount > 0n)).toBe(true);
        // The remainder never exceeds one rounding unit per instalment.
        expect(schedule.at(-1)!.amount - schedule[0]!.amount).toBeLessThan(BigInt(tenorMonths) * 1_000n);
      }
    }
  });

  it("D-03/D-04: refuses a principal or tenor outside the draft limits", () => {
    expect(() => validateLoanTerms({ principal: 99_999n, tenorMonths: 3 }))
      .toThrow(expect.objectContaining({ code: "LOAN_PRINCIPAL_OUT_OF_RANGE" }));
    expect(() => validateLoanTerms({ principal: 10_000_001n, tenorMonths: 3 }))
      .toThrow(expect.objectContaining({ code: "LOAN_PRINCIPAL_OUT_OF_RANGE" }));
    expect(() => validateLoanTerms({ principal: 1_000_000n, tenorMonths: 4 }))
      .toThrow(expect.objectContaining({ code: "LOAN_TENOR_OUT_OF_RANGE" }));
    expect(() => validateLoanTerms({ principal: 10_000_000n, tenorMonths: 12 })).not.toThrow();
  });

  it("never accepts a fraction of a rupiah or an unsafe number", () => {
    expect(toRupiah("1500000")).toBe(1_500_000n);
    expect(toRupiah(1_500_000)).toBe(1_500_000n);
    expect(() => toRupiah(1500000.5)).toThrow(RangeError);
    expect(() => toRupiah("1500000.00")).toThrow(RangeError);
    expect(() => toRupiah(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
    expect(() => rupiahToJson(2n ** 60n)).toThrow(RangeError);
    expect(formatRupiah(1_500_000n)).toBe("Rp1.500.000");
  });

  it("D-11: fills instalments oldest first from the total in force", () => {
    const schedule = buildInstalmentSchedule({ principal: 1_000_000n, tenorMonths: 3, firstDueMonth: "2026-10" });
    const standing = instalmentStanding(schedule, 400_000n, "2026-12");
    expect(standing.map((row) => [row.paid, row.state, row.overdue])).toEqual([
      [333_000n, "PAID", false],
      [67_000n, "PARTIAL", true],
      [0n, "UNPAID", false],
    ]);
    expect(instalmentStanding(schedule, 1_000_000n, "2027-06").every((row) => row.state === "PAID" && !row.overdue)).toBe(true);
  });

  it("D-10: a payment is positive and never more than the balance", () => {
    expect(() => assertPaymentFits(0n, 10n)).toThrow(expect.objectContaining({ code: "LOAN_PAYMENT_NOT_POSITIVE" }));
    expect(() => assertPaymentFits(11n, 10n)).toThrow(expect.objectContaining({ code: "LOAN_PAYMENT_EXCEEDS_BALANCE" }));
    expect(() => assertPaymentFits(10n, 10n)).not.toThrow();
    expect(repaymentStatus(10n, 10n)).toBe("PAID_OFF");
    expect(repaymentStatus(10n, 9n)).toBe("DISBURSED");
  });

  it("D-09: first instalment no earlier than the month after disbursement, which is not in the future", () => {
    expect(resolveFirstDueMonth({ disbursedOn: "2026-11-02", today: "2026-11-02" })).toBe("2026-12");
    expect(resolveFirstDueMonth({ disbursedOn: "2026-12-31", firstDueMonth: "2027-02", today: "2027-01-05" })).toBe("2027-02");
    expect(() => resolveFirstDueMonth({ disbursedOn: "2026-11-02", firstDueMonth: "2026-11", today: "2026-11-02" }))
      .toThrow(expect.objectContaining({ code: "LOAN_FIRST_DUE_TOO_EARLY" }));
    expect(resolveFirstDueMonth({ disbursedOn: "2026-11-02", firstDueMonth: "2027-03", today: "2026-11-02" })).toBe("2027-03");
    expect(() => resolveFirstDueMonth({ disbursedOn: "2026-11-02", firstDueMonth: "2027-04", today: "2026-11-02" }))
      .toThrow(expect.objectContaining({ code: "LOAN_FIRST_DUE_TOO_LATE" }));
    expect(() => resolveFirstDueMonth({ disbursedOn: "2026-11-03", today: "2026-11-02" }))
      .toThrow(expect.objectContaining({ code: "LOAN_DISBURSED_IN_FUTURE" }));
    expect(() => resolveFirstDueMonth({ disbursedOn: "2026-11-02", firstDueMonth: "2026-13", today: "2026-11-02" }))
      .toThrow(expect.objectContaining({ code: "LOAN_INVALID_MONTH" }));
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", 11)).toBe("2026-12");
  });

  it("D-08: cancellation only before money changes hands", () => {
    expect(canCancelLoan("IN_REVIEW")).toBe(true);
    expect(canCancelLoan("APPROVED")).toBe(true);
    for (const status of ["DISBURSED", "PAID_OFF", "REJECTED", "CANCELLED"] as const) {
      expect(canCancelLoan(status)).toBe(false);
    }
  });
});

describe("LOAN-001 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerLoanRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
    return app;
  }

  it("answers 401 without a session and 403 to a non-employee on self routes", async () => {
    const anonymous = await appFor(null);
    expect((await anonymous.inject({ method: "GET", url: "/loans/me" })).statusCode).toBe(401);
    const board = await appFor({ id: "b", email: "b@example.invalid", principalType: "FOUNDATION_BOARD" });
    expect((await board.inject({ method: "GET", url: "/loans/approvals" })).statusCode).toBe(403);
    const legacy = await appFor({ id: "s", email: "s@example.invalid", principalType: "SUPER_ADMIN" });
    expect((await legacy.inject({ method: "POST", url: "/loans/me", payload: {} })).statusCode).toBe(403);
  });

  it("LOAN-001-J: admin routes need loans.read or loans.manage before validating anything", async () => {
    const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
    const none = await appFor(employee, ["trips.manage", "payroll.loans.manage"]);
    expect((await none.inject({ method: "GET", url: "/admin/loans" })).statusCode).toBe(403);
    expect((await none.inject({ method: "POST", url: "/admin/loans/not-a-uuid/disburse", payload: {} })).statusCode).toBe(403);
    const reader = await appFor(employee, ["loans.read"]);
    for (const url of [
      "/admin/loans/not-a-uuid/disburse", "/admin/loans/not-a-uuid/payments",
      "/admin/loans/not-a-uuid/payments/not-a-uuid/reverse", "/admin/loans/not-a-uuid/cancel",
    ]) {
      expect((await reader.inject({ method: "POST", url, payload: {} })).statusCode, url).toBe(403);
    }
    expect((await reader.inject({ method: "GET", url: "/admin/loans/not-a-uuid" })).statusCode).toBe(400);
  });

  it("refuses a fractional or string amount before touching the database", async () => {
    const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
    const app = await appFor(employee);
    for (const principal of [1500000.5, "1500000", -1]) {
      const response = await app.inject({ method: "POST", url: "/loans/me/preview", payload: { principal, tenorMonths: 3 } });
      expect(response.statusCode, String(principal)).toBe(400);
    }
    const finance = await appFor(employee, ["loans.read", "loans.manage"]);
    const payment = await finance.inject({
      method: "POST",
      url: "/admin/loans/00000000-0000-4000-8000-000000000001/payments",
      payload: { amount: 100.5, paidOn: "2026-11-02", method: "CASH", idempotencyKey: "00000000-0000-4000-8000-000000000002" },
    });
    expect(payment.statusCode).toBe(400);
  });
});
