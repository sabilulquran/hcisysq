import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  LEAVE_GOVERNANCE_CAPABILITY,
  OrganizationAuthorityResolver,
  OrganizationResolutionError,
  OrganizationRolloutService,
  PostgresOrganizationRepository,
  type ResolvedAuthority,
  type RolloutAuthorityResult,
} from "../organization/index.js";
import {
  LeaveApprovalConfigurationError,
  resolveLeaveLineApprovalChain,
  snapshotResolvedLeaveAuthorities,
  type LeaveApprovalStep,
  type LeaveApprovalSource,
} from "./domain/approval-chain.js";

type Queryable = Pool | PoolClient;

export class LeaveOrganizationAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LeaveOrganizationAuthorityError";
  }
}

export interface LeaveAuthorityResolution {
  approvalChain: LeaveApprovalStep[];
  context: {
    mode: RolloutAuthorityResult["mode"];
    authoritativeSource: RolloutAuthorityResult["authoritativeSource"];
    authorities: Array<{
      employeeId: string | null;
      /** ORG-013: set for a Foundation Board account principal. */
      accountId?: string | undefined;
      /** ORG-013-4: the seat that resolved, which anchors oversight for an account approver. */
      positionKey?: string | null | undefined;
      source: LeaveApprovalSource;
      sources?: LeaveApprovalSource[] | undefined;
      path: string[];
      incumbentKind: string;
    }>;
    shadow?: RolloutAuthorityResult["shadow"];
  };
}

export interface ResolveLeaveAuthoritiesInput {
  workflowKey: string;
  requesterEmployeeId: string;
  effectiveDate: string;
  legacy: {
    directManagerEmployeeId: string | null;
    unitApproverEmployeeId: string | null;
  };
  policyChain: "LINE_AND_UNIT" | "UNIT_ONLY";
  /**
   * ORG-013: Leave routes that can store and decide account-principal steps opt in.
   * Other workflows sharing this resolver keep employee-only routing.
   */
  allowAccountPrincipal?: boolean | undefined;
}

function organizationServices(db: Queryable) {
  const repository = new PostgresOrganizationRepository(db);
  const resolver = new OrganizationAuthorityResolver(repository);
  return {
    resolver,
    rollout: new OrganizationRolloutService(repository, resolver),
  };
}

export async function resolveLeaveAuthorities(
  db: Queryable,
  input: ResolveLeaveAuthoritiesInput,
): Promise<LeaveAuthorityResolution> {
  const { rollout } = organizationServices(db);
  let result: RolloutAuthorityResult;
  try {
    result = await rollout.resolveAuthorities({
      workflowKey: input.workflowKey,
      requesterEmployeeId: input.requesterEmployeeId,
      effectiveDate: input.effectiveDate,
      legacy: input.legacy,
      authorityRequirement: input.policyChain,
      ...(input.allowAccountPrincipal ? { accountCapability: LEAVE_GOVERNANCE_CAPABILITY } : {}),
    });
  } catch (error) {
    if (error instanceof OrganizationResolutionError) {
      throw new LeaveOrganizationAuthorityError(error.code, error.message);
    }
    throw error;
  }

  return snapshotLeaveRolloutAuthorities(result, input);
}

