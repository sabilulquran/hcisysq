import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OrganizationUnitLink } from "@/components/organization/OrganizationUnitLink";
import type { OrganizationUnitSummary } from "@/lib/adminOrgAccess";
import type { OrganizationNode } from "@/lib/organizationDesigner";
import type { OrganizationUnitHcStaff } from "@/lib/organizationReadModel";

function visibleText(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ");
}

const noop = () => undefined;

const node: OrganizationNode = {
  id: "node-id", stableKey: "node-sdit", name: "SDIT", nodeType: "UNIT", parentNodeKey: null,
  active: true, effectiveFrom: "2026-01-01", effectiveTo: null, visualRankOffset: 0,
  integrationCode: null, legacyUnitId: null, memberCount: 30, leaderPositionKey: null,
};

const units: OrganizationUnitSummary[] = [
  { id: "unit-sdit", name: "SDIT Sintetis", employeeCount: 32, activeCount: 30 },
  { id: "unit-smp", name: "SMP Sintetis", employeeCount: 20, activeCount: 19 },
];

const render = (props: Partial<Parameters<typeof OrganizationUnitLink>[0]> = {}) =>
  renderToStaticMarkup(
    <OrganizationUnitLink
      node={node} units={units} unitsError={null}
      staff={null} staffLoading={false} staffError={null}
      canEdit saving={false} onLink={noop} onRetryStaff={noop}
      {...props}
    />,
  );

function staffAnswer(overrides: Partial<OrganizationUnitHcStaff> = {}): OrganizationUnitHcStaff {
  return {
    asOf: "2026-10-24", nodeKey: "node-sdit", linkedUnitIds: ["unit-sdit"], fallback: false,
    items: [{
      employeeId: "employee-hc", fullName: "Staf HC Sintetis",
      roleKey: "human_capital", unitId: "unit-sdit", unitName: "SDIT Sintetis",
    }],
    ...overrides,
  };
}

describe("ORG-008-6b menautkan unit ke unit lama", () => {
  it("explains what the link is for, in terms of the notification it fixes", () => {
    const text = visibleText(render());
    expect(text).toContain("staf Human Capital mana yang diberi tahu soal pengajuan lembur");
    expect(text).toContain("unit di bawahnya");
  });

  it("offers every imported unit with how many active people it holds", () => {
    const text = visibleText(render());
    expect(text).toContain("SDIT Sintetis (30 pegawai aktif)");
    expect(text).toContain("SMP Sintetis (19 pegawai aktif)");
    expect(text).toContain("Belum ditautkan");
  });

  it("says plainly when the unit list could not be loaded, rather than offering an empty picker", () => {
    const text = visibleText(render({ unitsError: "Daftar unit lama tidak dapat dimuat, jadi tautan belum bisa dipilih." }));
    expect(text).toContain("tidak dapat dimuat");
  });

  it("shows the current link read-only when the change set is not editable", () => {
    const html = render({ canEdit: false, node: { ...node, legacyUnitId: "unit-sdit" } });
    expect(html).not.toContain("Simpan tautan");
    expect(visibleText(html)).toContain('Tertaut ke unit lama "SDIT Sintetis"');
  });
});

describe("ORG-008-6b staf HC unit ini", () => {
  it("lists the staff already assigned, and says assignment happens elsewhere", () => {
    const text = visibleText(render({ staff: staffAnswer() }));
    expect(text).toContain("Staf HC Sintetis");
    expect(text).toContain("Kewenangan atas unit SDIT Sintetis");
    expect(text).toContain("Menambah atau mencabutnya dilakukan di layar Akses");
  });

  it("says the notification falls back when nothing up the branch is linked", () => {
    const text = visibleText(render({ staff: staffAnswer({ linkedUnitIds: [], fallback: true, items: [] }) }));
    expect(text).toContain("belum ditautkan ke unit lama");
    expect(text).toContain("penerima tingkat yayasan");
    // It does not claim there is nobody; it says the net is wider.
    expect(text).not.toContain("belum ada staf HC");
  });

  it("separates a linked unit that simply has nobody assigned from an unlinked one", () => {
    const text = visibleText(render({ staff: staffAnswer({ items: [] }) }));
    expect(text).toContain("Tautannya sudah ada, tetapi belum ada staf HC");
    expect(text).toContain("layar Akses");
  });

  it("reports a failed lookup as an error with a retry, not as an empty list", () => {
    const html = render({ staffError: "Staf HC unit ini tidak dapat dimuat." });
    expect(visibleText(html)).toContain("tidak dapat dimuat");
    expect(html).toContain("Coba lagi");
  });
});
