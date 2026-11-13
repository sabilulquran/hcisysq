import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { ApiConfig } from "../src/config/env.js";
import type { AuthPrincipal } from "../src/modules/auth/service.js";
import {
  addDays,
  assertExpensesFresh,
  canEmployeeCancel,
  canFinanceReject,
  categoryCatalog,
  exportWindowOk,
  validateItems,
  validatePayment,
  verifyAmounts,
} from "../src/modules/reimbursements/domain.js";
import { registerReimbursementRoutes } from "../src/modules/reimbursements/routes.js";

const TODAY = "2026-11-13";
const item = (overrides: Partial<{ category: string; expenseDate: string; description: string; amount: bigint }> = {}) => ({
  category: "TRANSPORT", expenseDate: "2026-11-10", description: "Tiket kereta", amount: 150_000n, ...overrides,
});

describe("REIMB-001 claim rules", () => {
  it("D-02/D-03: sums the items and holds each category and the claim to its limit", () => {
    expect(validateItems([item(), item({ category: "MEALS", amount: 85_000n })], TODAY)).toBe(235_000n);
    expect(() => validateItems([], TODAY)).toThrow(expect.objectContaining({ code: "REIMBURSEMENT_ITEM_COUNT" }));
    expect(() => validateItems(Array.from({ length: 11 }, () => item()), TODAY))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_ITEM_COUNT" }));
    expect(() => validateItems([item({ category: "FUEL" })], TODAY))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_UNKNOWN_CATEGORY" }));
    expect(() => validateItems([item({ amount: 999n })], TODAY))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_ITEM_BELOW_MINIMUM" }));
    expect(() => validateItems([item({ category: "MEALS", amount: 1_000_001n })], TODAY))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_ITEM_ABOVE_LIMIT" }));
    expect(validateItems([item({ category: "MEALS", amount: 1_000_000n })], TODAY)).toBe(1_000_000n);
    // Four transport lines at their cap pass each item, but not the claim (D-03).
    expect(() => validateItems(Array.from({ length: 4 }, () => item({ amount: 3_000_000n })), TODAY))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_TOTAL_ABOVE_LIMIT" }));
  });

  it("D-04: no future expense, and nothing older than 90 days at submission", () => {
    expect(() => validateItems([item({ expenseDate: "2026-11-14" })], TODAY))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_EXPENSE_IN_FUTURE" }));
    expect(() => validateItems([item({ expenseDate: "2026-02-30" })], TODAY))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_INVALID_DATE" }));
    expect(() => assertExpensesFresh([{ expenseDate: addDays(TODAY, -90) }], TODAY)).not.toThrow();
    expect(() => assertExpensesFresh([{ expenseDate: addDays(TODAY, -91) }], TODAY))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_EXPENSE_TOO_OLD" }));
  });

  it("D-09: verification decides every item once, never above the claim, with a note for any cut", () => {
    const items = [{ id: "a", amount: 100_000n }, { id: "b", amount: 50_000n }];
    expect(verifyAmounts(items, [{ itemId: "a", approvedAmount: 100_000n }, { itemId: "b", approvedAmount: 50_000n }], null))
      .toMatchObject({ total: 150_000n, reduced: 0 });
    expect(verifyAmounts(items, [{ itemId: "a", approvedAmount: 100_000n }, { itemId: "b", approvedAmount: 0n }], "Struk konsumsi tidak terbaca"))
      .toMatchObject({ total: 100_000n, reduced: 1 });
    expect(() => verifyAmounts(items, [{ itemId: "a", approvedAmount: 100_000n }, { itemId: "b", approvedAmount: 0n }], "kurang"))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_REDUCTION_NOTE_REQUIRED" }));
    expect(() => verifyAmounts(items, [{ itemId: "a", approvedAmount: 100_001n }, { itemId: "b", approvedAmount: 50_000n }], null))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_APPROVED_EXCEEDS_CLAIM" }));
    expect(() => verifyAmounts(items, [{ itemId: "a", approvedAmount: 100_000n }], null))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_ITEMS_MISMATCH" }));
    expect(() => verifyAmounts(items, [{ itemId: "a", approvedAmount: 1n }, { itemId: "a", approvedAmount: 1n }], null))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_ITEMS_MISMATCH" }));
    expect(() => verifyAmounts(items, [{ itemId: "a", approvedAmount: 0n }, { itemId: "b", approvedAmount: 0n }], "Seluruh bukti tidak sah"))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_NOTHING_APPROVED" }));
  });

  it("D-10/D-11: payment dates sit between verification and today; payroll needs the switch", () => {
    const base = { verifiedOn: "2026-11-10", today: TODAY, method: "TRANSFER" as const, payrollMonth: null, payrollHandoffEnabled: false };
    expect(() => validatePayment({ ...base, paidOn: "2026-11-12" })).not.toThrow();
    expect(() => validatePayment({ ...base, paidOn: "2026-11-09" })).toThrow(expect.objectContaining({ code: "REIMBURSEMENT_PAYMENT_DATE" }));
    expect(() => validatePayment({ ...base, paidOn: "2026-11-14" })).toThrow(expect.objectContaining({ code: "REIMBURSEMENT_PAYMENT_DATE" }));
    expect(() => validatePayment({ ...base, paidOn: TODAY, method: "PAYROLL", payrollMonth: "2026-12" }))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_PAYROLL_HANDOFF_DISABLED" }));
    expect(() => validatePayment({ ...base, paidOn: TODAY, method: "PAYROLL", payrollMonth: null, payrollHandoffEnabled: true }))
      .toThrow(expect.objectContaining({ code: "REIMBURSEMENT_PAYROLL_MONTH_REQUIRED" }));
    expect(() => validatePayment({ ...base, paidOn: TODAY, method: "PAYROLL", payrollMonth: "2026-12", payrollHandoffEnabled: true })).not.toThrow();
  });

  it("D-08/D-09/D-17: who may stop a claim, and the export window", () => {
    expect(["DRAFT", "IN_REVIEW", "APPROVED"].every((status) => canEmployeeCancel(status as never))).toBe(true);
    expect(["VERIFIED", "PAID", "REJECTED", "CANCELLED"].some((status) => canEmployeeCancel(status as never))).toBe(false);
    expect(canFinanceReject("APPROVED") && canFinanceReject("VERIFIED")).toBe(true);
    expect(canFinanceReject("PAID") || canFinanceReject("IN_REVIEW")).toBe(false);
    expect(exportWindowOk("2026-01-01", "2026-12-31")).toBe(true);
    expect(exportWindowOk("2026-01-01", "2027-01-01")).toBe(true);
    expect(exportWindowOk("2026-01-01", "2027-01-02")).toBe(false);
    expect(exportWindowOk("2026-02-01", "2026-01-01")).toBe(false);
    expect(categoryCatalog().map((category) => category.key)).toEqual(["TRANSPORT", "ACCOMMODATION", "MEALS", "OPERATIONAL", "OTHER"]);
  });
});

