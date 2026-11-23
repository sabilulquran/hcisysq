import type {
  ApprovalSeatTarget,
  AuthorityBindingType,
  AuthorityRequirement,
  AuthorityEligibilityValidator,
  AuthorityResolutionInput,
  OrganizationAuthorityBinding,
  OrganizationPosition,
  OrganizationSnapshot,
  OversightResolutionInput,
  ResolvedAuthority,
  ResolvedAuthoritySource,
  ResolvedLineAuthorities,
  VacancyPolicy,
} from "./domain.js";
import { OrganizationResolutionError } from "./domain.js";
import { effectiveDateOrToday, isEffective } from "./jakarta-date.js";

export interface OrganizationSnapshotReader {
  loadEffectiveSnapshot(effectiveDate: string): Promise<OrganizationSnapshot | null>;
}

/**
 * ORG-004 (DRAFT D-R5, 2026-11-23): alasan ketidaklayakan yang **tidak** boleh dibaca sebagai
 * kursi kosong.
 *
 * `CLIMB_TO_PARENT` berarti "kursi ini tidak ada yang menduduki, naik ke induknya". Itu benar
 * untuk kursi yang memang kosong. Tetapi kursi yang pejabatnya tertulis, orangnya ada, dan
 * pekerjaannya berjalan — hanya akunnya yang belum aktif atau izinnya belum diberikan — bukan
 * kursi kosong. Melewatinya diam-diam menghapus satu langkah persetujuan yang yayasan memang
 * konfigurasikan: pengajuannya tetap disetujui, pejabatnya tidak pernah melihatnya, dan tidak ada
 * satu pun pesan yang mengatakan demikian. Jadi untuk alasan di bawah ini resolusi menolak,
 * apa pun kebijakan kekosongannya.
 *
 * Yang **tidak** ada di sini, dan alasannya:
 *
 * - `EMPLOYEE_NOT_ACTIVE` — orangnya sudah tidak menjadi pegawai (keluar, `removed_at`), atau
 *   berada di luar pengelolaan HCIS (`management_scope <> 'MANAGED'`). Kursinya memang tidak lagi
 *   berpenghuni dalam arti yang sebenarnya, dan menunggu orang itu tidak akan pernah selesai;
 *   memanjat adalah kesinambungan yang benar. Ini juga keputusan EMP-005 S2B §8.7 yang sudah
 *   diterima, dan tidak diubah di sini.
 *
 * `INVALID` dan `CONFLICT` dari `validateAccount` tidak pernah lewat jalan ini: keduanya sudah
 * gagal tertutup sebelum kebijakan kekosongan sempat dibaca.
 */
const INELIGIBILITY_REFUSES_CLIMB: ReadonlySet<string> = new Set([
  "ACCOUNT_NOT_ACTIVE",
  "CAPABILITY_MISSING",
]);

/** Siapa yang ditemukan tidak layak, supaya penolakannya dapat menyebut kursi dan orangnya. */
interface IneligibleIncumbent {
  reason: string;
  positionKey: string;
  positionTitle: string;
  employeeId: string | null;
  accountId: string | null;
}

/**
 * Detail penolakan yang dipakai pemanggil untuk menyusun kalimat berbahasa Indonesia: kursinya,
 * alasannya, dan principal-nya. Nama orang tidak ada di sini — resolver tidak membaca data
 * pegawai — jadi pemanggil yang memegang basis data yang mencarinya.
 */
function ineligibleDetails(found: IneligibleIncumbent | null): Record<string, unknown> {
  if (!found) return {};
  return {
    ineligibleReason: found.reason,
    ineligiblePositionKey: found.positionKey,
    ineligiblePositionTitle: found.positionTitle,
    ineligibleEmployeeId: found.employeeId,
    ineligibleAccountId: found.accountId,
  };
}

export interface OrganizationAuthorityResolverOptions {
  eligibilityValidator?: AuthorityEligibilityValidator | undefined;
  maxTraversalDepth?: number | undefined;
}

