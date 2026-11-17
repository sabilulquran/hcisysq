// LOAN-001 Package 2: which part of a LOAN-001 schedule payroll proposes for a
// period. Exact bigint rupiah; synthetic values only (AGENTS.md section 8).

import { describe, expect, it } from "vitest";

import { proposedInstalmentDeduction } from "../src/modules/payroll/employee-loan-link.js";

// Rp1.000.000 over 3 months, D-07: 333.000, 333.000, 334.000 from September.
const SCHEDULE = [
  { dueMonth: "2026-09-01", amount: 333_000n },
  { dueMonth: "2026-10-01", amount: 333_000n },
  { dueMonth: "2026-11-01", amount: 334_000n },
];

const propose = (periodMonth: string, paidBefore: bigint) =>
  proposedInstalmentDeduction({ periodMonth, principal: 1_000_000n, paidBefore, instalments: SCHEDULE });

describe("LOAN-001 Package 2 instalment proposal", () => {
  it("proposes the instalment due in the period month", () => {
    expect(propose("2026-09-01", 0n)).toBe(333_000n);
    expect(propose("2026-10-01", 333_000n)).toBe(333_000n);
    // The last instalment carries the remainder, to the rupiah.
    expect(propose("2026-11-01", 666_000n)).toBe(334_000n);
  });

  it("proposes nothing before the first due month or after the schedule ends", () => {
    expect(propose("2026-08-01", 0n)).toBe(0n);
    expect(propose("2026-12-01", 666_000n)).toBe(0n);
  });

  it("counts a manual repayment first (D-11): a prepaid month is not deducted again", () => {
    // Paid 400.000 in cash: September is covered and 67.000 of October too.
    expect(propose("2026-09-01", 400_000n)).toBe(0n);
    expect(propose("2026-10-01", 400_000n)).toBe(266_000n);
  });

  it("does not sweep an overdue month into this one; only this month's instalment", () => {
    // September was never paid: October still proposes one instalment, not two.
    expect(propose("2026-10-01", 0n)).toBe(333_000n);
  });

  it("never proposes more than the balance", () => {
    expect(
      proposedInstalmentDeduction({
        periodMonth: "2026-11-01",
        principal: 1_000_000n,
        paidBefore: 900_000n,
        instalments: SCHEDULE,
      }),
    ).toBe(100_000n);
    expect(propose("2026-11-01", 1_000_000n)).toBe(0n);
  });

  it("stays exact beyond the safe integer range of a double", () => {
    const big = 4_000_000_000_000_000_001n;
    expect(
      proposedInstalmentDeduction({
        periodMonth: "2026-09-01",
        principal: big,
        paidBefore: 0n,
        instalments: [{ dueMonth: "2026-09-01", amount: big }],
      }),
    ).toBe(big);
  });
});
