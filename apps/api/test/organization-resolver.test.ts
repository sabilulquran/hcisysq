import { describe, expect, it, vi } from "vitest";

import {
  jakartaBusinessDate,
  OrganizationAuthorityResolver,
  OrganizationDraftService,
  OrganizationResolutionError,
  OrganizationRolloutService,
  PostgresOrganizationRepository,
  type AuthorityEligibilityResult,
  type OrganizationRolloutMode,
  type OrganizationSnapshot,
} from "../src/modules/organization/index.js";

const effectiveFrom = "2026-01-01";
const employeeIds = {
  staff: "employee-staff",
  staffTwo: "employee-staff-two",
  head: "employee-head",
  director: "employee-director",
  acting: "employee-acting",
  secretary: "employee-secretary",
  chair: "employee-chair",
};

function snapshot(
  overrides: Partial<OrganizationSnapshot> = {},
  id = "change-set-current",
): OrganizationSnapshot {
  return {
    changeSet: {
      id,
      name: "Synthetic structure",
      effectiveOn: effectiveFrom,
      status: "PUBLISHED",
      baseChangeSetId: null,
      validationReport: { valid: true, issues: [] },
      createdByAccountId: "admin",
      createdAt: "2026-01-01T00:00:00.000Z",
      validatedAt: "2026-01-01T00:00:00.000Z",
      publishedAt: "2026-01-01T00:00:00.000Z",
    },
    nodes: [
      node("node-root", null, 0),
      node("node-team", "node-root", 0),
    ],
    jobProfiles: [],
    positions: [
      position("position-director", "node-root", null),
      position("position-head", "node-team", "position-director"),
    ],
    memberships: [
      membership("membership-staff", employeeIds.staff),
      membership("membership-staff-two", employeeIds.staffTwo),
    ],
    incumbencies: [
      incumbency("incumbency-head", "position-head", employeeIds.head, "PRIMARY"),
      incumbency("incumbency-director", "position-director", employeeIds.director, "PRIMARY"),
    ],
    authorityBindings: [
      binding("binding-leader", "NODE", "node-team", "LEADER", "position-head"),
      binding("binding-unit", "NODE", "node-team", "UNIT_APPROVER", "position-director"),
    ],
    reportingOverrides: [],
    ...overrides,
  };
}

function node(stableKey: string, parentNodeKey: string | null, visualRankOffset: number) {
  return {
    id: `row-${stableKey}`,
    stableKey,
    name: stableKey,
    nodeType: "team",
    parentNodeKey,
    active: true,
    effectiveFrom,
    effectiveTo: null,
    visualRankOffset,
    integrationCode: null,
  };
}

function position(
  stableKey: string,
  nodeKey: string,
  parentPositionKey: string | null,
  visualRankOffset = 0,
) {
  return {
    id: `row-${stableKey}`,
    stableKey,
    nodeKey,
    title: stableKey,
    parentPositionKey,
    singleIncumbent: true,
    vacancyPolicy: "CLIMB_TO_PARENT" as const,
    active: true,
    effectiveFrom,
    effectiveTo: null,
    visualRankOffset,
  };
}

function membership(id: string, employeeId: string) {
  return {
    id,
    employeeId,
    nodeKey: "node-team",
    jobProfileKey: null,
    isPrimary: true,
    effectiveFrom,
    effectiveTo: null,
  };
}

function incumbency(
  id: string,
  positionKey: string,
  employeeId: string | null,
  kind: "PRIMARY" | "ACTING",
  from = effectiveFrom,
  to: string | null = null,
) {
  return {
    id,
    positionKey,
    employeeId,
    kind,
    effectiveFrom: from,
    effectiveTo: to,
    reason: kind === "ACTING" ? "Synthetic acting mandate" : null,
  };
}

