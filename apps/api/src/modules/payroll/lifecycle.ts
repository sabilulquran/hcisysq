/**
 * PAY-003 v1 payroll period lifecycle.
 *
 * Pure transition rules: which actor may move a period from which state to which,
 * what must hold first, and what the transition records. No HTTP and no database,
 * so the same rules can be asserted directly and reused by any caller.
 *
 * Specification: docs/domain/payroll-calculation-v1.md section 6
 */

export const PERIOD_STATES = [
  "DRAFT",
  "COLLECTING",
  "CALCULATED",
  "SUBMITTED",
  "APPROVED",
  "PAYMENT_CONFIRMED",
  "PUBLISHED",
  "REOPEN_REQUESTED",
] as const;

export type PeriodState = (typeof PERIOD_STATES)[number];

export const PERIOD_ACTIONS = [
  "start_collecting",
  "calculate",
  "submit",
  "return",
  "approve",
  "confirm_payment",
  "publish",
  "request_reopen",
  "approve_reopen",
  "reject_reopen",
] as const;

export type PeriodAction = (typeof PERIOD_ACTIONS)[number];

export type PeriodPermission =
  | "payroll.periods.manage"
  | "payroll.calculate"
  | "payroll.submit"
  | "payroll.approve"
  | "payroll.reopen.approve"
  | "payroll.payments.confirm";

export type TransitionRule = {
  /** States the action may start from. */
  from: readonly PeriodState[];
  to: PeriodState | "state_before_reopen_request";
  permission: PeriodPermission;
  reasonRequired: boolean;
  auditAction: string;
  /** The actor must not be the account that submitted the period. */
  forbidsSubmitter?: true;
  /** The period must carry a calculation with no blocker. */
  requiresCleanCalculation?: true;
};

/**
 * One table, so a reader can see the whole lifecycle at once. REOPENED is not a
 * state: approving a reopen returns the period to COLLECTING in one transition,
 * which keeps every state owned by an actor and an audit event.
 */
export const TRANSITIONS: Readonly<Record<PeriodAction, TransitionRule>> = {
  start_collecting: {
    from: ["DRAFT"],
    to: "COLLECTING",
    permission: "payroll.periods.manage",
    reasonRequired: false,
    auditAction: "payroll.period.collecting",
  },
  calculate: {
    from: ["COLLECTING", "CALCULATED"],
    to: "CALCULATED",
    permission: "payroll.calculate",
    reasonRequired: false,
    auditAction: "payroll.period.calculated",
  },
  submit: {
    from: ["CALCULATED"],
    to: "SUBMITTED",
    permission: "payroll.submit",
    reasonRequired: false,
    auditAction: "payroll.period.submitted",
    requiresCleanCalculation: true,
  },
  return: {
    from: ["SUBMITTED"],
    to: "COLLECTING",
    permission: "payroll.approve",
    reasonRequired: true,
    auditAction: "payroll.period.returned",
  },
  approve: {
    from: ["SUBMITTED"],
    to: "APPROVED",
    permission: "payroll.approve",
    reasonRequired: false,
    auditAction: "payroll.period.approved",
    forbidsSubmitter: true,
    requiresCleanCalculation: true,
  },
  confirm_payment: {
    from: ["APPROVED"],
    to: "PAYMENT_CONFIRMED",
    permission: "payroll.payments.confirm",
    reasonRequired: false,
    auditAction: "payroll.payment.confirmed",
  },
  publish: {
    from: ["PAYMENT_CONFIRMED"],
    to: "PUBLISHED",
    permission: "payroll.periods.manage",
    reasonRequired: false,
    auditAction: "payroll.payslips.published",
  },
  request_reopen: {
    from: ["APPROVED", "PAYMENT_CONFIRMED", "PUBLISHED"],
    to: "REOPEN_REQUESTED",
    permission: "payroll.periods.manage",
    reasonRequired: true,
    auditAction: "payroll.reopen.requested",
  },
  approve_reopen: {
    from: ["REOPEN_REQUESTED"],
    to: "COLLECTING",
    permission: "payroll.reopen.approve",
    reasonRequired: false,
    auditAction: "payroll.reopen.approved",
  },
  reject_reopen: {
    from: ["REOPEN_REQUESTED"],
    to: "state_before_reopen_request",
    permission: "payroll.reopen.approve",
    reasonRequired: true,
    auditAction: "payroll.reopen.rejected",
  },
};

export type PeriodSnapshot = {
  state: PeriodState;
  stateBeforeReopenRequest: PeriodState | null;
  submittedByAccountId: string | null;
  /** True once the period has a calculation that is newer than every input. */
  hasCurrentCalculation: boolean;
  blockerCount: number;
};

export type TransitionActor = {
  accountId: string;
  organizationPermissions: readonly string[];
};

