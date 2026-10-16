// EMP-005 / EMP-006 S3: read screens render every view state (EMP-PKG1-X2).
// Synthetic data only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ConsistencyReportView,
  EmploymentContractPanel,
  PlacementCareerPanel,
} from "@/components/employment/EmploymentPanels";
import { canAccessAdminPath } from "@/lib/authorization";
import {
  EmploymentApiError,
  formatDate,
  serviceLength,
  viewFromError,
  type EmploymentConsistencyReport,
  type EmploymentSummary,
  type EmploymentTimelineItem,
  type EmploymentView,
} from "@/lib/employment";
import { EmployeeDetailTabs } from "@/pages/AdminEmployeeDetailPage";
import type { AuthSession, PrincipalType } from "@/types/hcis";

const summary: EmploymentSummary = {
  mode: "SHADOW",
  date: "2027-08-15",
  state: "AKTIF",
  flags: ["KONTRAK_SEGERA_BERAKHIR"],
  current: {
    employment: {
      id: "e1", employeeId: "emp-1", staffType: "PENDIDIK", startedOn: "2026-07-01", startBasis: "RECORDED",
      serviceStartOn: "2026-07-01", endedOn: null, endBasis: null, endPrecision: null, endReason: null, version: 2,
    },
    term: { id: "t2", employmentId: "e1", sequence: 2, category: "KONTRAK", effectiveFrom: "2027-07-01", effectiveTo: "2027-09-30", contractReference: "PK-SINTETIS-002" },
    primaryPlacement: {
      id: "p1", employmentId: "e1", kind: "PRIMARY", unitName: "SDIT Sintetis", positionName: "Guru Kelas", jobTitleLabel: "Guru Kelas",
      effectiveFrom: "2026-11-01", effectiveTo: null, effectiveFromBasis: "BASELINE_ASSUMED",
    },
    additionalPlacements: [{
      id: "p2", employmentId: "e1", kind: "ADDITIONAL", unitName: "SDIT Sintetis", positionName: null, jobTitleLabel: "Koordinator Tahfidz",
      effectiveFrom: "2027-01-01", effectiveTo: null, effectiveFromBasis: "RECORDED",
    }],
  },
  employments: [],
};
summary.employments = [{
  ...summary.current.employment!,
  terms: [summary.current.term!, { id: "t1", employmentId: "e1", sequence: 1, category: "KONTRAK", effectiveFrom: "2026-07-01", effectiveTo: "2027-06-30", contractReference: null }],
  placements: [summary.current.primaryPlacement!, summary.current.additionalPlacements[0]!],
}];

const timeline: EmploymentTimelineItem[] = [
  {
    id: "a2", actionType: "PROMOTION", effectiveOn: "2027-09-01", state: "RECORDED", reversedByActionId: null, reasonCode: null,
    previousSnapshot: { placement: { jobTitleLabel: "Guru Kelas" } }, newSnapshot: { placement: { jobTitleLabel: "Wakasek Kurikulum" } },
    recordedAt: "2027-08-10T00:00:00Z", documents: [{ id: "d1", kind: "SURAT_KEPUTUSAN", number: "012/SK/SINTETIS/2027", type: "SK_PROMOSI" }],
  },
  {
    id: "a1", actionType: "BASELINE", effectiveOn: null, state: "RECORDED", reversedByActionId: null, reasonCode: null,
    previousSnapshot: {}, newSnapshot: { category: "KONTRAK", placement: { jobTitleLabel: "Guru Kelas" } },
    recordedAt: "2026-11-01T00:00:00Z", documents: [],
  },
];

const ready = <T,>(data: T): EmploymentView<T> => ({ kind: "ready", data });

