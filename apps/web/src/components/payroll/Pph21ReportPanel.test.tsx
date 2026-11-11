// PAY-003 Laporan PPh21 (TER) panel: every state the period screen can show,
// rendered statically. Synthetic data only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Pph21ReportView, type Pph21PanelState } from "@/components/payroll/Pph21ReportPanel";
import type { PayrollPph21Report } from "@/lib/payroll";

const PERIOD_ID = "50000000-0000-4000-8000-000000000001";

function report(overrides: Partial<PayrollPph21Report> = {}): PayrollPph21Report {
  return {
    taxPeriod: "2026-09",
    objectCode: "21-100-01",
    policy: { versionId: "v1", effectiveFrom: "2026-01-01", source: "Tabel uji sintetis" },
    totals: {
      employeeCount: 2,
      gross: "4600000",
      tax: "30000",
      excludedCount: 0,
      ptkpMissingCount: 1,
      annualCalculationCount: 0,
      skippedBlockedCount: 0,
    },
    rows: [
      {
        employmentId: "e1",
        employeeNumber: "2016001",
        fullName: "Siti Aminah",
        ptkpStatus: "TK/0",
        terCategory: "A",
        gross: "3000000",
        rate: 0.01,
        tax: "30000",
        flags: [],
        exclusionReason: null,
        note: "",
      },
      {
        employmentId: "e2",
        employeeNumber: "2016002",
        fullName: "Budi Santoso",
        ptkpStatus: null,
        terCategory: null,
        gross: "1600000",
        rate: null,
        tax: null,
        flags: ["PTKP_MISSING"],
        exclusionReason: null,
        note: "Status PTKP kosong atau tidak terpetakan di kebijakan; PPh21 belum dapat dihitung",
      },
    ],
    ...overrides,
  };
}

function render(state: Pph21PanelState) {
  return renderToStaticMarkup(<Pph21ReportView periodId={PERIOD_ID} state={state} onOpen={() => undefined} />);
}

describe("PAY-003 Laporan PPh21 panel", () => {
  it("is closed until opened, and says the opening is recorded", () => {
    const html = render({ kind: "idle" });
    expect(html).toContain("Laporan PPh21 (TER)");
    expect(html).toContain("Buka laporan PPh21");
    expect(html).toContain("akses sensitif");
    // Nothing to download before the server has answered.
    expect(html).not.toContain("format=csv");
  });

  it("shows that it is loading, with the button busy", () => {
    const html = render({ kind: "loading" });
    expect(html).toContain("Memuat laporan PPh21");
    expect(html).toContain('aria-busy="true"');
  });

  it("explains a refusal that is an expected state without an alarm", () => {
    const html = render({ kind: "refused", tone: "info", note: "Laporan PPh21 baru tersedia setelah periode disahkan." });
    expect(html).toContain("setelah periode disahkan");
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Coba lagi");
  });

  it("shows a real failure as an alert", () => {
    const html = render({ kind: "refused", tone: "error", note: "Permintaan payroll gagal diproses." });
    expect(html).toContain('role="alert"');
  });

  it("shows totals, rows, flags, the policy source and the CSV download", () => {
    const html = render({ kind: "ready", report: report() });
    expect(html).toContain("Masa pajak 2026-09");
    expect(html).toContain("Rp4.600.000");
    expect(html).toContain("Rp30.000");
    expect(html).toContain("Siti Aminah");
    expect(html).toContain("1%");
    expect(html).toContain("PTKP belum terpetakan");
    expect(html).toContain("1 pegawai tanpa status PTKP");
    expect(html).toContain("Tabel uji sintetis");
    expect(html).toContain(`/api/payroll/periods/${PERIOD_ID}/pph21?format=csv`);
  });

  it("labels a final masa pajak as not final", () => {
    const base = report();
    const html = render({
      kind: "ready",
      report: report({
        totals: { ...base.totals, ptkpMissingCount: 0, annualCalculationCount: 2 },
        rows: base.rows.map((row) => ({ ...row, flags: ["ANNUAL_CALCULATION_REQUIRED"] })),
      }),
    });
    expect(html).toContain("bukan angka final");
    expect(html).toContain("Pasal 17");
  });

  it("answers an empty period plainly, with nothing to download", () => {
    const base = report();
    const html = render({
      kind: "ready",
      report: report({
        rows: [],
        totals: { ...base.totals, employeeCount: 0, gross: "0", tax: "0", ptkpMissingCount: 0 },
      }),
    });
    expect(html).toContain("tidak memiliki hasil yang dibayar");
    expect(html).not.toContain("format=csv");
  });

  it("keeps the table scrolling inside its own container on a narrow screen", () => {
    const html = render({ kind: "ready", report: report() });
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("min-w-0");
  });
});
