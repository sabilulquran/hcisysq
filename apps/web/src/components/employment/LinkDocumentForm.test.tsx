// EMP-010-A: linking a PK/SK to a recorded action from the career timeline. Synthetic data only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DecisionDocumentPicker } from "@/components/employment/DecisionDocumentPicker";
import { PlacementCareerPanel } from "@/components/employment/EmploymentPanels";
import { LinkDocumentForm } from "@/components/employment/LinkDocumentForm";
import type { DecisionDocument } from "@/lib/decision-documents";
import type { EmploymentSummary, EmploymentTimelineItem } from "@/lib/employment";

const summary: EmploymentSummary = {
  mode: "AUTHORITATIVE",
  date: "2027-08-15",
  state: "BERAKHIR",
  flags: [],
  current: { employment: null, term: null, primaryPlacement: null, additionalPlacements: [] },
  employments: [],
} as unknown as EmploymentSummary;

const item = (id: string, overrides: Partial<EmploymentTimelineItem> = {}): EmploymentTimelineItem => ({
  id, actionType: "TERMINATION", effectiveOn: "2027-08-01", state: "RECORDED", reversedByActionId: null, reasonCode: "RESIGN",
  previousSnapshot: {}, newSnapshot: {}, recordedAt: "2027-08-01T00:00:00Z", documents: [], ...overrides,
});

const sk: DecisionDocument = {
  id: "d1", documentKind: "SURAT_KEPUTUSAN", documentNumber: "045/SK/SINTETIS/2027", signedOn: "2027-08-05",
  skType: "SK_PEMBERHENTIAN", subject: "Pemberhentian atas permintaan sendiri",
} as unknown as DecisionDocument;

const render = (props: Partial<Parameters<typeof PlacementCareerPanel>[0]>) =>
  renderToStaticMarkup(
    <PlacementCareerPanel
      view={{ kind: "ready", data: summary }}
      timeline={{ kind: "ready", data: [item("a1"), item("a2", { state: "REVERSED" }), item("a3", { actionType: "REVERSAL" })] }}
      {...props}
    />,
  );

describe("EMP-010-A link documents from the timeline", () => {
  it("offers Tautkan dokumen only to an operator, and never on a reversed action or a reversal", () => {
    expect(render({})).not.toContain("Tautkan dokumen");
    const html = render({ onLinkDocument: () => undefined });
    expect(html.match(/Tautkan dokumen/g)).toHaveLength(1);
  });

  it("shows the open form under its action instead of the button", () => {
    const html = render({ onLinkDocument: () => undefined, linkForm: { actionId: "a1", node: <p>FORM-A1</p> } });
    expect(html).toContain("FORM-A1");
    expect(html).not.toContain("Tautkan dokumen");
  });

  it("renders the form with both document kinds and a disabled submit until a pick", () => {
    const html = renderToStaticMarkup(
      <LinkDocumentForm employeeId="emp-1" actionId="a1" actionLabel="Akhiri hubungan kerja" onClose={() => undefined} onLinked={() => undefined} />,
    );
    expect(html).toContain("Surat Keputusan");
    expect(html).toContain("Perjanjian Kerja");
    expect(html).toMatch(/<button type="submit" disabled=""/);
  });

  it("searches the register instead of listing it, and shows a pick with Ganti", () => {
    const empty = renderToStaticMarkup(
      <DecisionDocumentPicker kind="SURAT_KEPUTUSAN" value={null} onChange={() => undefined} label="Cari Surat Keputusan" />,
    );
    expect(empty).toContain('type="search"');
    expect(empty).not.toContain("<select");
    const picked = renderToStaticMarkup(
      <DecisionDocumentPicker kind="SURAT_KEPUTUSAN" value={sk} onChange={() => undefined} label="Cari Surat Keputusan" />,
    );
    expect(picked).toContain("045/SK/SINTETIS/2027 · 05/08/2027 · Pemberhentian atas permintaan sendiri");
    expect(picked).toContain("Ganti");
  });
});
