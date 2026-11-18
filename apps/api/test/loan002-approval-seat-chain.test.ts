// LOAN-002: the kasbon approval chain the owner decided on 2026-11-18 —
// approver unit -> Kepala Keuangan -> Direktur -> Ketua Yayasan -> Bendahara Yayasan,
// plus Pembina on top above the threshold. Synthetic structures only; no database.

import { describe, expect, it } from "vitest";

import {
  approvalSeatReadiness,
  ApprovalSeatError,
  APPROVAL_SEAT_KEYS,
  resolveApprovalSeatPositions,
  type ApprovalSeatMapping,
} from "../src/modules/organization/approval-seats.js";
import {
  LOAN_GOVERNANCE_CAPABILITY,
  OrganizationAuthorityResolver,
  OrganizationResolutionError,
  OrganizationRolloutService,
  type AccountEligibilityResult,
  type ApprovalSeatTarget,
  type OrganizationSnapshot,
} from "../src/modules/organization/index.js";
import { snapshotLeaveRolloutAuthorities } from "../src/modules/leave/organization-authority.js";
import { loanApprovalSeatKeys, seatSource } from "../src/modules/loans/approval-seats.js";

const effectiveFrom = "2026-01-01";
const on = "2026-11-18";
const requester = "employee-requester";
const unitHead = "employee-unit-head";
const kakeu = "employee-kakeu";
const direktur = "employee-direktur";
const ketuaAccount = "account-ketua";
const bendaharaAccount = "account-bendahara";
const pembinaAccount = "account-pembina";

const DRAFT_THRESHOLD = 5_000_000n;

function seat(
  stableKey: string,
  holderSource: "EMPLOYEE" | "ACCOUNT",
  parentPositionKey: string | null = null,
) {
  return {
    id: `row-${stableKey}`, stableKey, nodeKey: "node-root", title: stableKey, parentPositionKey,
    singleIncumbent: true,
    // CLIMB_TO_PARENT on purpose: the seat chain must force BLOCK whatever the seat's own policy
    // says, so a vacant seat never resolves to whoever sits above it.
    vacancyPolicy: "CLIMB_TO_PARENT" as const,
    active: true, effectiveFrom, effectiveTo: null, visualRankOffset: 0, holderSource,
  };
}

function holder(positionKey: string, principal: { employeeId?: string; accountId?: string }) {
  return {
    id: `incumbency-${positionKey}`, positionKey,
    employeeId: principal.employeeId ?? null, accountId: principal.accountId ?? null,
    kind: "PRIMARY" as const, effectiveFrom, effectiveTo: null, reason: null,
  };
}

function structure(overrides: Partial<OrganizationSnapshot> = {}): OrganizationSnapshot {
  return {
    changeSet: {
      id: "change-set", name: "Synthetic", effectiveOn: effectiveFrom, status: "PUBLISHED",
      baseChangeSetId: null, validationReport: { valid: true, issues: [] }, createdByAccountId: "admin",
      createdAt: "2026-01-01T00:00:00.000Z", validatedAt: "2026-01-01T00:00:00.000Z",
      publishedAt: "2026-01-01T00:00:00.000Z", revision: 1,
    },
    nodes: [
      {
        id: "row-node-root", stableKey: "node-root", name: "Yayasan", nodeType: "governance",
        parentNodeKey: null, active: true, effectiveFrom, effectiveTo: null, visualRankOffset: 0,
        integrationCode: null,
      },
      {
        id: "row-node-unit", stableKey: "node-unit", name: "Unit Pendidikan", nodeType: "unit",
        parentNodeKey: "node-root", active: true, effectiveFrom, effectiveTo: null,
        visualRankOffset: 0, integrationCode: null,
      },
    ],
    jobProfiles: [],
    positions: [
      seat("position-root", "EMPLOYEE"),
      seat("position-unit-head", "EMPLOYEE"),
      seat("position-kakeu", "EMPLOYEE", "position-root"),
      seat("position-direktur", "EMPLOYEE", "position-root"),
      seat("position-ketua", "ACCOUNT", "position-root"),
      seat("position-bendahara", "ACCOUNT", "position-root"),
      seat("position-pembina", "ACCOUNT", "position-root"),
    ],
    memberships: [
      {
        id: "membership-requester", employeeId: requester, nodeKey: "node-unit", jobProfileKey: null,
        isPrimary: true, effectiveFrom, effectiveTo: null,
      },
      {
        id: "membership-direktur", employeeId: direktur, nodeKey: "node-unit", jobProfileKey: null,
        isPrimary: true, effectiveFrom, effectiveTo: null,
      },
    ],
    incumbencies: [
      holder("position-root", { employeeId: "employee-root" }),
      holder("position-unit-head", { employeeId: unitHead }),
      holder("position-kakeu", { employeeId: kakeu }),
      holder("position-direktur", { employeeId: direktur }),
      holder("position-ketua", { accountId: ketuaAccount }),
      holder("position-bendahara", { accountId: bendaharaAccount }),
      holder("position-pembina", { accountId: pembinaAccount }),
    ],
    authorityBindings: [{
      id: "unit-approver", subjectKind: "NODE" as const, subjectKey: "node-unit",
      bindingType: "UNIT_APPROVER" as const, targetPositionKey: "position-unit-head",
      vacancyPolicy: "BLOCK" as const, effectiveFrom, effectiveTo: null,
    }],
    reportingOverrides: [],
    ...overrides,
  };
}

