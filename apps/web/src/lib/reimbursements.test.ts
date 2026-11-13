import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimEventLabel,
  claimStatusLabel,
  exportHref,
  monthStart,
  payClaim,
  readReceiptFile,
  ReimbursementApiError,
  submitClaim,
  verifyClaim,
} from "@/lib/reimbursements";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("REIMB-001 client", () => {
  it("labels every state and event in Indonesian, passing unknown values through", () => {
    expect(claimStatusLabel("APPROVED")).toBe("Disetujui, menunggu verifikasi Keuangan");
    expect(claimStatusLabel("PAID")).toBe("Dibayar");
    expect(claimStatusLabel("UNKNOWN")).toBe("UNKNOWN");
    expect(claimEventLabel("reimbursement.finance.rejected")).toBe("Ditolak Keuangan");
    expect(claimEventLabel("reimbursement.other")).toBe("reimbursement.other");
  });

  it("never sends an amount with a payment: the API pays the verified total", async () => {
    const fetchMock = stubFetch(201, { status: "PAID", amount: 325000 });
    await payClaim("c1", { paidOn: "2026-11-13", method: "TRANSFER", reference: null, note: null, idempotencyKey: "k1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/reimbursements/c1/pay");
    expect(JSON.parse(String(init.body))).toEqual({ paidOn: "2026-11-13", method: "TRANSFER", reference: null, note: null, idempotencyKey: "k1" });
  });

  it("sends verification decisions per item and surfaces the API's code on failure", async () => {
    const fetchMock = stubFetch(409, { code: "REIMBURSEMENT_REDUCTION_NOTE_REQUIRED", message: "Tulis alasan" });
    await expect(verifyClaim("c1", [{ itemId: "i1", approvedAmount: 0 }], null))
      .rejects.toMatchObject({ status: 409, code: "REIMBURSEMENT_REDUCTION_NOTE_REQUIRED" });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)))
      .toEqual({ items: [{ itemId: "i1", approvedAmount: 0 }], note: null });
    stubFetch(403, null);
    await expect(submitClaim("c1")).rejects.toBeInstanceOf(ReimbursementApiError);
  });

  it("builds the export link and the default month window", () => {
    expect(exportHref("2026-11-01", "2026-11-13", "")).toBe("/api/admin/reimbursements/export.csv?from=2026-11-01&to=2026-11-13");
    expect(exportHref("2026-11-01", "2026-11-13", "PAID")).toContain("status=PAID");
    expect(monthStart("2026-11-13")).toBe("2026-11-01");
  });

  it("refuses a receipt of the wrong type or size before uploading", async () => {
    await expect(readReceiptFile(new File(["x"], "nota.webp", { type: "image/webp" }))).rejects.toThrow(/PDF, JPG, atau PNG/);
    const big = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "nota.pdf", { type: "application/pdf" });
    await expect(readReceiptFile(big)).rejects.toThrow(/4 MB/);
  });
});
