// TRIP-002 domain rules without a database. Spec: docs/domain/trip-advance-per-diem.md.

import { describe, expect, it } from "vitest";

import {
  advanceLimit,
  applyRefund,
  approvalRequestStatus,
  assertAdvanceAmount,
  assertTransactionDate,
  canEmployeeCancel,
  canSubmitSettlement,
  exportWindowOk,
  maxPerDiemDays,
  settle,
  settlementDueOn,
  TripAdvancePolicyError,
  tripDays,
  zoneCatalog,
} from "../src/modules/trip-advances/domain.js";

function code(work: () => unknown) {
  try {
    work();
  } catch (error) {
    if (error instanceof TripAdvancePolicyError) return error.code;
    throw error;
  }
  return null;
}

describe("TRIP-002 domain", () => {
  it("counts trip days inclusively and gives a trip that never happened no per diem (D-03)", () => {
    expect(tripDays("2026-11-10", "2026-11-12")).toBe(3);
    expect(tripDays("2026-11-10", "2026-11-10")).toBe(1);
    expect(maxPerDiemDays({ status: "COMPLETED", startOn: "2026-11-10", endOn: "2026-11-12" })).toBe(3);
    expect(maxPerDiemDays({ status: "CANCELLED", startOn: "2026-11-10", endOn: "2026-11-12" })).toBe(0);
  });

  it("caps the advance at Rp10 jt plus the per diem estimate, and guesses no rate (D-04)", () => {
    expect(advanceLimit(3, null)).toEqual({ perDiemEstimate: 0n, maxAmount: 10_000_000n });
    expect(advanceLimit(3, 150_000n)).toEqual({ perDiemEstimate: 450_000n, maxAmount: 10_450_000n });
    expect(code(() => assertAdvanceAmount(10_450_001n, 10_450_000n))).toBe("TRIP_ADVANCE_AMOUNT_ABOVE_LIMIT");
    expect(code(() => assertAdvanceAmount(0n, 10_000_000n))).toBeNull();
  });

  it("settles per diem plus claims against the advance in exact rupiah (D-10)", () => {
    const base = { advanceAmount: 2_000_000n, claims: [325_000n, 100_001n], maxDays: 3, dailyRate: 150_000n, note: null };
    expect(settle({ ...base, perDiemDays: 3 })).toEqual({
      perDiemAmount: 450_000n, claimsTotal: 425_001n, balance: -1_124_999n, status: "AWAITING_REFUND",
    });
    expect(settle({ ...base, advanceAmount: 0n, perDiemDays: 3 }).status).toBe("AWAITING_TOP_UP");
    expect(settle({ ...base, advanceAmount: 875_001n, perDiemDays: 3 }).status).toBe("SETTLED");
    expect(code(() => settle({ ...base, perDiemDays: 4 }))).toBe("TRIP_ADVANCE_PER_DIEM_DAYS");
    expect(code(() => settle({ ...base, perDiemDays: 2 }))).toBe("TRIP_ADVANCE_REDUCTION_NOTE_REQUIRED");
    expect(settle({ ...base, perDiemDays: 2, note: "Pulang sehari lebih awal" }).perDiemAmount).toBe(300_000n);
    expect(code(() => settle({ ...base, dailyRate: null, perDiemDays: 3 }))).toBe("TRIP_PER_DIEM_RATE_MISSING");
    expect(settle({ ...base, maxDays: 0, dailyRate: null, perDiemDays: 0 }).perDiemAmount).toBe(0n);
  });

  it("keeps refunds within what is owed (D-12) and dates within their window", () => {
    expect(applyRefund(1_225_000n, 0n, 1_000_000n)).toBe(225_000n);
    expect(applyRefund(1_225_000n, 1_000_000n, 225_000n)).toBe(0n);
    expect(code(() => applyRefund(1_225_000n, 1_000_000n, 225_001n))).toBe("TRIP_ADVANCE_REFUND_EXCEEDS_DUE");
    expect(code(() => applyRefund(1_225_000n, 0n, 0n))).toBe("TRIP_ADVANCE_REFUND_EXCEEDS_DUE");
    expect(code(() => assertTransactionDate("2026-11-09", "2026-11-10", "2026-11-17"))).toBe("TRIP_ADVANCE_PAYMENT_DATE");
    expect(code(() => assertTransactionDate("2026-11-18", "2026-11-10", "2026-11-17"))).toBe("TRIP_ADVANCE_PAYMENT_DATE");
    expect(code(() => assertTransactionDate("2026-02-30", "2026-01-01", "2026-11-17"))).toBe("TRIP_ADVANCE_PAYMENT_DATE");
    expect(code(() => assertTransactionDate("2026-11-10", "2026-11-10", "2026-11-17"))).toBeNull();
  });

  it("dates the settlement 14 days after return, or after an earlier cancellation (D-09)", () => {
    expect(settlementDueOn({ status: "ISSUED", endOn: "2026-11-12", cancelledOn: null })).toBe("2026-11-26");
    expect(settlementDueOn({ status: "CANCELLED", endOn: "2026-11-30", cancelledOn: "2026-11-05" })).toBe("2026-11-19");
  });

  it("names the states each actor may act on", () => {
    expect(canEmployeeCancel("APPROVED")).toBe(true);
    expect(canEmployeeCancel("DISBURSED")).toBe(false);
    expect(canSubmitSettlement("DISBURSED", 1n)).toBe(true);
    expect(canSubmitSettlement("APPROVED", 0n)).toBe(true);
    expect(canSubmitSettlement("APPROVED", 1n)).toBe(false);
    expect(approvalRequestStatus("IN_REVIEW")).toBe("in_review");
    expect(approvalRequestStatus("DISBURSED")).toBe("approved");
    expect(exportWindowOk("2026-01-01", "2026-12-31")).toBe(true);
    expect(exportWindowOk("2025-01-01", "2026-12-31")).toBe(false);
    expect(zoneCatalog().map((zone) => zone.key)).toEqual(["LOCAL", "PROVINCIAL", "NATIONAL", "INTERNATIONAL"]);
  });
});
