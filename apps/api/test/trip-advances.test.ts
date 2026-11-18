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
  golonganCatalog,
  highestGolongan,
  wilayahCatalog,
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
    // The stored columns stop at Rp1.000.000.000: a larger total is a 409, never a database error.
    expect(code(() => settle({ ...base, claims: [600_000_000n, 400_000_001n], perDiemDays: 3 }))).toBe("TRIP_ADVANCE_SETTLEMENT_TOO_LARGE");
    expect(settle({ ...base, claims: [600_000_000n, 400_000_000n], perDiemDays: 0, maxDays: 0 }).claimsTotal).toBe(1_000_000_000n);
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
    expect(wilayahCatalog().map((wilayah) => wilayah.key)).toEqual(["DALAM_DAERAH", "LUAR_DAERAH", "LUAR_NEGERI"]);
  });

  it("names the golongan of SK 01.111/YSQ/VII/2026 and takes the highest one held (D-20)", () => {
    expect(golonganCatalog()).toEqual([
      { key: "PIMPINAN", label: "Pimpinan / Yayasan" },
      { key: "KEPALA_UNIT", label: "Kepala Unit Kerja" },
      { key: "STAF", label: "Staf" },
    ]);
    expect(highestGolongan([])).toBeNull();
    expect(highestGolongan(["STAF"])).toBe("STAF");
    // A teacher who also heads a unit is paid as the unit head, not as staff.
    expect(highestGolongan(["STAF", "KEPALA_UNIT"])).toBe("KEPALA_UNIT");
    expect(highestGolongan(["KEPALA_UNIT", "PIMPINAN", "STAF"])).toBe("PIMPINAN");
  });

  it("never pays uang saku twice (D-21, Diktum Keempat SK 01.111/YSQ/VII/2026)", () => {
    const base = { advanceAmount: 500_000n, claims: [], maxDays: 3, dailyRate: 140_000n, note: "Uang saku ditanggung penyelenggara" };
    expect(code(() => settle({ ...base, perDiemDays: 3, organizerPerDiemPaid: true }))).toBe("TRIP_PER_DIEM_NOT_PAYABLE_TWICE");
    expect(code(() => settle({ ...base, perDiemDays: 1, organizerPerDiemPaid: true }))).toBe("TRIP_PER_DIEM_NOT_PAYABLE_TWICE");
    // Nothing is paid: the whole advance comes back.
    expect(settle({ ...base, perDiemDays: 0, organizerPerDiemPaid: true })).toEqual({
      perDiemAmount: 0n, claimsTotal: 0n, balance: -500_000n, status: "AWAITING_REFUND",
    });
    // Without the declaration the same trip earns its three days.
    expect(settle({ ...base, perDiemDays: 3 }).perDiemAmount).toBe(420_000n);
  });
});
