import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LeftoverDraftNotice } from "@/pages/AdminAttendanceRosterPage";

// ATT-011-8: the old Jadwal per tanggal and Pola jadwal screens are read-only. Synthetic data only.

describe("ATT-011-8 retired schedule screens", () => {
  it("offers only applying a leftover draft, never making or editing one", () => {
    const html = renderToStaticMarkup(<LeftoverDraftNotice busy={false} disabled={false} onApply={() => undefined} />);
    expect(html).toContain("Ada draf lama yang belum diterapkan.");
    expect(html).toMatch(/<button[^>]*>.*Terapkan draf<\/button>/);
  });

  it("no longer calls the manual draft or pattern write endpoints from the UI", () => {
    const roster = readFileSync(new URL("./AdminAttendanceRosterPage.tsx", import.meta.url), "utf8");
    for (const write of ["createAttendanceRoster", "updateAttendanceRosterEntries", "removeAttendanceRosterEntry", "copyPreviousAttendanceRoster"]) {
      expect(roster, write).not.toContain(write);
    }
    expect(roster).not.toContain("<select");
    const config = readFileSync(new URL("./AdminAttendanceConfigPages.tsx", import.meta.url), "utf8");
    expect(config).not.toContain("createAttendanceScheduleAssignment");
    expect(config).not.toContain("updateAttendanceScheduleAssignment");
  });
});
