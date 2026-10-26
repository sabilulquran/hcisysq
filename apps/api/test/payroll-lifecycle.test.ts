import { describe, expect, it } from "vitest";

import {
  availableActions,
  decideTransition,
  defaultCutoffWindow,
  monthEnd,
  PERIOD_ACTIONS,
  TRANSITIONS,
  type PeriodAction,
  type PeriodSnapshot,
  type PeriodState,
  type TransitionActor,
} from "../src/modules/payroll/lifecycle.js";

const HC = ["payroll.periods.manage", "payroll.calculate", "payroll.submit"];
const DIRECTOR = ["payroll.approve", "payroll.reopen.approve"];
const FINANCE = ["payroll.payments.confirm"];

function actor(permissions: readonly string[], accountId = "actor-1"): TransitionActor {
  return { accountId, organizationPermissions: permissions };
}

function period(overrides: Partial<PeriodSnapshot> = {}): PeriodSnapshot {
  return {
    state: "DRAFT",
    stateBeforeReopenRequest: null,
    submittedByAccountId: null,
    hasCurrentCalculation: false,
    blockerCount: 0,
    ...overrides,
  };
}

function refusalOf(action: PeriodAction, snapshot: PeriodSnapshot, who: TransitionActor, reason: string | null = null) {
  const decision = decideTransition(action, snapshot, who, reason);
  return decision.allowed ? null : decision.refusal.code;
}

describe("PAY-003 lifecycle shape", () => {
  it("has no REOPENED state: approving a reopen returns the period to COLLECTING", () => {
    expect(TRANSITIONS.approve_reopen.to).toBe("COLLECTING");
    const states = new Set<string>(Object.values(TRANSITIONS).map((rule) => rule.to));
    expect(states.has("REOPENED")).toBe(false);
  });

  it("sends a returned period back to COLLECTING, where its inputs can be fixed", () => {
    expect(TRANSITIONS.return.to).toBe("COLLECTING");
  });

  it("requires a reason exactly where the specification does", () => {
    const withReason = PERIOD_ACTIONS.filter((action) => TRANSITIONS[action].reasonRequired);
    expect(withReason).toEqual(["return", "request_reopen", "reject_reopen"]);
  });
});

describe("PAY-003 lifecycle authorization", () => {
  it("refuses an actor without the permission the action needs", () => {
    expect(refusalOf("approve", period({ state: "SUBMITTED" }), actor(HC))).toBe("PAYROLL_FORBIDDEN");
    expect(refusalOf("confirm_payment", period({ state: "APPROVED" }), actor(DIRECTOR))).toBe("PAYROLL_FORBIDDEN");
    expect(refusalOf("calculate", period({ state: "COLLECTING" }), actor(FINANCE))).toBe("PAYROLL_FORBIDDEN");
  });

  it("refuses the submitter as approver of the same period", () => {
    const snapshot = period({
      state: "SUBMITTED",
      submittedByAccountId: "kepala-hc",
      hasCurrentCalculation: true,
    });
    expect(refusalOf("approve", snapshot, actor([...DIRECTOR], "kepala-hc"))).toBe("PAYROLL_SELF_APPROVAL");
    const other = decideTransition("approve", snapshot, actor([...DIRECTOR], "direktur"), null);
    expect(other.allowed).toBe(true);
  });

  it("checks the permission before the state, so a refusal never leaks the period's state", () => {
    expect(refusalOf("approve", period({ state: "DRAFT" }), actor(HC))).toBe("PAYROLL_FORBIDDEN");
  });
});