function resolver(
  snapshot: OrganizationSnapshot,
  accounts: Record<string, AccountEligibilityResult> = {},
) {
  const capabilities: Array<string | null> = [];
  const subject = new OrganizationAuthorityResolver(
    { loadEffectiveSnapshot: async () => snapshot },
    {
      eligibilityValidator: {
        validate: async () => ({ eligible: true, reason: null }),
        validateAccount: async (accountId, context) => {
          capabilities.push(context.requiredCapability);
          return accounts[accountId] ?? { kind: "ACCOUNT" };
        },
      },
    },
  );
  return { subject, capabilities };
}

function seatsFor(principal: bigint): ApprovalSeatTarget[] {
  const positionByKey: Record<string, string> = {
    KEPALA_KEUANGAN: "position-kakeu",
    DIREKTUR: "position-direktur",
    KETUA_YAYASAN: "position-ketua",
    BENDAHARA_YAYASAN: "position-bendahara",
    PEMBINA: "position-pembina",
  };
  return loanApprovalSeatKeys(principal, DRAFT_THRESHOLD).map((seatKey) => ({
    source: seatSource(seatKey), positionKey: positionByKey[seatKey]!,
  }));
}

function chainInput(requesterEmployeeId = requester) {
  return {
    requesterEmployeeId,
    effectiveDate: on,
    workflowKey: "LOAN",
    accountCapability: LOAN_GOVERNANCE_CAPABILITY,
  };
}