describe("Kepegawaian & Kontrak tab (spec §13.1)", () => {
  it("shows status, contract sequence and period, TMT, masa kerja, flags, and contract history", () => {
    const html = renderToStaticMarkup(<EmploymentContractPanel view={ready(summary)} />);
    expect(html).toContain("Aktif");
    expect(html).toContain("Pegawai Kontrak (ke-2)");
    expect(html).toContain("1 Jul 2027 – 30 Sep 2027");
    expect(html).toContain("1 Jul 2026");
    expect(html).toContain("1 tahun 1 bulan");
    expect(html).toContain("Kontrak segera berakhir");
    expect(html).toContain("PK-SINTETIS-002");
    expect(html).toContain("No. perjanjian belum dicatat");
    expect(html).toContain("Mode tinjauan");
  });

  it.each<[string, EmploymentView<EmploymentSummary>, string]>([
    ["loading", { kind: "loading" }, "Memuat data kepegawaian"],
    ["disabled (mode OFF)", { kind: "disabled" }, "Riwayat kepegawaian belum diaktifkan"],
    ["forbidden", { kind: "forbidden" }, "tidak memiliki izin melihat riwayat kepegawaian"],
    ["error", { kind: "error", message: "Server sedang sibuk." }, "Server sedang sibuk."],
    ["empty (no history)", ready({ ...summary, state: "TANPA_DATA", flags: [], employments: [], current: { employment: null, term: null, primaryPlacement: null, additionalPlacements: [] } }), "Belum ada data kepegawaian"],
  ])("renders the %s state", (_name, view, text) => {
    expect(renderToStaticMarkup(<EmploymentContractPanel view={view} />)).toContain(text);
  });

  it("shows an ended employment with month precision and reason", () => {
    const ended: EmploymentSummary = {
      ...summary,
      state: "BERAKHIR",
      flags: [],
      current: { employment: null, term: null, primaryPlacement: null, additionalPlacements: [] },
      employments: [{ ...summary.employments[0]!, endedOn: "2024-06-30", endBasis: "RECORDED", endPrecision: "MONTH", endReason: "RESIGN" }],
    };
    const html = renderToStaticMarkup(<EmploymentContractPanel view={ready(ended)} />);
    expect(html).toContain("Berakhir");
    expect(html).toContain("30 Jun 2024 (bulan) · Resign");
  });
});

describe("Penempatan & Karier tab (spec §13.2)", () => {
  it("shows the current placement 'sejak data awal', additional tasks, and the career timeline with SK", () => {
    const html = renderToStaticMarkup(<PlacementCareerPanel view={ready(summary)} timeline={ready(timeline)} />);
    expect(html).toContain("SDIT Sintetis");
    expect(html).toContain("sejak data awal");
    expect(html).toContain("Koordinator Tahfidz");
    expect(html).toContain("Promosi · 1 Sep 2027");
    expect(html).toContain("Guru Kelas → Wakasek Kurikulum");
    expect(html).toContain("SK No. 012/SK/SINTETIS/2027");
    expect(html).toContain("Terjadwal");
    expect(html).toContain("Riwayat sebelum data awal tidak tercatat");
  });

  it("strikes through a reversed action", () => {
    const html = renderToStaticMarkup(
      <PlacementCareerPanel view={ready(summary)} timeline={ready([{ ...timeline[0]!, state: "REVERSED", reversedByActionId: "a3" }])} />,
    );
    expect(html).toContain("line-through");
    expect(html).toContain("Dibatalkan");
  });

  it("renders timeline loading/error and an empty timeline independently of the summary", () => {
    expect(renderToStaticMarkup(<PlacementCareerPanel view={ready(summary)} timeline={{ kind: "loading" }} />)).toContain("Memuat riwayat jabatan");
    expect(renderToStaticMarkup(<PlacementCareerPanel view={ready(summary)} timeline={ready([])} />)).toContain("Belum ada tindakan kepegawaian yang tercatat");
    expect(renderToStaticMarkup(<PlacementCareerPanel view={{ kind: "disabled" }} timeline={{ kind: "disabled" }} />)).toContain("belum diaktifkan");
  });
});