interface ResolutionContext {
  snapshot: OrganizationSnapshot;
  effectiveDate: string;
  requesterEmployeeId: string;
  workflowKey?: string | undefined;
  requiredCapability?: string | undefined;
  /** Undefined: account seats fail closed. Null: allowed without a capability (oversight). */
  accountCapability?: string | null | undefined;
}

export class OrganizationAuthorityResolver {
  private readonly eligibilityValidator: AuthorityEligibilityValidator;
  private readonly maxTraversalDepth: number;

  constructor(
    private readonly repository: OrganizationSnapshotReader,
    options: OrganizationAuthorityResolverOptions = {},
  ) {
    const repositoryValidator = repository as OrganizationSnapshotReader &
      Partial<AuthorityEligibilityValidator>;
    const validator = options.eligibilityValidator ??
      (typeof repositoryValidator.validate === "function" ? repositoryValidator : undefined);
    if (!validator) {
      throw new Error("OrganizationAuthorityResolver requires an eligibility validator.");
    }
    this.eligibilityValidator = validator as AuthorityEligibilityValidator;
    this.maxTraversalDepth = options.maxTraversalDepth ?? 32;
  }

  async resolveLineAuthorities(
    input: AuthorityResolutionInput,
    authorityRequirement: AuthorityRequirement = "LINE_AND_UNIT",
    approvalSeats: readonly ApprovalSeatTarget[] = [],
  ): Promise<ResolvedLineAuthorities> {
    const context = await this.context(input);
    if (authorityRequirement === "UNIT_AND_APPROVAL_SEATS") {
      return this.resolveSeatChainInContext(context, approvalSeats);
    }
    const governance = await this.resolveGovernanceInContext(context);
    if (governance) {
      return {
        effectiveDate: context.effectiveDate,
        changeSetId: context.snapshot.changeSet.id,
        governanceApplied: true,
        authorities: [governance],
      };
    }

    const directManager = authorityRequirement === "LINE_AND_UNIT"
      ? await this.resolveDirectManagerInContext(context)
      : null;
    const unitApprover = await this.resolveUnitApproverInContext(context);
    const authorities: ResolvedAuthority[] = [];
    if (directManager) appendAuthority(authorities, directManager);
    if (unitApprover) appendAuthority(authorities, unitApprover);
    return {
      effectiveDate: context.effectiveDate,
      changeSetId: context.snapshot.changeSet.id,
      governanceApplied: false,
      authorities,
    };
  }

  /**
   * LOAN-002 (owner decision 2026-11-18): the requester's unit approver, then the fixed seats the
   * caller names, in the caller's order.
   *
   * Three deliberate differences from the Leave chains:
   * - No GOVERNANCE_APPROVER short-circuit. That binding replaces the whole chain, which would
   *   silently drop the seats the owner put in it.
   * - A seat never climbs to its parent. `BLOCK` is forced whatever the position's own vacancy
   *   policy says, so a vacant Direktur never resolves to whoever sits above Direktur.
   * - Self-approval fails closed instead of dropping the step. A seatholder's own request would
   *   otherwise travel a chain shorter than the one the owner decided (employee-loans.md §16 D-19).
   */
  private async resolveSeatChainInContext(
    context: ResolutionContext,
    approvalSeats: readonly ApprovalSeatTarget[],
  ): Promise<ResolvedLineAuthorities> {
    // LOAN-002 M2 (D-20 DRAFT): rungs are NOT merged here, unlike every other chain. If one person
    // holds two of them — the likeliest case being a Staf Keuangan whose unit approver is the
    // Kepala Keuangan — merging would quietly turn the owner's five approvals into four, with one
    // signature carrying two mandates and nothing on screen, in the audit or in the history saying
    // so. The owner named five seats, not "five seats unless it is the same person". So both rungs
    // stand, the same person approves twice, and that is visible.
    const authorities: ResolvedAuthority[] = [];
    const unitApprover = await this.resolveUnitApproverInContext(context, true);
    if (unitApprover) authorities.push({ ...unitApprover, sources: [unitApprover.source] });
    for (const seat of approvalSeats) {
      const authority = await this.resolvePosition(
        context, seat.positionKey, "BLOCK", seat.source, [`seat:${seat.source}`],
      );
      authorities.push({ ...authority, sources: [authority.source] });
    }
    return {
      effectiveDate: context.effectiveDate,
      changeSetId: context.snapshot.changeSet.id,
      governanceApplied: false,
      authorities,
    };
  }

