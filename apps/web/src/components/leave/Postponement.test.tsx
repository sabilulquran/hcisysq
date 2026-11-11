// LEAVE-008: the approver proposes other dates; the requester accepts or declines. The screens
// only show what the API returns and send the answer; the API decides everything else.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostponementResponse } from "@/components/leave/PostponementResponse";
import { ProposeAlternativeDates } from "@/components/leave/ProposeAlternativeDates";
import {
  acceptLeavePostponement,
  declineLeavePostponement,
  postponeLeaveApproval,
  previewLeavePostponement,
  type LeavePostponement,
} from "@/lib/employeeLeave";
import { formatLeaveRange, postponementStatusNote } from "@/lib/leavePostponementView";

const PROPOSAL: LeavePostponement = {
  id: "50000000-0000-4000-8000-000000000001",
  status: "proposed",
  proposedStartOn: "2099-02-09",
  proposedEndOn: "2099-02-11",
  proposedWorkingDays: 3,
  note: "Pekan itu ada akreditasi.",
  proposedByName: "Atasan Sintetis",
  proposedAt: "2099-01-05T08:00:00+07:00",
  respondedAt: null,
  replacementRequestId: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LEAVE-008 requester answer", () => {
  it("shows who proposed which dates and why, with accept and decline", () => {
    const html = renderToStaticMarkup(<PostponementResponse postponement={PROPOSAL} onDone={() => undefined} />);
    expect(html).toContain("Atasan Sintetis mengusulkan tanggal lain");
    expect(html).toContain("3 hari kerja");
    expect(html).toContain("Pekan itu ada akreditasi.");
    expect(html).toContain("Terima tanggal ini");
    expect(html).toContain("Tolak usulan");
    expect(html).not.toContain("Ya, tolak usulan");
  });

  it("labels postponed, declined and replacement requests", () => {
    expect(postponementStatusNote({ status: "postponed", postponement: { ...PROPOSAL, status: "accepted" } }))
      .toMatch(/diganti pengajuan baru/);
    expect(postponementStatusNote({ status: "cancelled", postponement: { ...PROPOSAL, status: "declined" } }))
      .toMatch(/menolak usulan/);
    expect(postponementStatusNote({ status: "in_review", replacesRequestId: PROPOSAL.id })).toMatch(/Pengganti/);
    expect(postponementStatusNote({ status: "cancelled", postponement: null })).toBeNull();
    expect(formatLeaveRange("2099-02-09", "2099-02-09")).toBe("9 Feb 2099");
  });
});

describe("LEAVE-008 approver proposal", () => {
  it("starts as one action next to approve and reject", () => {
    const html = renderToStaticMarkup(<ProposeAlternativeDates stepId="s1" onDone={() => undefined} />);
    expect(html).toContain("Usulkan tanggal lain");
    expect(html).not.toContain("Kirim usulan");
  });

  it("calls the documented routes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await previewLeavePostponement("step-1", { startOn: "2099-02-09", endOn: "2099-02-11" });
    await postponeLeaveApproval("step-1", { startOn: "2099-02-09", endOn: "2099-02-11", note: "Mohon geser" });
    await acceptLeavePostponement("p-1", "key-1");
    await declineLeavePostponement("p-1", null);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url)).toEqual([
      "/api/leave/approvals/step-1/postponement/preview",
      "/api/leave/approvals/step-1/postpone",
      "/api/leave/me/postponements/p-1/accept",
      "/api/leave/me/postponements/p-1/decline",
    ]);
    expect(calls.every(([, init]) => init.method === "POST" && init.credentials === "include")).toBe(true);
    expect(JSON.parse(String(calls[2]![1].body))).toEqual({ idempotencyKey: "key-1" });
  });

  it("surfaces the API refusal message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ code: "PERIOD_LIMIT_EXCEEDED", message: "Kuota periode tidak cukup." }), { status: 409 },
    )));
    await expect(previewLeavePostponement("step-1", { startOn: "2099-02-09", endOn: "2099-02-12" }))
      .rejects.toMatchObject({ status: 409, code: "PERIOD_LIMIT_EXCEEDED", message: "Kuota periode tidak cukup." });
  });
});
