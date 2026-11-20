// UX-FLOW-001 "satu langkah per layar" for the employee loan, trip and work-arrangement requests:
// the first screen holds only its own step (no approver preview or submit button under the
// inputs), and the type chooser of Tugas Luar & WFH is a step of its own.
// Static render of the first paint (effects do not run); synthetic data only.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmployeeLoansPage } from "@/pages/EmployeeLoansPage";
import { EmployeeTripsPage } from "@/pages/EmployeeTripsPage";
import { EmployeeWorkArrangementsPage } from "@/pages/EmployeeWorkArrangementsPage";

// This static render has no router, so the step hook reads ?langkah= from the stubbed location.
vi.mock("@/lib/useWizardStep", () => ({
  useWizardStep: (steps: readonly string[]) => {
    const raw = new URLSearchParams(window.location.search).get("langkah");
    const step = raw && steps.includes(raw) ? raw : steps[0];
    return { step, index: steps.indexOf(step as string), goTo: () => undefined };
  },
}));

function renderAt(path: string, element: ReactElement) {
  const url = new URL(path, "https://hcis.example.test");
  vi.stubGlobal("window", {
    location: { href: url.href, pathname: url.pathname, search: url.search },
    history: { state: null },
  });
  return renderToStaticMarkup(element);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const STEPS = 'aria-label="Langkah pengajuan"';

describe("employee request wizards show one step per screen", () => {
  it("Pinjaman: the form step has the next button but no submit, review, or approvers", () => {
    const html = renderAt("/app/loans", <EmployeeLoansPage />);
    expect(html).toContain(STEPS);
    expect(html).toContain("Pokok pinjaman (Rp)");
    expect(html).toContain("Lihat cicilan dan penyetuju");
    expect(html).toContain("Pinjaman saya");
    expect(html).not.toContain("Kirim pengajuan");
    expect(html).not.toContain("Ringkasan sebelum dikirim");
  });

  it("Perjalanan Dinas: the form step has the next button but no submit or review", () => {
    const html = renderAt("/app/trips", <EmployeeTripsPage />);
    expect(html).toContain(STEPS);
    expect(html).toContain("Periksa penyetuju");
    expect(html).toContain("Perjalanan saya");
    expect(html).not.toContain("Kirim pengajuan");
    expect(html).not.toContain("Ringkasan sebelum dikirim");
  });

  it("Tugas Luar & WFH: the type chooser is its own step, without the fields", () => {
    const html = renderAt("/app/attendance/arrangements", <EmployeeWorkArrangementsPage />);
    expect(html).toContain(STEPS);
    expect(html).toContain("Pilih jenis pengajuan");
    expect(html).toContain("Pengajuan saya");
    expect(html).not.toContain("Keperluan");
    expect(html).not.toContain("Periksa penyetuju");
    expect(html).not.toContain("Kirim pengajuan");
  });

  it.each([
    ["/app/loans?langkah=periksa", <EmployeeLoansPage key="loans" />, "Pinjaman saya"],
    ["/app/trips?langkah=periksa", <EmployeeTripsPage key="trips" />, "Perjalanan saya"],
    ["/app/attendance/arrangements?langkah=periksa", <EmployeeWorkArrangementsPage key="arr" />, "Pengajuan saya"],
  ])("%s without checked data shows no review and no list", (path, page, list) => {
    const html = renderAt(path, page);
    expect(html).not.toContain("Ringkasan sebelum dikirim");
    expect(html).not.toContain("Kirim pengajuan");
    expect(html).not.toContain(list);
  });
});
