// PERF-001: one review rendered as markup. Synthetic data.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReviewDetailPanel, ScoreForm } from "@/components/performance/ReviewDetailPanel";
import type { ReviewDetail } from "@/lib/performance";

const rubric = {
  indicators: [
    { code: "TASK_RESULT", label: "Hasil kerja", description: "Mutu tugas pokok.", weight: 60 },
    { code: "AKHLAK", label: "Akhlak dan adab", description: "", weight: 40 },
  ],
  predicates: [
    { code: "A", label: "Sangat baik", minScore: 3.5 },
    { code: "D", label: "Kurang", minScore: 1 },
  ],
};

function review(overrides: Partial<ReviewDetail> = {}): ReviewDetail {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    status: "MANAGER_REVIEW",
    cycleId: "30000000-0000-4000-8000-000000000002",
    cycleName: "Penilaian kinerja November 2026",
    cycleKind: "MONTHLY",
    cycleStatus: "OPEN",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    selfDueOn: "2026-11-25",
    reviewDueOn: "2026-11-30",
    employeeId: "30000000-0000-4000-8000-000000000003",
    employeeName: "Pegawai Sintetis",
    employeeNumber: "SYN-001",
    unitName: "Unit Sintetis",
    raterEmployeeId: "30000000-0000-4000-8000-000000000004",
    raterName: "Atasan Sintetis",
    raterSource: "DIRECT_MANAGER",
    raterAccountReady: true,
    selfSubmittedAt: "2026-11-20T02:00:00.000Z",
    ratedAt: null,
    finalizedAt: null,
    acknowledgedAt: null,
    finalScore: null,
    predicateCode: null,
    predicateLabel: null,
    rubric,
    selfAssessment: { scores: { TASK_RESULT: 3, AKHLAK: 4 }, note: "Capaian sintetis" },
    rating: null,
    acknowledgementComment: null,
    removedReason: null,
    allowedActions: [],
    events: [{ id: "e1", eventType: "performance.review.self_submitted", occurredAt: "2026-11-20T02:00:00.000Z", note: null, metadata: {}, actorName: "Pegawai Sintetis" }],
    ...overrides,
  };
}

describe("PERF-001 review panel", () => {
  it("shows the self-assessment and no result while the rater has not scored", () => {
    const html = renderToStaticMarkup(<ReviewDetailPanel review={review()} />);
    expect(html).toContain("Menunggu penilai");
    expect(html).toContain("Atasan Sintetis (Atasan langsung)");
    expect(html).toContain("Capaian sintetis");
    expect(html).toContain("Penilaian diri dikirim");
    expect(html).not.toContain("Nilai akhir");
  });

  it("shows the server's result and predicate, and that it still waits for HC", () => {
    const html = renderToStaticMarkup(<ReviewDetailPanel review={review({
      status: "HC_VALIDATION", finalScore: 3.6, predicateCode: "A", predicateLabel: "Sangat baik",
      rating: { scores: { TASK_RESULT: 4, AKHLAK: 3 }, strengths: "Teliti", improvements: null, note: null },
    })} />);
    expect(html).toContain("3,60");
    expect(html).toContain("A Sangat baik");
    expect(html).toContain("Belum disahkan Human Capital.");
    expect(html).toContain("Teliti");
  });

  it("warns when the rater cannot sign in yet or is missing", () => {
    expect(renderToStaticMarkup(<ReviewDetailPanel review={review({ raterAccountReady: false })} />))
      .toContain("Akun penilai belum aktif");
    expect(renderToStaticMarkup(<ReviewDetailPanel review={review({ raterName: null, raterEmployeeId: null, raterSource: null })} />))
      .toContain("belum ada (Belum ada penilai)");
  });

  it("offers one 1-4 choice per indicator and keeps the submit disabled until all are scored", () => {
    const html = renderToStaticMarkup(<ScoreForm kind="rating" rubric={rubric} busy={false} onSubmit={() => undefined} />);
    expect(html.match(/<select/g)).toHaveLength(2);
    expect(html).toContain("4 · Sangat baik");
    expect(html).toContain("Area perbaikan");
    expect(html).toMatch(/<button type="submit" disabled=""/);
    const prefilled = renderToStaticMarkup(<ScoreForm kind="self" rubric={rubric} initial={{ TASK_RESULT: 3, AKHLAK: 2 }} busy={false} onSubmit={() => undefined} />);
    expect(prefilled).not.toMatch(/<button type="submit" disabled=""/);
    expect(prefilled).not.toContain("Area perbaikan");
  });
});
