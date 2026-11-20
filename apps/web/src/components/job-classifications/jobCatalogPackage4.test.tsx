// ORG-011 Package 4 web: export link, import gate and report, change history, employee view,
// placement and seat read labels. Synthetic data only; the fetch boundary is stubbed.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { auditEventDetail } from "@/components/job-classifications/JobCatalogAuditList";
import { EmployeeJobClassificationCard } from "@/components/job-classifications/EmployeeJobClassificationCard";
import { ImportReportView, JobCatalogImportPanel, canApply, templateHref } from "@/components/job-classifications/JobCatalogImportPanel";
import { classificationLabel } from "@/components/employment/EmploymentPanels";
import {
  catalogExportUrl,
  getEmployeeJobClassifications,
  importJobCatalog,
  listJobCatalogAuditEvents,
  type CatalogImportReport,
} from "@/lib/jobClassifications";
import { seatClassificationLabel } from "@/pages/AdminOrganizationPage";

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(body: unknown, status = 200) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", spy);
  return spy as unknown as { mock: { calls: unknown[][] } };
}

const cleanCheck: CatalogImportReport = {
  importId: "00000000-0000-4000-8000-000000000001",
  kind: "CLASSIFICATION",
  dryRun: true,
  applied: false,
  summary: { rows: 2, create: 1, amend: 0, unchanged: 1, error: 0 },
  rows: [
    { line: 2, code: "FUNC_SINTETIS", outcome: "CREATE" },
    { line: 3, code: "STRUCT_SINTETIS", outcome: "UNCHANGED" },
  ],
};

describe("UX-FLOW-001 catalog import steps", () => {
  it("opens on the upload step alone, without the report or the apply button", () => {
    const html = renderToStaticMarkup(<JobCatalogImportPanel kind="CLASSIFICATION" onApplied={() => undefined} />);
    expect(html).toContain("Unggah berkas");
    expect(html).toContain('type="file"');
    expect(html).toContain("Periksa berkas");
    expect(html).not.toContain("Terapkan impor");
    expect(html).not.toContain('role="status"');
  });
});

describe("ORG-011 Package 4 export and import client", () => {
  it("builds the export link for a date, or for every version without a date", () => {
    expect(catalogExportUrl("CLASSIFICATION", { onDate: "2026-11-17" }))
      .toBe("/api/admin/job-classifications/export?onDate=2026-11-17");
    expect(catalogExportUrl("GRADE", { onDate: "2026-11-17", includeHistory: true }))
      .toBe("/api/admin/job-grades/export?includeHistory=true");
  });

  it("returns the report of a rejected real import (422) instead of throwing it away", async () => {
    stubFetch({ report: { ...cleanCheck, dryRun: false, summary: { ...cleanCheck.summary, error: 1 } } }, 422);
    const report = await importJobCatalog({ kind: "CLASSIFICATION", csv: "x", dryRun: false, fileName: null });
    expect(report.summary.error).toBe(1);
  });

  it("throws a request-level problem such as a missing column", async () => {
    stubFetch({ code: "IMPORT_MISSING_COLUMNS", message: "Kolom wajib tidak ada: family." }, 400);
    await expect(importJobCatalog({ kind: "CLASSIFICATION", csv: "x", dryRun: true, fileName: null }))
      .rejects.toMatchObject({ code: "IMPORT_MISSING_COLUMNS" });
  });

  it("only lets the exact text of a clean check with changes be applied", () => {
    expect(canApply({ csv: "a", report: cleanCheck }, "a")).toBe(true);
    expect(canApply({ csv: "a", report: cleanCheck }, "b")).toBe(false);
    expect(canApply(null, "a")).toBe(false);
    expect(canApply({ csv: "a", report: { ...cleanCheck, summary: { ...cleanCheck.summary, error: 1 } } }, "a")).toBe(false);
    expect(canApply({ csv: "a", report: { ...cleanCheck, summary: { ...cleanCheck.summary, create: 0 } } }, "a")).toBe(false);
  });

  it("offers a header-only template", () => {
    expect(decodeURIComponent(templateHref("GRADE"))).toContain("code,name,rank_order,effective_from");
  });

  it("renders every report row and says nothing was saved on a check", () => {
    const html = renderToStaticMarkup(<ImportReportView report={cleanCheck} />);
    expect(html).toContain("Pemeriksaan bersih. Belum ada yang disimpan.");
    expect(html).toContain("FUNC_SINTETIS");
    expect(html).toContain("Tidak berubah");
    const rejected = renderToStaticMarkup(<ImportReportView report={{
      ...cleanCheck, dryRun: false,
      summary: { ...cleanCheck.summary, error: 1 },
      rows: [{ line: 2, code: null, outcome: "ERROR", errorCode: "IMPORT_INVALID_CODE", message: "Kode harus huruf besar." }],
    }} />);
    expect(rejected).toContain("Tidak ada yang disimpan.");
    expect(rejected).toContain("Kode harus huruf besar.");
  });
});

