import { describe, expect, it } from "vitest";

import {
  APPROVAL_SEAT_KEYS,
  APPROVAL_SEAT_LABELS,
  APPROVAL_SEAT_STATE_HINTS,
  APPROVAL_SEAT_STATE_LABELS,
  approvalSeatSummary,
  type ApprovalSeatKey,
  type ApprovalSeatReadiness,
  type ApprovalSeatRow,
  type ApprovalSeatState,
} from "@/lib/approvalSeats";

function row(seatKey: ApprovalSeatKey, state: ApprovalSeatState): ApprovalSeatRow {
  return {
    seatKey, state,
    positionKey: state === "UNMAPPED" ? null : `position-${seatKey}`,
    seatLabel: state === "UNMAPPED" ? null : seatKey,
    positionTitle: null, unitName: null,
    holderSource: state === "UNMAPPED" ? null : "EMPLOYEE",
  };
}

function readiness(states: Partial<Record<ApprovalSeatKey, ApprovalSeatState>>, structurePublished = true): ApprovalSeatReadiness {
  const items = APPROVAL_SEAT_KEYS.map((seatKey) => row(seatKey, states[seatKey] ?? "READY"));
  return {
    asOf: "2026-11-18",
    structurePublished,
    ready: items.every((item) => item.state === "READY"),
    neverMapped: items.filter((item) => item.state === "UNMAPPED").map((item) => item.seatKey),
    items,
    history: [],
  };
}

describe("LOAN-002 approval seat screen", () => {
  it("names production's opening state — all five unmapped — rather than leaving it to be counted", () => {
    const all = Object.fromEntries(APPROVAL_SEAT_KEYS.map((key) => [key, "UNMAPPED"])) as Record<ApprovalSeatKey, ApprovalSeatState>;
    const summary = approvalSeatSummary(readiness(all));
    expect(summary).toContain("Kelima kursi belum pernah dipetakan");
    // The consequence is said out loud: it is the whole institution, not one request.
    expect(summary).toContain("tidak ada kasbon yang dapat diajukan siapa pun");
  });

  it("names the seats that are not ready, so HC knows what to attend to", () => {
    const summary = approvalSeatSummary(readiness({ DIREKTUR: "VACANT", PEMBINA: "UNMAPPED" }));
    expect(summary).toContain("2 kursi belum siap");
    expect(summary).toContain(APPROVAL_SEAT_LABELS.DIREKTUR);
    expect(summary).toContain(APPROVAL_SEAT_LABELS.PEMBINA);
  });

  it("F2: the conclusion claims only what this screen actually checked", () => {
    // The chain's first rung is the requester's own unit approver, which is not a seat and is
    // never judged here, so "the chain can run" would be claiming more than was looked at.
    const summary = approvalSeatSummary(readiness({}));
    expect(summary).toBe("Kelima kursi siap. Rantai kasbon tidak terhalang di sisi kursi.");
    expect(summary).not.toContain("dapat berjalan");
  });

  it("F2: an organ account that cannot act counts as not ready, and points at the role", () => {
    const summary = approvalSeatSummary(readiness({ KETUA_YAYASAN: "ACCOUNT_CAPABILITY_MISSING" }));
    expect(summary).toContain("1 kursi belum siap");
    expect(summary).toContain(APPROVAL_SEAT_LABELS.KETUA_YAYASAN);
    // The instruction names the role and says where it is granted, because it is not granted here.
    expect(APPROVAL_SEAT_STATE_HINTS.ACCOUNT_CAPABILITY_MISSING).toContain("governance_loan_approver");
    expect(APPROVAL_SEAT_STATE_HINTS.ACCOUNT_CAPABILITY_MISSING).toContain("SQ Hub");
  });

  it("explains a missing structure instead of blaming the seats", () => {
    expect(approvalSeatSummary(readiness({}, false))).toContain("Belum ada struktur organisasi yang berlaku");
  });

  it("has a label and an instruction for every state the API can return", () => {
    const states: ApprovalSeatState[] = [
      "READY", "UNMAPPED", "POSITION_NOT_IN_FORCE", "VACANT", "SEAT_HELD_BY_REQUESTER",
      "ACCOUNT_CAPABILITY_MISSING",
    ];
    for (const state of states) {
      expect(APPROVAL_SEAT_STATE_LABELS[state], state).toBeTruthy();
      // Every state that is not READY tells Human Capital what to do about it.
      expect(APPROVAL_SEAT_STATE_HINTS[state], state).toBeTruthy();
    }
  });
});