  async resolveDirectManager(input: AuthorityResolutionInput): Promise<ResolvedAuthority> {
    return this.resolveDirectManagerInContext(await this.context(input));
  }

  async resolveUnitApprover(input: AuthorityResolutionInput): Promise<ResolvedAuthority | null> {
    return this.resolveUnitApproverInContext(await this.context(input));
  }

  async resolveGovernanceApprover(
    input: AuthorityResolutionInput,
  ): Promise<ResolvedAuthority | null> {
    return this.resolveGovernanceInContext(await this.context(input));
  }

  async resolveOversightAbove(input: OversightResolutionInput): Promise<ResolvedAuthority | null> {
    const effectiveDate = effectiveDateOrToday(input.effectiveDate);
    const snapshot = await this.repository.loadEffectiveSnapshot(effectiveDate);
    if (!snapshot) return null;
    const context: ResolutionContext = {
      snapshot,
      effectiveDate,
      requesterEmployeeId: input.approverEmployeeId ?? "",
      workflowKey: input.workflowKey,
      requiredCapability: input.requiredCapability,
      ...(input.allowAccountRecipient ? { accountCapability: null } : {}),
    };
    // ORG-013-4: an account approver has no employee id, so its snapshotted
    // position anchors the oversight lookup instead.
    const candidates = input.approverPositionKey
      ? context.snapshot.positions.filter((item) => item.stableKey === input.approverPositionKey
        && item.active && isEffective(item.effectiveFrom, item.effectiveTo, context.effectiveDate))
      : input.approverEmployeeId
        ? this.employeePositions(context, input.approverEmployeeId)
        : [];
    const positions = candidates
      .filter((position) => this.binding(context, "POSITION", position.stableKey, "OVERSIGHT_PARENT"));
    if (positions.length === 0) return null;
    if (positions.length > 1) {
      throw new OrganizationResolutionError(
        "AUTHORITY_NOT_CONFIGURED",
        "Approver has more than one applicable oversight relationship.",
        { approverEmployeeId: input.approverEmployeeId, approverPositionKey: input.approverPositionKey ?? null },
      );
    }
    const position = positions[0]!;
    const binding = this.binding(context, "POSITION", position.stableKey, "OVERSIGHT_PARENT")!;
    return this.resolvePosition(
      context,
      binding.targetPositionKey,
      binding.vacancyPolicy,
      "OVERSIGHT_PARENT",
      [position.stableKey],
    );
  }

  private async context(input: AuthorityResolutionInput): Promise<ResolutionContext> {
    const effectiveDate = effectiveDateOrToday(input.effectiveDate);
    const snapshot = await this.repository.loadEffectiveSnapshot(effectiveDate);
    if (!snapshot) {
      throw new OrganizationResolutionError(
        "STRUCTURE_NOT_CONFIGURED",
        "No published organization structure is effective on this date.",
        { effectiveDate },
      );
    }
    return {
      snapshot,
      effectiveDate,
      requesterEmployeeId: input.requesterEmployeeId,
      workflowKey: input.workflowKey,
      requiredCapability: input.requiredCapability,
      accountCapability: input.accountCapability,
    };
  }

