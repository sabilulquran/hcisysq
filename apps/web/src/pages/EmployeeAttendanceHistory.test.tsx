import { describe, expect, it } from "vitest";

import { historyCells, type HistoryRow } from "@/pages/EmployeeAttendancePage";

// ATT-014 §6.5b (DRAFT): riwayat pegawai harus jujur ketika tanggalnya belum dikalkulasi.
// Data sintetis.

const schedule = {
  state: "scheduled",
  scheduledStartAt: "2026-11-12T00:00:00.000Z",
  scheduledEndAt: "2026-11-12T09:00:00.000Z",
} as unknown as HistoryRow["schedule"];

const row = (over: Partial<HistoryRow>): HistoryRow => ({
  workDate: "2026-11-12",
  schedule,
  result: null,
  pendingScans: null,
  ...over,
});

describe("ATT-014 §6.5b riwayat pegawai", () => {
  it("menampilkan jam scan dan menahan angka resmi saat tanggalnya belum dikalkulasi", () => {
    const cells = historyCells(row({ pendingScans: { firstScanAt: "2026-11-12T05:40:04.000Z", lastScanAt: null, scanCount: 1 } }));
    expect(cells.pending).toBe(true);
    expect(cells.status).toBe("Belum dihitung");
    expect(cells.checkIn).toBe("12.40");
    expect(cells.checkOut).toBe("—");
    expect([cells.worked, cells.late, cells.overtime]).toEqual(["—", "—", "—"]);
  });

  it("memakai hasil kalkulasi begitu hasilnya ada", () => {
    const cells = historyCells(row({
      result: {
        status: "incomplete",
        firstCheckInAt: "2026-11-12T05:40:04.000Z",
        lastCheckOutAt: null,
        workedMinutes: 0,
        lateMinutes: 340,
        overtimeMinutes: 0,
      } as unknown as HistoryRow["result"],
    }));
    expect(cells.pending).toBe(false);
    expect(cells.status).toBe("Belum lengkap");
    expect(cells.late).toBe("340 mnt");
  });

  it("tetap menampilkan jadwal apa adanya saat tidak ada scan dan tidak ada hasil", () => {
    const cells = historyCells(row({}));
    expect(cells.status).toBe("Terjadwal");
    expect(cells.checkIn).toBe("—");
    expect(cells.worked).toBe("0 mnt");
  });
});
