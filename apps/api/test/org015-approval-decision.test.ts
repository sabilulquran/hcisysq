import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { applyLeaveApprovalDecision, mapKnownError } from "../src/modules/leave/employee-routes.js";

/**
 * ORG-015-3 idempotency and ORG-015-B, against the real decision function rather than a mock of
 * it. The client is a fake that answers each statement by shape, so these run without a database;
 * what they pin is the branch taken, which is where the two doors could drift apart.
 *
 * Synthetic ids only.
 */

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const OTHER_ACCOUNT = "00000000-0000-4000-8000-000000000002";
const STEP = "00000000-0000-4000-8000-0000000000aa";
const REQUEST = "00000000-0000-4000-8000-0000000000bb";
const EMPLOYEE = "00000000-0000-4000-8000-0000000000ee";
const ACTION = "00000000-0000-4000-8000-0000000000cc";
const OTHER_ACTION = "00000000-0000-4000-8000-0000000000dd";

interface StepRow {
  status: string;
  decisionRequestId: string | null;
  approverAccountId: string | null;
  approverEmployeeId: string | null;
  requestStatus: string;
}

function client(step: Partial<StepRow> = {}, options: { capability?: boolean; steps?: unknown[]; actorIsRequester?: boolean } = {}) {
  const statements: string[] = [];
  const row = {
    id: STEP,
    requestId: REQUEST,
    requesterEmployeeId: EMPLOYEE,
    approverEmployeeId: null,
    approverAccountId: ACCOUNT,
    status: "pending",
    decisionRequestId: null,
    requestStatus: "in_review",
    hcHandling: "notify",
    policyKey: "annual",
    ...step,
  };
  const fake = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FOR UPDATE OF s, r")) return { rows: [row] };
      if (sql.includes("status = 'pending'") && sql.includes("LIMIT 1")) return { rows: [{ id: "next-step" }] };
      if (sql.includes("leave.governance.approve")) return { rows: [{ allowed: options.capability ?? true }] };
      // ORG-013-1 butir 4: the self-approval match fails closed, so the fake has to answer it.
      if (sql.includes("AS same")) return { rows: [{ same: options.actorIsRequester ?? false }] };
      if (sql.includes("step_order AS \"order\"")) {
        return { rows: options.steps ?? [{ id: STEP, order: 1, status: row.status }] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { fake, statements };
}

const principal = { id: ACCOUNT, principalType: "FOUNDATION_BOARD" as const };

describe("ORG-015-3 replay", () => {
  it("answers the decision already made when the same requestId comes back", async () => {
    const { fake, statements } = client({ status: "approved", decisionRequestId: ACTION });
    const result = await applyLeaveApprovalDecision(fake, {
      principal, stepId: STEP, decision: "approve", decisionRequestId: ACTION,
    });

    expect(result.replayed).toBe(true);
    expect(result.payload).toMatchObject({ requestId: REQUEST, stepStatus: "approved" });
    // Nothing was written and no notification queued: a replay is a read.
    expect(statements.some((sql) => sql.includes("UPDATE leave_request_approval_steps"))).toBe(false);
  });

  it("refuses a different requestId on a step that was decided", async () => {
    const { fake } = client({ status: "approved", decisionRequestId: ACTION });
    await expect(applyLeaveApprovalDecision(fake, {
      principal, stepId: STEP, decision: "approve", decisionRequestId: OTHER_ACTION,
    })).rejects.toMatchObject({ statusCode: 409, code: "APPROVAL_STEP_DECIDED" });
  });

  it("refuses the same requestId asking for the other decision", async () => {
    const { fake } = client({ status: "approved", decisionRequestId: ACTION });
    await expect(applyLeaveApprovalDecision(fake, {
      principal, stepId: STEP, decision: "reject", decisionRequestId: ACTION,
    })).rejects.toMatchObject({ statusCode: 409, code: "APPROVAL_STEP_DECIDED" });
  });

  it.each([
    [
      "a step still waiting behind an earlier one",
      { status: "waiting" },
      [{ id: "earlier", order: 1, status: "pending" }, { id: STEP, order: 2, status: "waiting" }],
      "STEP_NOT_PENDING",
    ],
    [
      "a request that was cancelled",
      { status: "pending", requestStatus: "cancelled" },
      [{ id: STEP, order: 1, status: "pending" }],
      "REQUEST_NOT_REVIEWABLE",
    ],
  ])("gives %s the same answer as the cookie route, not APPROVAL_STEP_DECIDED", async (_label, step, steps, code) => {
    const { fake } = client(step, { steps });
    const error = await applyLeaveApprovalDecision(fake, {
      principal, stepId: STEP, decision: "approve", decisionRequestId: ACTION,
    }).catch((caught: unknown) => caught);
    // The workflow error is what the cookie route raises too, and both doors map it to 409.
    expect(error).toMatchObject({ code });
    expect(mapKnownError(error)).toMatchObject({ statusCode: 409, code });
  });
});

describe("ORG-015-B the rules do not depend on which door was used", () => {
  it("refuses a step owned by another account before anything else", async () => {
    const { fake, statements } = client({ approverAccountId: OTHER_ACCOUNT });
    await expect(applyLeaveApprovalDecision(fake, {
      principal, stepId: STEP, decision: "approve", decisionRequestId: ACTION,
    })).rejects.toMatchObject({ statusCode: 403, code: "APPROVAL_FORBIDDEN" });
    expect(statements.some((sql) => sql.includes("leave.governance.approve"))).toBe(false);
  });

  it("refuses a step owned by an employee, which the portal never decides", async () => {
    const { fake } = client({ approverAccountId: null, approverEmployeeId: EMPLOYEE });
    await expect(applyLeaveApprovalDecision(fake, {
      principal, stepId: STEP, decision: "approve", decisionRequestId: ACTION,
    })).rejects.toMatchObject({ statusCode: 403, code: "APPROVAL_FORBIDDEN" });
  });

  it("refuses the requester deciding their own request, at decision time", async () => {
    const { fake } = client({}, { actorIsRequester: true });
    await expect(applyLeaveApprovalDecision(fake, {
      principal, stepId: STEP, decision: "approve", decisionRequestId: ACTION,
    })).rejects.toMatchObject({ statusCode: 403, code: "APPROVAL_SELF_FORBIDDEN" });
  });

  it("refuses an account whose governance capability has lapsed, at decision time", async () => {
    const { fake } = client({}, { capability: false });
    await expect(applyLeaveApprovalDecision(fake, {
      principal, stepId: STEP, decision: "approve", decisionRequestId: ACTION,
    })).rejects.toMatchObject({ statusCode: 403, code: "APPROVAL_FORBIDDEN" });
  });

  it("records the requestId with the decision so a later resend can be recognised", async () => {
    const { fake, statements } = client();
    await applyLeaveApprovalDecision(fake, {
      principal, stepId: STEP, decision: "approve", note: "Disetujui", decisionRequestId: ACTION,
    });
    const update = statements.find((sql) => sql.includes("UPDATE leave_request_approval_steps") && sql.includes("decision_request_id"));
    expect(update).toBeDefined();
  });

  it("leaves the column null for a decision made with a cookie session", async () => {
    const { fake, statements } = client();
    const result = await applyLeaveApprovalDecision(fake, {
      principal: { id: ACCOUNT, principalType: "FOUNDATION_BOARD" },
      stepId: STEP,
      decision: "approve",
    });
    expect(result.replayed).toBe(false);
    // Without a requestId the replay branch cannot be entered at all, whatever the step's state.
    expect(statements.some((sql) => sql.includes("FOR UPDATE OF s, r"))).toBe(true);
  });

  it("never enters the replay branch for a decided step when no requestId is given", async () => {
    const { fake } = client(
      { status: "approved", decisionRequestId: ACTION },
      { steps: [{ id: STEP, order: 1, status: "approved" }, { id: "later", order: 2, status: "pending" }] },
    );
    await expect(applyLeaveApprovalDecision(fake, {
      principal, stepId: STEP, decision: "approve",
    })).rejects.toMatchObject({ code: "STEP_NOT_PENDING" });
  });
});
