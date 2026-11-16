// SQ Core app-shell rule "Detail views open as a pop-up" (owner decision 2026-11-13): the admin
// registers (Pinjaman, Reimbursement, Perjalanan Dinas, Tugas Luar/WFH/Ubah Jadwal, Perbaikan Absen,
// Kartu Pegawai, Penilaian Kinerja, Pusat Bantuan, Perjanjian Kerja & SK) keep their list full
// width, and one item opens on top of it only when its URL parameter is set. Static render;
// synthetic data only.

import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The admin shell waits for the session before it shows a page; render the page body directly.
vi.mock("@/layouts/AdminShell", () => ({
  AdminShell: ({ title, children }: { title: string; children: ReactNode }) => <main><h1>{title}</h1>{children}</main>,
}));

import { DecisionDocumentRegister } from "@/components/employment/DecisionDocumentRegister";
import { AdminAttendanceCorrectionsPage } from "@/pages/AdminAttendanceCorrectionsPage";
import { AdminEmployeeCardsPage } from "@/pages/AdminEmployeeCardsPage";
import { AdminHelpPage } from "@/pages/AdminHelpPage";
import { AdminLoansPage } from "@/pages/AdminLoansPage";
import { AdminPerformancePage } from "@/pages/AdminPerformancePage";
import { AdminReimbursementsPage } from "@/pages/AdminReimbursementsPage";
import { AdminTripsPage } from "@/pages/AdminTripsPage";
import { AdminWorkArrangementsPage } from "@/pages/AdminWorkArrangementsPage";

function renderAt(search: string, page: ReactElement) {
  vi.stubGlobal("window", { location: { search, pathname: "/admin", href: `http://localhost/admin${search}` } });
  return renderToStaticMarkup(page);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const registers: Array<{ name: string; page: () => ReactElement; param: string; title: string; placeholder: string; list: string }> = [
  { name: "Pinjaman Pegawai", page: () => <AdminLoansPage />, param: "pinjaman", title: "Detail pinjaman", placeholder: "Pilih pinjaman untuk", list: "Memuat register" },
  { name: "Reimbursement", page: () => <AdminReimbursementsPage />, param: "klaim", title: "Detail klaim", placeholder: "Pilih klaim untuk", list: "Memuat register" },
  { name: "Perjalanan Dinas", page: () => <AdminTripsPage />, param: "perjalanan", title: "Detail perjalanan dinas", placeholder: "Pilih perjalanan untuk", list: "Memuat register" },
  { name: "Tugas Luar, WFH & Ubah Jadwal", page: () => <AdminWorkArrangementsPage />, param: "pengajuan", title: "Detail pengajuan", placeholder: "Pilih pengajuan untuk", list: "Memuat register" },
  { name: "Kartu Pegawai", page: () => <AdminEmployeeCardsPage />, param: "pegawai", title: "Kartu pegawai", placeholder: "Pilih pegawai untuk", list: "Cari nama atau NIP" },
];

describe.each(registers)("$name register", ({ page, param, title, placeholder, list }) => {
  it("shows the list full width, without a detail column, when nothing is open", () => {
    const html = renderAt("", page());
    expect(html).toContain(list);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain(placeholder);
    expect(html).not.toMatch(/xl:grid-cols-\[minmax\(0,1(\.2)?fr\)_minmax\(0,1(\.2)?fr\)\]/);
  });

  it(`opens the item in a pop-up for ?${param}=<id>`, () => {
    const html = renderAt(`?${param}=item-1`, page());
    expect(html).toMatch(new RegExp(`role="dialog"[^>]*aria-modal="true"[^>]*aria-label="${title}"`));
    expect(html).toContain('aria-label="Tutup"');
    expect(html).not.toContain(placeholder);
  });
});

describe("Perbaikan Absen", () => {
  it("has no permanent detail column and no placeholder", () => {
    const html = renderAt("", <AdminAttendanceCorrectionsPage />);
    expect(html).toContain("Tanggal kerja");
    expect(html).not.toContain("lg:grid-cols-[minmax(0,1fr)_380px]");
    expect(html).not.toContain("Pilih baris untuk");
    expect(html).not.toContain('role="dialog"');
  });

  it("waits for the list before opening ?perbaikan=<id>, so an unknown id never flashes a dialog", () => {
    expect(renderAt("?perbaikan=item-1", <AdminAttendanceCorrectionsPage />)).not.toContain('role="dialog"');
  });
});

describe("Penilaian Kinerja", () => {
  it("keeps the cycle workspace on the page and opens nothing without a parameter", () => {
    const html = renderAt("", <AdminPerformancePage />);
    expect(html).toContain("Pilih siklus untuk melihat rekap dan penilaiannya.");
    expect(html).not.toContain('role="dialog"');
  });

  it("does not show the new-cycle form before the account's permission is known", () => {
    expect(renderAt("?siklus=baru", <AdminPerformancePage />)).not.toContain('role="dialog"');
  });
});

describe("Inline forms that used to push the page", () => {
  it("Pusat Bantuan opens the article editor as a wide pop-up only for ?artikel=", () => {
    expect(renderAt("", <AdminHelpPage />)).not.toContain('role="dialog"');
    const html = renderAt("?artikel=baru", <AdminHelpPage />);
    expect(html).toMatch(/role="dialog"[^>]*aria-label="Artikel baru"/);
    expect(html).toContain("md:max-w-[960px]");
  });

  it("Perjanjian Kerja & SK opens a document as a pop-up only for ?dokumen=", () => {
    const register = <DecisionDocumentRegister kind="SURAT_KEPUTUSAN" onKindChange={() => undefined} canManage canCorrect employeeHref={(id) => `/admin/employees/${id}`} />;
    expect(renderAt("?kind=SURAT_KEPUTUSAN", register)).not.toContain('role="dialog"');
    expect(renderAt("?kind=SURAT_KEPUTUSAN&dokumen=doc-1", register)).toMatch(/role="dialog"[^>]*aria-label="Detail dokumen"/);
  });
});
