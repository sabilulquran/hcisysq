import { describe, expect, it } from "vitest";

import { eventLabel, formatScore, monthlyDefaults, raterSourceLabel, reviewStatusLabel } from "@/lib/performance";

describe("PERF-001 client helpers", () => {
  it("defaults a new cycle to the whole current month with deadlines on its last day", () => {
    const input = monthlyDefaults();
    expect(input.kind).toBe("MONTHLY");
    expect(input.periodStart).toMatch(/^\d{4}-\d{2}-01$/);
    expect(input.periodEnd.slice(0, 7)).toBe(input.periodStart.slice(0, 7));
    const nextDay = new Date(`${input.periodEnd}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    expect(nextDay.getUTCDate()).toBe(1);
    expect(input.selfDueOn).toBe(input.periodEnd);
  });

  it("labels states, sources and history in Indonesian and shows two decimals", () => {
    expect(reviewStatusLabel("HC_VALIDATION")).toBe("Menunggu pengesahan HC");
    expect(raterSourceLabel(null)).toBe("Belum ada penilai");
    expect(raterSourceLabel("HC_ASSIGNED")).toBe("Ditunjuk HC");
    expect(eventLabel("performance.review.returned")).toBe("Dikembalikan HC");
    expect(formatScore(3.5)).toBe("3,50");
    expect(formatScore(null)).toBe("-");
  });
});
