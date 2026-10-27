import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ScheduleChangePreview } from "@/lib/scheduleChanges";
import { ImpactPanel } from "@/pages/AdminAttendancePlannerPage";

// ATT-011-5 §5.2 Lihat dampak: Terapkan stays off while a blocking problem remains; each problem with an
// employee offers Kecualikan. Synthetic data only.

const preview = (issues: ScheduleChangePreview["issues"]): ScheduleChangePreview => ({
  fingerprint: "a".repeat(64),
  summary: { employees: 40, from: "2026-11-02", to: null, newEmployees: 31, replacedEmployees: 9, rosterDays: 0, blockingIssues: issues.filter((issue) => issue.blocking).length },
  issues,
  holidays: [{ date: "2026-12-25", label: "Synthetic holiday" }],
  employees: [{ id: "synthetic-1", employeeNumber: "SYN-1", fullName: "Pegawai Sintetis", changes: 2 }],
  employeesTotal: 40,
});
const render = (value: ScheduleChangePreview) =>
  renderToStaticMarkup(<ImpactPanel preview={value} busy={false} onExclude={() => undefined} onBack={() => undefined} onApply={() => undefined} />);

describe("ATT-011-5 Lihat dampak", () => {
  it("summarizes the change and allows Terapkan when nothing blocks", () => {
    const html = render(preview([{ employeeId: "synthetic-2", employeeName: "Budi", code: "ended", date: "2026-11-30", message: "Berhenti 2026-11-30; dikecualikan otomatis setelah tanggal itu.", blocking: false }]));
    expect(html).toContain("40 pegawai");
    expect(html).toContain("tanpa akhir");
    expect(html).toContain("31 pegawai jadwal baru");
    expect(html).toContain("9 pegawai menggantikan jadwal lama");
    expect(html).toContain("1 tanggal libur nasional");
    expect(html).toContain("Budi: Berhenti");
    expect(html).not.toContain("tidak bisa diterapkan");
    expect(html).toMatch(/<button[^>]*>\s*Terapkan<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>\s*Terapkan/);
  });

  it("keeps Terapkan off while a blocking problem remains, and offers Kecualikan", () => {
    const html = render(preview([
      { employeeId: "synthetic-3", employeeName: "Citra", code: "shift_swap", date: "2026-11-15", message: "Sedang mengajukan Tukar Shift 2026-11-15; selesaikan dulu atau kecualikan.", blocking: true },
      { employeeId: null, employeeName: null, code: "draft_roster", date: "2026-11-09", message: "Ada draf jadwal per tanggal.", blocking: true },
    ]));
    expect(html).toContain("2 masalah — tidak bisa diterapkan");
    expect(html.match(/Kecualikan/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>\s*Terapkan/);
  });
});
