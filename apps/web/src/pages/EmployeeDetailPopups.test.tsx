// SQ Core app-shell rule "Detail views open as a pop-up" (owner decision 2026-11-13), employee
// area: the list keeps the full width, the detail opens as a dialog only when its URL parameter is
// set, and the parameter names that notification links already use still open the item.
// Static render of the first paint (effects do not run); synthetic data only.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProposeAlternativeDates } from "@/components/leave/ProposeAlternativeDates";
import { MeetingDetailPanel } from "@/components/meetings/MeetingDetailPanel";
import { EmployeeAnnouncementsPage } from "@/pages/EmployeeAnnouncementsPage";
import { EmployeeCalendarPage } from "@/pages/EmployeeCalendarPage";
import { EmployeeCommitteesPage } from "@/pages/EmployeeCommitteesPage";
import { EmployeeLoansPage } from "@/pages/EmployeeLoansPage";
import { EmployeePerformancePage } from "@/pages/EmployeePerformancePage";
import { EmployeeReimbursementsPage } from "@/pages/EmployeeReimbursementsPage";
import { EmployeeTrainingPage } from "@/pages/EmployeeTrainingPage";
import { EmployeeTripsPage } from "@/pages/EmployeeTripsPage";
import { EmployeeWorkArrangementsPage } from "@/pages/EmployeeWorkArrangementsPage";
import type { MeetingDetail } from "@/lib/meetings";

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

const DIALOG = 'role="dialog" aria-modal="true"';

// Each list-and-detail screen: its page, the notification parameter, the dialog title, the
// list heading, and the side column it used to have.
const listScreens = [
  { name: "Pinjaman", page: <EmployeeLoansPage />, path: "/app/loans", param: "loan", title: "Detail pinjaman", list: "Pinjaman saya", oldColumn: "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]" },
  { name: "Reimbursement", page: <EmployeeReimbursementsPage />, path: "/app/reimbursements", param: "claim", title: "Detail klaim", list: "Klaim saya", oldColumn: "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]" },
  { name: "Perjalanan Dinas", page: <EmployeeTripsPage />, path: "/app/trips", param: "trip", title: "Detail perjalanan dinas", list: "Perjalanan saya", oldColumn: "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" },
  { name: "Pelatihan", page: <EmployeeTrainingPage />, path: "/app/training", param: "program", title: "Program pelatihan", list: "Program yang saya ikuti", oldColumn: "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" },
  { name: "Tugas Luar & WFH", page: <EmployeeWorkArrangementsPage />, path: "/app/attendance/arrangements", param: "arrangement", title: "Detail pengajuan", list: "Pengajuan saya", oldColumn: "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" },
  { name: "Penilaian Kinerja", page: <EmployeePerformancePage />, path: "/app/performance", param: "review", title: "Detail penilaian kinerja", list: "Penilaian saya", oldColumn: "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]" },
  { name: "Kepanitiaan Saya", page: <EmployeeCommitteesPage />, path: "/app/committees", param: "committee", title: "Detail kepanitiaan", list: "Berjalan", oldColumn: "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]" },
  { name: "Kalender & Rapat", page: <EmployeeCalendarPage />, path: "/app/calendar", param: "meeting", title: "Rapat", list: "Buat rapat", oldColumn: "lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" },
];

describe("employee list screens show the detail as a pop-up", () => {
  it.each(listScreens)("$name: the list is full width and no dialog shows without the parameter", ({ page, path, list, oldColumn }) => {
    const html = renderAt(path, page);
    expect(html).toContain(list);
    expect(html).not.toContain(oldColumn);
    expect(html).not.toContain(DIALOG);
    expect(html).not.toMatch(/>Pilih (pinjaman|klaim|perjalanan|program|pengajuan|penilaian|kepanitiaan) untuk/);
  });

  it.each(listScreens)("$name: ?$param=<id> from a notification opens the dialog", ({ page, path, param, title }) => {
    const html = renderAt(`${path}?${param}=00000000-0000-4000-8000-000000000001`, page);
    expect(html).toContain(DIALOG);
    expect(html).toContain(`aria-label="${title}"`);
    const dialog = html.slice(html.indexOf(DIALOG));
    expect(dialog).toContain('aria-label="Tutup"');
    // The item is fetched once the page is mounted; until then the dialog says it is loading.
    expect(dialog).toMatch(/Memuat\.\.\.|Membuka\.\.\./);
  });

  it("keeps the team tab of a rater's review link", () => {
    const html = renderAt("/app/performance?tab=team&review=00000000-0000-4000-8000-000000000001", <EmployeePerformancePage />);
    expect(html).toContain('aria-selected="true" class="min-h-11 rounded-xl px-4 text-sm font-bold bg-brand-primary text-brand-foreground">Tim yang saya nilai');
    expect(html).toContain(DIALOG);
  });

  it("keeps the page number next to an open claim", () => {
    const html = renderAt("/app/reimbursements?page=2&claim=00000000-0000-4000-8000-000000000001", <EmployeeReimbursementsPage />);
    expect(html).toContain(DIALOG);
  });
});

describe("inline details and forms open as pop-ups", () => {
  it("opens an announcement from ?pengumuman=<id> instead of expanding its card", () => {
    expect(renderAt("/app/announcements", <EmployeeAnnouncementsPage />)).not.toContain(DIALOG);
    const html = renderAt("/app/announcements?pengumuman=00000000-0000-4000-8000-000000000001", <EmployeeAnnouncementsPage />);
    expect(html).toContain(DIALOG);
    expect(html).toContain('aria-label="Pengumuman"');
  });

  it("opens the alternative-dates form only for the step named in ?usul-tanggal", () => {
    const closed = renderAt("/app/approvals", <ProposeAlternativeDates stepId="step-1" onDone={() => undefined} />);
    expect(closed).toContain("Usulkan tanggal lain");
    expect(closed).not.toContain(DIALOG);

    const other = renderAt("/app/approvals?usul-tanggal=step-2", <ProposeAlternativeDates stepId="step-1" onDone={() => undefined} />);
    expect(other).not.toContain(DIALOG);

    const open = renderAt("/app/approvals?usul-tanggal=step-1", <ProposeAlternativeDates stepId="step-1" onDone={() => undefined} />);
    expect(open).toContain(DIALOG);
    expect(open).toContain('aria-label="Usulkan tanggal lain"');
    expect(open).toContain("Periksa tanggal");
    // The button stays in the card, so the card does not change while the form is open.
    expect(open.indexOf("Usulkan tanggal lain")).toBeLessThan(open.indexOf(DIALOG));
  });

  it("leaves the meeting title and close button to the dialog header", () => {
    const meeting = {
      id: "00000000-0000-4000-8000-000000000002", title: "Rapat sintetis", status: "SCHEDULED", confidential: false,
      startAt: "2026-11-20T02:00:00Z", endAt: "2026-11-20T03:00:00Z", location: "Ruang rapat", organizerName: "Pegawai Sintetis",
      description: null, cancelReason: null, version: 1, me: { role: "ORGANIZER", response: "ACCEPTED" },
      canEdit: true, canCancel: true, canRespond: false, participants: [], events: [],
    } as unknown as MeetingDetail;
    const html = renderToStaticMarkup(
      <MeetingDetailPanel meeting={meeting} busy={false} whatsappActive={false} onRespond={() => undefined} onEdit={() => undefined} onCancel={() => undefined} />,
    );
    expect(html).not.toContain("Tutup detail");
    expect(html).not.toContain("<h2");
    expect(html).toContain("Penyelenggara: Pegawai Sintetis");
  });
});
