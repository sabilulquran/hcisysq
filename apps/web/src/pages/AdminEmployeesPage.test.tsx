// EMP-005 S2B-b §13.9: the admin list's own "Di luar pengelolaan HCIS" filter,
// the grey badge, and the read-only detail. Static render; synthetic data.

import type { ChangeEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listEmployees, outsideHcisBadgeLabel, type AdminEmployeeListItem, type EmployeeManagementScopeFilter } from "@/lib/adminEmployees";
import { ISSUE_LABEL } from "@/lib/employment";
import { OutsideHcisReadOnlyMaster } from "@/pages/AdminEmployeeDetailPage";
import {
  EmployeeListEmpty,
  EmployeeListRow,
  INITIAL_EMPLOYEE_LIST_FILTERS,
  ManagementScopeFilter,
  employeeListRequest,
  withFilter,
  type EmployeeListFilters,
} from "@/pages/AdminEmployeesPage";

function item(overrides: Partial<AdminEmployeeListItem> = {}): AdminEmployeeListItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    employeeNumber: "SYN-001",
    fullName: "Pegawai Sintetis",
    status: "active",
    employmentStatus: "Tetap",
    unitId: null,
    unitName: "Unit Sintetis",
    positionId: null,
    positionName: null,
    employmentType: null,
    functionalPosition: null,
    structuralPosition: null,
    email: null,
    phone: null,
    education: null,
    startedOn: "2020-01-06",
    endedOn: null,
    updatedAt: "2026-11-01T00:00:00Z",
    managementScope: "MANAGED",
    managementScopeReason: null,
    ...overrides,
  };
}

const row = (employee: AdminEmployeeListItem) =>
  renderToStaticMarkup(<table><tbody><EmployeeListRow employee={employee} /></tbody></table>);

describe("EMP-005 S2B §13.9 Daftar pegawai — Di luar pengelolaan HCIS", () => {
  it("offers the filter, with the managed population as the default", () => {
    const html = renderToStaticMarkup(<ManagementScopeFilter value="MANAGED" onChange={() => undefined} />);
    expect(html).toContain('aria-label="Cakupan pengelolaan"');
    expect(html).toContain('<option value="MANAGED" selected="">Dikelola HCIS</option>');
    expect(html).toContain('<option value="OUTSIDE_HCIS">Di luar pengelolaan HCIS</option>');
    expect(html).toContain('<option value="ALL">Semua data</option>');

    const outside = renderToStaticMarkup(<ManagementScopeFilter value="OUTSIDE_HCIS" onChange={() => undefined} />);
    expect(outside).toContain('<option value="OUTSIDE_HCIS" selected="">Di luar pengelolaan HCIS</option>');
  });

  it("names the reason on the grey badge", () => {
    expect(outsideHcisBadgeLabel({ managementScope: "OUTSIDE_HCIS", managementScopeReason: "BUMY" }))
      .toBe("Di luar pengelolaan HCIS — BUMY");
    expect(outsideHcisBadgeLabel({ managementScope: "OUTSIDE_HCIS", managementScopeReason: "PENGURUS_YAYASAN" }))
      .toBe("Di luar pengelolaan HCIS — Pengurus Yayasan");
    expect(outsideHcisBadgeLabel({ managementScope: "OUTSIDE_HCIS", managementScopeReason: null }))
      .toBe("Di luar pengelolaan HCIS");
    expect(outsideHcisBadgeLabel({ managementScope: "MANAGED", managementScopeReason: null })).toBeNull();
    // An older API without the field reads as managed, never as marked.
    expect(outsideHcisBadgeLabel({})).toBeNull();
  });

  it("shows the badge on a marked row only, next to the status", () => {
    const marked = row(item({ managementScope: "OUTSIDE_HCIS", managementScopeReason: "BUMY" }));
    expect(marked).toContain("Di luar pengelolaan HCIS — BUMY");
    expect(marked).toContain("bg-muted");
    expect(marked).toContain(">Aktif<");
    expect(marked).toContain('href="/admin/employees/00000000-0000-4000-8000-000000000001"');

    const managed = row(item());
    expect(managed).not.toContain("Di luar pengelolaan HCIS");
    expect(managed).toContain(">Aktif<");
  });

  it("keeps the default empty state and explains an empty outside filter", () => {
    const managed = renderToStaticMarkup(<EmployeeListEmpty scope="MANAGED" />);
    expect(managed).toContain("Belum ada pegawai yang cocok.");
    expect(managed).toContain("Impor Pegawai");

    const outside = renderToStaticMarkup(<EmployeeListEmpty scope="OUTSIDE_HCIS" />);
    expect(outside).toContain("Tidak ada data di luar pengelolaan HCIS yang cocok.");
    expect(outside).not.toContain("Impor Pegawai");
  });

  it("shows a marked record's contact and line manager as text, with no edit control", () => {
    const html = renderToStaticMarkup(
      <OutsideHcisReadOnlyMaster
        employee={{
          email: "pengurus@example.invalid",
          phone: null,
          managerFullName: "Atasan Sintetis",
          managerEmployeeNumber: "SYN-009",
          managementScope: "OUTSIDE_HCIS",
          managementScopeReason: "PENGURUS_YAYASAN",
        }}
      />,
    );
    expect(html).toContain("Di luar pengelolaan HCIS — Pengurus Yayasan");
    expect(html).toContain("pengurus@example.invalid");
    expect(html).toContain("Atasan Sintetis · SYN-009");
    expect(html).toContain("hanya dapat dibaca");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<select");
  });

  it("labels the consistency-report line for accounts still linked to a marked record", () => {
    expect(ISSUE_LABEL.ACCOUNT_LINKED_TO_OUTSIDE_HCIS_RECORD)
      .toBe("Akun pegawai masih terhubung ke data di luar pengelolaan HCIS");
  });
});