describe("Periksa kecocokan data (spec §13.6)", () => {
  const report: EmploymentConsistencyReport = {
    mode: "SHADOW",
    date: "2026-11-01",
    employeeCount: 3,
    groups: [{ code: "BASELINE_EXCLUDED_BUMY", count: 1 }, { code: "HISTORY_DIFFERS_FROM_MASTER", count: 1 }],
    total: 2,
    page: 1,
    pageSize: 50,
    rows: [
      { employeeId: "emp-1", employeeNumber: "SYN-0001", fullName: "Pegawai Sintetis", codes: ["HISTORY_DIFFERS_FROM_MASTER"], differingFields: ["organizationalUnitId"] },
      { employeeId: "emp-2", employeeNumber: "SYN-0002", fullName: "Staf BUMY Sintetis", codes: ["BASELINE_EXCLUDED_BUMY"], differingFields: [] },
    ],
  };
  const render = (view: EmploymentView<EmploymentConsistencyReport>, selected: string | null = null) =>
    renderToStaticMarkup(
      <ConsistencyReportView view={view} selectedCode={selected} codeHref={(code) => `?code=${code ?? ""}`} employeeHref={(id) => `/admin/employees/${id}`} />,
    );

  it("groups issues with counts and links each employee", () => {
    const html = render(ready(report), "HISTORY_DIFFERS_FROM_MASTER");
    expect(html).toContain("Staf BUMY (tidak dikelola) · 1");
    expect(html).toContain("Berbeda dengan master pegawai · 1");
    expect(html).toContain('href="/admin/employees/emp-1"');
    expect(html).toContain("Berbeda: Unit");
    expect(html).toContain('aria-current="true"');
  });

  it("renders no-issue, disabled, and forbidden states", () => {
    expect(render(ready({ ...report, groups: [], rows: [], total: 0 }))).toContain("Tidak ada masalah ditemukan");
    expect(render({ kind: "disabled" })).toContain("belum diaktifkan");
    expect(render({ kind: "forbidden" })).toContain("tidak memiliki izin");
  });
});

function session(principalType: PrincipalType, permissions: string[]): AuthSession {
  return { principal: { id: "actor", email: "actor@example.invalid", principalType }, expiresAt: "2099-01-01T00:00:00Z", authorization: { organizationPermissions: permissions } };
}

describe("UI eligibility mirrors the API (the API still authorizes)", () => {
  it("opens the consistency page only with employment.read, never via Super Admin compatibility", () => {
    expect(canAccessAdminPath(session("EMPLOYEE", ["employees.manage", "employment.read"]), "/admin/employment/consistency")).toBe(true);
    expect(canAccessAdminPath(session("SUPER_ADMIN", ["employees.manage", "employees.read.all", "access.governance.manage"]), "/admin/employment/consistency")).toBe(false);
    expect(canAccessAdminPath(session("EMPLOYEE", ["employees.manage"]), "/admin/employment/consistency")).toBe(false);
    expect(canAccessAdminPath(session("FOUNDATION_BOARD", ["employment.read"]), "/admin/employment/consistency")).toBe(false);
  });

  it("shows the employment tabs only to employment.read holders", () => {
    const shown = renderToStaticMarkup(<EmployeeDetailTabs active="ringkasan" canReadEmployment onSelect={() => undefined} />);
    expect(shown).toContain("Kepegawaian &amp; Kontrak");
    expect(shown).toContain("Penempatan &amp; Karier");
    expect(shown).toContain('aria-selected="true"');
    expect(renderToStaticMarkup(<EmployeeDetailTabs active="ringkasan" canReadEmployment={false} onSelect={() => undefined} />)).toBe("");
  });
});

describe("helpers", () => {
  it("maps API errors to view states", () => {
    expect(viewFromError(new EmploymentApiError(409, "EMPLOYMENT_HISTORY_DISABLED", "x"))).toEqual({ kind: "disabled" });
    expect(viewFromError(new EmploymentApiError(403, "EMPLOYMENT_FORBIDDEN", "x"))).toEqual({ kind: "forbidden" });
    expect(viewFromError(new EmploymentApiError(404, "EMPLOYEE_NOT_FOUND", "Pegawai tidak ditemukan."))).toEqual({ kind: "error", message: "Pegawai tidak ditemukan." });
    expect(viewFromError(new TypeError("network"))).toMatchObject({ kind: "error" });
  });

  it("formats calendar dates without time-zone shifts and computes masa kerja", () => {
    expect(formatDate("2027-01-01")).toBe("1 Jan 2027");
    expect(formatDate(null, "Belum diketahui")).toBe("Belum diketahui");
    expect(serviceLength("2026-07-01", "2027-08-15")).toBe("1 tahun 1 bulan");
    expect(serviceLength("2027-08-01", "2027-08-15")).toBe("kurang dari 1 bulan");
    expect(serviceLength("2028-01-01", "2027-08-15")).toBeNull();
    expect(serviceLength(null, "2027-08-15")).toBeNull();
  });
});