function binding(
  id: string,
  subjectKind: "NODE" | "POSITION",
  subjectKey: string,
  bindingType: "SUPERVISORY_PARENT" | "LEADER" | "UNIT_APPROVER" | "GOVERNANCE_APPROVER" | "OVERSIGHT_PARENT",
  targetPositionKey: string,
) {
  return {
    id,
    subjectKind,
    subjectKey,
    bindingType,
    targetPositionKey,
    vacancyPolicy: "CLIMB_TO_PARENT" as const,
    effectiveFrom,
    effectiveTo: null,
  };
}

function resolver(
  structure: OrganizationSnapshot,
  ineligible = new Set<string>(),
): OrganizationAuthorityResolver {
  return new OrganizationAuthorityResolver(
    { loadEffectiveSnapshot: async () => structure },
    {
      eligibilityValidator: {
        validate: async (employeeId): Promise<AuthorityEligibilityResult> => ineligible.has(employeeId)
          ? { eligible: false, reason: "EMPLOYEE_NOT_ACTIVE" }
          : { eligible: true, reason: null },
      },
    },
  );
}

describe("ORG-004 authority resolver", () => {
  it("resolves one structural team leader for many members", async () => {
    const subject = resolver(snapshot());
    await expect(subject.resolveDirectManager({ requesterEmployeeId: employeeIds.staff, effectiveDate: "2026-08-22" }))
      .resolves.toMatchObject({ employeeId: employeeIds.head, source: "DIRECT_MANAGER" });
    await expect(subject.resolveDirectManager({ requesterEmployeeId: employeeIds.staffTwo, effectiveDate: "2026-08-22" }))
      .resolves.toMatchObject({ employeeId: employeeIds.head });
  });

  it("gives an effective employee reporting override precedence", async () => {
    const structure = snapshot({
      reportingOverrides: [{
        id: "override", employeeId: employeeIds.staff,
        managerPositionKey: null, managerEmployeeId: employeeIds.director,
        reason: "Documented exception", effectiveFrom, effectiveTo: null,
      }],
    });
    await expect(resolver(structure).resolveDirectManager({ requesterEmployeeId: employeeIds.staff, effectiveDate: "2026-08-22" }))
      .resolves.toMatchObject({ employeeId: employeeIds.director, incumbentKind: "OVERRIDE" });
  });

  it("climbs past one or two vacant positions", async () => {
    const oneVacancy = snapshot({
      incumbencies: [incumbency("director", "position-director", employeeIds.director, "PRIMARY")],
    });
    await expect(resolver(oneVacancy).resolveDirectManager({ requesterEmployeeId: employeeIds.staff, effectiveDate: "2026-08-22" }))
      .resolves.toMatchObject({ employeeId: employeeIds.director });

    const twoVacancies = snapshot({
      positions: [
        position("position-director", "node-root", null),
        position("position-affairs", "node-root", "position-director"),
        position("position-head", "node-team", "position-affairs"),
      ],
      incumbencies: [incumbency("director", "position-director", employeeIds.director, "PRIMARY")],
    });
    await expect(resolver(twoVacancies).resolveDirectManager({ requesterEmployeeId: employeeIds.staff, effectiveDate: "2026-08-22" }))
      .resolves.toMatchObject({ employeeId: employeeIds.director });
  });

  it("uses an effective acting incumbent and ignores an expired acting period", async () => {
    const structure = snapshot({
      incumbencies: [
        incumbency("acting", "position-head", employeeIds.acting, "ACTING", "2026-05-01", "2026-06-30"),
        incumbency("director", "position-director", employeeIds.director, "PRIMARY"),
      ],
    });
    await expect(resolver(structure).resolveDirectManager({ requesterEmployeeId: employeeIds.staff, effectiveDate: "2026-06-01" }))
      .resolves.toMatchObject({ employeeId: employeeIds.acting, incumbentKind: "ACTING" });
    await expect(resolver(structure).resolveDirectManager({ requesterEmployeeId: employeeIds.staff, effectiveDate: "2026-07-01" }))
      .resolves.toMatchObject({ employeeId: employeeIds.director });
  });

  it("detects cycles and bounded traversal safely", async () => {
    const structure = snapshot({
      positions: [
        position("position-director", "node-root", "position-head"),
        position("position-head", "node-team", "position-director"),
      ],
      incumbencies: [],
    });
    await expect(resolver(structure).resolveDirectManager({ requesterEmployeeId: employeeIds.staff, effectiveDate: "2026-08-22" }))
      .rejects.toMatchObject({ code: "AUTHORITY_CYCLE" });
  });

  it("skips an inactive incumbent only when vacancy climbing permits it", async () => {
    const structure = snapshot();
    await expect(resolver(structure, new Set([employeeIds.head])).resolveDirectManager({
      requesterEmployeeId: employeeIds.staff,
      effectiveDate: "2026-08-22",
    })).resolves.toMatchObject({ employeeId: employeeIds.director });

    structure.positions[1] = { ...structure.positions[1]!, vacancyPolicy: "BLOCK" };
    structure.authorityBindings[0] = { ...structure.authorityBindings[0]!, vacancyPolicy: "BLOCK" };
    await expect(resolver(structure, new Set([employeeIds.head])).resolveDirectManager({
      requesterEmployeeId: employeeIds.staff,
      effectiveDate: "2026-08-22",
    })).rejects.toMatchObject({ code: "AUTHORITY_INELIGIBLE" });
  });

  it("deduplicates a concrete approver while preserving both semantic sources", async () => {
    const structure = snapshot({
      authorityBindings: [
        binding("leader", "NODE", "node-team", "LEADER", "position-director"),
        binding("unit", "NODE", "node-team", "UNIT_APPROVER", "position-director"),
      ],
    });
    const result = await resolver(structure).resolveLineAuthorities({
      requesterEmployeeId: employeeIds.staff,
      effectiveDate: "2026-08-22",
    });
    expect(result.authorities).toHaveLength(1);
    expect(result.authorities[0]).toMatchObject({
      employeeId: employeeIds.director,
      source: "DIRECT_MANAGER",
      sources: ["DIRECT_MANAGER", "UNIT_APPROVER"],
    });
  });

  it("never uses node or position visual offsets in resolution", async () => {
    const normal = snapshot();
    const offset = snapshot({
      nodes: [node("node-root", null, 0), node("node-team", "node-root", 2)],
      positions: [
        position("position-director", "node-root", null, 4),
        position("position-head", "node-team", "position-director", 3),
      ],
    });
    const input = { requesterEmployeeId: employeeIds.staff, effectiveDate: "2026-08-22" };
    const first = await resolver(normal).resolveLineAuthorities(input);
    const second = await resolver(offset).resolveLineAuthorities(input);
    expect(second.authorities).toEqual(first.authorities);
  });

  it("resolves historical incumbents and does not activate a future snapshot early", async () => {
    const historical = snapshot({
      incumbencies: [
        incumbency("old", "position-head", employeeIds.head, "PRIMARY"),
        incumbency("director", "position-director", employeeIds.director, "PRIMARY"),
      ],
    }, "historical");
    const future = snapshot({
      incumbencies: [
        incumbency("new", "position-head", employeeIds.acting, "PRIMARY"),
        incumbency("director", "position-director", employeeIds.director, "PRIMARY"),
      ],
    }, "future");
    const subject = new OrganizationAuthorityResolver(
      { loadEffectiveSnapshot: async (date) => date < "2027-01-01" ? historical : future },
      { eligibilityValidator: { validate: async () => ({ eligible: true, reason: null }) } },
    );
    await expect(subject.resolveDirectManager({ requesterEmployeeId: employeeIds.staff, effectiveDate: "2026-12-31" }))
      .resolves.toMatchObject({ employeeId: employeeIds.head });
    await expect(subject.resolveDirectManager({ requesterEmployeeId: employeeIds.staff, effectiveDate: "2027-01-01" }))
      .resolves.toMatchObject({ employeeId: employeeIds.acting });
  });

  it("uses the explicit primary structural position as the reporting anchor", async () => {
    const structure = snapshot({
      positions: [
        position("position-director", "node-root", null),
        position("position-head", "node-team", "position-director"),
        position("position-secondary", "node-team", null),
      ],
      memberships: [membership("head-membership", employeeIds.head)],
      incumbencies: [
        { ...incumbency("head-primary", "position-head", employeeIds.head, "PRIMARY"), isPrimaryStructural: true },
        incumbency("head-secondary", "position-secondary", employeeIds.head, "PRIMARY"),
        incumbency("director", "position-director", employeeIds.director, "PRIMARY"),
      ],
      authorityBindings: [],
    });
    await expect(resolver(structure).resolveDirectManager({
      requesterEmployeeId: employeeIds.head,
      effectiveDate: "2026-08-22",
    })).resolves.toMatchObject({
      employeeId: employeeIds.director,
      path: ["position-head", "position-director"],
    });
  });

  it("fails closed instead of choosing a secondary structural position by row order", async () => {
    const structure = snapshot({
      positions: [
        position("position-director", "node-root", null),
        position("position-head", "node-team", "position-director"),
        position("position-secondary", "node-team", "position-director"),
      ],
      memberships: [membership("head-membership", employeeIds.head)],
      incumbencies: [
        incumbency("head-one", "position-head", employeeIds.head, "PRIMARY"),
        incumbency("head-two", "position-secondary", employeeIds.head, "PRIMARY"),
        incumbency("director", "position-director", employeeIds.director, "PRIMARY"),
      ],
      authorityBindings: [],
    });
    await expect(resolver(structure).resolveDirectManager({
      requesterEmployeeId: employeeIds.head,
      effectiveDate: "2026-08-22",
    })).rejects.toMatchObject({ code: "PRIMARY_STRUCTURAL_POSITION_NOT_CONFIGURED" });
  });

  it("preserves account-held incumbency data but refuses to activate it as structural routing", async () => {
    const structure = snapshot();
    structure.positions[1] = { ...structure.positions[1]!, holderSource: "ACCOUNT" };
    structure.incumbencies[0] = {
      ...structure.incumbencies[0]!,
      employeeId: null,
      accountId: "foundation-board-account",
    };
    await expect(resolver(structure).resolveDirectManager({
      requesterEmployeeId: employeeIds.staff,
      effectiveDate: "2026-08-22",
    })).rejects.toMatchObject({ code: "INVALID_AUTHORITY_PRINCIPAL" });
  });

  it("uses governance and oversight bindings without title checks", async () => {
    const structure = snapshot({
      positions: [
        position("position-director", "node-root", null),
        position("position-secretary", "node-root", null),
        position("position-chair", "node-root", null),
      ],
      memberships: [membership("director-membership", employeeIds.director)],
      incumbencies: [
        incumbency("director", "position-director", employeeIds.director, "PRIMARY"),
        incumbency("secretary", "position-secretary", employeeIds.secretary, "PRIMARY"),
        incumbency("chair", "position-chair", employeeIds.chair, "PRIMARY"),
      ],
      authorityBindings: [
        binding("governance", "POSITION", "position-director", "GOVERNANCE_APPROVER", "position-secretary"),
        binding("oversight", "POSITION", "position-secretary", "OVERSIGHT_PARENT", "position-chair"),
      ],
    });
    const subject = resolver(structure);
    const line = await subject.resolveLineAuthorities({
      requesterEmployeeId: employeeIds.director,
      effectiveDate: "2026-08-22",
    });
    expect(line.governanceApplied).toBe(true);
    expect(line.authorities).toEqual([
      expect.objectContaining({ employeeId: employeeIds.secretary, source: "GOVERNANCE_APPROVER" }),
    ]);
    await expect(subject.resolveOversightAbove({
      approverEmployeeId: employeeIds.secretary,
      effectiveDate: "2026-08-22",
    })).resolves.toMatchObject({ employeeId: employeeIds.chair, source: "OVERSIGHT_PARENT" });
  });

  it("rejects self resolution", async () => {
    const structure = snapshot({
      reportingOverrides: [{
        id: "invalid-self-override", employeeId: employeeIds.staff,
        managerPositionKey: null, managerEmployeeId: employeeIds.staff,
        reason: "Invalid synthetic override", effectiveFrom, effectiveTo: null,
      }],
    });
    await expect(resolver(structure).resolveDirectManager({
      requesterEmployeeId: employeeIds.staff,
      effectiveDate: "2026-08-22",
    })).rejects.toBeInstanceOf(OrganizationResolutionError);
  });

  it("uses Asia/Jakarta when deriving the business date", () => {
    expect(jakartaBusinessDate(new Date("2026-08-21T17:00:00.000Z"))).toBe("2026-08-22");
  });
});