describe("ORG-011 Package 4 change history", () => {
  it("pages the audit list through the server", async () => {
    const spy = stubFetch({ events: [], pagination: { page: 2, pageSize: 25, total: 30, pageCount: 2 } });
    await listJobCatalogAuditEvents({ page: 2, pageSize: 25, entityCode: "FUNC_SINTETIS" });
    expect(String(spy.mock.calls[0]?.[0])).toBe("/api/admin/job-classification-audit-events?page=2&pageSize=25&entityCode=FUNC_SINTETIS");
  });

  it("describes events from their own payload", () => {
    const base = { id: "e", entityType: "JOB_CLASSIFICATION" as const, entityCode: "FUNC_SINTETIS", actorName: null, occurredAt: "2026-11-17T00:00:00Z" };
    expect(auditEventDetail({ ...base, action: "job_classification.amended", payload: { name: "Guru", effectiveFrom: "2026-07-01", importId: "x" } }))
      .toBe('nama "Guru" · berlaku 2026-07-01 · lewat impor');
    expect(auditEventDetail({ ...base, action: "job_classification.imported", payload: { create: 2, amend: 1, fileName: "a.csv" } }))
      .toBe("2 baru, 1 versi baru dari a.csv");
    expect(auditEventDetail({ ...base, action: "job_classification.deactivated", payload: { endOn: "2026-12-31", reason: "Salah kode" } }))
      .toBe("ditutup 2026-12-31 · alasan: Salah kode");
  });
});

describe("ORG-011 Package 4 read views", () => {
  it("asks the per-employee endpoint with an optional date", async () => {
    const spy = stubFetch({ employeeId: "e", onDate: "2026-11-17", employments: [] });
    await getEmployeeJobClassifications("00000000-0000-4000-8000-000000000002", "2026-11-17");
    expect(String(spy.mock.calls[0]?.[0]))
      .toBe("/api/admin/employees/00000000-0000-4000-8000-000000000002/job-classifications?onDate=2026-11-17");
  });

  it("renders the loading state of the employee card without money or authority wording", () => {
    stubFetch({ employeeId: "e", onDate: "2026-11-17", employments: [] });
    const html = renderToStaticMarkup(<EmployeeJobClassificationCard employeeId="00000000-0000-4000-8000-000000000002" />);
    expect(html).toContain("Klasifikasi jabatan");
    expect(html).toContain("Memuat");
    expect(html).toContain("tidak memberi kewenangan persetujuan");
  });

  it("labels a placement's own classification and a seat default", () => {
    const placement = {
      id: "p", employmentId: "e", kind: "PRIMARY" as const, unitName: null, positionName: null,
      jobTitleLabel: "Guru", effectiveFrom: "2026-01-01", effectiveTo: null, effectiveFromBasis: "RECORDED" as const,
    };
    expect(classificationLabel({ ...placement, jobClassificationCode: "FUNC_SINTETIS" })).toBe("Klasifikasi FUNC_SINTETIS");
    expect(classificationLabel({ ...placement, jobClassificationCode: null })).toBeNull();
    expect(classificationLabel(placement)).toBeNull();
    expect(seatClassificationLabel("STRUCT_SINTETIS")).toContain("bukan kewenangan");
    expect(seatClassificationLabel(null)).toBe("Klasifikasi jabatan: belum ditetapkan");
  });
});