describe("PAY-003 lifecycle order", () => {
  const path: ReadonlyArray<[PeriodAction, PeriodState, PeriodState, readonly string[]]> = [
    ["start_collecting", "DRAFT", "COLLECTING", HC],
    ["calculate", "COLLECTING", "CALCULATED", HC],
    ["submit", "CALCULATED", "SUBMITTED", HC],
    ["approve", "SUBMITTED", "APPROVED", DIRECTOR],
    ["confirm_payment", "APPROVED", "PAYMENT_CONFIRMED", FINANCE],
    ["publish", "PAYMENT_CONFIRMED", "PUBLISHED", HC],
  ];

  it("walks DRAFT to PUBLISHED one step at a time", () => {
    for (const [action, from, to, permissions] of path) {
      const decision = decideTransition(
        action,
        period({ state: from, hasCurrentCalculation: true, submittedByAccountId: "kepala-hc" }),
        actor(permissions, "aktor-lain"),
        null,
      );
      expect(decision.allowed).toBe(true);
      expect(decision.allowed && decision.nextState).toBe(to);
    }
  });

  it("refuses every step taken out of order", () => {
    for (const [action, , , permissions] of path) {
      if (action === "start_collecting") continue;
      expect(refusalOf(action, period({ state: "DRAFT" }), actor(permissions, "aktor-lain"))).toBe(
        "PAYROLL_STATE_CONFLICT",
      );
    }
  });

  it("lets a calculated period be calculated again, and nothing else repeat itself", () => {
    const recalculate = decideTransition("calculate", period({ state: "CALCULATED" }), actor(HC), null);
    expect(recalculate.allowed && recalculate.nextState).toBe("CALCULATED");

    const republish = decideTransition("publish", period({ state: "PUBLISHED" }), actor(HC), null);
    expect(republish.allowed).toBe(false);
    expect(!republish.allowed && republish.refusal.code).toBe("PAYROLL_STATE_CONFLICT");
  });
});

describe("PAY-003 submission guards", () => {
  it("refuses submission while a blocker stands", () => {
    const snapshot = period({ state: "CALCULATED", hasCurrentCalculation: true, blockerCount: 3 });
    expect(refusalOf("submit", snapshot, actor(HC))).toBe("PAYROLL_BLOCKERS_PRESENT");
  });

  it("refuses submission when an input changed after the last calculation", () => {
    const snapshot = period({ state: "CALCULATED", hasCurrentCalculation: false });
    expect(refusalOf("submit", snapshot, actor(HC))).toBe("PAYROLL_CALCULATION_STALE");
  });

  it("refuses approval of a period whose blockers reappeared", () => {
    const snapshot = period({ state: "SUBMITTED", hasCurrentCalculation: true, blockerCount: 1 });
    expect(refusalOf("approve", snapshot, actor(DIRECTOR))).toBe("PAYROLL_BLOCKERS_PRESENT");
  });

  it("does not ask the director for a fresh calculation, which only the submitter can run", () => {
    const snapshot = period({ state: "SUBMITTED", hasCurrentCalculation: false });
    const decision = decideTransition("approve", snapshot, actor(DIRECTOR), null);
    expect(decision.allowed).toBe(true);
  });

  it("requires a reason to return a submitted period", () => {
    const snapshot = period({ state: "SUBMITTED" });
    expect(refusalOf("return", snapshot, actor(DIRECTOR))).toBe("PAYROLL_REASON_REQUIRED");
    expect(refusalOf("return", snapshot, actor(DIRECTOR), "   ")).toBe("PAYROLL_REASON_REQUIRED");
    const decision = decideTransition("return", snapshot, actor(DIRECTOR), "Jam mengajar belum diperbarui");
    expect(decision.allowed && decision.nextState).toBe("COLLECTING");
  });
});