  private async resolveDirectManagerInContext(
    context: ResolutionContext,
  ): Promise<ResolvedAuthority> {
    const overrides = context.snapshot.reportingOverrides.filter(
      (item) => item.employeeId === context.requesterEmployeeId
        && isEffective(item.effectiveFrom, item.effectiveTo, context.effectiveDate),
    );
    if (overrides.length > 1) {
      throw new OrganizationResolutionError(
        "AUTHORITY_NOT_CONFIGURED",
        "Multiple reporting overrides are effective for the employee.",
        { employeeId: context.requesterEmployeeId },
      );
    }
    const override = overrides[0];
    if (override?.managerEmployeeId) {
      await this.assertEligible(context, override.managerEmployeeId, "reporting-override");
      this.assertNotSelf(context, override.managerEmployeeId, "DIRECT_MANAGER");
      return {
        employeeId: override.managerEmployeeId,
        source: "DIRECT_MANAGER",
        path: [`override:${override.id}`],
        incumbentKind: "OVERRIDE",
        positionKey: null,
      };
    }
    if (override?.managerPositionKey) {
      return this.resolvePosition(
        context,
        override.managerPositionKey,
        this.position(context, override.managerPositionKey).vacancyPolicy,
        "DIRECT_MANAGER",
        [`override:${override.id}`],
      );
    }

    const incumbentPositions = this.employeePositions(context, context.requesterEmployeeId);
    const supervisedPositions = this.reportingPositions(context, incumbentPositions).filter((position) =>
      position.parentPositionKey !== null
      || this.binding(context, "POSITION", position.stableKey, "SUPERVISORY_PARENT") !== null,
    );
    if (supervisedPositions.length > 1) {
      throw new OrganizationResolutionError(
        "AUTHORITY_NOT_CONFIGURED",
        "Employee has multiple applicable structural reporting positions.",
        { employeeId: context.requesterEmployeeId },
      );
    }
    if (supervisedPositions.length === 1) {
      const ownPosition = supervisedPositions[0]!;
      const supervisorBinding = this.binding(
        context, "POSITION", ownPosition.stableKey, "SUPERVISORY_PARENT",
      );
      const parentKey = supervisorBinding?.targetPositionKey ?? ownPosition.parentPositionKey;
      if (!parentKey) return this.unresolved("Direct manager", context);
      return this.resolvePosition(
        context,
        parentKey,
        supervisorBinding?.vacancyPolicy ?? ownPosition.vacancyPolicy,
        "DIRECT_MANAGER",
        [ownPosition.stableKey],
      );
    }

    const membership = this.primaryMembership(context);
    const { binding, path } = this.findNodeBinding(context, membership.nodeKey, "LEADER");
    return this.resolvePosition(
      context,
      binding.targetPositionKey,
      binding.vacancyPolicy,
      "DIRECT_MANAGER",
      path,
    );
  }

  /**
   * LOAN-002 M1: `selfIsError` tells apart two things the caller used to see as one.
   *
   * Dropping the unit approver when it resolves to the requester is right for Leave, where the
   * direct-manager rung still carries the request. On a chain where the unit approver is the first
   * rung, dropping it reads downstream as "unit approver not configured" — so a unit head's own
   * request would blame a configuration that is in fact correct, and HC would hunt a fault that
   * does not exist. The seat chain asks for the error instead, and says what is actually the case.
   */
  private async resolveUnitApproverInContext(
    context: ResolutionContext,
    selfIsError = false,
  ): Promise<ResolvedAuthority | null> {
    const membership = this.primaryMembership(context);
    const { binding, path } = this.findNodeBinding(context, membership.nodeKey, "UNIT_APPROVER");
    const authority = await this.resolvePosition(
      context,
      binding.targetPositionKey,
      binding.vacancyPolicy,
      "UNIT_APPROVER",
      path,
      true,
    );
    if (selfIsError && authority.employeeId !== null
        && authority.employeeId === context.requesterEmployeeId) {
      throw new OrganizationResolutionError(
        "AUTHORITY_SELF_RESOLUTION",
        "The unit approver of this request is the requester.",
        { employeeId: authority.employeeId, source: "UNIT_APPROVER", positionKey: authority.positionKey },
      );
    }
    return authority.employeeId !== null && authority.employeeId === context.requesterEmployeeId
      ? null
      : authority;
  }

