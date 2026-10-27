import { afterEach, describe, expect, it, vi } from "vitest";

import { listPayrollLoans, policyLabel, searchPayrollEmployments } from "@/lib/payrollReference";

function stubFetch(body: unknown) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return urls;
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
    const urls = stubFetch({ loans: [], total: 0, page: 2, pageSize: 50 });
    await listPayrollLoans({ page: 2, pageSize: 50 });
    expect(urls).toEqual(["/api/payroll/loans?page=2&pageSize=50"]);
  });

  it("defaults the register to the standard page size", async () => {
    const urls = stubFetch({ loans: [], total: 0, page: 1, pageSize: 25 });
    await listPayrollLoans();
    expect(urls).toEqual(["/api/payroll/loans?page=1&pageSize=25"]);
  });

  it("searches employments rather than listing everyone", async () => {
    const urls = stubFetch({ employments: [], total: 0, page: 1, pageSize: 10 });
    await searchPayrollEmployments({ q: "Siti Aminah", pageSize: 10 });
    expect(urls).toEqual(["/api/payroll/employments?q=Siti+Aminah&page=1&pageSize=10"]);
  });
});