export type TransitionRefusal = {
  code:
    | "PAYROLL_FORBIDDEN"
    | "PAYROLL_STATE_CONFLICT"
    | "PAYROLL_REASON_REQUIRED"
    | "PAYROLL_SELF_APPROVAL"
    | "PAYROLL_BLOCKERS_PRESENT"
    | "PAYROLL_CALCULATION_STALE"
    | "PAYROLL_REOPEN_STATE_MISSING";
  message: string;
};

export type TransitionDecision =
  | { allowed: true; nextState: PeriodState; auditAction: string; alreadyThere: boolean }
  | { allowed: false; refusal: TransitionRefusal };

/**
 * Decides one transition. The order of the checks is the order a reviewer reads
 * them in: who you are, where the period is, then what the period must satisfy.
 */
export function decideTransition(
  action: PeriodAction,
  period: PeriodSnapshot,
  actor: TransitionActor,
  reason: string | null,
): TransitionDecision {
  const rule = TRANSITIONS[action];

  if (!actor.organizationPermissions.includes(rule.permission)) {
    return {
      allowed: false,
      refusal: {
        code: "PAYROLL_FORBIDDEN",
        message: "Anda tidak memiliki akses untuk tindakan ini.",
      },
    };
  }

  if (!rule.from.includes(period.state)) {
    return {
      allowed: false,
      refusal: {
        code: "PAYROLL_STATE_CONFLICT",
        message: `Periode berstatus ${period.state}; tindakan ini hanya berlaku dari ${rule.from.join(", ")}.`,
      },
    };
  }

  if (rule.reasonRequired && (reason === null || reason.trim().length === 0)) {
    return {
      allowed: false,
      refusal: { code: "PAYROLL_REASON_REQUIRED", message: "Alasan wajib diisi untuk tindakan ini." },
    };
  }

  if (rule.forbidsSubmitter && period.submittedByAccountId === actor.accountId) {
    return {
      allowed: false,
      refusal: {
        code: "PAYROLL_SELF_APPROVAL",
        message: "Akun yang mengajukan periode tidak dapat mengesahkannya.",
      },
    };
  }

  if (rule.requiresCleanCalculation) {
    if (!period.hasCurrentCalculation) {
      return {
        allowed: false,
        refusal: {
          code: "PAYROLL_CALCULATION_STALE",
          message: "Input berubah setelah perhitungan terakhir; hitung ulang periode lebih dulu.",
        },
      };
    }
    if (period.blockerCount > 0) {
      return {
        allowed: false,
        refusal: {
          code: "PAYROLL_BLOCKERS_PRESENT",
          message: `Periode masih memiliki ${period.blockerCount} blocker yang harus diselesaikan.`,
        },
      };
    }
  }

  let nextState: PeriodState;
  if (rule.to === "state_before_reopen_request") {
    if (period.stateBeforeReopenRequest === null) {
      return {
        allowed: false,
        refusal: {
          code: "PAYROLL_REOPEN_STATE_MISSING",
          message: "Status sebelum permintaan buka ulang tidak tercatat.",
        },
      };
    }
    nextState = period.stateBeforeReopenRequest;
  } else {
    nextState = rule.to;
  }

  // Recalculating a period that is already CALCULATED is the one transition that
  // legitimately ends where it started, and repeating any other action must not
  // move the period twice (specification section 6: operations are idempotent).
  return {
    allowed: true,
    nextState,
    auditAction: rule.auditAction,
    alreadyThere: period.state === nextState && action !== "calculate",
  };
}

/** The actions this actor could take on this period right now, for the UI. */
export function availableActions(
  period: PeriodSnapshot,
  actor: TransitionActor,
): PeriodAction[] {
  return PERIOD_ACTIONS.filter((action) => {
    const rule = TRANSITIONS[action];
    if (!actor.organizationPermissions.includes(rule.permission)) return false;
    if (!rule.from.includes(period.state)) return false;
    if (rule.forbidsSubmitter && period.submittedByAccountId === actor.accountId) return false;
    return true;
  });
}

/**
 * The cutoff window for a pay month, from the 23rd of the previous month to the
 * 22nd of the pay month (specification section 10 item 1). Human capital may
 * change it per period; this is only the default a new period starts with.
 */
export function defaultCutoffWindow(periodMonth: string): { start: string; end: string } {
  const match = /^(\d{4})-(\d{2})-01$/.exec(periodMonth);
  if (!match) throw new Error(`periodMonth must be the first day of a month, received ${periodMonth}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    start: `${previousYear}-${pad(previousMonth)}-23`,
    end: `${year}-${pad(month)}-22`,
  };
}

/** The last day of the pay month, as an Asia/Jakarta calendar date. */
export function monthEnd(periodMonth: string): string {
  const match = /^(\d{4})-(\d{2})-01$/.exec(periodMonth);
  if (!match) throw new Error(`periodMonth must be the first day of a month, received ${periodMonth}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return `${year}-${String(month).padStart(2, "0")}-${daysInMonth}`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