  private async resolveGovernanceInContext(
    context: ResolutionContext,
  ): Promise<ResolvedAuthority | null> {
    const positions = this.employeePositions(context, context.requesterEmployeeId)
      .filter((position) => this.binding(
        context, "POSITION", position.stableKey, "GOVERNANCE_APPROVER",
      ));
    if (positions.length === 0) return null;
    if (positions.length > 1) {
      throw new OrganizationResolutionError(
        "AUTHORITY_NOT_CONFIGURED",
        "Employee has multiple applicable governance approval bindings.",
        { employeeId: context.requesterEmployeeId },
      );
    }
    const ownPosition = positions[0]!;
    const binding = this.binding(
      context, "POSITION", ownPosition.stableKey, "GOVERNANCE_APPROVER",
    )!;
    return this.resolvePosition(
      context,
      binding.targetPositionKey,
      binding.vacancyPolicy,
      "GOVERNANCE_APPROVER",
      [ownPosition.stableKey],
    );
  }

  private async resolvePosition(
    context: ResolutionContext,
    initialPositionKey: string,
    initialVacancyPolicy: VacancyPolicy,
    source: ResolvedAuthoritySource,
    initialPath: string[],
    allowSelf = false,
  ): Promise<ResolvedAuthority> {
    let positionKey: string | null = initialPositionKey;
    let policy = initialVacancyPolicy;
    const seen = new Set<string>();
    const path = [...initialPath];
    let lastIneligibility: string | null = null;
    let lastIneligible: IneligibleIncumbent | null = null;

    for (let depth = 0; positionKey !== null; depth += 1) {
      /** Ketidaklayakan yang menolak pendakian, bila ditemukan pada kursi yang sedang dibaca. */
      let refusedHere: IneligibleIncumbent | null = null;
      if (depth >= this.maxTraversalDepth) {
        throw new OrganizationResolutionError(
          "AUTHORITY_TRAVERSAL_LIMIT",
          "Organization authority traversal exceeded its safe bound.",
          { path },
        );
      }
      if (seen.has(positionKey)) {
        throw new OrganizationResolutionError(
          "AUTHORITY_CYCLE",
          "Organization authority traversal encountered a cycle.",
          { path: [...path, positionKey] },
        );
      }
      seen.add(positionKey);
      path.push(positionKey);
      const position = this.position(context, positionKey);
      const incumbencies = context.snapshot.incumbencies.filter(
        (item) => item.positionKey === positionKey
          && isEffective(item.effectiveFrom, item.effectiveTo, context.effectiveDate),
      );

      for (const kind of ["PRIMARY", "ACTING"] as const) {
        const candidates = incumbencies.filter((item) => item.kind === kind);
        if (candidates.length > 1) {
          throw new OrganizationResolutionError(
            "AUTHORITY_NOT_CONFIGURED",
            `Multiple ${kind.toLowerCase()} incumbents are effective for one position.`,
            { positionKey },
          );
        }
        const candidate = candidates[0];
        if (!candidate) continue;
        const accountHeld = (position.holderSource ?? "EMPLOYEE") === "ACCOUNT";
        if (accountHeld || candidate.accountId) {
          // ORG-013-1: only an account row in an account-held seat may resolve,
          // and only for callers that name the account capability.
          if (!accountHeld || !candidate.accountId || candidate.employeeId
              || context.accountCapability === undefined || !this.eligibilityValidator.validateAccount) {
            throw new OrganizationResolutionError(
              "INVALID_AUTHORITY_PRINCIPAL",
              "Account-held organization authority is preserved but not activated for structural routing.",
              { positionKey, accountId: candidate.accountId ?? null, source },
            );
          }
          const account = await this.eligibilityValidator.validateAccount(candidate.accountId, {
            effectiveDate: context.effectiveDate,
            requiredCapability: context.accountCapability,
          });
          if (account.kind === "INVALID") {
            throw new OrganizationResolutionError(
              "INVALID_AUTHORITY_PRINCIPAL",
              "Account-held position names an account that cannot hold structural authority.",
              { positionKey, accountId: candidate.accountId, source },
            );
          }
          if (account.kind === "CONFLICT") {
            throw new OrganizationResolutionError(
              "AUTHORITY_NOT_CONFIGURED",
              "Foundation Board account cannot be told apart from an employee.",
              { positionKey, accountId: candidate.accountId, reason: account.reason, source },
            );
          }
          if (account.kind === "INELIGIBLE") {
            lastIneligibility = account.reason;
            lastIneligible = {
              reason: account.reason,
              positionKey,
              positionTitle: position.title,
              employeeId: null,
              accountId: candidate.accountId,
            };
            if (INELIGIBILITY_REFUSES_CLIMB.has(account.reason)) refusedHere ??= lastIneligible;
            continue;
          }
          if (account.kind === "ACCOUNT") {
            return {
              employeeId: null,
              accountId: candidate.accountId,
              source,
              path,
              incumbentKind: kind,
              positionKey,
            };
          }
          const linked = await this.eligibilityValidator.validate(account.employeeId, {
            effectiveDate: context.effectiveDate,
            workflowKey: context.workflowKey,
            requiredCapability: context.requiredCapability,
          });
          if (!linked.eligible) {
            lastIneligibility = linked.reason;
            if (linked.reason) {
              lastIneligible = {
                reason: linked.reason,
                positionKey,
                positionTitle: position.title,
                employeeId: account.employeeId,
                accountId: candidate.accountId,
              };
              if (INELIGIBILITY_REFUSES_CLIMB.has(linked.reason)) refusedHere ??= lastIneligible;
            }
            continue;
          }
          if (!allowSelf) this.assertNotSelf(context, account.employeeId, source);
          return {
            employeeId: account.employeeId,
            source,
            path,
            incumbentKind: kind,
            positionKey,
          };
        }
        if (!candidate.employeeId) {
          throw new OrganizationResolutionError(
            "INVALID_AUTHORITY_PRINCIPAL",
            "Employee-held position has no employee incumbent.",
            { positionKey, source },
          );
        }
        const eligibility = await this.eligibilityValidator.validate(candidate.employeeId, {
          effectiveDate: context.effectiveDate,
          workflowKey: context.workflowKey,
          requiredCapability: context.requiredCapability,
        });
        if (!eligibility.eligible) {
          lastIneligibility = eligibility.reason;
          if (eligibility.reason) {
            lastIneligible = {
              reason: eligibility.reason,
              positionKey,
              positionTitle: position.title,
              employeeId: candidate.employeeId,
              accountId: null,
            };
            if (INELIGIBILITY_REFUSES_CLIMB.has(eligibility.reason)) refusedHere ??= lastIneligible;
          }
          continue;
        }
        if (!allowSelf) this.assertNotSelf(context, candidate.employeeId, source);
        return {
          employeeId: candidate.employeeId,
          source,
          path,
          incumbentKind: kind,
          positionKey,
        };
      }

      if (policy === "REQUIRE_ACTING_OR_BLOCK") {
        throw new OrganizationResolutionError(
          "ACTING_AUTHORITY_REQUIRED",
          "The position requires an effective acting incumbent before authority can resolve.",
          { positionKey, lastIneligibility, source, ...ineligibleDetails(lastIneligible) },
        );
      }
      // ORG-004 (DRAFT D-R5): `refusedHere` adalah satu-satunya tambahan pada baris ini. Kursi
      // yang pejabatnya ada tetapi belum layak karena keadaan akunnya menolak sekalipun
      // kebijakannya `CLIMB_TO_PARENT`; kursi yang benar-benar kosong tetap memanjat seperti dulu.
      if (policy === "BLOCK" || refusedHere) {
        throw new OrganizationResolutionError(
          lastIneligibility ? "AUTHORITY_INELIGIBLE" : "AUTHORITY_VACANT",
          lastIneligibility
            ? "The configured incumbent is not eligible for this authority."
            : "The configured authority position is vacant.",
          {
            positionKey,
            lastIneligibility,
            source,
            ...ineligibleDetails(refusedHere ?? lastIneligible),
          },
        );
      }

      const parentBinding = this.binding(
        context, "POSITION", positionKey, "SUPERVISORY_PARENT",
      );
      positionKey = parentBinding?.targetPositionKey ?? position.parentPositionKey;
      policy = parentBinding?.vacancyPolicy ?? position.vacancyPolicy;
    }
    throw new OrganizationResolutionError(
      lastIneligibility ? "AUTHORITY_INELIGIBLE" : "AUTHORITY_VACANT",
      "No eligible incumbent was found before the organization root.",
      { path, lastIneligibility, source, ...ineligibleDetails(lastIneligible) },
    );
  }

