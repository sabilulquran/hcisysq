import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MobileEvidencePanel } from "@/components/attendance/MobileEvidencePanel";
import { correctionOriginLabel } from "@/lib/attendanceCorrections";
import { geofenceLabel } from "@/lib/attendanceLabels";

// ATT-011-3R Perbaikan Absen and mobile evidence in Data Transaksi. Synthetic data only.

describe("Perbaikan Absen vocabulary", () => {
  it("names where a correction came from", () => {
    expect(correctionOriginLabel("employee")).toBe("Diajukan pegawai");
    expect(correctionOriginLabel("hc")).toBe("Diinput HC");
    expect(geofenceLabel("outside")).toBe("Di luar area");
    expect(geofenceLabel("something")).toBe("Lokasi tidak diketahui");
  });
});

describe("Mobile evidence panel (ATT-006)", () => {
  it("shows GPS details but never loads the photo until asked", () => {
    const html = renderToStaticMarkup(<MobileEvidencePanel evidence={{
      evidenceId: "00000000-0000-4000-8000-000000019001", latitude: -6.71234, longitude: 108.54321, accuracyMeters: 180.4,
      distanceMeters: 420.2, geofenceStatus: "outside", workLocationName: "Kampus Sintetis", radiusMeters: 150,
    }} />);
    expect(html).toContain("Di luar area");
    expect(html).toContain("420 m dari titik");
    expect(html).toContain("±180 m");
    expect(html).toContain("Lihat foto");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("/photo");
  });
});
