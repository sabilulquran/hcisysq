import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OrganizationWorkLocation } from "@/components/organization/OrganizationWorkLocation";
import type { OrganizationNode } from "@/lib/organizationDesigner";

/** ORG-005-1 (DRAFT): a unit names the work location it works at; units below inherit it. */

const node = (overrides: Partial<OrganizationNode> = {}): OrganizationNode => ({
  id: "node", stableKey: "school", name: "SDIT", nodeType: "SCHOOL", parentNodeKey: null, active: true,
  effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0, integrationCode: null,
  memberCount: 0, leaderPositionKey: null, ...overrides,
});

const locations = [
  { id: "loc-sdit", name: "Kampus SDIT", active: true },
  { id: "loc-old", name: "Gedung Lama", active: false },
];

const render = (props: Partial<Parameters<typeof OrganizationWorkLocation>[0]> = {}) =>
  renderToStaticMarkup(
    <OrganizationWorkLocation node={node()} locations={locations} locationsError={null} canEdit saving={false}
      onSave={() => undefined} {...props} />,
  );

describe("ORG-005-1 the unit's work location", () => {
  it("offers active locations and inheriting from the unit above", () => {
    const html = render();
    expect(html).toContain("Ikuti unit di atasnya");
    expect(html).toContain("Kampus SDIT");
    expect(html).not.toContain("Gedung Lama");
  });

  it("keeps a location that was switched off since it was chosen, marked as such", () => {
    expect(render({ node: node({ workLocationId: "loc-old" }) })).toContain("Gedung Lama (nonaktif)");
  });

  it("only shows the current location to someone who cannot compose", () => {
    const html = render({ canEdit: false, node: node({ workLocationId: "loc-sdit", workLocationName: "Kampus SDIT" }) });
    expect(html).toContain("Bekerja di Kampus SDIT.");
    expect(html).not.toContain("<select");
  });

  it("says why the picker is missing when the list cannot be loaded", () => {
    const html = render({ locationsError: "Daftar lokasi kerja tidak dapat dimuat, jadi lokasi belum bisa dipilih." });
    expect(html).toContain("tidak dapat dimuat");
    expect(html).not.toContain("<select");
  });
});
