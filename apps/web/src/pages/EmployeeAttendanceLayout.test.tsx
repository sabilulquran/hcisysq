// The attendance screen used to stack everything at once: a five-button service row above the
// heading, a second Clock In/Out button, then Ringkasan, the overtime form, 14 days of schedule,
// the clarification list and a 30-day history whose desktop table forced 900 px. This locks the
// shape that replaced it. Synthetic data only.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AttendancePanel, AttendanceTabList, hashForTab, tabForHash } from "@/components/attendance/AttendanceTabs";
import { EmployeeAttendanceNavigation } from "@/components/attendance/EmployeeAttendanceNavigation";
import { HISTORY_PAGE_SIZE } from "@/pages/EmployeeAttendancePage";
import { paginationView } from "@/components/PaginationBar";

describe("bagian kehadiran: tab dari alamat", () => {
  it("membuka Pengajuan dari tautan layanan yang sudah diterbitkan", () => {
    // ATT-011 published these two; a direct link and Back must keep landing on Pengajuan.
    expect(tabForHash("#overtime")).toBe("pengajuan");
    expect(tabForHash("#clarifications")).toBe("pengajuan");
    expect(tabForHash("#pengajuan")).toBe("pengajuan");
  });

  it("membuka Jadwal dari #jadwal dan Riwayat untuk sisanya", () => {
    expect(tabForHash("#jadwal")).toBe("jadwal");
    expect(tabForHash("")).toBe("riwayat");
    expect(tabForHash("#entah")).toBe("riwayat");
  });

  it("menulis kembali alamat yang sama untuk tiap tab", () => {
    expect(hashForTab("riwayat")).toBe("");
    expect(hashForTab("jadwal")).toBe("#jadwal");
    expect(hashForTab("pengajuan")).toBe("#pengajuan");
  });

  it("memberi tablist yang bisa dijangkau keyboard", () => {
    const html = renderToStaticMarkup(<AttendanceTabList tab="riwayat" onSelect={() => undefined} />);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    // Roving tabindex: the selected tab is the one Tab reaches, the arrows move between them.
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-controls="panel-riwayat"');
    expect(html).toContain("focus-visible:ring-2");
    for (const label of ["Riwayat", "Jadwal", "Pengajuan"]) expect(html).toContain(`>${label}<`);
  });

  it("hanya menampilkan panel yang dipilih, dengan nama yang terbaca pembaca layar", () => {
    expect(renderToStaticMarkup(<AttendancePanel tab="riwayat" value="jadwal"><p>x</p></AttendancePanel>)).toBe("");
    const open = renderToStaticMarkup(<AttendancePanel tab="jadwal" value="jadwal"><p>isi</p></AttendancePanel>);
    expect(open).toContain('role="tabpanel"');
    expect(open).toContain('aria-labelledby="tab-jadwal"');
    expect(open).toContain("isi");
  });
});

describe("riwayat 30 hari: daftar ringkas berhalaman", () => {
  it("memakai halaman seminggu, bukan 30 baris sekaligus", () => {
    expect(HISTORY_PAGE_SIZE).toBe(7);
    const view = paginationView(1, HISTORY_PAGE_SIZE, 30);
    expect(view.totalPages).toBe(5);
    expect([view.start, view.end]).toEqual([1, 7]);
    const last = paginationView(5, HISTORY_PAGE_SIZE, 30);
    expect([last.start, last.end]).toEqual([29, 30]);
    expect(last.atLast).toBe(true);
  });
});

describe("navigasi layanan kehadiran", () => {
  it("tetap menawarkan kelima tujuan dari layar kehadiran lain", () => {
    const html = renderToStaticMarkup(<EmployeeAttendanceNavigation currentPath="/app/attendance/clock" />);
    expect(html).toContain('href="/app/attendance/shift-swap"');
    expect(html).toContain('href="/app/attendance#overtime"');
    expect(html).toContain('href="/app/attendance#clarifications"');
    expect(html).not.toContain("overflow-x-auto");
  });
});