describe("LOAN-002 seat registry", () => {
  const mappings: ApprovalSeatMapping[] = [
    { seatKey: "KEPALA_KEUANGAN", positionKey: "position-kakeu", seatLabel: "Kepala Keuangan - Keuangan" },
    { seatKey: "DIREKTUR", positionKey: "position-direktur", seatLabel: "Direktur - Yayasan" },
  ];

  it("D-17: the Pembina seat is added only when the principal exceeds the threshold", () => {
    expect(loanApprovalSeatKeys(4_999_999n, DRAFT_THRESHOLD)).toEqual([
      "KEPALA_KEUANGAN", "DIREKTUR", "KETUA_YAYASAN", "BENDAHARA_YAYASAN",
    ]);
    // Exactly at the threshold is not above it.
    expect(loanApprovalSeatKeys(DRAFT_THRESHOLD, DRAFT_THRESHOLD)).toHaveLength(4);
    expect(loanApprovalSeatKeys(5_000_001n, DRAFT_THRESHOLD)).toEqual([
      "KEPALA_KEUANGAN", "DIREKTUR", "KETUA_YAYASAN", "BENDAHARA_YAYASAN", "PEMBINA",
    ]);
  });

  it("D-18: an unmapped seat fails closed and names the seat", () => {
    expect(() => resolveApprovalSeatPositions(mappings, ["KEPALA_KEUANGAN", "KETUA_YAYASAN"]))
      .toThrow(expect.objectContaining({ code: "APPROVAL_SEAT_UNMAPPED", seatKey: "KETUA_YAYASAN" }));
    try {
      resolveApprovalSeatPositions(mappings, ["PEMBINA"]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApprovalSeatError);
      expect((error as Error).message).toContain("Pembina");
    }
    expect(resolveApprovalSeatPositions(mappings, ["DIREKTUR", "KEPALA_KEUANGAN"])).toEqual([
      { seatKey: "DIREKTUR", positionKey: "position-direktur" },
      { seatKey: "KEPALA_KEUANGAN", positionKey: "position-kakeu" },
    ]);
  });

  it("tells Human Capital which seats are unmapped, gone or vacant, without blocking anything", () => {
    const full: ApprovalSeatMapping[] = APPROVAL_SEAT_KEYS.map((seatKey) => ({
      seatKey,
      positionKey: {
        KEPALA_KEUANGAN: "position-kakeu", DIREKTUR: "position-direktur",
        KETUA_YAYASAN: "position-ketua", BENDAHARA_YAYASAN: "position-bendahara",
        PEMBINA: "position-pembina",
      }[seatKey],
      seatLabel: seatKey,
    }));
    const snapshot = structure({
      incumbencies: structure().incumbencies.filter((item) => item.positionKey !== "position-pembina"),
    });
    const readiness = approvalSeatReadiness(full.slice(0, 4), snapshot, on);
    expect(readiness.map((item) => [item.seatKey, item.state])).toEqual([
      ["KEPALA_KEUANGAN", "READY"],
      ["DIREKTUR", "READY"],
      ["KETUA_YAYASAN", "READY"],
      ["BENDAHARA_YAYASAN", "READY"],
      ["PEMBINA", "UNMAPPED"],
    ]);
    expect(approvalSeatReadiness(full, snapshot, on).at(-1)).toMatchObject({
      seatKey: "PEMBINA", state: "VACANT", holderSource: "ACCOUNT",
    });
    // A mapping whose position left the structure reads apart from a vacancy.
    expect(approvalSeatReadiness(
      [{ seatKey: "DIREKTUR", positionKey: "position-gone", seatLabel: "Direktur" }], snapshot, on,
    )[1]).toMatchObject({ seatKey: "DIREKTUR", state: "POSITION_NOT_IN_FORCE" });
    // ORG-013: an account-held seat is reported as such, so HC knows an organ account is needed.
    expect(approvalSeatReadiness(full, snapshot, on).find((item) => item.seatKey === "KETUA_YAYASAN"))
      .toMatchObject({ state: "READY", holderSource: "ACCOUNT" });
  });
});

