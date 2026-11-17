import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MyTransactionList } from "@/components/attendance/MyTransactionList";
import { myTransactionSourceLabel } from "@/lib/attendanceLabels";
import type { MyTransaction, MyTransactionDay } from "@/lib/workforceAttendance";
import { historyCells, type HistoryRow } from "@/pages/EmployeeAttendancePage";

// ATT-014 §6.5b/§6.5c (DRAFT): riwayat pegawai memisahkan transaksi (scan mentah, real-time) dari
// hasil kehadiran (kalkulasi). Data sintetis.

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

const calculated = {
  status: "incomplete",
  firstCheckInAt: "2026-11-12T05:40:04.000Z",
  lastCheckOutAt: null,
  workedMinutes: 0,
  lateMinutes: 340,
  overtimeMinutes: 0,
} as unknown as HistoryRow["result"];

const day = (over: Partial<MyTransactionDay>): MyTransactionDay => ({
  workDate: "2026-11-12",
  firstScanAt: "2026-11-12T00:55:00.000Z",
  lastScanAt: "2026-11-12T09:20:00.000Z",
  scanCount: 3,
  calculatedAt: null,
  newSinceCalculation: false,
  ...over,
});

describe("ATT-014 §6.5c riwayat: jam dari transaksi, angka dari kalkulasi", () => {
  it("menampilkan jam scan mentah walau tanggalnya belum dikalkulasi, tanpa menebak angka", () => {
    const cells = historyCells(row({}), day({}));
    expect(cells.status).toBe("Belum dihitung");
    expect(cells.marker).toBe("Belum dihitung");
    expect([cells.checkIn, cells.checkOut]).toEqual(["07.55", "16.20"]);
    expect(cells.scanCount).toBe(3);
    expect([cells.worked, cells.late, cells.overtime]).toEqual(["—", "—", "—"]);
  });

  it("memakai jam transaksi, bukan jam hasil, untuk tanggal yang sudah dikalkulasi", () => {
    const cells = historyCells(row({ result: calculated }), day({ calculatedAt: "2026-11-12T06:00:00.000Z" }));
    expect(cells.status).toBe("Belum lengkap");
    expect([cells.checkIn, cells.checkOut]).toEqual(["07.55", "16.20"]);
    expect(cells.late).toBe("340 mnt");
    expect(cells.stale).toBe(false);
    expect(cells.marker).toBeNull();
  });

  it("menandai tanggal yang menerima scan baru sejak dihitung tanpa mengubah angka resmi", () => {
    const cells = historyCells(row({ result: calculated }), day({ newSinceCalculation: true }));
    expect(cells.stale).toBe(true);
    expect(cells.marker).toBe("Ada scan baru sejak dihitung");
    expect(cells.status).toBe("Belum lengkap");
    expect(cells.late).toBe("340 mnt");
  });

  it("tanpa scan dan tanpa hasil: jadwal apa adanya, jam dan angka kosong", () => {
    const cells = historyCells(row({}), null);
    expect(cells.status).toBe("Terjadwal");
    expect([cells.checkIn, cells.checkOut, cells.worked]).toEqual(["—", "—", "—"]);
    expect(cells.marker).toBeNull();
    expect(cells.scanCount).toBe(0);
  });

  it("selama transaksi belum termuat, memakai sumber lama (§6.5b)", () => {
    const pending = historyCells(row({ pendingScans: { firstScanAt: "2026-11-12T05:40:04.000Z", lastScanAt: null, scanCount: 1 } }));
    expect(pending.status).toBe("Belum dihitung");
    expect([pending.checkIn, pending.checkOut]).toEqual(["12.40", "—"]);
    const stored = historyCells(row({ result: calculated }));
    expect(stored.checkIn).toBe("12.40");
    expect(stored.late).toBe("340 mnt");
  });
});

describe("ATT-014 §6.5c daftar transaksi", () => {
  const items: MyTransaction[] = [
    { occurredAt: "2026-11-12T00:55:03.000Z", workDate: "2026-11-12", source: "adms", kind: null, deviceName: "Lobi Utama", reviewState: null, afterCalculation: false },
    { occurredAt: "2026-11-12T09:20:00.000Z", workDate: "2026-11-12", source: "mobile", kind: "check_out", deviceName: null, reviewState: "needs_review", afterCalculation: true },
  ];

  it("mendaftar setiap scan beserta sumber dan jenisnya", () => {
    const html = renderToStaticMarkup(<MyTransactionList items={items} refreshing={false} generatedAt="2026-11-12T09:21:00.000Z" error={null} onRefresh={vi.fn()} />);
    expect(html).toContain("07.55.03");
    expect(html).toContain("Mesin absensi · Lobi Utama");
    expect(html).toContain("Presensi HP");
    expect(html).toContain("Keluar");
    expect(html).toContain("Perlu ditinjau HC");
    expect(html).toContain("Masuk setelah dihitung");
    expect(html).toContain("Segarkan");
    expect(html).toContain("Diperbarui pukul 16.21.00 WIB");
  });

  it("jujur saat kosong", () => {
    const html = renderToStaticMarkup(<MyTransactionList items={[]} refreshing={false} generatedAt={null} error={null} onRefresh={vi.fn()} />);
    expect(html).toContain("Belum ada scan yang diterima untuk tanggal ini.");
  });

  it("memberi nama sumber tanpa nomor seri mesin", () => {
    expect(myTransactionSourceLabel({ source: "adms", deviceName: null })).toBe("Mesin absensi");
    expect(myTransactionSourceLabel({ source: "manual", deviceName: null })).toBe("Koreksi HC");
  });
});