describe("ORG-004 rollout service", () => {
  function rollout(mode: OrganizationRolloutMode, structure = snapshot()) {
    return new OrganizationRolloutService(
      { getRolloutMode: async () => mode },
      resolver(structure),
    );
  }
  const input = {
    workflowKey: "leave.annual",
    requesterEmployeeId: employeeIds.staff,
    effectiveDate: "2026-08-22",
    legacy: {
      directManagerEmployeeId: employeeIds.director,
      unitApproverEmployeeId: employeeIds.director,
    },
  };

  it("keeps LEGACY authoritative and deduplicates semantic sources", async () => {
    const result = await rollout("LEGACY").resolveAuthorities(input);
    expect(result.authoritativeSource).toBe("LEGACY");
    expect(result.authorities).toHaveLength(1);
    expect(result.authorities[0]).toMatchObject({
      source: "DIRECT_MANAGER",
      sources: ["DIRECT_MANAGER", "UNIT_APPROVER"],
    });
  });

  it("reports SHADOW differences while keeping legacy authority", async () => {
    const result = await rollout("SHADOW").resolveAuthorities(input);
    expect(result.authoritativeSource).toBe("LEGACY");
    expect(result.authorities.every((item) => item.employeeId === employeeIds.director)).toBe(true);
    expect(result.shadow?.matches).toBe(false);
  });

  it("uses STRUCTURE authoritatively and fails closed without configuration", async () => {
    const result = await rollout("STRUCTURE").resolveAuthorities(input);
    expect(result.authoritativeSource).toBe("STRUCTURE");
    expect(result.authorities[0]?.employeeId).toBe(employeeIds.head);

    const missing = snapshot({ authorityBindings: [] });
    await expect(rollout("STRUCTURE", missing).resolveAuthorities(input))
      .rejects.toMatchObject({ code: "AUTHORITY_NOT_CONFIGURED" });
  });

  it("allows UNIT_ONLY workflows without a Direct Manager", async () => {
    const structure = snapshot({
      authorityBindings: [binding("unit", "NODE", "node-team", "UNIT_APPROVER", "position-director")],
    });
    const result = await rollout("STRUCTURE", structure).resolveAuthorities({
      ...input,
      authorityRequirement: "UNIT_ONLY",
      legacy: { directManagerEmployeeId: null, unitApproverEmployeeId: employeeIds.director },
    });
    expect(result.authorities).toEqual([
      expect.objectContaining({ employeeId: employeeIds.director, source: "UNIT_APPROVER" }),
    ]);
  });
});