describe("REIMB-001 route guards", () => {
  async function appFor(principal: AuthPrincipal | null, permissions: string[] = []) {
    const app = Fastify({ logger: false });
    // Guards answer before any query, so an inert pool proves no data is read.
    await registerReimbursementRoutes(app, {} as Pool, { NODE_ENV: "test", AUTH_ENCRYPTION_KEY: "11".repeat(32) } as ApiConfig, {
      getSession: async () => (principal ? { principal, expiresAt: "2099-01-01T00:00:00Z" } : null),
      getAuthorizationContext: async () => ({ organizationPermissions: permissions }),
    } as never);
    return app;
  }
  const employee = { id: "e", email: "e@example.invalid", principalType: "EMPLOYEE" as const };
  const claim = "00000000-0000-4000-8000-000000000001";

  it("answers 401 without a session and 403 to a non-employee on self routes", async () => {
    const anonymous = await appFor(null);
    expect((await anonymous.inject({ method: "GET", url: "/reimbursements/me" })).statusCode).toBe(401);
    const board = await appFor({ id: "b", email: "b@example.invalid", principalType: "FOUNDATION_BOARD" });
    expect((await board.inject({ method: "GET", url: "/reimbursements/approvals" })).statusCode).toBe(403);
    const legacy = await appFor({ id: "s", email: "s@example.invalid", principalType: "SUPER_ADMIN" });
    expect((await legacy.inject({ method: "POST", url: "/reimbursements/me", payload: {} })).statusCode).toBe(403);
  });

  it("REIMB-001-J: admin routes need reimbursements.read or .manage before validating anything", async () => {
    const none = await appFor(employee, ["loans.manage", "payroll.loans.manage", "payroll.approve", "trips.manage"]);
    for (const url of [
      "/admin/reimbursements", "/admin/reimbursements/summary", "/admin/reimbursements/export.csv",
      "/admin/reimbursements/claimants", `/admin/reimbursements/${claim}`, `/admin/reimbursements/${claim}/receipts/${claim}`,
    ]) {
      expect((await none.inject({ method: "GET", url })).statusCode, url).toBe(403);
    }
    const reader = await appFor(employee, ["reimbursements.read"]);
    for (const url of [`/admin/reimbursements/${claim}/verify`, `/admin/reimbursements/${claim}/reject`, `/admin/reimbursements/${claim}/pay`]) {
      expect((await reader.inject({ method: "POST", url, payload: {} })).statusCode, url).toBe(403);
    }
    expect((await reader.inject({ method: "GET", url: "/admin/reimbursements/not-a-uuid" })).statusCode).toBe(400);
    expect((await reader.inject({ method: "GET", url: "/admin/reimbursements/summary?from=2026-01-01&to=2027-06-01" })).statusCode).toBe(400);
  });

  it("D-15: refuses a fractional or string amount before touching the database", async () => {
    const app = await appFor(employee);
    for (const amount of [150000.5, "150000", -1, 0]) {
      const response = await app.inject({
        method: "POST", url: "/reimbursements/me",
        payload: {
          title: "Transport rapat", idempotencyKey: claim,
          items: [{ category: "TRANSPORT", expenseDate: "2026-11-10", description: "Ojek", amount }],
        },
      });
      expect(response.statusCode, String(amount)).toBe(400);
    }
    const finance = await appFor(employee, ["reimbursements.read", "reimbursements.manage"]);
    const verify = await finance.inject({
      method: "POST", url: `/admin/reimbursements/${claim}/verify`,
      payload: { items: [{ itemId: claim, approvedAmount: 100.5 }] },
    });
    expect(verify.statusCode).toBe(400);
  });
});
