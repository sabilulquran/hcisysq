import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RoleSeatPanel } from "@/components/access/RoleSeatPanel";
import type { RoleSeatCheck } from "@/lib/adminOrgAccess";

/** ORG-008-9: the Akses screen shows when the Kepala HC role and the Kepala HC seat drift apart. */

const SEAT = {
  positionKey: "position-kepala-hc", title: "Kepala Human Capital", unitName: "Human Capital",
  reason: "SK 12/2026", setAt: "2026-10-27T01:00:00.000Z",
};

function check(overrides: Partial<RoleSeatCheck> = {}): RoleSeatCheck {
  return {
    roleKey: "human_capital_lead", asOf: "2026-10-27", seat: SEAT, status: "CHECKED",
    holders: [], incumbents: [], mismatches: [], ...overrides,
  };
}

function visibleText(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/&bull;/g, "•").replace(/\s+/g, " ");
}

const render = (checks: RoleSeatCheck[] | null, canSetSeat = false, error: string | null = null) =>
  renderToStaticMarkup(
    <RoleSeatPanel checks={checks} error={error} canSetSeat={canSetSeat} busy={false}
      onSetSeat={() => undefined} onSearchPositions={async () => []} />,
  );

describe("ORG-008-9 Kepala HC role against the Kepala HC seat", () => {
  it("names both directions of a difference", () => {
    const text = visibleText(render([check({
      mismatches: [
        { kind: "HOLDER_NOT_SEATED", accountId: "acct-siti", employeeId: "emp-siti", name: "Siti" },
        { kind: "SEATED_WITHOUT_ROLE", employeeId: "emp-budi", name: "Budi", incumbentKind: "PRIMARY", reason: "NO_ROLE" },
      ],
    })]));

    expect(text).toContain("Siti memegang peran Kepala HC, tetapi bukan pemegang Kepala Human Capital (Human Capital)");
    expect(text).toContain("Budi adalah pemegang Kepala Human Capital (Human Capital), tetapi belum memegang peran Kepala HC.");
  });

  it("names a Plt as Plt and says when an account is what is missing", () => {
    const text = visibleText(render([check({
      mismatches: [
        { kind: "SEATED_WITHOUT_ROLE", employeeId: "emp-rina", name: "Rina", incumbentKind: "ACTING", reason: "NO_ACCOUNT" },
      ],
    })]));
    expect(text).toContain("Rina adalah Plt Kepala Human Capital (Human Capital), tetapi belum punya akun HCIS.");
  });

  it("confirms a match instead of staying silent", () => {
    expect(visibleText(render([check()]))).toContain("Pemegang peran Kepala HC sama dengan pemegang jabatannya.");
  });

  it("explains why nothing could be compared", () => {
    const text = visibleText(render([check({ seat: null, status: "SEAT_NOT_SET" })]));
    expect(text).toContain("Jabatan acuan Kepala HC belum ditetapkan");
    expect(text).not.toContain("sama dengan pemegang jabatannya");
  });

  it("offers to set the seat only to Super Admin, and never a shortcut to grant the role", () => {
    const superAdmin = render([check()], true);
    expect(superAdmin).toContain("Ubah jabatan acuan");
    expect(render([check()], false)).not.toContain("jabatan acuan</button>");
    expect(superAdmin).not.toMatch(/Berikan peran|Tambah assignment/);
  });

  it("shows a load failure without breaking the rest of the screen", () => {
    expect(visibleText(render(null, false, "Pemeriksaan peran Kepala HC tidak dapat dimuat.")))
      .toContain("tidak dapat dimuat");
    expect(render(null)).toBe("");
  });
});