export function snapshotLeaveRolloutAuthorities(
  result: RolloutAuthorityResult,
  input: Pick<ResolveLeaveAuthoritiesInput, "requesterEmployeeId" | "policyChain"> &
    Partial<Pick<ResolveLeaveAuthoritiesInput, "legacy">>,
): LeaveAuthorityResolution {

  if (result.authoritativeSource === "LEGACY" && input.legacy) {
    if (input.policyChain === "LINE_AND_UNIT") {
      resolveLeaveLineApprovalChain({
        requesterEmployeeId: input.requesterEmployeeId,
        ...input.legacy,
      });
    } else if (!input.legacy.unitApproverEmployeeId) {
      throw new LeaveApprovalConfigurationError(
        "UNIT_APPROVER_MISSING",
        "Kepala Satuan Kerja / Unit Approver belum dikonfigurasi.",
      );
    } else if (input.legacy.unitApproverEmployeeId === input.requesterEmployeeId) {
      throw new LeaveApprovalConfigurationError(
        "UNIT_APPROVER_SELF",
        "Cuti Tanpa Gaji memerlukan Unit Approver yang berbeda dari pemohon.",
      );
    }
  }

  const sourcesOf = (authority: ResolvedAuthority): LeaveApprovalSource[] =>
    (authority.sources ?? [authority.source]).filter(
      (source): source is LeaveApprovalSource => source !== "OVERSIGHT_PARENT",
    );
  const hasGovernanceAuthority = result.authorities.some((authority) =>
    sourcesOf(authority).includes("GOVERNANCE_APPROVER"),
  );
  const policyAuthorities = result.authorities.filter(
    (authority): authority is ResolvedAuthority & { source: LeaveApprovalSource } =>
      authority.source !== "OVERSIGHT_PARENT" &&
      (input.policyChain === "LINE_AND_UNIT" ||
        hasGovernanceAuthority ||
        sourcesOf(authority).includes("UNIT_APPROVER")),
  );
  const policySources = new Set(policyAuthorities.flatMap(sourcesOf));
  if (!hasGovernanceAuthority && input.policyChain === "LINE_AND_UNIT") {
    if (!policySources.has("DIRECT_MANAGER")) {
      throw new LeaveApprovalConfigurationError(
        "DIRECT_MANAGER_MISSING",
        "Atasan langsung belum dikonfigurasi.",
      );
    }
    if (!policySources.has("UNIT_APPROVER")) {
      throw new LeaveApprovalConfigurationError(
        "UNIT_APPROVER_MISSING",
        "Approver unit belum dikonfigurasi.",
      );
    }
  } else if (!hasGovernanceAuthority && !policySources.has("UNIT_APPROVER")) {
    throw new LeaveApprovalConfigurationError(
      "UNIT_APPROVER_MISSING",
      "Approver unit belum dikonfigurasi.",
    );
  }
  const approvalChain = snapshotResolvedLeaveAuthorities({
    requesterEmployeeId: input.requesterEmployeeId,
    authorities: policyAuthorities.flatMap((authority) =>
      sourcesOf(authority).map((source) => authority.employeeId
        ? { employeeId: authority.employeeId, source }
        : {
            principalType: "ACCOUNT" as const,
            employeeId: null,
            accountId: authority.accountId ?? null,
            source,
          }),
    ),
  });

  return {
    approvalChain,
    context: {
      mode: result.mode,
      authoritativeSource: result.authoritativeSource,
      authorities: policyAuthorities.map((authority) => ({
        employeeId: authority.employeeId,
        ...(authority.accountId ? { accountId: authority.accountId } : {}),
        positionKey: authority.positionKey,
        source: authority.source,
        sources: sourcesOf(authority),
        path: authority.path,
        incumbentKind: authority.incumbentKind,
      })),
      ...(result.shadow ? { shadow: result.shadow } : {}),
    },
  };
}

/**
 * ORG-013-1 butir 5. A Foundation Board account has no employee id, so the decision repeats the
 * submit-time e-mail match against the requester. An account without an e-mail counts as a match.
 */
