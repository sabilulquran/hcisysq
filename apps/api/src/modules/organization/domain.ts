export type OrganizationChangeSetStatus = "DRAFT" | "VALIDATED" | "PUBLISHED";
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
}

export interface OrganizationNode extends EffectivePeriod {
  id: string;
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
}

export interface AuthorityResolutionInput {
  requesterEmployeeId: string;
  effectiveDate?: string | undefined;
  workflowKey?: string | undefined;
  requiredCapability?: string | undefined;
}

export interface OversightResolutionInput {
  approverEmployeeId: string;
  effectiveDate?: string | undefined;
  workflowKey?: string | undefined;
  requiredCapability?: string | undefined;
}

export interface ResolvedAuthority {
  employeeId: string;
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
  ) {
    super(message);
    this.name = "OrganizationDraftError";
  }
}
