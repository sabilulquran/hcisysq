// ORG-004 D-R7: the rollout switch and its way back are operable from the screen.
//
// Guards the two things that made the switch SQL-only: nothing in the app addressed
// `POST /admin/organization/rollout/:id/end`, and nothing offered the write at all. Static render;
// synthetic data only.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrganizationRolloutPanel } from "@/components/organization/OrganizationRolloutPanel";
import type {
  OrganizationNode,
  OrganizationRolloutConfiguration,
} from "@/lib/organizationDesigner";

const UNIT_KEY = "2ed0521d-5ba3-41db-a4d7-1ce54994b565";
const ROW_ID = "11111111-1111-4111-8111-111111111111";

function node(stableKey: string, name: string): OrganizationNode {
  return {
    id: stableKey,
    stableKey,
    name,
    nodeType: "UNIT",
    parentNodeKey: null,
    active: true,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    visualRankOffset: 0,
    integrationCode: null,
    memberCount: 0,
    leaderPositionKey: null,
  };
}

const nodes = [node(UNIT_KEY, "Taman Tahfizh Sabilul Qur'an"), node("other", "Bidang Pendidikan")];

const configured: OrganizationRolloutConfiguration = {
  mode: "STRUCTURE",
  configuredRowCount: 1,
  asOf: "2026-11-25",
  settings: [{
    id: ROW_ID,
    workflowKey: "leave.annual",
    organizationalNodeKey: UNIT_KEY,
    mode: "STRUCTURE",
    effectiveFrom: "2026-11-25",
    effectiveTo: null,
    reason: "pilot Cuti Tahunan Taman Tahfizh",
  }],
};

function withSearch(search: string) {
  vi.stubGlobal("window", { location: { search } });
}

function render(
  rollout: OrganizationRolloutConfiguration | null,
  options?: { canManage?: boolean; search?: string },
) {
  withSearch(options?.search ?? "");
  return renderToStaticMarkup(
    <OrganizationRolloutPanel
      rollout={rollout}
      nodes={nodes}
      today="2026-11-25"
      canManage={options?.canManage ?? true}
      onChanged={() => undefined}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ORG-004 panel mode persetujuan per unit", () => {
  it("states plainly that nothing is moved when no setting exists", () => {
    const html = render({ mode: "LEGACY", configuredRowCount: 0, settings: [] });
    expect(html).toContain("Belum ada unit yang dipindahkan");
    expect(html).toContain("Pindahkan unit");
  });

  it("names the unit, the request type and the subtree reach of an effective setting", () => {
    const html = render(configured);
    expect(html).toContain("Taman Tahfizh Sabilul Qur&#x27;an");
    expect(html).toContain("Cuti Tahunan");
    expect(html).toContain("termasuk seluruh bagian di bawahnya");
    expect(html).toContain("pilot Cuti Tahunan Taman Tahfizh");
    // The way back is offered on the row itself, not only in a document.
    expect(html).toContain("Akhiri");
  });

  it("offers neither the write nor the way back without approvals.policy.manage", () => {
    const html = render(configured, { canManage: false });
    expect(html).not.toContain("Pindahkan unit");
    expect(html).not.toContain(">Akhiri<");
  });

  it("opens the move form as a pop-up named in the URL", () => {
    const html = render(configured, { search: "?mode-persetujuan=baru" });
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Pindahkan unit ke struktur"/);
    expect(html).toContain("Taman Tahfizh Sabilul Qur&#x27;an");
    // Picking no unit moves the whole foundation; the form says so where the choice is made.
    expect(html).toContain("Seluruh yayasan");
  });

  it("opens the end form for the row the URL names, and never for a row already ended", () => {
    expect(render(configured, { search: `?akhiri-mode=${ROW_ID}` }))
      .toMatch(/role="dialog"[^>]*aria-label="Akhiri pengaturan"/);
    const ended: OrganizationRolloutConfiguration = {
      ...configured,
      settings: [{ ...configured.settings![0]!, effectiveTo: "2026-11-30" }],
    };
    expect(render(ended, { search: `?akhiri-mode=${ROW_ID}` })).not.toContain('role="dialog"');
  });

  it("opens no form for someone who may not manage the switch", () => {
    expect(render(configured, { search: "?mode-persetujuan=baru", canManage: false }))
      .not.toContain('role="dialog"');
    expect(render(configured, { search: `?akhiri-mode=${ROW_ID}`, canManage: false }))
      .not.toContain('role="dialog"');
  });
});
