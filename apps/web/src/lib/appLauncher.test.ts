import { afterEach, describe, expect, it, vi } from "vitest";

import { applicationAppearance, fetchLauncherApplications, launcherTiles, loadLauncherApplications, resetLauncherCacheForTests } from "@/lib/appLauncher";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetLauncherCacheForTests();
});

describe("AUTH-013 launcher tiles", () => {
  it("adds HCIS when SQ Hub left it out and keeps the list ordered by name", () => {
    const tiles = launcherTiles([
      { key: "spmb", name: "SPMB", canonicalUrl: "https://spmb.example.test" },
      { key: "aset-sq", name: "Aset SQ", canonicalUrl: "https://aset.example.test" },
    ]);
    expect(tiles.map((tile) => tile.key)).toEqual(["aset-sq", "hcis", "spmb"]);
    expect(tiles.find((tile) => tile.key === "hcis")?.canonicalUrl).toBe("/app");
  });

  it("shows only HCIS for an unavailable or empty list", () => {
    expect(launcherTiles(null).map((tile) => tile.key)).toEqual(["hcis"]);
    expect(launcherTiles([]).map((tile) => tile.key)).toEqual(["hcis"]);
  });
});

describe("AUTH-013 launcher appearance (SQ Hub HUB-IMPL-022 §6)", () => {
  it.each([
    ["hcis", "UsersRound", "bg-cat-attendance-soft text-cat-attendance"],
    ["aset-sq", "Boxes", "bg-cat-service-soft text-cat-service"],
    ["karir-sq", "BriefcaseBusiness", "bg-cat-task-soft text-cat-task"],
    ["spmb-sq", "GraduationCap", "bg-cat-leave-soft text-cat-leave"],
    ["kirim-sq", "MessageCircle", "bg-cat-pay-soft text-cat-pay"],
    ["unknown-app", "PanelsTopLeft", "bg-brand-primary-pale text-brand-primary-deep"],
  ])("maps %s like SQ Hub", (key, iconName, tile) => {
    const appearance = applicationAppearance(key);
    expect(appearance.tile).toBe(tile);
    expect((appearance.icon as { displayName?: string }).displayName).toBe(iconName);
  });
});

describe("AUTH-013 launcher fetch", () => {
  it("reads the same-origin API, never SQ Hub, and drops unsafe links", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        applications: [
          { key: "aset-sq", name: "Aset SQ", canonicalUrl: "https://aset.example.test" },
          { key: "bad", name: "Bad", canonicalUrl: "javascript:alert(1)" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchLauncherApplications()).toEqual([
      { key: "aset-sq", name: "Aset SQ", canonicalUrl: "https://aset.example.test" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/launcher", expect.objectContaining({ credentials: "include" }));
  });

  it.each([
    ["the unavailable fallback", () => jsonResponse({ applications: null, unavailable: true })],
    ["an error status", () => jsonResponse({ code: "UNAUTHENTICATED" }, 401)],
    ["a network failure", () => Promise.reject(new TypeError("offline"))],
  ])("resolves null for %s", async (_label, respond) => {
    vi.stubGlobal("fetch", vi.fn(respond));
    expect(await fetchLauncherApplications()).toBeNull();
  });

  it("reuses one read for 5 minutes but retries after an unavailable answer", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ applications: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await loadLauncherApplications(0);
    await loadLauncherApplications(299_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await loadLauncherApplications(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resetLauncherCacheForTests();
    fetchMock.mockImplementation(async () => jsonResponse({ applications: null, unavailable: true }));
    await loadLauncherApplications(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await loadLauncherApplications(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
