// ORG-010 amendment 2026-11-13: /board for an organ account once the Portal Organ Yayasan exists. Synthetic data.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BoardDashboardApiError, loadBoardPage, type BoardDashboardData } from "@/lib/boardDashboard";
import { OrganApprovalsOnly } from "@/pages/FoundationBoardPage";
import type { AuthSession } from "@/types/hcis";

const PORTAL = "https://organ.example.invalid";

function session(principalType: AuthSession["principal"]["principalType"], organPortalUrl?: string): AuthSession {
  return {
    principal: { id: "00000000-0000-4000-8000-000000000001", email: "organ@example.invalid", principalType },
    expiresAt: "2026-11-13T12:00:00.000Z",
    authorization: { organizationPermissions: principalType === "EMPLOYEE" ? ["board.read"] : [] },
    ...(organPortalUrl ? { organPortalUrl } : {}),
  } as AuthSession;
}

const dashboard = { actor: { principalType: "FOUNDATION_BOARD" } } as BoardDashboardData;

describe("ORG-010 /board with the Portal Organ Yayasan", () => {
  it("never requests the dashboard for an organ account when HCIS names the portal", async () => {
    const getDashboard = vi.fn(async () => dashboard);
    const state = await loadBoardPage({ getSession: async () => session("FOUNDATION_BOARD", PORTAL), getDashboard });
    expect(state).toEqual({ kind: "approvals-only", principalType: "FOUNDATION_BOARD", organPortalUrl: PORTAL });
    expect(getDashboard).not.toHaveBeenCalled();
  });

  it("loads the dashboard as before when the portal is not configured", async () => {
    const getDashboard = vi.fn(async () => dashboard);
    const state = await loadBoardPage({ getSession: async () => session("FOUNDATION_BOARD"), getDashboard });
    expect(state).toEqual({ kind: "dashboard", principalType: "FOUNDATION_BOARD", data: dashboard });
    expect(getDashboard).toHaveBeenCalledOnce();
  });

  it("keeps the dashboard for an Employee with board.read even if a portal link were present", async () => {
    const getDashboard = vi.fn(async () => dashboard);
    const state = await loadBoardPage({ getSession: async () => session("EMPLOYEE", PORTAL), getDashboard });
    expect(state.kind).toBe("dashboard");
    expect(getDashboard).toHaveBeenCalledOnce();
  });

  it("falls back to approvals only when the API refuses with ORGAN_PORTAL_ONLY", async () => {
    const state = await loadBoardPage({
      getSession: async () => session("FOUNDATION_BOARD"),
      getDashboard: async () => { throw new BoardDashboardApiError(403, "ORGAN_PORTAL_ONLY", "Portal", PORTAL); },
    });
    expect(state).toEqual({ kind: "approvals-only", principalType: "FOUNDATION_BOARD", organPortalUrl: PORTAL });
  });

  it("shows other errors as before", async () => {
    const state = await loadBoardPage({
      getSession: async () => session("FOUNDATION_BOARD"),
      getDashboard: async () => { throw new BoardDashboardApiError(403, "FORBIDDEN", "Akses ditolak."); },
    });
    expect(state).toEqual({ kind: "error", principalType: "FOUNDATION_BOARD", message: "Akses ditolak." });
  });

  it("renders the approvals heading and the portal link, and no dashboard figures", () => {
    const html = renderToStaticMarkup(<OrganApprovalsOnly organPortalUrl={PORTAL} />);
    expect(html).toContain("Persetujuan Organ Yayasan");
    expect(html).toContain(`href="${PORTAL}"`);
    expect(html).toContain("Ringkasan dan data pegawai ada di Portal Organ Yayasan");
    // BoardApprovalsSection's first render.
    expect(html).toContain("Menunggu keputusan Anda");
    expect(html).not.toContain("Dashboard Organ Yayasan");
    expect(html).not.toContain("Pegawai aktif");
  });
});
