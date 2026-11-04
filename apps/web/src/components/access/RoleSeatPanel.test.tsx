import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RoleSeatPanel } from "@/components/access/RoleSeatPanel";
import type { RoleSeat, RoleSeatCheck, RoleSeatChecksResponse } from "@/lib/adminOrgAccess";

/** AUTH-015: the Akses screen shows which roles follow which seats, and for whom they are in force. */

const SEAT: RoleSeat = {
  positionKey: "position-staf-keuangan", title: "Staf Keuangan", unitName: "Keuangan",
  reason: "Keputusan owner 2026-11-04", setAt: "2026-11-04T01:00:00.000Z", status: "HELD",
  incumbents: [{
    employeeId: "emp-panji", name: "Panji", kind: "PRIMARY", accountId: "acct-panji",
    roleEffective: true, notEffectiveReason: null, alsoDirect: false,
  }],
};

function check(overrides: Partial<RoleSeatCheck> = {}): RoleSeatCheck {
  return {
    roleKey: "finance_officer", roleName: "Staf Keuangan (Kasbon)", asOf: "2026-11-04",
    seats: [SEAT], holders: [], mismatches: [], ...overrides,
  };
}

function data(items: RoleSeatCheck[]): RoleSeatChecksResponse {
  return { asOf: "2026-11-04", items, linkableRoles: [{ roleKey: "finance_officer", roleName: "Staf Keuangan (Kasbon)" }] };
}

function visibleText(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/&bull;/g, "•").replace(/\s+/g, " ");
}

const render = (value: RoleSeatChecksResponse | null, canManage = false, error: string | null = null) =>
  renderToStaticMarkup(
    <RoleSeatPanel data={value} error={error} canManage={canManage} busy={false}
      onAdd={async () => true} onRemove={async () => true} onSearchPositions={async () => []} />,
  );

describe("AUTH-015 roles that follow a seat", () => {
  it("shows the seat, its basis and the holder for whom the role is in force", () => {
    const text = visibleText(render(data([check()])));
    expect(text).toContain("Staf Keuangan (Kasbon)");
    expect(text).toContain("Staf Keuangan (Keuangan)");
    expect(text).toContain("Dasar: Keputusan owner 2026-11-04");
    expect(text).toContain("Panji: peran berlaku");
  });

  it("says why the role is not in force for a seat holder, and names a Plt as Plt", () => {
    const text = visibleText(render(data([check({
      seats: [{ ...SEAT, incumbents: [{ ...SEAT.incumbents[0]!, kind: "ACTING", roleEffective: false, notEffectiveReason: "ACCOUNT_NOT_ACTIVE" }] }],
      mismatches: [{
        kind: "SEAT_HOLDER_NOT_EFFECTIVE", positionKey: SEAT.positionKey, employeeId: "emp-panji", name: "Panji",
        incumbentKind: "ACTING", reason: "ACCOUNT_NOT_ACTIVE",
      }],
    })])));
    expect(text).toContain("Plt Panji: belum berlaku, akun HCIS-nya belum aktif");
    expect(text).toContain("Panji adalah Plt Staf Keuangan (Keuangan), tetapi peran Staf Keuangan (Kasbon) belum berlaku karena akun HCIS-nya belum aktif.");
  });

  it("warns that a direct grant outside the seats will not move with the seat", () => {
    const text = visibleText(render(data([check({
      mismatches: [{ kind: "DIRECT_HOLDER_NOT_SEATED", accountId: "acct-siti", employeeId: "emp-siti", name: "Siti" }],
    })])));
    expect(text).toContain("Siti memegang peran Staf Keuangan (Kasbon) lewat pemberian langsung, bukan lewat jabatan");
  });

  it("explains a vacant seat", () => {
    const text = visibleText(render(data([check({ seats: [{ ...SEAT, status: "SEAT_VACANT", incumbents: [] }] })])));
    expect(text).toContain("Jabatan ini sedang kosong");
  });

  it("offers linking and unlinking only to Super Admin", () => {
    const superAdmin = render(data([check()]), true);
    expect(superAdmin).toContain("Tautkan peran ke jabatan");
    expect(superAdmin).toContain("Lepas tautan");
    const reader = render(data([check()]), false);
    expect(reader).not.toContain("Tautkan peran ke jabatan");
    expect(reader).not.toContain("Lepas tautan");
  });

  it("says when no role follows a seat yet, and shows a load failure without breaking the screen", () => {
    expect(visibleText(render(data([])))).toContain("Belum ada peran yang mengikuti jabatan.");
    expect(visibleText(render(null, false, "Peran yang mengikuti jabatan tidak dapat dimuat."))).toContain("tidak dapat dimuat");
    expect(render(null)).toBe("");
  });
});
