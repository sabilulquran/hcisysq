import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OrganizationChart } from "@/components/organization/OrganizationChart";
import type { OrganizationNode, OrganizationPosition } from "@/lib/organizationDesigner";
import { buildOrganizationTree, selectableOrganizationParents } from "@/lib/organizationTree";

const baseNode: OrganizationNode = {
  id: "node-root-id",
  stableKey: "foundation",
  name: "Foundation Management",
  nodeType: "FOUNDATION",
  parentNodeKey: null,
  active: true,
  effectiveFrom: "2027-01-01",
  effectiveTo: null,
  visualRankOffset: 0,
  integrationCode: null,
  memberCount: 2,
  leaderPositionKey: "director",
};

const vacantPosition: OrganizationPosition = {
  id: "position-id",
  stableKey: "director",
  nodeKey: "foundation",
  title: "Director",
  parentPositionKey: null,
  singleIncumbent: true,
  vacancyPolicy: "CLIMB_TO_PARENT",
  active: true,
  effectiveFrom: "2027-01-01",
  effectiveTo: null,
  visualRankOffset: 0,
  primaryIncumbent: null,
  actingIncumbent: null,
};

function childNode(
  stableKey: string,
  name: string,
  visualRankOffset = 0,
): OrganizationNode {
  return {
    ...baseNode,
    id: `${stableKey}-id`,
    stableKey,
    name,
    nodeType: "SCHOOL",
    parentNodeKey: baseNode.stableKey,
    visualRankOffset,
    memberCount: 25,
    leaderPositionKey: null,
  };
}

function renderChart(nodes: OrganizationNode[], positions: OrganizationPosition[]) {
  return renderToStaticMarkup(
    <OrganizationChart
      nodes={nodes}
      positions={positions}
      selection={null}
      onSelect={() => undefined}
      canEdit
      onStart={() => undefined}
    />,
  );
}

describe("Organization Designer chart", () => {
  it("keeps the selected node available as the default parent when adding a child", () => {
    const child = childNode("sdit", "SDIT");

    expect(selectableOrganizationParents([baseNode, child], "child", baseNode.stableKey))
      .toContainEqual(baseNode);
    expect(selectableOrganizationParents([baseNode, child], "edit", baseNode.stableKey))
      .not.toContainEqual(baseNode);
  });

  it("shows the required guided empty state", () => {
    const html = renderToStaticMarkup(
      <OrganizationChart
        nodes={[]}
        positions={[]}
        selection={null}
        onSelect={() => undefined}
        canEdit={false}
        onStart={() => undefined}
      />,
    );

    // ORG-008-1 §3 kamus istilah: the guided empty state speaks the operator's language.
    expect(html).toContain("Belum ada struktur");
    expect(html).toContain("Mulai perubahan struktur");
  });

  it("keeps structural parentage unchanged when a child has a visual offset", () => {
    const child: OrganizationNode = {
      ...baseNode,
      id: "bureau-id",
      stableKey: "quran-bureau",
      name: "Al-Qur'an Bureau",
      nodeType: "DIVISION",
      parentNodeKey: "foundation",
      visualRankOffset: 1,
      leaderPositionKey: null,
    };

    const tree = buildOrganizationTree([baseNode, child], [vacantPosition]);

    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].stableKey).toBe("quran-bureau");
    expect(tree[0].children[0].visualRankOffset).toBe(1);
    expect(tree[0].positions[0].stableKey).toBe("director");
  });

  it("renders siblings horizontally as same-rank peers", () => {
    const first = childNode("sdit", "SDIT");
    const second = childNode("smpit", "SMPIT");
    const html = renderChart([baseNode, first, second], [vacantPosition]);

    expect(html).toContain('data-sibling-parent="foundation"');
    expect(html).toContain('data-layout-axis="horizontal"');
    expect(html).toMatch(/data-node-key="sdit"[^>]*data-structural-depth="1"[^>]*data-visual-band="1"/);
    expect(html).toMatch(/data-node-key="smpit"[^>]*data-structural-depth="1"[^>]*data-visual-band="1"/);
  });

  it("renders a child below its parent with a visible structural connector", () => {
    const child = childNode("sdit", "SDIT");
    const html = renderChart([baseNode, child], [vacantPosition]);

    expect(html).toContain('data-child-level-of="foundation"');
    expect(html).toMatch(/data-connector-kind="node"[^>]*data-connector-from="foundation"[^>]*data-connector-to="sdit"/);
    expect(html).toMatch(/data-node-key="foundation"[^>]*data-structural-depth="0"/);
    expect(html).toMatch(/data-node-key="sdit"[^>]*data-structural-depth="1"/);
  });

  it("uses node visual offset as a real lower layout band", () => {
    const bureau = childNode("quran-bureau", "Al-Qur'an Bureau", 1);
    const html = renderChart([baseNode, bureau], [vacantPosition]);

    expect(html).toMatch(/data-node-key="quran-bureau"[^>]*data-structural-depth="1"[^>]*data-visual-band="2"[^>]*data-visual-rank-offset="1"/);
    expect(html).toContain('style="height:76px"');
  });

  it("uses position visual offset as a real lower layout band", () => {
    const vicePrincipal: OrganizationPosition = {
      ...vacantPosition,
      id: "vice-id",
      stableKey: "vice-principal",
      title: "Vice Principal",
      parentPositionKey: "director",
      visualRankOffset: 2,
    };
    const html = renderChart([baseNode], [vacantPosition, vicePrincipal]);

    expect(html).toMatch(/data-position-key="vice-principal"[^>]*data-parent-position-key="director"[^>]*data-structural-depth="1"[^>]*data-visual-band="3"/);
    expect(html).toContain('style="height:96px"');
    expect(html).toMatch(/data-connector-kind="position"[^>]*data-connector-from="director"[^>]*data-connector-to="vice-principal"/);
  });

  it("keeps connectors attached to the structural parent after a visual-only change", () => {
    const normal = childNode("quran-bureau", "Al-Qur'an Bureau", 0);
    const offset = { ...normal, visualRankOffset: 2 };
    const normalTree = buildOrganizationTree([baseNode, normal], [vacantPosition]);
    const offsetTree = buildOrganizationTree([baseNode, offset], [vacantPosition]);
    const html = renderChart([baseNode, offset], [vacantPosition]);

    expect(offsetTree[0].children[0].parentNodeKey).toBe(normalTree[0].children[0].parentNodeKey);
    expect(offsetTree[0].children[0].structuralDepth).toBe(normalTree[0].children[0].structuralDepth);
    expect(offsetTree[0].children[0].visualDepth).toBe(normalTree[0].children[0].visualDepth + 2);
    expect(vacantPosition.vacancyPolicy).toBe("CLIMB_TO_PARENT");
    expect(html).toMatch(/data-connector-from="foundation"[^>]*data-connector-to="quran-bureau"/);
  });

  it("renders a real vacancy separately from visual-rank presentation", () => {
    const html = renderToStaticMarkup(
      <OrganizationChart
        nodes={[baseNode]}
        positions={[{ ...vacantPosition, visualRankOffset: 2 }]}
        selection={{ kind: "position", key: "director" }}
        onSelect={() => undefined}
        canEdit
        onStart={() => undefined}
      />,
    );

    expect(html).toContain("Kosong · belum ada pejabat");
    expect(html).toContain("Tampilan: turun 2 tingkat");
  });
});
