// SQ Core app-shell rule "Detail views open as a pop-up": the Kepanitiaan list stays full width and
// a committee, the create form, or an employee's recap opens on top of it only when its URL
// parameter is set. Static render; synthetic data only.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommitteesTab, ParticipationTab } from "@/pages/AdminCommitteesPage";

function withSearch(search: string) {
  vi.stubGlobal("window", { location: { search } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Kepanitiaan detail as a pop-up", () => {
  it("shows the list full width with no detail column and no dialog when nothing is open", () => {
    withSearch("");
    const html = renderToStaticMarkup(<CommitteesTab canManage />);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Pilih kepanitiaan untuk");
    expect(html).not.toContain("xl:grid-cols");
    expect(html).toContain("Catat kepanitiaan");
  });

  it("opens the create form in a dialog for ?panitia=baru", () => {
    withSearch("?panitia=baru");
    const html = renderToStaticMarkup(<CommitteesTab canManage />);
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Catat kepanitiaan"/);
    expect(html).toContain("Nama kegiatan");
  });

  it("does not open the create form for someone who cannot manage committees", () => {
    withSearch("?panitia=baru");
    expect(renderToStaticMarkup(<CommitteesTab canManage={false} />)).not.toContain('role="dialog"');
  });

  it("opens a committee in a wide dialog for ?panitia=<id> while it loads", () => {
    withSearch("?panitia=committee-1");
    const html = renderToStaticMarkup(<CommitteesTab canManage />);
    expect(html).toMatch(/role="dialog"[^>]*aria-label="Kepanitiaan"/);
    expect(html).toContain("md:max-w-[960px]");
    expect(html).toContain("Memuat...");
  });

  it("opens an employee's recap in a dialog only for ?rekap=<employeeId>", () => {
    withSearch("");
    expect(renderToStaticMarkup(<ParticipationTab />)).not.toContain('role="dialog"');
    withSearch("?rekap=employee-1");
    const html = renderToStaticMarkup(<ParticipationTab />);
    expect(html).toMatch(/role="dialog"[^>]*aria-label="Keikutsertaan kepanitiaan"/);
    expect(html).not.toContain("Pilih pegawai untuk");
  });
});