  private primaryMembership(context: ResolutionContext) {
    const memberships = context.snapshot.memberships.filter(
      (item) => item.employeeId === context.requesterEmployeeId && item.isPrimary
        && isEffective(item.effectiveFrom, item.effectiveTo, context.effectiveDate),
    );
    if (memberships.length === 0) {
      throw new OrganizationResolutionError(
        "MEMBERSHIP_NOT_CONFIGURED",
        "Employee has no effective primary organization membership.",
        { employeeId: context.requesterEmployeeId },
      );
    }
    if (memberships.length > 1) {
      throw new OrganizationResolutionError(
        "AMBIGUOUS_MEMBERSHIP",
        "Employee has multiple effective primary organization memberships.",
        { employeeId: context.requesterEmployeeId },
      );
    }
    return memberships[0]!;
  }

  private findNodeBinding(
    context: ResolutionContext,
    initialNodeKey: string,
    bindingType: "LEADER" | "UNIT_APPROVER",
  ): { binding: OrganizationAuthorityBinding; path: string[] } {
    const seen = new Set<string>();
    const path: string[] = [];
    let nodeKey: string | null = initialNodeKey;
    for (let depth = 0; nodeKey !== null; depth += 1) {
      if (depth >= this.maxTraversalDepth) {
        throw new OrganizationResolutionError(
          "AUTHORITY_TRAVERSAL_LIMIT",
          "Organization node traversal exceeded its safe bound.", { path },
        );
      }
      if (seen.has(nodeKey)) {
        throw new OrganizationResolutionError(
          "AUTHORITY_CYCLE", "Organization node traversal encountered a cycle.",
          { path: [...path, nodeKey] },
        );
      }
      seen.add(nodeKey);
      path.push(nodeKey);
      const node = context.snapshot.nodes.find(
        (item) => item.stableKey === nodeKey && item.active
          && isEffective(item.effectiveFrom, item.effectiveTo, context.effectiveDate),
      );
      if (!node) {
        throw new OrganizationResolutionError(
          "AUTHORITY_NOT_CONFIGURED", "Organization node is not effective.", { nodeKey },
        );
      }
      const binding = this.binding(context, "NODE", nodeKey, bindingType);
      if (binding) return { binding, path };
      nodeKey = node.parentNodeKey;
    }
    throw new OrganizationResolutionError(
      "AUTHORITY_NOT_CONFIGURED",
      `${bindingType === "LEADER" ? "Structural leader" : "Unit approver"} is not configured.`,
      { initialNodeKey },
    );
  }