export async function governanceActorIsRequester(
  db: Queryable,
  accountId: string,
  requesterEmployeeId: string,
): Promise<boolean> {
  const match = await db.query<{ same: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM accounts actor
       JOIN employees e ON e.id = $2
       LEFT JOIN accounts ea ON ea.employee_id = e.id AND ea.principal_type = 'EMPLOYEE'
       WHERE actor.id = $1
         AND (
           NULLIF(lower(btrim(actor.email)), '') IS NULL
           OR NULLIF(lower(btrim(actor.email)), '') IN (
             NULLIF(lower(btrim(e.email)), ''), NULLIF(lower(btrim(ea.email)), '')
           )
         )
     ) AS same`,
    [accountId, requesterEmployeeId],
  );
  return match.rows[0]?.same ?? true;
}

interface FinalApprover {
  employeeId: string | null;
  positionKey: string | null;
}

async function finalLineOrGovernanceApprover(
  db: PoolClient,
  requestId: string,
): Promise<FinalApprover | null> {
  // ORG-013-4: the final step's seat comes from the resolution context snapshotted with the
  // request, for either principal. An employee who holds an account-held seat (a salaried
  // organ member) has no employee incumbency there, so looking the seat up from the employee
  // would miss it, or find a staff seat with a different oversight parent.
  const result = await db.query<FinalApprover>(
    `SELECT s.approver_employee_id AS "employeeId",
            (
              SELECT authority ->> 'positionKey'
              FROM jsonb_array_elements(
                COALESCE(r.validation_summary #> '{authorityResolution,authorities}', '[]'::jsonb)
              ) AS authority
              WHERE (s.approver_account_id IS NOT NULL
                      AND authority ->> 'accountId' = s.approver_account_id::text)
                 OR (s.approver_employee_id IS NOT NULL
                      AND authority ->> 'employeeId' = s.approver_employee_id::text)
              LIMIT 1
            ) AS "positionKey"
     FROM leave_request_approval_steps s
     JOIN leave_requests r ON r.id = s.leave_request_id
     WHERE s.leave_request_id = $1
       AND s.sources && ARRAY[
         'DIRECT_MANAGER', 'UNIT_APPROVER', 'GOVERNANCE_APPROVER'
       ]::text[]
     ORDER BY s.step_order DESC
     LIMIT 1`,
    [requestId],
  );
  const row = result.rows[0];
  return row && (row.employeeId || row.positionKey) ? row : null;
}

async function snapshottedRolloutMode(
  db: PoolClient,
  requestId: string,
): Promise<"LEGACY" | "SHADOW" | "STRUCTURE" | null> {
  const result = await db.query<{ mode: string | null }>(
    `SELECT validation_summary #>> '{authorityResolution,mode}' AS mode
     FROM leave_requests
     WHERE id = $1`,
    [requestId],
  );
  const mode = result.rows[0]?.mode;
  return mode === "LEGACY" || mode === "SHADOW" || mode === "STRUCTURE" ? mode : null;
}

/**
 * Adds the informational ORG-004 oversight intent without making it an
 * approval step. A savepoint deliberately isolates resolver/outbox failures
 * so this non-blocking notification can never undo the final Leave decision.
 */
export async function enqueueFinalApprovalOversight(
  db: PoolClient,
  input: {
    requestId: string;
    workflowKey: string;
    effectiveDate: string;
    finalApproverEmployeeId?: string;
  },
  dependencies: {
    resolver?: Pick<OrganizationAuthorityResolver, "resolveOversightAbove">;
  } = {},
): Promise<void> {
  let savepointCreated = false;
  try {
    await db.query("SAVEPOINT leave_oversight_notification");
    savepointCreated = true;
    // Behavioral mode is immutable for an in-flight request. Missing mode
    // metadata identifies pre-ORG-004/legacy submissions and is side-effect safe.
    if (await snapshottedRolloutMode(db, input.requestId) !== "STRUCTURE") {
      await db.query("RELEASE SAVEPOINT leave_oversight_notification");
      return;
    }
    const stored = await finalLineOrGovernanceApprover(db, input.requestId);
    const finalApprover: FinalApprover | null = input.finalApproverEmployeeId
      ? {
          employeeId: input.finalApproverEmployeeId,
          positionKey: stored?.employeeId === input.finalApproverEmployeeId ? stored.positionKey : null,
        }
      : stored;
    if (!finalApprover) {
      await db.query("RELEASE SAVEPOINT leave_oversight_notification");
      return;
    }

    const resolver = dependencies.resolver ?? organizationServices(db).resolver;
    // Oversight is informational: the recipient needs no approval capability.
    const recipient = await resolver.resolveOversightAbove({
      approverEmployeeId: finalApprover.employeeId,
      approverPositionKey: finalApprover.positionKey,
      effectiveDate: input.effectiveDate,
      workflowKey: input.workflowKey,
      allowAccountRecipient: true,
    });
    if (recipient) {
      await db.query(
        `INSERT INTO leave_notification_outbox (
          id, leave_request_id, event_type, target_type, target_key, payload
        )
        SELECT $1, $2, 'leave.oversight.approved', $5, $3, $4::jsonb
        WHERE NOT EXISTS (
          SELECT 1
          FROM leave_notification_outbox
          WHERE leave_request_id = $2
            AND event_type = 'leave.oversight.approved'
        )`,
        [
          randomUUID(),
          input.requestId,
          recipient.employeeId ?? recipient.accountId,
          JSON.stringify({
            finalLineApproverEmployeeId: finalApprover.employeeId,
            ...(finalApprover.positionKey ? { finalLineApproverPositionKey: finalApprover.positionKey } : {}),
            resolutionSource: recipient.source,
            resolutionPath: recipient.path,
            incumbentKind: recipient.incumbentKind,
          }),
          recipient.employeeId ? "employee" : "account",
        ],
      );
    }
    await db.query("RELEASE SAVEPOINT leave_oversight_notification");
  } catch {
    if (savepointCreated) {
      await db.query("ROLLBACK TO SAVEPOINT leave_oversight_notification");
      await db.query("RELEASE SAVEPOINT leave_oversight_notification");
    }
  }
}
