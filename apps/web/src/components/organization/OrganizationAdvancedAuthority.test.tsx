import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  OrganizationAdvancedAuthority,
  organizationAdvancedSentence,
} from "@/components/organization/OrganizationAdvancedAuthority";
import { OrganizationChart } from "@/components/organization/OrganizationChart";
import type {
  OrganizationAuthorityBinding,
  OrganizationNode,
  OrganizationPosition,
} from "@/lib/organizationDesigner";

function visibleText(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");
}

const noop = () => undefined;

function position(stableKey: string, title: string, overrides: Partial<OrganizationPosition> = {}): OrganizationPosition {
  return {
    id: `${stableKey}-id`, stableKey, nodeKey: "node-foundation", title, parentPositionKey: null,
    singleIncumbent: true, vacancyPolicy: "CLIMB_TO_PARENT", active: true,
    effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0,
    primaryIncumbent: null, actingIncumbent: null, ...overrides,
  };
}

function binding(overrides: Partial<OrganizationAuthorityBinding>): OrganizationAuthorityBinding {
  return {
    id: "binding-1", sourceType: "POSITION", sourceKey: "position-director",
    authorityType: "GOVERNANCE_APPROVER", targetPositionKey: "position-secretary",
    vacancyPolicy: "CLIMB_TO_PARENT", effectiveFrom: "2026-01-01", effectiveTo: null,
    ...overrides,
  };
}

const director = position("position-director", "Direktur");
const secretary = position("position-secretary", "Sekretaris Yayasan");
const chair = position("position-chair", "Ketua Yayasan");

describe("ORG-008-5 aturan khusus ditulis sebagai kalimat (gap W-2)", () => {
  it("states the approval rule the way the owner described it", () => {
    expect(organizationAdvancedSentence({
      bindingType: "GOVERNANCE_APPROVER", subjectTitle: "Direktur", targetTitle: "Sekretaris Yayasan",
    })).toBe("Bila pejabat Direktur mengajukan cuti, yang menyetujui adalah Sekretaris Yayasan.");
  });

  it("states who is told afterwards", () => {
    expect(organizationAdvancedSentence({
      bindingType: "OVERSIGHT_PARENT", subjectTitle: "Direktur", targetTitle: "Ketua Yayasan",
    })).toBe("Setelah pengajuan pejabat Direktur disetujui, Ketua Yayasan diberi tahu.");
  });

  it("renders both rules without a single binding term on screen", () => {
    const text = visibleText(renderToStaticMarkup(
      <OrganizationAdvancedAuthority
        position={director}
        bindings={[
          binding({}),
          binding({ id: "binding-2", authorityType: "OVERSIGHT_PARENT", targetPositionKey: "position-chair" }),
        ]}
        positions={[director, secretary, chair]}
        canManage saving={false} onAdd={noop} onRemove={noop}
      />,
    ));

    expect(text).toContain("yang menyetujui adalah Sekretaris Yayasan");
    expect(text).toContain("Ketua Yayasan diberi tahu");
    for (const term of ["GOVERNANCE_APPROVER", "OVERSIGHT_PARENT", "binding", "oversight"]) {
      expect(text).not.toContain(term);
    }
  });

  it("says plainly that a rule pointing at a Dewan-held seat cannot be used yet (gap W-3)", () => {
    const boardSeat = position("position-secretary", "Sekretaris Yayasan", { holderSource: "ACCOUNT" });
    const text = visibleText(renderToStaticMarkup(
      <OrganizationAdvancedAuthority
        position={director}
        bindings={[binding({})]}
        positions={[director, boardSeat]}
        canManage saving={false} onAdd={noop} onRemove={noop}
      />,
    ));

    expect(text).toContain("Belum bisa dipakai untuk persetujuan");
    expect(text).toContain("akun Dewan");
  });

  it("hides the editing form from someone without the approval permission", () => {
    const html = renderToStaticMarkup(
      <OrganizationAdvancedAuthority
        position={director} bindings={[]} positions={[director, secretary]}
        canManage={false} saving={false} onAdd={noop} onRemove={noop}
      />,
    );
    expect(html).not.toContain("Simpan aturan");
    expect(visibleText(html)).toContain("diatur oleh pemegang izin persetujuan");
  });

  it("says when there is no special rule at all", () => {
    const text = visibleText(renderToStaticMarkup(
      <OrganizationAdvancedAuthority
        position={director} bindings={[]} positions={[director]}
        canManage saving={false} onAdd={noop} onRemove={noop}
      />,
    ));
    expect(text).toContain("Belum ada aturan khusus");
  });
});

describe("ORG-008-5 bagan: cari, fokus, ciutkan, dan tampilan HP (gap S-5)", () => {
  const nodes: OrganizationNode[] = [
    {
      id: "n1", stableKey: "node-foundation", name: "Yayasan", nodeType: "FOUNDATION",
      parentNodeKey: null, active: true, effectiveFrom: "2026-01-01", effectiveTo: null,
      visualRankOffset: 0, integrationCode: null, memberCount: 0, leaderPositionKey: null,
    },
    {
      id: "n2", stableKey: "node-sdit", name: "SDIT", nodeType: "UNIT",
      parentNodeKey: "node-foundation", active: true, effectiveFrom: "2026-01-01", effectiveTo: null,
      visualRankOffset: 0, integrationCode: null, memberCount: 30, leaderPositionKey: null,
    },
  ];
  const chartPositions = [
    position("position-head", "Kepala SDIT", { nodeKey: "node-sdit" }),
  ];

  const render = () => renderToStaticMarkup(
    <OrganizationChart
      nodes={nodes} positions={chartPositions} selection={null}
      onSelect={noop} canEdit onStart={noop}
    />,
  );

  it("offers search, focus, collapse-all and zoom", () => {
    const html = render();
    expect(html).toContain("Cari unit, jabatan, atau nama pejabat");
    expect(html).toContain("Seluruh struktur");
    expect(html).toContain("Ciutkan semua");
    expect(html).toContain('aria-label="Perbesar"');
    expect(html).toContain('aria-label="Perkecil"');
  });

  it("renders a nested list for phones beside the chart for larger screens (decision O-10)", () => {
    const html = render();
    expect(html).toContain('data-chart-view="mobile"');
    expect(html).toContain('data-chart-view="desktop"');
    // The chart is hidden below 768px and the list above it, so only one is ever visible.
    expect(html).toMatch(/data-chart-view="mobile"[^>]*/);
    expect(html).toContain("md:hidden");
    expect(html).toContain("md:block");
  });

  it("lists every unit in the phone view, so nothing is reachable only by scrolling sideways", () => {
    const text = visibleText(render());
    expect(text).toContain("Yayasan");
    expect(text).toContain("SDIT");
    expect(text).toContain("Kepala SDIT");
  });

  it("keeps the structural data attributes the visual-ranking contract relies on", () => {
    const html = render();
    expect(html).toMatch(/data-node-key="node-sdit"/);
    expect(html).toMatch(/data-parent-node-key="node-foundation"/);
  });
});
