export type OrganizationChangeSetStatus = "DRAFT" | "VALIDATED" | "PUBLISHED" | "DISCARDED";
export type VacancyPolicy = "CLIMB_TO_PARENT" | "REQUIRE_ACTING_OR_BLOCK" | "BLOCK";
export type IncumbencyKind = "PRIMARY" | "ACTING";
export type AuthoritySubjectKind = "NODE" | "POSITION";
export type AuthorityBindingType =
  | "SUPERVISORY_PARENT"
  | "LEADER"
  | "UNIT_APPROVER"
  | "GOVERNANCE_APPROVER"
  | "OVERSIGHT_PARENT";
export type OrganizationRolloutMode = "LEGACY" | "SHADOW" | "STRUCTURE";
export type ResolvedAuthoritySource =
  | "DIRECT_MANAGER"
  | "UNIT_APPROVER"
  | "GOVERNANCE_APPROVER"
  | "OVERSIGHT_PARENT";

export interface EffectivePeriod {
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface OrganizationChangeSet {
  id: string;
  name: string;
  effectiveOn: string;
  status: OrganizationChangeSetStatus;
  baseChangeSetId: string | null;
  validationReport: OrganizationValidationReport;
  createdByAccountId: string;
  createdAt: string;
  validatedAt: string | null;
  publishedAt: string | null;
  /** ORG-008-3b: increments on every draft mutation; the If-Match value for concurrent edits. */
  revision: number;
}

export interface OrganizationNode extends EffectivePeriod {
  id: string;
  /** ORG-008-6 (O-9): the imported unit that role scopes point at, when this unit is linked. */
  legacyUnitId?: string | null;
  /** ORG-005-1 (DRAFT D-5-2): the work location this unit works at; units below inherit it. */
  workLocationId?: string | null;
  stableKey: string;
  name: string;
  nodeType: string;
  parentNodeKey: string | null;
  active: boolean;
  visualRankOffset: number;
  integrationCode: string | null;
}

export interface OrganizationJobProfile extends EffectivePeriod {
  id: string;
  stableKey: string;
  name: string;
  active: boolean;
}

export interface OrganizationPosition extends EffectivePeriod {
  id: string;
  stableKey: string;
  nodeKey: string;
  title: string;
  parentPositionKey: string | null;
  singleIncumbent: boolean;
  vacancyPolicy: VacancyPolicy;
  active: boolean;
  visualRankOffset: number;
  /** Defaults to EMPLOYEE for snapshots created before migration 0020. */
  holderSource?: "EMPLOYEE" | "ACCOUNT";
  /** ORG-011: the seat default classification. Null until Human Capital assigns one; it
   * carries no authority and no money, and a placement of its own overrides it. */
  jobClassificationCode?: string | null;
}

export interface OrganizationMembership extends EffectivePeriod {
  id: string;
  employeeId: string;
  nodeKey: string;
  jobProfileKey: string | null;
  isPrimary: boolean;
}

export interface OrganizationIncumbency extends EffectivePeriod {
  id: string;
  positionKey: string;
  employeeId: string | null;
  accountId?: string | null;
  kind: IncumbencyKind;
  /** Explicit reporting anchor for employees with multiple structural positions. */
  isPrimaryStructural?: boolean;
  reason: string | null;
}

export interface OrganizationAuthorityBinding extends EffectivePeriod {
  id: string;
  subjectKind: AuthoritySubjectKind;
  subjectKey: string;
  bindingType: AuthorityBindingType;
  targetPositionKey: string;
  vacancyPolicy: VacancyPolicy;
}

export interface OrganizationReportingOverride extends EffectivePeriod {
  id: string;
  employeeId: string;
  managerPositionKey: string | null;
  managerEmployeeId: string | null;
  reason: string;
}

export interface OrganizationSnapshot {
  changeSet: OrganizationChangeSet;
  nodes: OrganizationNode[];
  jobProfiles: OrganizationJobProfile[];
  positions: OrganizationPosition[];
  memberships: OrganizationMembership[];
  incumbencies: OrganizationIncumbency[];
  authorityBindings: OrganizationAuthorityBinding[];
  reportingOverrides: OrganizationReportingOverride[];
}

export interface AuthorityEligibilityContext {
  effectiveDate: string;
  workflowKey?: string | undefined;
  requiredCapability?: string | undefined;
}

export interface AuthorityEligibilityResult {
  eligible: boolean;
  reason:
    | "EMPLOYEE_NOT_ACTIVE"
    | "ACCOUNT_NOT_ACTIVE"
    | "CAPABILITY_MISSING"
    | null;
}

export interface AuthorityEligibilityValidator {
  validate(
    employeeId: string,
    context: AuthorityEligibilityContext,
  ): Promise<AuthorityEligibilityResult>;
  /** ORG-012: classifies the account behind an account-held position. */
  validateAccount?(
    accountId: string,
    context: AccountEligibilityContext,
  ): Promise<AccountEligibilityResult>;
}

/** ORG-012-2: the capability an account principal needs for a Leave step (migration 0023). */
export const LEAVE_GOVERNANCE_CAPABILITY = "leave.governance.approve";

export interface AccountEligibilityContext {
  effectiveDate: string;
  /** Null for an informational recipient (oversight), which needs no capability. */
  requiredCapability: string | null;
}

/**
 * ORG-012-1. `EMPLOYEE` routes the seat to the linked employee principal;
 * `ACCOUNT` is an eligible Foundation Board principal; `INELIGIBLE` follows the
 * vacancy policy; `INVALID` and `CONFLICT` fail closed.
 */
export type AccountEligibilityResult =
  | { kind: "EMPLOYEE"; employeeId: string }
  | { kind: "ACCOUNT" }
  | { kind: "INELIGIBLE"; reason: "ACCOUNT_NOT_ACTIVE" | "CAPABILITY_MISSING" }
  | { kind: "INVALID" }
  | { kind: "CONFLICT"; reason: "ACCOUNT_IDENTITY_MISSING" | "ACCOUNT_EMAIL_MISSING" | "ACCOUNT_PERSON_IS_EMPLOYEE" };

export interface AuthorityResolutionInput {
  requesterEmployeeId: string;
  effectiveDate?: string | undefined;
  workflowKey?: string | undefined;
  requiredCapability?: string | undefined;
  /**
   * ORG-012: capability an account principal must hold. Account-held
   * positions resolve only when the caller sets it; otherwise they keep
   * failing with INVALID_AUTHORITY_PRINCIPAL.
   */
  accountCapability?: string | undefined;
}

export interface OversightResolutionInput {
  /** Final line/governance approver; ignored when `approverPositionKey` is set. */
  approverEmployeeId: string | null;
  /** ORG-012-4: the snapshotted position of the final step, used for account approvers. */
  approverPositionKey?: string | null | undefined;
  /** ORG-012-4: an account-held seat may receive the oversight notification. */
  allowAccountRecipient?: boolean | undefined;
  effectiveDate?: string | undefined;
  workflowKey?: string | undefined;
  requiredCapability?: string | undefined;
}

export interface ResolvedAuthority {
  /** Null only for an ORG-012 account principal, which then carries `accountId`. */
  employeeId: string | null;
  accountId?: string | null | undefined;
  source: ResolvedAuthoritySource;
  /** All semantic sources represented by this concrete, deduplicated approver. */
  sources?: ResolvedAuthoritySource[] | undefined;
  path: string[];
  incumbentKind: IncumbencyKind | "OVERRIDE";
  positionKey: string | null;
}

export interface ResolvedLineAuthorities {
  effectiveDate: string;
  changeSetId: string;
  governanceApplied: boolean;
  authorities: ResolvedAuthority[];
}

export interface LegacyAuthorityInput {
  directManagerEmployeeId: string | null;
  unitApproverEmployeeId: string | null;
}

export interface RolloutAuthorityInput extends AuthorityResolutionInput {
  workflowKey: string;
  legacy: LegacyAuthorityInput;
  authorityRequirement?: "LINE_AND_UNIT" | "UNIT_ONLY" | undefined;
}

export interface StructuralResolutionDiagnostic {
  matches: boolean;
  mismatchReasons: string[];
  structural?: ResolvedLineAuthorities | undefined;
  error?: { code: string; message: string } | undefined;
}

export interface RolloutAuthorityResult {
  mode: OrganizationRolloutMode;
  authoritativeSource: "LEGACY" | "STRUCTURE";
  authorities: ResolvedAuthority[];
  structure?: ResolvedLineAuthorities | undefined;
  shadow?: StructuralResolutionDiagnostic | undefined;
}

export interface OrganizationValidationIssue {
  code: string;
  message: string;
  entityType?: string | undefined;
  entityId?: string | undefined;
}

export interface OrganizationValidationReport {
  valid: boolean;
  issues: OrganizationValidationIssue[];
  checkedAt?: string | undefined;
}

export interface OrganizationImpactPreview {
  directManagerChanges: Array<{
    employeeId: string;
    beforeEmployeeId: string | null;
    afterEmployeeId: string | null;
  }>;
  unitApproverChanges: Array<{
    nodeKey: string;
    beforeEmployeeId: string | null;
    afterEmployeeId: string | null;
  }>;
  affectedAuthorityPaths: string[];
  vacantPositionKeys: string[];
  unresolvedEmployeeIds: string[];
  visualOnly: boolean;
  routingImpact: boolean;
  /** ORG-011: a seat classification changed. Decides compensation, never routing, so it is
   * reported apart from routingImpact and still prevents visualOnly. */
  compensationImpact: boolean;
}

export type OrganizationResolutionErrorCode =
  | "INVALID_EFFECTIVE_DATE"
  | "PRIMARY_STRUCTURAL_POSITION_NOT_CONFIGURED"
  | "INVALID_AUTHORITY_PRINCIPAL"
  | "STRUCTURE_NOT_CONFIGURED"
  | "MEMBERSHIP_NOT_CONFIGURED"
  | "AMBIGUOUS_MEMBERSHIP"
  | "POSITION_NOT_CONFIGURED"
  | "AUTHORITY_NOT_CONFIGURED"
  | "AUTHORITY_VACANT"
  | "ACTING_AUTHORITY_REQUIRED"
  | "AUTHORITY_INELIGIBLE"
  | "AUTHORITY_SELF_RESOLUTION"
  | "AUTHORITY_CYCLE"
  | "AUTHORITY_TRAVERSAL_LIMIT";

export class OrganizationResolutionError extends Error {
  constructor(
    public readonly code: OrganizationResolutionErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OrganizationResolutionError";
  }
}

export class OrganizationDraftError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** Item identifiers the caller turns into an operator sentence; never employee-sensitive data. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OrganizationDraftError";
  }
}

/**
 * ORG-008-3a: a published change set that the draft cannot contain, because it was published after
 * the draft cloned its base and takes effect no later than the draft does. Publishing the draft would
 * replace that content with the older snapshot it was built from.
 */
export interface OrganizationStaleBaseConflict {
  changeSetId: string;
  name: string;
  effectiveOn: string;
  publishedAt: string;
}