describe("EMP-005 S2B §13.9 the filter reaches the API", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("choosing Di luar pengelolaan HCIS calls listEmployees with scope=OUTSIDE_HCIS from page 1", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    // The page keeps all filters in one value; start on page 3 of the managed list.
    let filters: EmployeeListFilters = { ...INITIAL_EMPLOYEE_LIST_FILTERS, page: 3 };
    const control = ManagementScopeFilter({
      value: filters.scope,
      onChange: (next) => { filters = withFilter(filters, "scope", next); },
    }) as ReactElement<{ onChange: (event: ChangeEvent<HTMLSelectElement>) => void }>;
    control.props.onChange({ target: { value: "OUTSIDE_HCIS" } } as ChangeEvent<HTMLSelectElement>);

    expect(filters).toMatchObject({ scope: "OUTSIDE_HCIS", page: 1 });
    await listEmployees(employeeListRequest(filters));
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/api/admin/employees?");
    expect(new URL(url, "http://localhost").searchParams.get("scope")).toBe("OUTSIDE_HCIS");
    expect(new URL(url, "http://localhost").searchParams.get("page")).toBe("1");
  });

  it("asks for the managed population by default, and every filter change goes back to page 1", () => {
    expect(employeeListRequest(INITIAL_EMPLOYEE_LIST_FILTERS)).toMatchObject({ scope: "MANAGED", page: 1, pageSize: 25 });
    const onPage2 = { ...INITIAL_EMPLOYEE_LIST_FILTERS, page: 2 };
    for (const scope of ["MANAGED", "OUTSIDE_HCIS", "ALL"] as EmployeeManagementScopeFilter[]) {
      expect(employeeListRequest(withFilter(onPage2, "scope", scope))).toMatchObject({ scope, page: 1 });
    }
    expect(withFilter(onPage2, "status", "active")).toMatchObject({ status: "active", page: 1, scope: "MANAGED" });
  });
});
