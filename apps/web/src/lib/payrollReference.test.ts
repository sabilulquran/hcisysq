import { afterEach, describe, expect, it, vi } from "vitest";

import { listPayrollLoans, policyLabel, searchPayrollEmployments } from "@/lib/payrollReference";

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PAY-003 reference data vocabulary", () => {
  it("names a policy key the way an operator reads it", () => {
    expect(policyLabel("BPJS_KESEHATAN")).toBe("BPJS Kesehatan");
    expect(policyLabel("EARLY_SERVICE")).toBe("Masa kerja awal");
  });

  it("shows a key it does not know rather than hiding it", () => {
    expect(policyLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("PAY-003 reference data requests", () => {
  it("asks for one page of the loan register, never the whole register", async () => {
    const fetchMock = stubFetch({ loans: [], total: 0, page: 2, pageSize: 50 });
    await listPayrollLoans({ page: 2, pageSize: 50 });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/payroll/loans?page=2&pageSize=50");
  });

  it("defaults the register to the standard page size", async () => {
    const fetchMock = stubFetch({ loans: [], total: 0, page: 1, pageSize: 25 });
    await listPayrollLoans();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/payroll/loans?page=1&pageSize=25");
  });

  it("searches employments rather than listing everyone", async () => {
    const fetchMock = stubFetch({ employments: [], total: 0, page: 1, pageSize: 10 });
    await searchPayrollEmployments({ q: "Siti Aminah", pageSize: 10 });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/payroll/employments?q=Siti+Aminah&page=1&pageSize=10");
  });
});
