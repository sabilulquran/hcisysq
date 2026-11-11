import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { unlocatedShifts } from "@/lib/workforceAttendance";
import { LocationUsage, UnlocatedShiftsBanner } from "@/pages/AdminAttendanceConfigPages";

// ORG-005-3: the Shift and Lokasi kerja screens make a missing location obvious. Synthetic data only.

describe("ORG-005-3 Shift without a location", () => {
  const shifts = [
    { id: "a", active: true, workLocationId: null },
    { id: "b", active: true, workLocationId: "loc-1" },
    { id: "c", active: false, workLocationId: null },
  ];

  it("counts only active shifts without a location, and only while HP attendance is on", () => {
    expect(unlocatedShifts(shifts, true).map((item) => item.id)).toEqual(["a"]);
    expect(unlocatedShifts(shifts, false)).toEqual([]);
  });

  it("shows the count and offers to set a location, or to add one when none exists", () => {
    const withLocations = renderToStaticMarkup(<UnlocatedShiftsBanner count={3} hasLocations onLocate={() => undefined} />);
    expect(withLocations).toContain("3 shift aktif belum punya lokasi kerja.");
    expect(withLocations).toContain("tidak dicek radius");
    expect(withLocations).toMatch(/<button[^>]*>Atur lokasi<\/button>/);

    const withoutLocations = renderToStaticMarkup(<UnlocatedShiftsBanner count={1} hasLocations={false} onLocate={() => undefined} />);
    expect(withoutLocations).toContain('href="/admin/attendance/settings/locations"');
    expect(withoutLocations).toContain("Tambah lokasi kerja");

    expect(renderToStaticMarkup(<UnlocatedShiftsBanner count={0} hasLocations onLocate={() => undefined} />)).toBe("");
  });
});

describe("ORG-005-3 Lokasi kerja usage", () => {
  it("names the shifts and counts units and machines", () => {
    const html = renderToStaticMarkup(
      <LocationUsage active usage={{ shifts: [{ id: "s1", name: "Pagi SDIT" }, { id: "s2", name: "Siang SDIT" }], unitCount: 2, deviceCount: 1 }} />,
    );
    expect(html).toContain("2 shift:");
    expect(html).toContain("Pagi SDIT, Siang SDIT");
    expect(html).toContain("2 unit · 1 mesin");
  });

  it("nudges to link a shift when an active location is not used by any", () => {
    const html = renderToStaticMarkup(<LocationUsage active usage={{ shifts: [], unitCount: 0, deviceCount: 0 }} />);
    expect(html).toContain('href="/admin/attendance/shifts"');
    expect(html).toContain("Belum dipakai shift");
    expect(renderToStaticMarkup(<LocationUsage active={false} usage={{ shifts: [], unitCount: 0, deviceCount: 0 }} />)).toContain("Tidak dipakai shift");
  });
});
