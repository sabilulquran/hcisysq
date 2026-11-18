import { describe, expect, it } from "vitest";

import { criticalPeriodRange, criticalPeriodWarning } from "@/lib/leaveCriticalPeriods";

describe("LEAVE-009 critical period wording", () => {
  it("warns without blocking and stays silent when no period matches", () => {
    expect(criticalPeriodWarning([])).toBeNull();
    const message = criticalPeriodWarning([{ label: "Ujian Akhir" }, { label: "PPDB" }]);
    expect(message).toContain("Ujian Akhir, PPDB");
    expect(message).toContain("tetap bisa dikirim");
    // D-12 (2026-11-18): no HC review follows, so the warning no longer promises one.
    expect(message).not.toContain("Human Capital");
  });

  it("shows one date for a one-day period and a range otherwise", () => {
    expect(criticalPeriodRange({ startOn: "2026-12-07", endOn: "2026-12-07" })).not.toContain("–");
    expect(criticalPeriodRange({ startOn: "2026-12-07", endOn: "2026-12-12" })).toContain("–");
  });
});
