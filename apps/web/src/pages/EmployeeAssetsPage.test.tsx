// ASSET-001: Asset Saya and the Termination asset notice, rendered as markup. Synthetic data.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TerminationAssetNotice } from "@/components/employment/TerminationAssetWarning";
import { formatAssetDate, safeAssetLink, type AssetHoldings } from "@/lib/employeeAssets";
import { getEmployeeService } from "@/lib/employeeServices";
import { AssetHoldingsView } from "@/pages/EmployeeAssetsPage";

const SELF_SERVICE = "https://aset.example.test/my-assets";

function available(overrides: Partial<Extract<AssetHoldings, { status: "AVAILABLE" }>> = {}): AssetHoldings {
  return {
    status: "AVAILABLE",
    generatedAt: "2026-11-02T03:00:00.000Z",
    clearance: "OUTSTANDING",
    counts: { outstanding: 2, pendingAcceptance: 1, overdue: 1 },
    assignments: [
      {
        assignmentId: "20000000-0000-4000-8000-000000000001",
        assetTag: "SQ-LTP-0012",
        assetLabel: "Lenovo ThinkPad E14",
        custodyState: "ACTIVE",
        checkoutAt: "2026-09-01T02:00:00.000Z",
        expectedReturnOn: "2026-10-31",
        overdue: true,
      },
      {
        assignmentId: "20000000-0000-4000-8000-000000000002",
        assetTag: "SQ-PRJ-0003",
        assetLabel: "Epson EB-X51",
        custodyState: "PENDING_ACCEPTANCE",
        checkoutAt: "2026-10-30T02:00:00.000Z",
        expectedReturnOn: null,
        overdue: false,
      },
    ],
    truncated: false,
    selfServiceUrl: SELF_SERVICE,
    ...overrides,
  };
}

describe("Asset Saya view", () => {
  it("lists held assets with their state and the Aset SQ link", () => {
    const html = renderToStaticMarkup(<AssetHoldingsView holdings={available()} />);
    expect(html).toContain("Anda memegang 2 aset");
    expect(html).toContain("1 menunggu konfirmasi Anda · 1 lewat tanggal kembali");
    expect(html).toContain("SQ-LTP-0012");
    expect(html).toContain("Menunggu konfirmasi Anda");
    expect(html).toContain("Lewat tanggal kembali");
    expect(html).toContain(`href="${SELF_SERVICE}"`);
    expect(html).not.toContain("Sebagian aset tidak ditampilkan");
  });

  it("says so when Aset SQ cut the list", () => {
    expect(renderToStaticMarkup(<AssetHoldingsView holdings={available({ truncated: true })} />))
      .toContain("Sebagian aset tidak ditampilkan");
  });

  it("shows the empty state", () => {
    const html = renderToStaticMarkup(<AssetHoldingsView holdings={available({
      clearance: "CLEAR",
      counts: { outstanding: 0, pendingAcceptance: 0, overdue: 0 },
      assignments: [],
    })} />);
    expect(html).toContain("Tidak ada aset organisasi yang sedang Anda pegang.");
  });

  it("still links to Aset SQ when the list is unavailable or not configured", () => {
    const off = renderToStaticMarkup(<AssetHoldingsView holdings={{ status: "NOT_CONFIGURED", selfServiceUrl: SELF_SERVICE }} />);
    expect(off).toContain("Sambungan ke Aset SQ belum diaktifkan");
    expect(off).toContain(`href="${SELF_SERVICE}"`);
    const down = renderToStaticMarkup(<AssetHoldingsView holdings={{ status: "UNAVAILABLE", selfServiceUrl: SELF_SERVICE }} />);
    expect(down).toContain("Aset SQ sedang tidak dapat dihubungi");
  });

  it("is an available service now", () => {
    expect(getEmployeeService("assets")).toMatchObject({ stage: "available", href: "/app/services/assets" });
  });
});

describe("Termination asset notice", () => {
  it("warns with counts and tags, and says recording still works", () => {
    const html = renderToStaticMarkup(<TerminationAssetNotice holdings={available()} failed={false} />);
    expect(html).toContain("masih memegang 2 aset organisasi di Aset SQ");
    expect(html).toContain("(1 lewat tanggal kembali)");
    expect(html).toContain("SQ-LTP-0012, SQ-PRJ-0003");
    expect(html).toContain("Pemberhentian tetap bisa dicatat");
    expect(html).toContain('href="https://aset.example.test/"');
  });

  it("names how many more there are beyond the visible tags", () => {
    const html = renderToStaticMarkup(<TerminationAssetNotice
      holdings={available({ counts: { outstanding: 9, pendingAcceptance: 0, overdue: 0 } })}
      failed={false}
    />);
    expect(html).toContain("dan 7 lainnya");
  });

  it("is calm when nothing is held, and neutral when Aset SQ cannot be checked", () => {
    expect(renderToStaticMarkup(<TerminationAssetNotice holdings={available({
      clearance: "CLEAR", counts: { outstanding: 0, pendingAcceptance: 0, overdue: 0 }, assignments: [],
    })} failed={false} />)).toContain("tidak sedang memegang aset organisasi");
    for (const [holdings, failed] of [
      [{ status: "UNAVAILABLE", selfServiceUrl: SELF_SERVICE } as AssetHoldings, false],
      [null, true],
    ] as const) {
      expect(renderToStaticMarkup(<TerminationAssetNotice holdings={holdings} failed={failed} />))
        .toContain("tidak dapat diperiksa saat ini");
    }
  });
});

describe("employee asset helpers", () => {
  it("only lets http(s) links out", () => {
    expect(safeAssetLink("javascript:alert(1)")).toBe("https://aset.sabilulquran.or.id/my-assets");
    expect(safeAssetLink(SELF_SERVICE)).toBe(SELF_SERVICE);
  });

  it("reads a bare return date as a Jakarta calendar day", () => {
    expect(formatAssetDate("2026-10-31")).toContain("31");
    expect(formatAssetDate(null)).toBe("-");
  });
});