describe("PAY-003 reopen", () => {
  it("can be requested from approved, paid and published periods, with a reason", () => {
    for (const state of ["APPROVED", "PAYMENT_CONFIRMED", "PUBLISHED"] as const) {
      expect(refusalOf("request_reopen", period({ state }), actor(HC))).toBe("PAYROLL_REASON_REQUIRED");
      const decision = decideTransition("request_reopen", period({ state }), actor(HC), "Koreksi lembur");
      expect(decision.allowed && decision.nextState).toBe("REOPEN_REQUESTED");
    }
  });

  it("cannot be requested from a period that is still being worked on", () => {
    for (const state of ["DRAFT", "COLLECTING", "CALCULATED", "SUBMITTED"] as const) {
      expect(refusalOf("request_reopen", period({ state }), actor(HC), "Koreksi")).toBe(
        "PAYROLL_STATE_CONFLICT",
      );
    }
  });

  it("returns an approved reopen to COLLECTING in one step", () => {
    const decision = decideTransition(
      "approve_reopen",
      period({ state: "REOPEN_REQUESTED", stateBeforeReopenRequest: "PUBLISHED" }),
      actor(DIRECTOR),
      null,
    );
    expect(decision.allowed && decision.nextState).toBe("COLLECTING");
  });

  it("puts a rejected reopen back where the period was", () => {
    const decision = decideTransition(
      "reject_reopen",
      period({ state: "REOPEN_REQUESTED", stateBeforeReopenRequest: "PAYMENT_CONFIRMED" }),
      actor(DIRECTOR),
      "Selisihnya ditangani periode berikutnya",
    );
    expect(decision.allowed && decision.nextState).toBe("PAYMENT_CONFIRMED");
  });

  it("refuses a rejection when the earlier state was never recorded", () => {
    expect(
      refusalOf("reject_reopen", period({ state: "REOPEN_REQUESTED" }), actor(DIRECTOR), "Tidak perlu"),
    ).toBe("PAYROLL_REOPEN_STATE_MISSING");
  });

  it("needs the director's permission, not human capital's", () => {
    const snapshot = period({ state: "REOPEN_REQUESTED", stateBeforeReopenRequest: "APPROVED" });
    expect(refusalOf("approve_reopen", snapshot, actor(HC))).toBe("PAYROLL_FORBIDDEN");
  });
});

describe("PAY-003 available actions", () => {
  it("offers human capital only what it may do here", () => {
    expect(availableActions(period({ state: "DRAFT" }), actor(HC))).toEqual(["start_collecting"]);
    expect(availableActions(period({ state: "COLLECTING" }), actor(HC))).toEqual(["calculate"]);
    expect(availableActions(period({ state: "CALCULATED" }), actor(HC))).toEqual(["calculate", "submit"]);
  });

  it("offers the director approval and return on a submitted period", () => {
    expect(availableActions(period({ state: "SUBMITTED" }), actor(DIRECTOR))).toEqual(["return", "approve"]);
  });

  it("offers the submitter the return but not the approval", () => {
    const snapshot = period({ state: "SUBMITTED", submittedByAccountId: "orang" });
    expect(availableActions(snapshot, actor(DIRECTOR, "orang"))).toEqual(["return"]);
  });

  it("offers nothing to an actor with no payroll permission", () => {
    expect(availableActions(period({ state: "SUBMITTED" }), actor([]))).toEqual([]);
  });
});

describe("PAY-003 period dates", () => {
  it("defaults the cutoff to the 23rd of the previous month through the 22nd", () => {
    expect(defaultCutoffWindow("2026-09-01")).toEqual({ start: "2026-08-23", end: "2026-09-22" });
  });

  it("crosses the turn of the year", () => {
    expect(defaultCutoffWindow("2026-01-01")).toEqual({ start: "2025-12-23", end: "2026-01-22" });
  });

  it("knows how long each month is, February included", () => {
    expect(monthEnd("2026-09-01")).toBe("2026-09-30");
    expect(monthEnd("2026-10-01")).toBe("2026-10-31");
    expect(monthEnd("2026-02-01")).toBe("2026-02-28");
    expect(monthEnd("2028-02-01")).toBe("2028-02-29");
    expect(monthEnd("2100-02-01")).toBe("2100-02-28");
  });

  it("refuses a month that is not given as its first day", () => {
    expect(() => defaultCutoffWindow("2026-09-15")).toThrow();
    expect(() => monthEnd("2026-09")).toThrow();
  });
});