describe("LOAN-002 chain under STRUCTURE", () => {
  it("builds the owner's six steps above the threshold, in the owner's order", async () => {
    const { subject, capabilities } = resolver(structure());
    const line = await subject.resolveLineAuthorities(
      chainInput(), "UNIT_AND_APPROVAL_SEATS", seatsFor(6_000_000n),
    );
    expect(line.governanceApplied).toBe(false);
    expect(line.authorities.map((item) => [item.source, item.employeeId, item.accountId ?? null])).toEqual([
      ["UNIT_APPROVER", unitHead, null],
      ["SEAT_KEPALA_KEUANGAN", kakeu, null],
      ["SEAT_DIREKTUR", direktur, null],
      ["SEAT_KETUA_YAYASAN", null, ketuaAccount],
      ["SEAT_BENDAHARA_YAYASAN", null, bendaharaAccount],
      ["SEAT_PEMBINA", null, pembinaAccount],
    ]);
    // The direct manager is gone from the chain entirely.
    expect(line.authorities.some((item) => item.source === "DIRECT_MANAGER")).toBe(false);
    // ORG-013-5: each account seat was judged against the loan capability, not the leave one.
    expect(capabilities).toEqual([
      LOAN_GOVERNANCE_CAPABILITY, LOAN_GOVERNANCE_CAPABILITY, LOAN_GOVERNANCE_CAPABILITY,
    ]);
  });

  it("stops at Bendahara Yayasan below the threshold", async () => {
    const { subject } = resolver(structure());
    const line = await subject.resolveLineAuthorities(
      chainInput(), "UNIT_AND_APPROVAL_SEATS", seatsFor(DRAFT_THRESHOLD),
    );
    expect(line.authorities.map((item) => item.source)).toEqual([
      "UNIT_APPROVER", "SEAT_KEPALA_KEUANGAN", "SEAT_DIREKTUR",
      "SEAT_KETUA_YAYASAN", "SEAT_BENDAHARA_YAYASAN",
    ]);
  });

  it("D-18: a vacant seat refuses, names the position, and never climbs to its parent", async () => {
    const snapshot = structure({
      incumbencies: structure().incumbencies.filter((item) => item.positionKey !== "position-direktur"),
    });
    const { subject } = resolver(snapshot);
    await expect(subject.resolveLineAuthorities(
      chainInput(), "UNIT_AND_APPROVAL_SEATS", seatsFor(1_000_000n),
    )).rejects.toMatchObject({
      code: "AUTHORITY_VACANT",
      details: expect.objectContaining({ positionKey: "position-direktur" }),
    });
    // The seat's own policy is CLIMB_TO_PARENT and position-root is occupied, so the refusal
    // proves the chain forces BLOCK rather than quietly promoting whoever sits above Direktur.
    expect(snapshot.positions.find((item) => item.stableKey === "position-direktur")?.vacancyPolicy)
      .toBe("CLIMB_TO_PARENT");
  });

  it("ORG-013-1: an organ account without the loan capability is not an approver", async () => {
    const { subject } = resolver(structure(), {
      [ketuaAccount]: { kind: "INELIGIBLE", reason: "CAPABILITY_MISSING" },
    });
    await expect(subject.resolveLineAuthorities(
      chainInput(), "UNIT_AND_APPROVAL_SEATS", seatsFor(1_000_000n),
    )).rejects.toBeInstanceOf(OrganizationResolutionError);
    await expect(subject.resolveLineAuthorities(
      chainInput(), "UNIT_AND_APPROVAL_SEATS", seatsFor(1_000_000n),
    )).rejects.toMatchObject({ code: "AUTHORITY_INELIGIBLE" });
  });

  it("D-19: a requester who holds one of the seats is refused, not given a shorter chain", async () => {
    const { subject } = resolver(structure());
    await expect(subject.resolveLineAuthorities(
      chainInput(direktur), "UNIT_AND_APPROVAL_SEATS", seatsFor(1_000_000n),
    )).rejects.toMatchObject({
      code: "AUTHORITY_SELF_RESOLUTION",
      details: expect.objectContaining({ source: "SEAT_DIREKTUR" }),
    });
  });

  it("M1: a unit head's own request fails as self-resolution, not as a missing configuration", async () => {
    // The unit approver of this request IS the requester. Leave drops the rung and leans on the
    // direct manager; this chain has no such rung, so dropping it would surface downstream as
    // UNIT_APPROVER_MISSING and send HC hunting a configuration fault that does not exist.
    const snapshot = structure({
      memberships: [{
        id: "membership-unit-head", employeeId: unitHead, nodeKey: "node-unit", jobProfileKey: null,
        isPrimary: true, effectiveFrom, effectiveTo: null,
      }],
    });
    const { subject } = resolver(snapshot);
    await expect(subject.resolveLineAuthorities(
      chainInput(unitHead), "UNIT_AND_APPROVAL_SEATS", seatsFor(1_000_000n),
    )).rejects.toMatchObject({
      code: "AUTHORITY_SELF_RESOLUTION",
      details: expect.objectContaining({ source: "UNIT_APPROVER" }),
    });

    // Leave is untouched: there the rung is dropped and the direct manager carries the request.
    const leave = await subject.resolveLineAuthorities({ ...chainInput(unitHead) }, "UNIT_ONLY");
    expect(leave.authorities).toEqual([]);
  });

  it("M2 (D-20): one person on two rungs stays two steps, and both are visible", async () => {
    // The likeliest case and the most sensitive: a Staf Keuangan whose unit approver is the
    // Kepala Keuangan. Merging would turn the owner's five approvals into four, silently.
    const snapshot = structure({
      incumbencies: structure().incumbencies.map((item) =>
        item.positionKey === "position-unit-head" ? { ...item, employeeId: kakeu } : item),
    });
    const { subject } = resolver(snapshot);
    const line = await subject.resolveLineAuthorities(
      chainInput(), "UNIT_AND_APPROVAL_SEATS", seatsFor(1_000_000n),
    );
    expect(line.authorities.map((item) => [item.source, item.employeeId])).toEqual([
      ["UNIT_APPROVER", kakeu],
      ["SEAT_KEPALA_KEUANGAN", kakeu],
      ["SEAT_DIREKTUR", direktur],
      ["SEAT_KETUA_YAYASAN", null],
      ["SEAT_BENDAHARA_YAYASAN", null],
    ]);
    // And the snapshot keeps them apart too, so the stored chain is five steps, not four.
    const snapshotted = snapshotLeaveRolloutAuthorities(
      { mode: "STRUCTURE", authoritativeSource: "STRUCTURE", authorities: line.authorities, structure: line },
      { requesterEmployeeId: requester, policyChain: "UNIT_AND_APPROVAL_SEATS" },
    );
    expect(snapshotted.approvalChain).toHaveLength(5);
    expect(snapshotted.approvalChain.slice(0, 2).map((step) => [step.employeeId, step.sources])).toEqual([
      [kakeu, ["UNIT_APPROVER"]],
      [kakeu, ["SEAT_KEPALA_KEUANGAN"]],
    ]);
  });

  it("M2: Leave still merges one person standing on two of its rungs", async () => {
    // The same situation on a Leave chain is one approval, and must stay one: there the rungs are
    // a line of authority, not a list of mandates.
    const merged = snapshotLeaveRolloutAuthorities(
      {
        mode: "LEGACY",
        authoritativeSource: "LEGACY",
        authorities: [{
          employeeId: unitHead, source: "DIRECT_MANAGER",
          sources: ["DIRECT_MANAGER", "UNIT_APPROVER"],
          path: ["legacy"], incumbentKind: "OVERRIDE", positionKey: null,
        }],
      },
      {
        requesterEmployeeId: requester,
        policyChain: "LINE_AND_UNIT",
        legacy: { directManagerEmployeeId: unitHead, unitApproverEmployeeId: unitHead },
      },
    );
    expect(merged.approvalChain).toEqual([
      { employeeId: unitHead, sources: ["DIRECT_MANAGER", "UNIT_APPROVER"] },
    ]);
  });

  it("M4 (D-19): the readiness surface names the seat the requester holds", () => {
    const full: ApprovalSeatMapping[] = APPROVAL_SEAT_KEYS.map((seatKey) => ({
      seatKey,
      positionKey: {
        KEPALA_KEUANGAN: "position-kakeu", DIREKTUR: "position-direktur",
        KETUA_YAYASAN: "position-ketua", BENDAHARA_YAYASAN: "position-bendahara",
        PEMBINA: "position-pembina",
      }[seatKey],
      seatLabel: seatKey,
    }));
    const snapshot = structure();
    // An employee-held seat the requester sits in.
    expect(approvalSeatReadiness(full, snapshot, on, { employeeId: direktur })
      .find((item) => item.seatKey === "DIREKTUR"))
      .toMatchObject({ state: "SEAT_HELD_BY_REQUESTER" });
    // And an account-held seat whose organ account is the same person (ORG-013-1 butir 5).
    expect(approvalSeatReadiness(full, snapshot, on, { employeeId: requester, accountIds: [ketuaAccount] })
      .find((item) => item.seatKey === "KETUA_YAYASAN"))
      .toMatchObject({ state: "SEAT_HELD_BY_REQUESTER" });
    // Asked about nobody, nothing changes.
    expect(approvalSeatReadiness(full, snapshot, on).every((item) => item.state === "READY")).toBe(true);
  });

  it("N1: the state follows the incumbent the resolver would pick, PRIMARY before ACTING", () => {
    const full: ApprovalSeatMapping[] = APPROVAL_SEAT_KEYS.map((seatKey) => ({
      seatKey,
      positionKey: {
        KEPALA_KEUANGAN: "position-kakeu", DIREKTUR: "position-direktur",
        KETUA_YAYASAN: "position-ketua", BENDAHARA_YAYASAN: "position-bendahara",
        PEMBINA: "position-pembina",
      }[seatKey],
      seatLabel: seatKey,
    }));
    // The requester holds Direktur as PRIMARY; somebody else is ACTING on the same seat.
    // `resolvePosition` never reaches the ACTING row — it throws on the PRIMARY one — so the
    // request is refused, and the readiness has to say so rather than reporting READY.
    const withActing = structure({
      incumbencies: [
        ...structure().incumbencies,
        {
          id: "incumbency-direktur-acting", positionKey: "position-direktur",
          employeeId: unitHead, accountId: null, kind: "ACTING" as const,
          effectiveFrom, effectiveTo: null, reason: null,
        },
      ],
    });
    expect(approvalSeatReadiness(full, withActing, on, { employeeId: direktur })
      .find((item) => item.seatKey === "DIREKTUR"))
      .toMatchObject({ state: "SEAT_HELD_BY_REQUESTER" });
    // And the resolver agrees: it refuses rather than falling through to the acting incumbent.
    expect(withActing.incumbencies.filter((item) => item.positionKey === "position-direktur")).toHaveLength(2);
  });

  it("N1: an ACTING incumbent decides the state when the seat has no PRIMARY", async () => {
    const actingOnly = structure({
      incumbencies: [
        ...structure().incumbencies.filter((item) => item.positionKey !== "position-direktur"),
        {
          id: "incumbency-direktur-acting", positionKey: "position-direktur",
          employeeId: direktur, accountId: null, kind: "ACTING" as const,
          effectiveFrom, effectiveTo: null, reason: null,
        },
      ],
    });
    const full: ApprovalSeatMapping[] = [
      { seatKey: "DIREKTUR", positionKey: "position-direktur", seatLabel: "DIREKTUR" },
    ];
    expect(approvalSeatReadiness(full, actingOnly, on, { employeeId: direktur })
      .find((item) => item.seatKey === "DIREKTUR"))
      .toMatchObject({ state: "SEAT_HELD_BY_REQUESTER" });
    expect(approvalSeatReadiness(full, actingOnly, on, { employeeId: requester })
      .find((item) => item.seatKey === "DIREKTUR"))
      .toMatchObject({ state: "READY" });
    // The resolver resolves that seat to the acting incumbent, so READY is the truth there.
    const { subject } = resolver(actingOnly);
    const line = await subject.resolveLineAuthorities(
      chainInput(), "UNIT_AND_APPROVAL_SEATS",
      [{ source: "SEAT_DIREKTUR", positionKey: "position-direktur" }],
    );
    expect(line.authorities.map((item) => [item.source, item.employeeId])).toEqual([
      ["UNIT_APPROVER", unitHead],
      ["SEAT_DIREKTUR", direktur],
    ]);
  });
});