  private binding(
    context: ResolutionContext,
    subjectKind: "NODE" | "POSITION",
    subjectKey: string,
    bindingType: AuthorityBindingType,
  ): OrganizationAuthorityBinding | null {
    const bindings = context.snapshot.authorityBindings.filter(
      (item) => item.subjectKind === subjectKind && item.subjectKey === subjectKey
        && item.bindingType === bindingType
        && isEffective(item.effectiveFrom, item.effectiveTo, context.effectiveDate),
    );
    if (bindings.length > 1) {
      throw new OrganizationResolutionError(
        "AUTHORITY_NOT_CONFIGURED", "Multiple authority bindings are effective for one subject.",
        { subjectKind, subjectKey, bindingType },
      );
    }
    return bindings[0] ?? null;
  }

  private employeePositions(context: ResolutionContext, employeeId: string): OrganizationPosition[] {
    const keys = new Set(
      context.snapshot.incumbencies
        .filter((item) => item.employeeId === employeeId
          && isEffective(item.effectiveFrom, item.effectiveTo, context.effectiveDate))
        .map((item) => item.positionKey),
    );
    return context.snapshot.positions.filter(
      (item) => keys.has(item.stableKey) && item.active
        && isEffective(item.effectiveFrom, item.effectiveTo, context.effectiveDate),
    );
  }