describe("ORG-004 draft validation and impact", () => {
  it("separates active structural employment from login eligibility", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM employees\n       WHERE id")) {
        expect(sql).toContain("removed_at IS NULL");
        return { rows: [{ employeeActive: true }], rowCount: 1 };
      }
      if (sql.includes("FROM employees e WHERE e.id")) {
        expect(sql).toContain("e.removed_at IS NULL");
        return {
          rows: [{ employeeActive: true, accountActive: false, capabilityValid: false }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected eligibility SQL: ${sql}`);
    });
    const repository = new PostgresOrganizationRepository({ query } as never);

    await expect(repository.validateStructuralIncumbent(employeeIds.head))
      .resolves.toEqual({ eligible: true, reason: null });
    await expect(repository.validate(employeeIds.head, {
      effectiveDate: "2026-08-22",
      requiredCapability: "leave.approve",
    })).resolves.toEqual({ eligible: false, reason: "ACCOUNT_NOT_ACTIVE" });
  });

  it("allows an active employee without a login account to be published as an incumbent", async () => {
    const draft = snapshot();
    draft.changeSet.status = "DRAFT";
    draft.changeSet.validatedAt = null;
    draft.changeSet.publishedAt = null;
    const fakeRepository = {
      loadChangeSetSnapshot: async () => draft,
      validateStructuralIncumbent: async () => ({ eligible: true, reason: null }),
      markValidated: async (_id: string, _actor: string, report: { valid: boolean }) => {
        draft.changeSet.status = report.valid ? "VALIDATED" : "DRAFT";
        draft.changeSet.validationReport = { valid: report.valid, issues: [] };
      },
      publishValidated: async () => {
        draft.changeSet.status = "PUBLISHED";
      },
    } as unknown as PostgresOrganizationRepository;
    const service = new OrganizationDraftService(fakeRepository);

    await expect(service.validateDraft(draft.changeSet.id, "admin"))
      .resolves.toMatchObject({ valid: true });
    await expect(service.publish(draft.changeSet.id, "admin")).resolves.toBeUndefined();
    expect(draft.changeSet.status).toBe("PUBLISHED");
  });

  it("fails closed when a structural Leave approver has no eligible account", async () => {
    const structure = snapshot();
    structure.positions[1] = { ...structure.positions[1]!, vacancyPolicy: "BLOCK" };
    structure.authorityBindings[0] = {
      ...structure.authorityBindings[0]!,
      vacancyPolicy: "BLOCK",
    };
    let accountReady = false;
    const subject = new OrganizationRolloutService(
      { getRolloutMode: async () => "STRUCTURE" },
      new OrganizationAuthorityResolver(
        { loadEffectiveSnapshot: async () => structure },
        {
          eligibilityValidator: {
            validate: async () => accountReady
              ? { eligible: true, reason: null }
              : { eligible: false, reason: "ACCOUNT_NOT_ACTIVE" },
          },
        },
      ),
    );
    const input = {
      workflowKey: "leave.annual",
      requesterEmployeeId: employeeIds.staff,
      effectiveDate: "2026-08-22",
      requiredCapability: "leave.approve",
      legacy: { directManagerEmployeeId: employeeIds.director, unitApproverEmployeeId: employeeIds.director },
    };

    await expect(subject.resolveAuthorities(input)).rejects.toMatchObject({
      code: "AUTHORITY_INELIGIBLE",
      details: expect.objectContaining({ lastIneligibility: "ACCOUNT_NOT_ACTIVE" }),
    });
    accountReady = true;
    await expect(subject.resolveAuthorities(input)).resolves.toMatchObject({
      authoritativeSource: "STRUCTURE",
      authorities: expect.arrayContaining([
        expect.objectContaining({ employeeId: employeeIds.head }),
      ]),
    });
  });

  it("treats a removed employee as ineligible for new structural authority without deleting history", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("removed_at IS NULL");
      return { rows: [{ employeeActive: false, accountActive: true, capabilityValid: true }], rowCount: 1 };
    });
    const repository = new PostgresOrganizationRepository({ query } as never);
    await expect(repository.validate(employeeIds.head, {
      effectiveDate: "2026-08-22",
      requiredCapability: "leave.approve",
    })).resolves.toEqual({ eligible: false, reason: "EMPLOYEE_NOT_ACTIVE" });
  });

  it("keeps an inactive employee invalid as an active incumbent", async () => {
    const draft = snapshot();
    draft.changeSet.status = "DRAFT";
    draft.changeSet.validatedAt = null;
    draft.changeSet.publishedAt = null;
    const fakeRepository = {
      loadChangeSetSnapshot: async () => draft,
      validateStructuralIncumbent: async (employeeId: string) => employeeId === employeeIds.head
        ? { eligible: false, reason: "EMPLOYEE_NOT_ACTIVE" }
        : { eligible: true, reason: null },
      markValidated: async () => undefined,
    } as unknown as PostgresOrganizationRepository;

    const report = await new OrganizationDraftService(fakeRepository)
      .validateDraft(draft.changeSet.id, "admin");
    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "INACTIVE_INCUMBENT",
      entityId: "incumbency-head",
    }));
  });

  it("rejects overlapping primary structural assignments for the same employee", async () => {
    const draft = snapshot({
      positions: [
        position("position-director", "node-root", null),
        position("position-head", "node-team", "position-director"),
        position("position-secondary", "node-team", "position-director"),
      ],
      incumbencies: [
        { ...incumbency("primary-one", "position-head", employeeIds.head, "PRIMARY"), isPrimaryStructural: true },
        { ...incumbency("primary-two", "position-secondary", employeeIds.head, "PRIMARY"), isPrimaryStructural: true },
        incumbency("director", "position-director", employeeIds.director, "PRIMARY"),
      ],
    });
    draft.changeSet.status = "DRAFT";
    const fakeRepository = {
      loadChangeSetSnapshot: async () => draft,
      validateStructuralIncumbent: async () => ({ eligible: true, reason: null }),
      markValidated: async () => undefined,
    } as unknown as PostgresOrganizationRepository;
    const report = await new OrganizationDraftService(fakeRepository).validateDraft(draft.changeSet.id, "admin");
    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "PRIMARY_STRUCTURAL_POSITION_OVERLAP",
    }));
  });

  it("rejects overlapping primary incumbencies during draft validation", async () => {
    const draft = snapshot({
      incumbencies: [
        incumbency("first", "position-head", employeeIds.head, "PRIMARY", "2026-01-01", "2026-12-31"),
        incumbency("second", "position-head", employeeIds.acting, "PRIMARY", "2026-06-01", null),
        incumbency("director", "position-director", employeeIds.director, "PRIMARY"),
      ],
    });
    draft.changeSet.status = "DRAFT";
    draft.changeSet.validatedAt = null;
    draft.changeSet.publishedAt = null;
    let persistedValid: boolean | null = null;
    const fakeRepository = {
      loadChangeSetSnapshot: async () => draft,
      validateStructuralIncumbent: async () => ({ eligible: true, reason: null }),
      markValidated: async (_id: string, _actor: string, report: { valid: boolean }) => {
        persistedValid = report.valid;
      },
    } as unknown as PostgresOrganizationRepository;
    const report = await new OrganizationDraftService(fakeRepository).validateDraft(draft.changeSet.id, "admin");
    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "PRIMARY_INCUMBENCY_OVERLAP" }));
    expect(persistedValid).toBe(false);
  });

  it("reports a pure visual-offset edit as having no routing impact", async () => {
    const before = snapshot({}, "base");
    const draft = snapshot({
      nodes: [node("node-root", null, 0), node("node-team", "node-root", 2)],
      positions: [
        position("position-director", "node-root", null, 1),
        position("position-head", "node-team", "position-director", 3),
      ],
    }, "draft");
    draft.changeSet.status = "DRAFT";
    draft.changeSet.baseChangeSetId = before.changeSet.id;
    draft.changeSet.validatedAt = null;
    draft.changeSet.publishedAt = null;
    const fakeRepository = {
      loadChangeSetSnapshot: async (id: string) => id === draft.changeSet.id ? draft : before,
      validate: async () => ({ eligible: true, reason: null }),
      validateStructuralIncumbent: async () => ({ eligible: true, reason: null }),
    } as unknown as PostgresOrganizationRepository;
    const impact = await new OrganizationDraftService(fakeRepository).previewImpact(draft.changeSet.id);
    expect(impact.visualOnly).toBe(true);
    expect(impact.routingImpact).toBe(false);
    expect(impact.directManagerChanges).toEqual([]);
    expect(impact.unitApproverChanges).toEqual([]);
  });
});
