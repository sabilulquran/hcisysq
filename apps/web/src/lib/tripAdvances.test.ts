import { afterEach, describe, expect, it, vi } from "vitest";

import {
  advanceEventLabel,
  advanceExportHref,
  advanceStatusLabel,
  balanceLabel,
  disburseAdvance,
  estimateAdvance,
  getAdminAdvances,
  nextStepHint,
  recordRefund,
  settleAdvance,
  TripAdvanceApiError,
} from "@/lib/tripAdvances";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const call = (fetchMock: ReturnType<typeof stubFetch>) => fetchMock.mock.calls[0] as unknown as [string, RequestInit];

describe("TRIP-002 client", () => {
  it("labels states and events in Indonesian, passing unknown values through", () => {
    expect(advanceStatusLabel("AWAITING_REFUND")).toBe("Menunggu pengembalian pegawai");
    expect(advanceStatusLabel("UNKNOWN")).toBe("UNKNOWN");
    expect(advanceEventLabel("trip_advance.settled")).toBe("Diselesaikan Keuangan");
    expect(advanceEventLabel("trip_advance.other")).toBe("trip_advance.other");
    expect(balanceLabel(-1)).toBe("Lebih, dikembalikan pegawai");
    expect(balanceLabel(1)).toBe("Kurang, dibayar ke pegawai");
    expect(balanceLabel(null)).toBeNull();
  });

  it("tells the employee the next step, including the overdue deadline", () => {
    expect(nextStepHint({ status: "APPROVED", amount: 0, overdue: false, dueOn: "2026-12-01" })).toMatch(/uang harian/);
    expect(nextStepHint({ status: "DISBURSED", amount: 5, overdue: true, dueOn: "2026-12-01" })).toMatch(/2026-12-01 sudah lewat/);
    expect(nextStepHint({ status: "SETTLED", amount: 5, overdue: false, dueOn: "2026-12-01" })).toBeNull();
  });

  it("never sends an amount with a disbursement: the API pays the approved amount", async () => {
    const fetchMock = stubFetch(201, { status: "DISBURSED", amount: 2_000_000 });
    await disburseAdvance("a1", { paidOn: "2026-11-17", method: "TRANSFER", reference: null, note: null, idempotencyKey: "k1" });
    const [url, init] = call(fetchMock);
    expect(url).toBe("/api/admin/trip-advances/a1/disburse");
    expect(JSON.parse(String(init.body))).toEqual({ paidOn: "2026-11-17", method: "TRANSFER", reference: null, note: null, idempotencyKey: "k1" });
  });

  it("sends settlement days and refund amounts, and surfaces the API's code on failure", async () => {
    let fetchMock = stubFetch(409, { code: "TRIP_PER_DIEM_RATE_MISSING", message: "Tarif belum ditetapkan" });
    await expect(settleAdvance("a1", { perDiemDays: 3, note: null, idempotencyKey: "k2" }))
      .rejects.toMatchObject({ status: 409, code: "TRIP_PER_DIEM_RATE_MISSING" });
    expect(JSON.parse(String(call(fetchMock)[1].body))).toEqual({ perDiemDays: 3, note: null, idempotencyKey: "k2" });
    fetchMock = stubFetch(201, { status: "AWAITING_REFUND", refundOutstanding: 1 });
    await recordRefund("a1", { paidOn: "2026-11-17", method: "CASH", reference: null, note: null, idempotencyKey: "k3", amount: 500_000 });
    expect(JSON.parse(String(call(fetchMock)[1].body))).toMatchObject({ amount: 500_000, method: "CASH" });
    stubFetch(403, null);
    await expect(estimateAdvance("t1", "LUAR_DAERAH")).rejects.toBeInstanceOf(TripAdvanceApiError);
  });

  it("builds register filters and the export link", async () => {
    const fetchMock = stubFetch(200, { items: [], pagination: { page: 1, pageSize: 25, total: 0, pageCount: 1 }, wilayahs: [] });
    await getAdminAdvances({ page: 2, status: "DISBURSED", overdue: true });
    expect(call(fetchMock)[0]).toBe("/api/admin/trip-advances?page=2&status=DISBURSED&overdue=true");
    expect(advanceExportHref("2026-11-01", "2026-11-17", "")).toBe("/api/admin/trip-advances/export.csv?from=2026-11-01&to=2026-11-17");
  });
});
