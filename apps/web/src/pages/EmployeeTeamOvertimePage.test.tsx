import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { initiatorLabel } from "@/pages/AdminAttendanceOvertimePage";
import { OvertimeRequestCard } from "@/pages/EmployeeAttendancePage";
import { orderStatusLabel } from "@/pages/EmployeeTeamOvertimePage";

// ATT-011-6b-2: a supervisor's order asks the employee Setuju / Tolak and cannot be cancelled by them;
// the employee's own request waits for the supervisor and can be cancelled. Synthetic data only.

const base = {
  id: "synthetic-1", workDate: "2026-11-07", requestedMinutes: 240, approvedMinutes: null, note: "Persiapan wisuda",
  status: "submitted" as const, decisionNote: null, createdAt: "2026-11-01T00:00:00Z", decidedAt: null,
};
const render = (item: Parameters<typeof OvertimeRequestCard>[0]["item"]) =>
  renderToStaticMarkup(<OvertimeRequestCard item={item} busy={false} cancelling={false} onCancel={() => undefined} onRespond={() => undefined} />);

describe("ATT-011-6b-2 overtime cards", () => {
  it("asks the employee to agree to or decline a supervisor's order, without a cancel button", () => {
    const html = render({ ...base, initiatedBy: "supervisor", supervisorName: "Pak Budi", awaiting: "employee" });
    expect(html).toContain("Perintah lembur dari atasan (Pak Budi)");
    expect(html).toContain(">Setuju</button>");
    expect(html).toContain(">Tolak</button>");
    expect(html).not.toContain("Batalkan");
  });

  it("shows the employee's own request waiting for the supervisor, cancellable", () => {
    const html = render({ ...base, initiatedBy: "employee", supervisorName: "Pak Budi", awaiting: "supervisor" });
    expect(html).toContain("Menunggu persetujuan Pak Budi");
    expect(html).toContain("Batalkan");
    expect(html).not.toContain(">Setuju</button>");
  });

  it("labels orders by the employee's answer and HC rows by who started them", () => {
    expect(orderStatusLabel({ status: "submitted", initiatedBy: "supervisor" })).toBe("Menunggu persetujuan pegawai");
    expect(orderStatusLabel({ status: "rejected", initiatedBy: "supervisor" })).toBe("Ditolak pegawai");
    expect(initiatorLabel("supervisor")).toBe("Atasan");
    expect(initiatorLabel("hc")).toBe("HC");
    expect(initiatorLabel("employee")).toBe("Pegawai");
  });
});