  // A person may hold multiple positions. Only an explicitly marked primary
  // structural incumbency anchors requester reporting; secondary assignments
  // remain available for explicit authority bindings but never win by row order.
  private reportingPositions(
    context: ResolutionContext,
    positions: OrganizationPosition[],
  ): OrganizationPosition[] {
    if (positions.length <= 1) return positions;
    const primaryKeys = new Set(
      context.snapshot.incumbencies
        .filter((item) => item.employeeId === context.requesterEmployeeId
          && item.kind === "PRIMARY"
          && item.isPrimaryStructural
          && isEffective(item.effectiveFrom, item.effectiveTo, context.effectiveDate))
        .map((item) => item.positionKey),
    );
    if (primaryKeys.size !== 1) {
      throw new OrganizationResolutionError(
        "PRIMARY_STRUCTURAL_POSITION_NOT_CONFIGURED",
        "Employee has multiple effective structural positions but no single primary structural position is configured.",
        {
          employeeId: context.requesterEmployeeId,
          positionKeys: positions.map((item) => item.stableKey),
        },
      );
    }
    return positions.filter((item) => primaryKeys.has(item.stableKey));
  }

  private position(context: ResolutionContext, positionKey: string): OrganizationPosition {
    const position = context.snapshot.positions.find(
      (item) => item.stableKey === positionKey && item.active
        && isEffective(item.effectiveFrom, item.effectiveTo, context.effectiveDate),
    );
    if (!position) {
      throw new OrganizationResolutionError(
        "POSITION_NOT_CONFIGURED", "Authority position is not effective.", { positionKey },
      );
    }
    return position;
  }

  private async assertEligible(
    context: ResolutionContext,
    employeeId: string,
    path: string,
  ): Promise<void> {
    const eligibility = await this.eligibilityValidator.validate(employeeId, {
      effectiveDate: context.effectiveDate,
      workflowKey: context.workflowKey,
      requiredCapability: context.requiredCapability,
    });
    if (!eligibility.eligible) {
      throw new OrganizationResolutionError(
        "AUTHORITY_INELIGIBLE", "Configured authority employee is not eligible.",
        {
          employeeId,
          reason: eligibility.reason,
          path,
          ineligibleReason: eligibility.reason,
          ineligibleEmployeeId: employeeId,
          ineligibleAccountId: null,
        },
      );
    }
  }

  private assertNotSelf(
    context: ResolutionContext,
    employeeId: string,
    source: ResolvedAuthoritySource,
  ): void {
    if (employeeId === context.requesterEmployeeId) {
      throw new OrganizationResolutionError(
        "AUTHORITY_SELF_RESOLUTION", "Authority resolution cannot resolve to the requester.",
        { employeeId, source },
      );
    }
  }

  private unresolved(label: string, context: ResolutionContext): never {
    throw new OrganizationResolutionError(
      "AUTHORITY_NOT_CONFIGURED", `${label} is not configured.`,
      { employeeId: context.requesterEmployeeId },
    );
  }
}

function appendAuthority(
  authorities: ResolvedAuthority[],
  candidate: ResolvedAuthority,
): void {
  // ORG-013-1: dedupe by principal, so two different account approvers never merge.
  const existing = authorities.find((item) => candidate.employeeId
    ? item.employeeId === candidate.employeeId
    : !item.employeeId && item.accountId === candidate.accountId);
  if (!existing) {
    authorities.push({ ...candidate, sources: [candidate.source] });
    return;
  }

  const sources = existing.sources ?? [existing.source];
  if (!sources.includes(candidate.source)) existing.sources = [...sources, candidate.source];
}