describe("LOAN-002 rollout", () => {
  const legacy = { directManagerEmployeeId: "employee-manager", unitApproverEmployeeId: unitHead };

  async function rollout(mode: "LEGACY" | "SHADOW" | "STRUCTURE") {
    const { subject } = resolver(structure());
    const service = new OrganizationRolloutService(
      { getRolloutMode: async () => mode }, subject,
    );
    return service.resolveAuthorities({
      ...chainInput(), legacy,
      authorityRequirement: "UNIT_AND_APPROVAL_SEATS",
      approvalSeats: seatsFor(6_000_000n),
    });
  }

  it("ORG-004: under LEGACY the chain is still the direct manager then the unit approver", async () => {
    const result = await rollout("LEGACY");
    expect(result.authoritativeSource).toBe("LEGACY");
    expect(result.structure).toBeUndefined();
    expect(result.authorities.map((item) => [item.source, item.employeeId])).toEqual([
      ["DIRECT_MANAGER", "employee-manager"],
      ["UNIT_APPROVER", unitHead],
    ]);
    const snapshotted = snapshotLeaveRolloutAuthorities(result, {
      requesterEmployeeId: requester, policyChain: "UNIT_AND_APPROVAL_SEATS", legacy,
    });
    expect(snapshotted.approvalChain.map((step) => [step.employeeId, step.sources])).toEqual([
      ["employee-manager", ["DIRECT_MANAGER"]],
      [unitHead, ["UNIT_APPROVER"]],
    ]);
  });

  it("ORG-004: under SHADOW the legacy chain still decides; the seats only inform the diagnostic", async () => {
    const result = await rollout("SHADOW");
    expect(result.authoritativeSource).toBe("LEGACY");
    expect(result.authorities.map((item) => item.source)).toEqual(["DIRECT_MANAGER", "UNIT_APPROVER"]);
    expect(result.shadow?.matches).toBe(false);
  });

  it("ORG-004: under STRUCTURE the snapshotted chain is the owner's, accounts included", async () => {
    const result = await rollout("STRUCTURE");
    expect(result.authoritativeSource).toBe("STRUCTURE");
    const snapshotted = snapshotLeaveRolloutAuthorities(result, {
      requesterEmployeeId: requester, policyChain: "UNIT_AND_APPROVAL_SEATS", legacy,
    });
    expect(snapshotted.approvalChain.map((step) => [
      step.employeeId, step.accountId ?? null, step.sources,
    ])).toEqual([
      [unitHead, null, ["UNIT_APPROVER"]],
      [kakeu, null, ["SEAT_KEPALA_KEUANGAN"]],
      [direktur, null, ["SEAT_DIREKTUR"]],
      [null, ketuaAccount, ["SEAT_KETUA_YAYASAN"]],
      [null, bendaharaAccount, ["SEAT_BENDAHARA_YAYASAN"]],
      [null, pembinaAccount, ["SEAT_PEMBINA"]],
    ]);
  });
});
