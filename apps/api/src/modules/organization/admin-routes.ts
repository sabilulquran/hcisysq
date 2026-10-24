import type { AdminPermission } from "../auth/permissions.js";
import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type { ApiConfig } from "../../config/env.js";
import { requirePermissionsFromCookie } from "../auth/authorization.js";
import { resolveAuthorizationContext } from "../auth/permissions.js";
import { AuthError, AuthService, type AuthPrincipal } from "../auth/service.js";
import type {
  AuthorityBindingType,
} from "./domain.js";
import {
  applyOrganizationCommand,
  OrganizationCommandError,
  type OrganizationCommand,
} from "./commands.js";
import {
  bindingIsFromPublishedStructure,
  findNodeUses,
  findPositionUses,
  type OrganizationItemUse,
} from "./corrections.js";
import { OrganizationDraftService } from "./draft-service.js";
import { replayJournal } from "./replay.js";
import {
  buildSeedFromLegacy,
  type LegacyEmployeeRow,
  type LegacyUnitRow,
} from "./seed-from-legacy.js";
import {
  buildOrganizationPeopleView,
  computeOrganizationReadiness,
  explainPerson,
  RequestScopedEligibilityValidator,
  type OrganizationPersonEmployee,
  type OrganizationPersonRow,
} from "./read-model.js";
import { OrganizationAuthorityResolver } from "./resolver.js";
import { PostgresOrganizationRepository, type OrganizationQueryable } from "./repository.js";
import { assertIsoDate, isEffective as isEffectiveOn, jakartaBusinessDate } from "./jakarta-date.js";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const draftParams = z.object({ draftId: uuid });
const itemParams = z.object({ draftId: uuid, itemId: uuid });
const vacancyPolicy = z.enum(["CLIMB_TO_PARENT", "REQUIRE_ACTING_OR_BLOCK", "BLOCK"]);

const draftInput = z.object({
  name: z.string().trim().min(1).max(160),
  effectiveOn: date,
});
const nodeInput = z.object({
  name: z.string().trim().min(1).max(160),
  nodeType: z.string().trim().min(1).max(80),
  parentNodeKey: uuid.nullable().default(null),
  visualRankOffset: z.number().int().min(0).max(10).default(0),
  integrationCode: z.string().trim().min(1).max(100).nullable().optional(),
  // ORG-008-6 (O-9): which imported unit this structural unit stands for, so HC notification can
  // find "the employee's unit or the unit above it" through the structure's own hierarchy.
  legacyUnitId: uuid.nullable().optional(),
});
const nodePatch = nodeInput.partial().extend({ active: z.boolean().optional() });
const positionInput = z.object({
  nodeKey: uuid,
  title: z.string().trim().min(1).max(160),
  parentPositionKey: uuid.nullable().default(null),
  singleIncumbent: z.boolean().default(true),
  vacancyPolicy: vacancyPolicy.default("CLIMB_TO_PARENT"),
  visualRankOffset: z.number().int().min(0).max(10).default(0),
});
const positionPatch = positionInput.partial().extend({ active: z.boolean().optional() });
const membershipInput = z.object({
  nodeKey: uuid,
  employeeIds: z.array(uuid).max(500),
  effectiveFrom: date,
  effectiveTo: date.nullable().optional(),
});
const incumbencyInput = z.object({
  positionKey: uuid,
  primaryEmployeeId: uuid.nullable().optional(),
  actingEmployeeId: uuid.nullable().optional(),
  actingFrom: date.nullable().optional(),
  actingTo: date.nullable().optional(),
  effectiveFrom: date,
});
const bindingType = z.enum([
  "SUPERVISORY_PARENT",
  "LEADER",
  "UNIT_APPROVER",
  "GOVERNANCE_APPROVER",
  "OVERSIGHT_PARENT",
]);
const bindingInput = z.object({
  sourceType: z.enum(["NODE", "POSITION"]),
  sourceKey: uuid,
  authorityType: bindingType,
  targetPositionKey: uuid,
  vacancyPolicy,
  effectiveFrom: date,
  effectiveTo: date.nullable().optional(),
});
const overrideInput = z.object({
  employeeId: uuid,
  managerPositionKey: uuid,
  reason: z.string().trim().min(1).max(500),
  effectiveFrom: date,
  effectiveTo: date.nullable().optional(),
});
const resolutionInput = z.object({
  employeeId: uuid,
  workflowKey: z.string().trim().min(1).max(100),
  effectiveDate: date,
});
const rolloutInput = z.object({
  mode: z.enum(["LEGACY", "SHADOW", "STRUCTURE"]),
  workflowKey: z.string().trim().min(1).max(100).default("LEAVE"),
  organizationalNodeKey: uuid.nullable().optional(),
  effectiveFrom: date.optional(),
  effectiveTo: date.nullable().optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

function invalid(reply: FastifyReply, code: string, message: string) {
  return reply.status(400).send({ code, message });
}

/**
 * ORG-008-4b: refuse removing or switching off something other records still point at, and say what
 * points at it. Today this only surfaces later, as a validation code with no name attached.
 */
function replyItemInUse(reply: FastifyReply, itemKind: string, uses: OrganizationItemUse[]) {
  return reply.status(409).send({
    code: "ORGANIZATION_ITEM_IN_USE",
    message: "This item is still in use and cannot be removed or deactivated yet.",
    details: { itemKind, uses },
  });
}

/** Published structure is history: it is deactivated or ended, never deleted. */
function replyPublishedItem(reply: FastifyReply, itemKind: string) {
  return reply.status(409).send({
    code: "ORGANIZATION_ITEM_PUBLISHED",
    message: "This item has been published; deactivate it instead of deleting it.",
    details: { itemKind, deactivateInstead: true },
  });
}

async function insertAuditEvent(
  db: OrganizationQueryable,
  principal: AuthPrincipal,
  action: string,
  entityType: string,
  entityId: string | null,
  changeSetId: string | null,
  payload: Record<string, unknown> = {},
) {
  await db.query(
    `INSERT INTO organization_audit_events
      (id, actor_account_id, action, entity_type, entity_id, change_set_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [randomUUID(), principal.id, action, entityType, entityId, changeSetId, JSON.stringify(payload)],
  );
}

interface OrganizationMutationContext {
  client: PoolClient;
  repository: PostgresOrganizationRepository;
  draftService: OrganizationDraftService;
  audit(
    action: string,
    entityType: string,
    entityId: string | null,
    changeSetId: string | null,
    payload?: Record<string, unknown>,
  ): Promise<void>;
}

async function atomicOrganizationMutation<T>(
  pool: Pool,
  principal: AuthPrincipal,
  operation: (context: OrganizationMutationContext) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const repository = new PostgresOrganizationRepository(client);
    const result = await operation({
      client,
      repository,
      draftService: new OrganizationDraftService(repository),
      audit: (action, entityType, entityId, changeSetId, payload = {}) =>
        insertAuditEvent(client, principal, action, entityType, entityId, changeSetId, payload),
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerOrganizationAdminRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ApiConfig,
) {
  if (!config.AUTH_ENCRYPTION_KEY) throw new Error("AUTH_ENCRYPTION_KEY is required");
  const auth = new AuthService(
    pool,
    config.AUTH_ENCRYPTION_KEY,
    config.AUTH_SESSION_TTL_HOURS,
    config.NODE_ENV === "production",
  );
  const repository = new PostgresOrganizationRepository(pool);
  const draftService = new OrganizationDraftService(repository);

  async function authenticate(request: FastifyRequest, reply: FastifyReply,
    permission: AdminPermission | readonly AdminPermission[],
  ) {
    try {
      return await requirePermissionsFromCookie(auth, request.headers.cookie, permission);
    } catch (error) {
      if (error instanceof AuthError) {
        await reply.status(error.statusCode).send({ code: error.code, message: error.message });
        return null;
      }
      throw error;
    }
  }

  async function editableSnapshot(
    draftId: string,
    reply: FastifyReply,
    activeRepository: PostgresOrganizationRepository = repository,
  ) {
    const snapshot = await activeRepository.loadChangeSetSnapshot(draftId);
    if (!snapshot) {
      await reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND", message: "Draft not found." });
      return null;
    }
    if (snapshot.changeSet.status !== "DRAFT") {
      await reply.status(409).send({
        code: "ORGANIZATION_DRAFT_NOT_EDITABLE",
        message: "Only a draft that has not been validated or published can be edited.",
      });
      return null;
    }
    return snapshot;
  }

  /**
   * ORG-008-3b concurrency guard (If-Match).
   *
   * The header carries the draft revision the operator last saw. When it is present and no longer
   * matches, the mutation is refused with 409 ORGANIZATION_DRAFT_CHANGED instead of overwriting the
   * other person's work. The revision is bumped in the same transaction as the mutation.
   *
   * A request without the header still proceeds and still bumps the revision. Rejecting those would
   * lock out any client that has not been updated yet; the Perubahan screen sends the header, and
   * making it mandatory is a separate, deliberate step once no client is left without it.
   */
  async function claimDraftRevision(
    request: FastifyRequest,
    reply: FastifyReply,
    snapshot: { changeSet: { id: string; revision: number } },
    activeRepository: PostgresOrganizationRepository,
  ): Promise<boolean> {
    const header = request.headers["if-match"];
    const raw = Array.isArray(header) ? header[0] : header;
    const expected = raw === undefined ? snapshot.changeSet.revision : Number(raw.replace(/"/g, "").trim());
    if (!Number.isInteger(expected)) {
      await reply.status(400).send({
        code: "INVALID_DRAFT_REVISION",
        message: "If-Match must carry the draft revision the client last read.",
      });
      return false;
    }
    const bumped = await activeRepository.bumpDraftRevision(snapshot.changeSet.id, expected);
    if (bumped === null) {
      await reply.status(409).send({
        code: "ORGANIZATION_DRAFT_CHANGED",
        message: "This change was modified by someone else; reload before saving.",
        details: { revision: snapshot.changeSet.revision },
      });
      return false;
    }
    return true;
  }

  /**
   * ORG-008-2 read model. One snapshot, one employee query, one resolver, one eligibility cache.
   * Nothing here writes: not a snapshot row, not a rollout row, not an approval snapshot.
   */
  async function peopleContext(input: {
    asOf?: string | undefined;
    draftId?: string | undefined;
    includeLegacy: boolean;
  }) {
    const asOf = input.asOf ?? jakartaBusinessDate();
    const snapshot = input.draftId
      ? await repository.loadChangeSetSnapshot(input.draftId)
      : await repository.loadEffectiveSnapshot(asOf);
    if (input.draftId && !snapshot) return null;
    // Only the fields the screens show: number, name, unit, and the legacy manager/approver pair.
    // No identity number, address, salary, or document content is read here.
    const employees = await pool.query<OrganizationPersonEmployee>(
      `SELECT e.id,
              e.employee_number AS "employeeNumber",
              e.full_name AS "fullName",
              unit.id AS "legacyUnitId",
              unit.name AS "legacyUnitName",
              e.direct_manager_employee_id AS "legacyDirectManagerEmployeeId",
              manager.full_name AS "legacyDirectManagerName",
              unit.leave_approver_employee_id AS "legacyUnitApproverEmployeeId",
              approver.full_name AS "legacyUnitApproverName"
       FROM employees e
       LEFT JOIN organizational_units unit ON unit.id = e.organizational_unit_id
       LEFT JOIN employees manager ON manager.id = e.direct_manager_employee_id
       LEFT JOIN employees approver ON approver.id = unit.leave_approver_employee_id
       WHERE e.status = 'active'
       ORDER BY e.full_name, e.employee_number`,
    );
    const eligibility = new RequestScopedEligibilityValidator(repository);
    const rows = await buildOrganizationPeopleView({
      snapshot,
      employees: employees.rows,
      eligibility,
      asOf,
      includeLegacy: input.includeLegacy,
    });
    return { asOf, snapshot, rows, eligibility };
  }

  /** A unit and everything under it, so filtering by unit includes its sub-units. */
  function nodeWithDescendants(
    snapshot: { nodes: Array<{ stableKey: string; parentNodeKey: string | null }> } | null,
    nodeKey: string,
  ): Set<string> {
    const keys = new Set([nodeKey]);
    if (!snapshot) return keys;
    let added = true;
    while (added) {
      added = false;
      for (const node of snapshot.nodes) {
        if (node.parentNodeKey && keys.has(node.parentNodeKey) && !keys.has(node.stableKey)) {
          keys.add(node.stableKey);
          added = true;
        }
      }
    }
    return keys;
  }

  function matchesIssueFilter(row: OrganizationPersonRow, issue: string): boolean {
    if (issue === "ANY") return row.issues.length > 0;
    if (issue === "NO_UNIT") return row.unit === null && row.position === null;
    if (issue === "UNRESOLVED_MANAGER") return row.directManager === null;
    if (issue === "DIFFERENT_FROM_LEGACY") return row.legacy?.comparison === "DIFFERENT";
    return row.issues.some((item) => item.code === issue);
  }

  /**
   * ORG-008-2 approval check. Workflows the operator can pick, mapped to what the resolver needs.
   *
   * Annual and unpaid leave use the capability Leave already requires. The overtime approver
   * capability is set by ATT-011-6b and is not decided yet, so overtime resolves on the structural
   * line without demanding a capability and is returned marked as a preview (spec 4.6, gap X-5).
   * There is no second resolver here: this is the one approvals use.
   */
  const PREVIEW_WORKFLOWS = {
    LEAVE_ANNUAL: { workflowKey: "LEAVE", requiredCapability: "leave.approve", preview: false },
    LEAVE_UNPAID: { workflowKey: "LEAVE", requiredCapability: "leave.approve", preview: false },
    OVERTIME: { workflowKey: "OVERTIME", requiredCapability: undefined, preview: true },
  } as const;

  async function resolutionPreview(input: {
    employeeId: string;
    workflow: keyof typeof PREVIEW_WORKFLOWS;
    effectiveDate: string;
    draftId?: string | undefined;
  }) {
    const plan = PREVIEW_WORKFLOWS[input.workflow];
    const snapshot = input.draftId
      ? await repository.loadChangeSetSnapshot(input.draftId)
      : await repository.loadEffectiveSnapshot(input.effectiveDate);
    if (!snapshot) return { notFound: true } as const;

    const eligibility = new RequestScopedEligibilityValidator(repository);
    const resolver = new OrganizationAuthorityResolver(
      { loadEffectiveSnapshot: async () => snapshot },
      { eligibilityValidator: eligibility },
    );
    const resolutionInputs = {
      requesterEmployeeId: input.employeeId,
      effectiveDate: input.effectiveDate,
      workflowKey: plan.workflowKey,
      ...(plan.requiredCapability === undefined ? {} : { requiredCapability: plan.requiredCapability }),
    };

    const warnings: Array<{ code: string; details?: Record<string, unknown> }> = [];
    if (plan.preview) warnings.push({ code: "OVERTIME_CAPABILITY_PENDING" });

    let line;
    try {
      line = await resolver.resolveLineAuthorities(resolutionInputs);
    } catch (error) {
      const item = error as { code?: string; message?: string; details?: Record<string, unknown> };
      return {
        failed: {
          code: item.code ?? "ORGANIZATION_RESOLUTION_FAILED",
          message: item.message ?? "Authority cannot be resolved.",
          ...(item.details ? { details: item.details } : {}),
        },
        warnings,
      } as const;
    }

    // ORG-008-2 fills what the old preview always left null: who is told after the final approval.
    // It is only acted on under STRUCTURE, so the mode it applies in travels with it.
    let oversight = null;
    const finalApprover = line.authorities[line.authorities.length - 1];
    if (finalApprover) {
      try {
        oversight = await resolver.resolveOversightAbove({
          approverEmployeeId: finalApprover.employeeId,
          effectiveDate: input.effectiveDate,
          workflowKey: plan.workflowKey,
          ...(plan.requiredCapability === undefined ? {} : { requiredCapability: plan.requiredCapability }),
        });
      } catch (error) {
        warnings.push({
          code: (error as { code?: string }).code ?? "OVERSIGHT_UNRESOLVED",
        });
      }
    }

    const employeeIds = [...new Set([
      input.employeeId,
      ...line.authorities.map((item) => item.employeeId),
      ...(oversight ? [oversight.employeeId] : []),
    ])];
    const employees = await pool.query<{ id: string; employeeNumber: string; fullName: string }>(
      `SELECT id, employee_number AS "employeeNumber", full_name AS "fullName"
       FROM employees WHERE id = ANY($1::uuid[])`,
      [employeeIds],
    );
    const byId = new Map(employees.rows.map((item) => [item.id, item]));
    const titleOf = (positionKey: string | null) =>
      positionKey ? snapshot.positions.find((item) => item.stableKey === positionKey)?.title ?? null : null;

    return {
      result: {
        employee: byId.get(input.employeeId) ?? { id: input.employeeId, fullName: "" },
        effectiveDate: line.effectiveDate,
        workflow: input.workflow,
        workflowKey: plan.workflowKey,
        changeSetId: snapshot.changeSet.id,
        preview: plan.preview,
        governanceApplied: line.governanceApplied,
        steps: line.authorities.map((item) => ({
          employeeId: item.employeeId,
          employeeName: byId.get(item.employeeId)?.fullName ?? "",
          positionTitle: titleOf(item.positionKey),
          authorityType: (item.sources ?? [item.source]).join(" + "),
          source: item.incumbentKind,
        })),
        oversight: oversight
          ? {
              employeeId: oversight.employeeId,
              employeeName: byId.get(oversight.employeeId)?.fullName ?? "",
              positionTitle: titleOf(oversight.positionKey),
              appliesInMode: "STRUCTURE",
            }
          : null,
        warnings,
      },
    } as const;
  }

  app.post("/admin/organization/resolution-preview", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const body = z.object({
      employeeId: uuid,
      workflow: z.enum(["LEAVE_ANNUAL", "LEAVE_UNPAID", "OVERTIME"]).default("LEAVE_ANNUAL"),
      date: date.optional(),
      draftId: uuid.optional(),
    }).safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_RESOLUTION_PREVIEW", "Invalid resolution preview input.");
    const outcome = await resolutionPreview({
      employeeId: body.data.employeeId,
      workflow: body.data.workflow,
      effectiveDate: body.data.date ?? jakartaBusinessDate(),
      draftId: body.data.draftId,
    });
    if ("notFound" in outcome) {
      return reply.status(404).send({
        code: body.data.draftId ? "ORGANIZATION_DRAFT_NOT_FOUND" : "ORGANIZATION_STRUCTURE_NOT_FOUND",
        message: "No organization structure is effective for that date.",
      });
    }
    if ("failed" in outcome) {
      return reply.status(409).send({ ...outcome.failed, warnings: outcome.warnings });
    }
    return reply.send(outcome.result);
  });

  app.get("/admin/organization/capabilities", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    // ORG-008-2: the screen hides what the API would refuse instead of offering a button that ends
    // in 403. Every endpoint still authorizes its own call; this only drives what is shown.
    const context = await resolveAuthorizationContext(pool, principal);
    const can = (permission: string) => context.organizationPermissions.includes(permission);
    return reply.send({
      viewStructure: can("organization.manage"),
      composeChange: can("organization.manage"),
      discardChange: can("organization.manage"),
      // ORG-008-8 (O-1): composing incumbents and authority inside a change set.
      assignIncumbents: can("organization.manage"),
      manageAuthority: can("organization.manage"),
      publish: can("approvals.policy.manage"),
      manageRollout: can("approvals.policy.manage"),
    });
  });

  /**
   * ORG-008-6 (O-9, ATT-011 D-11): the imported units this structural unit stands for, itself first
   * and then upwards.
   *
   * Role scopes point at organizational_units, a flat list with no parent. The hierarchy lives in
   * the structure. Walking up the structure and collecting each linked imported unit is what turns
   * "the employee's unit or the unit above it" into something that can actually be resolved.
   * A unit with no link contributes nothing, so an unlinked branch falls back to the
   * organisation-wide recipients ATT-011 already uses rather than guessing.
   */
  function linkedUnitChain(
    nodes: Array<{ stableKey: string; parentNodeKey: string | null; legacyUnitId?: string | null }>,
    nodeKey: string,
  ): string[] {
    const byKey = new Map(nodes.map((node) => [node.stableKey, node]));
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | null = nodeKey;
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = byKey.get(current);
      if (!node) break;
      if (node.legacyUnitId) chain.push(node.legacyUnitId);
      current = node.parentNodeKey;
    }
    return chain;
  }

  app.get("/admin/organization/units/:nodeKey/hc-staff", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const params = z.object({ nodeKey: uuid }).safeParse(request.params);
    const query = z.object({ asOf: date.optional(), draftId: uuid.optional() }).safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply, "INVALID_UNIT_QUERY", "Invalid unit query.");
    const asOf = query.data.asOf ?? jakartaBusinessDate();
    const snapshot = query.data.draftId
      ? await repository.loadChangeSetSnapshot(query.data.draftId)
      : await repository.loadEffectiveSnapshot(asOf);
    if (!snapshot) return reply.status(404).send({ code: "ORGANIZATION_STRUCTURE_NOT_FOUND" });
    if (!snapshot.nodes.some((node) => node.stableKey === params.data.nodeKey)) {
      return reply.status(404).send({ code: "ORGANIZATION_NODE_NOT_FOUND" });
    }

    const chain = linkedUnitChain(snapshot.nodes, params.data.nodeKey);
    if (chain.length === 0) {
      // Honest empty answer: no link anywhere up the branch, so ATT-011 keeps its existing
      // organisation-wide fallback instead of a narrower guess.
      return reply.send({ asOf, nodeKey: params.data.nodeKey, linkedUnitIds: [], fallback: true, items: [] });
    }
    // Read-only: who is already assigned, never who should be. Assignment stays in Akses.
    const staff = await pool.query(
      `SELECT DISTINCT employee.id AS "employeeId", employee.full_name AS "fullName",
         role.role_key AS "roleKey", unit.id AS "unitId", unit.name AS "unitName"
       FROM account_role_assignments assignment
       JOIN accounts account ON account.id = assignment.account_id
       JOIN employees employee ON employee.id = account.employee_id
       JOIN roles role ON role.id = assignment.role_id
       JOIN organizational_units unit ON unit.id = assignment.organizational_unit_id
       WHERE assignment.scope_type = 'unit'
         AND assignment.organizational_unit_id = ANY($1::uuid[])
         AND account.status = 'active' AND employee.status = 'active'
         AND (assignment.starts_on IS NULL OR assignment.starts_on <= $2::date)
         AND (assignment.ends_on IS NULL OR assignment.ends_on >= $2::date)
       ORDER BY employee.full_name`,
      [chain, asOf],
    );
    return reply.send({
      asOf,
      nodeKey: params.data.nodeKey,
      linkedUnitIds: chain,
      fallback: false,
      items: staff.rows,
    });
  });

  app.get("/admin/organization/positions/search", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const query = z.object({
      q: z.string().trim().max(120).optional(),
      asOf: date.optional(),
      draftId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_POSITION_QUERY", "Invalid position query.");
    const asOf = query.data.asOf ?? jakartaBusinessDate();
    const snapshot = query.data.draftId
      ? await repository.loadChangeSetSnapshot(query.data.draftId)
      : await repository.loadEffectiveSnapshot(asOf);
    if (!snapshot) return reply.send({ asOf, items: [] });

    // ORG-008-6 (O-8, ATT-011 D-10): the overtime rule points at a position by its stable key, which
    // survives renames and restructuring. The unit path is here so two seats with the same title in
    // different schools can be told apart (gap S-4).
    const nodeByKey = new Map(snapshot.nodes.map((node) => [node.stableKey, node]));
    const pathOf = (nodeKey: string) => {
      const names: string[] = [];
      const seen = new Set<string>();
      let current: string | null = nodeKey;
      while (current && !seen.has(current)) {
        seen.add(current);
        const node = nodeByKey.get(current);
        if (!node) break;
        names.unshift(node.name);
        current = node.parentNodeKey;
      }
      return names;
    };
    const needle = query.data.q?.toLowerCase() ?? "";
    const items = snapshot.positions
      .filter((position) => position.active && isEffectiveOn(position.effectiveFrom, position.effectiveTo, asOf))
      .map((position) => ({
        stableKey: position.stableKey,
        title: position.title,
        nodeKey: position.nodeKey,
        unitPath: pathOf(position.nodeKey),
      }))
      .filter((item) => !needle
        || item.title.toLowerCase().includes(needle)
        || item.unitPath.join(" ").toLowerCase().includes(needle))
      .slice(0, query.data.limit);
    return reply.send({ asOf, items });
  });

  app.get("/admin/organization/people", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const query = z.object({
      asOf: date.optional(),
      draftId: uuid.optional(),
      nodeKey: uuid.optional(),
      issue: z.string().trim().min(1).max(60).optional(),
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
      withLegacy: z.enum(["true", "false"]).default("false"),
    }).safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_PEOPLE_QUERY", "Invalid people query.");
    const context = await peopleContext({
      asOf: query.data.asOf,
      draftId: query.data.draftId,
      includeLegacy: query.data.withLegacy === "true",
    });
    if (!context) return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });

    let rows = context.rows;
    if (query.data.nodeKey) {
      const keys = nodeWithDescendants(context.snapshot, query.data.nodeKey);
      rows = rows.filter((row) => row.unit !== null && keys.has(row.unit.nodeKey));
    }
    const issue = query.data.issue;
    if (issue) rows = rows.filter((row) => matchesIssueFilter(row, issue));
    if (query.data.q) {
      const needle = query.data.q.toLowerCase();
      rows = rows.filter((row) =>
        row.fullName.toLowerCase().includes(needle) || row.employeeNumber.toLowerCase().includes(needle));
    }
    const start = (query.data.page - 1) * query.data.pageSize;
    return reply.send({
      asOf: context.asOf,
      changeSetId: context.snapshot?.changeSet.id ?? null,
      page: query.data.page,
      pageSize: query.data.pageSize,
      total: rows.length,
      items: rows.slice(start, start + query.data.pageSize),
    });
  });

  app.get("/admin/organization/readiness", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const query = z.object({ asOf: date.optional(), draftId: uuid.optional() }).safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_READINESS_QUERY", "Invalid readiness query.");
    const context = await peopleContext({
      asOf: query.data.asOf, draftId: query.data.draftId, includeLegacy: true,
    });
    if (!context) return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
    return reply.send(computeOrganizationReadiness({
      rows: context.rows, snapshot: context.snapshot, asOf: context.asOf,
    }));
  });

  app.get("/admin/organization/explanation", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const query = z.object({
      employeeId: uuid, asOf: date.optional(), draftId: uuid.optional(),
    }).safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_EXPLANATION_QUERY", "Invalid explanation query.");
    const context = await peopleContext({
      asOf: query.data.asOf, draftId: query.data.draftId, includeLegacy: true,
    });
    if (!context) return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
    const row = context.rows.find((item) => item.employeeId === query.data.employeeId);
    if (!row) return reply.status(404).send({ code: "ORGANIZATION_EMPLOYEE_NOT_FOUND" });
    // Codes and parameters only; the sentences are composed in the web app (ORG-008-1 vocabulary).
    return reply.send({ asOf: context.asOf, employeeId: row.employeeId, person: row, steps: explainPerson(row) });
  });

  app.get("/admin/organization/designer", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const query = z.object({ effectiveDate: date.optional(), draftId: uuid.optional() }).safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_ORGANIZATION_VIEW", "Invalid date or draft identifier.");
    const viewDate = query.data.effectiveDate ?? jakartaBusinessDate();
    const snapshot = query.data.draftId
      ? await repository.loadChangeSetSnapshot(query.data.draftId)
      : await repository.loadEffectiveSnapshot(viewDate);
    if (query.data.draftId && !snapshot) {
      return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND", message: "Draft not found." });
    }
    if (!snapshot) {
      return reply.send({
        viewDate,
        staleBase: null,
        mode: viewDate < jakartaBusinessDate() ? "HISTORICAL" : viewDate > jakartaBusinessDate() ? "FUTURE" : "CURRENT",
        draft: null,
        nodes: [], positions: [], memberships: [], assignments: [], bindings: [], reportingOverrides: [],
      });
    }
    const employeeIds = [...new Set([
      ...snapshot.memberships.map((item) => item.employeeId),
      ...snapshot.incumbencies.flatMap((item) => item.employeeId ? [item.employeeId] : []),
    ])];
    const employees = employeeIds.length === 0 ? { rows: [] as Array<{ id: string; employeeNumber: string; fullName: string }> }
      : await pool.query<{ id: string; employeeNumber: string; fullName: string }>(
        `SELECT id, employee_number AS "employeeNumber", full_name AS "fullName"
         FROM employees WHERE id = ANY($1::uuid[])`, [employeeIds]);
    const employeeById = new Map(employees.rows.map((item) => [item.id, item]));
    const accountIds = [...new Set(
      snapshot.incumbencies.flatMap((item) => item.accountId ? [item.accountId] : []),
    )];
    const accounts = accountIds.length === 0
      ? { rows: [] as Array<{ id: string; email: string; status: string }> }
      : await pool.query<{ id: string; email: string; status: string }>(
        `SELECT id, email, status
         FROM accounts
         WHERE id = ANY($1::uuid[]) AND principal_type = 'FOUNDATION_BOARD'`,
        [accountIds],
      );
    const accountById = new Map(accounts.rows.map((item) => [item.id, item]));
    const assignments = snapshot.incumbencies.map((item) => ({
      assignmentId: item.id,
      positionKey: item.positionKey,
      employeeId: item.employeeId,
      accountId: item.accountId ?? null,
      accountEmail: item.accountId ? accountById.get(item.accountId)?.email ?? null : null,
      employeeNumber: item.employeeId ? employeeById.get(item.employeeId)?.employeeNumber : undefined,
      employeeName: item.employeeId
        ? employeeById.get(item.employeeId)?.fullName ?? "Unknown employee"
        : accountById.get(item.accountId ?? "")?.email ?? "Unknown governance account",
      accountStatus: item.accountId ? accountById.get(item.accountId)?.status ?? "unknown" : null,
      effectiveFrom: item.effectiveFrom,
      effectiveTo: item.effectiveTo,
      assignmentType: item.kind,
      isPrimaryStructural: item.isPrimaryStructural ?? false,
    }));
    // ORG-008-3a: only for a change set the operator opened by id; the plain by-date view keeps its
    // single query. The marker lets the screen warn before publish instead of only at the 409.
    const staleBase = query.data.draftId
      ? await draftService.findStaleBaseConflict(snapshot.changeSet)
      : null;
    return reply.send({
      viewDate,
      staleBase,
      mode: snapshot.changeSet.status === "PUBLISHED"
        ? viewDate < jakartaBusinessDate() ? "HISTORICAL" : viewDate > jakartaBusinessDate() ? "FUTURE" : "CURRENT"
        : "DRAFT",
      draft: snapshot.changeSet,
      nodes: snapshot.nodes.map((item) => ({
        ...item,
        memberCount: snapshot.memberships.filter((member) => member.nodeKey === item.stableKey).length,
        leaderPositionKey: snapshot.authorityBindings.find((binding) =>
          binding.subjectKind === "NODE" && binding.subjectKey === item.stableKey && binding.bindingType === "LEADER")
          ?.targetPositionKey ?? null,
      })),
      positions: snapshot.positions.map((item) => ({
        ...item,
        primaryIncumbent: assignments.find((assignment) =>
          assignment.positionKey === item.stableKey && assignment.assignmentType === "PRIMARY") ?? null,
        actingIncumbent: assignments.find((assignment) =>
          assignment.positionKey === item.stableKey && assignment.assignmentType === "ACTING") ?? null,
      })),
      memberships: snapshot.memberships.map((item) => ({
        ...item,
        employeeName: employeeById.get(item.employeeId)?.fullName,
      })),
      assignments,
      bindings: snapshot.authorityBindings.map((item) => ({
        id: item.id,
        sourceType: item.subjectKind,
        sourceKey: item.subjectKey,
        authorityType: item.bindingType,
        targetPositionKey: item.targetPositionKey,
        vacancyPolicy: item.vacancyPolicy,
        effectiveFrom: item.effectiveFrom,
        effectiveTo: item.effectiveTo,
      })),
      reportingOverrides: snapshot.reportingOverrides.map((item) => ({
        id: item.id,
        employeeId: item.employeeId,
        managerPositionKey: item.managerPositionKey,
        managerEmployeeId: item.managerEmployeeId,
        reason: item.reason,
        effectiveFrom: item.effectiveFrom,
        effectiveTo: item.effectiveTo,
      })),
    });
  });

  app.get("/admin/organization/designer/employees", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    // ORG-008-2 adds search and a status filter (gaps P-1, P-4). The default stays every employee so
    // a seat already held by someone no longer active can still show that person's name; the new
    // screens ask for status=active.
    const query = z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum(["active", "all"]).default("all"),
      limit: z.coerce.number().int().min(1).max(1000).optional(),
    }).safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_EMPLOYEE_QUERY", "Invalid employee query.");
    const result = await pool.query(
      `SELECT e.id, e.employee_number AS "employeeNumber", e.full_name AS "fullName",
        e.status, u.name AS "unitName", p.name AS "positionName"
       FROM employees e
       LEFT JOIN organizational_units u ON u.id = e.organizational_unit_id
       LEFT JOIN positions p ON p.id = e.position_id
       WHERE ($1::text IS NULL OR e.status = $1::text)
         AND ($2::text IS NULL OR e.full_name ILIKE '%' || $2::text || '%'
              OR e.employee_number ILIKE '%' || $2::text || '%')
       ORDER BY (e.status = 'active') DESC, e.full_name
       LIMIT $3::int`,
      [
        query.data.status === "active" ? "active" : null,
        query.data.q && query.data.q.length > 0 ? query.data.q : null,
        query.data.limit ?? 5000,
      ],
    );
    return reply.send({ items: result.rows });
  });

  app.post("/admin/organization/designer/drafts", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const parsed = draftInput.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "INVALID_ORGANIZATION_DRAFT", "Draft name and effective date are required.");
    try { assertIsoDate(parsed.data.effectiveOn); } catch { return invalid(reply, "INVALID_EFFECTIVE_DATE", "Invalid effective date."); }
    // ORG-008-3b (O-7): one change set is composed at a time for the whole foundation, so a second
    // one cannot be built from a base the first will replace. The existing one is named in the reply
    // so the screen can offer to continue it. This is checked here rather than by a unique index,
    // because how many open change sets production already holds has not been verified.
    const open = await repository.findOpenChangeSet();
    if (open) {
      return reply.status(409).send({
        code: "ORGANIZATION_DRAFT_ALREADY_OPEN",
        message: "Another organization change is still open.",
        details: { changeSetId: open.id, name: open.name, effectiveOn: open.effectiveOn, status: open.status },
      });
    }
    const changeSet = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await transaction.repository.createDraft({ ...parsed.data, actorAccountId: principal.id });
      await transaction.audit("organization.draft.created", "organization_change_set", snapshot.changeSet.id, snapshot.changeSet.id, {
        effectiveOn: snapshot.changeSet.effectiveOn,
        baseChangeSetId: snapshot.changeSet.baseChangeSetId,
      });
      return snapshot.changeSet;
    });
    return reply.status(201).send(changeSet);
  });

  app.get("/admin/organization/designer/drafts", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const query = z.object({
      status: z.enum(["DRAFT", "VALIDATED", "PUBLISHED", "DISCARDED"]).optional(),
    }).safeParse(request.query);
    if (!query.success) return invalid(reply, "INVALID_DRAFT_FILTER", "Invalid change status filter.");
    const items = await repository.listChangeSets(query.data.status ? [query.data.status] : undefined);
    return reply.send({ items });
  });

  app.post("/admin/organization/designer/drafts/:draftId/reopen", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid draft identifier.");
    const changeSet = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await transaction.repository.loadChangeSetSnapshot(params.data.draftId);
      if (!snapshot) { await reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" }); return null; }
      // Only a checked change goes back to being composed; published history stays immutable.
      if (!(await transaction.repository.markReopened(snapshot.changeSet.id))) {
        await reply.status(409).send({
          code: "ORGANIZATION_DRAFT_NOT_REOPENABLE",
          message: "Only a validated change set can be reopened for editing.",
        });
        return null;
      }
      await transaction.audit("organization.draft.reopened", "organization_change_set", snapshot.changeSet.id,
        snapshot.changeSet.id, { effectiveOn: snapshot.changeSet.effectiveOn });
      return (await transaction.repository.loadChangeSetSnapshot(snapshot.changeSet.id))!.changeSet;
    });
    if (!changeSet) return;
    return reply.send(changeSet);
  });

  app.post("/admin/organization/designer/drafts/:draftId/discard", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params);
    const body = z.object({ reason: z.string().trim().min(1).max(500).optional() })
      .safeParse(request.body ?? {});
    if (!params.success || !body.success) return invalid(reply, "INVALID_DRAFT_DISCARD", "Invalid discard request.");
    const changeSet = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await transaction.repository.loadChangeSetSnapshot(params.data.draftId);
      if (!snapshot) { await reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" }); return null; }
      // Discarding keeps every row and the audit trail; a published change set is never discarded.
      if (!(await transaction.repository.markDiscarded(snapshot.changeSet.id))) {
        await reply.status(409).send({
          code: "ORGANIZATION_DRAFT_NOT_DISCARDABLE",
          message: "Only a change set that has not been published can be discarded.",
        });
        return null;
      }
      await transaction.audit("organization.draft.discarded", "organization_change_set", snapshot.changeSet.id,
        snapshot.changeSet.id, {
          effectiveOn: snapshot.changeSet.effectiveOn,
          previousStatus: snapshot.changeSet.status,
          ...(body.data.reason ? { reason: body.data.reason } : {}),
        });
      return (await transaction.repository.loadChangeSetSnapshot(snapshot.changeSet.id))!.changeSet;
    });
    if (!changeSet) return;
    return reply.send(changeSet);
  });

  /**
   * ORG-008-7 (decision O-3): a first change set built from the data HCIS already holds.
   *
   * Standing the structure up otherwise means retyping every unit, placement and manager that is
   * already recorded (gap S-1). Everything here comes from recorded relationships; nothing is
   * inferred from a job title (invariant I-7), nothing is published, and rollout is not touched.
   *
   * Only offered when no structure is effective on that date. Merging a proposal into a structure
   * that already exists would mean inventing rules about what to keep; composing a change by hand
   * is the honest answer there.
   */
  app.post("/admin/organization/designer/drafts/from-legacy", async (request, reply) => {
    // ORG-008-8 (O-1): it only composes a change set; publishing it still needs approvals.policy.manage.
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const parsed = draftInput.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "INVALID_ORGANIZATION_DRAFT", "Draft name and effective date are required.");
    try { assertIsoDate(parsed.data.effectiveOn); } catch { return invalid(reply, "INVALID_EFFECTIVE_DATE", "Invalid effective date."); }

    const open = await repository.findOpenChangeSet();
    if (open) {
      return reply.status(409).send({
        code: "ORGANIZATION_DRAFT_ALREADY_OPEN",
        message: "Another organization change is still open.",
        details: { changeSetId: open.id, name: open.name, effectiveOn: open.effectiveOn, status: open.status },
      });
    }
    const existing = await repository.loadEffectiveSnapshot(parsed.data.effectiveOn);
    if (existing) {
      return reply.status(409).send({
        code: "ORGANIZATION_STRUCTURE_EXISTS",
        message: "A structure is already effective on that date; compose a change instead of seeding.",
        details: { changeSetId: existing.changeSet.id, effectiveOn: existing.changeSet.effectiveOn },
      });
    }

    const [units, employees] = await Promise.all([
      pool.query<LegacyUnitRow>(
        `SELECT id, name, leave_approver_employee_id AS "leaveApproverEmployeeId"
         FROM organizational_units ORDER BY name`,
      ),
      pool.query<LegacyEmployeeRow>(
        `SELECT id, organizational_unit_id AS "organizationalUnitId",
           direct_manager_employee_id AS "directManagerEmployeeId"
         FROM employees WHERE status = 'active' ORDER BY full_name`,
      ),
    ]);

    const outcome = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const created = await transaction.repository.createDraft({
        ...parsed.data, actorAccountId: principal.id,
      });
      const seeded = buildSeedFromLegacy({
        changeSet: created.changeSet,
        units: units.rows,
        employees: employees.rows,
      });
      await transaction.repository.replaceDraftSnapshot(seeded.snapshot);
      await transaction.audit("organization.draft.created", "organization_change_set",
        created.changeSet.id, created.changeSet.id,
        { effectiveOn: created.changeSet.effectiveOn, baseChangeSetId: created.changeSet.baseChangeSetId });
      await transaction.audit("organization.draft.seeded_from_legacy", "organization_change_set",
        created.changeSet.id, created.changeSet.id, { ...seeded.summary });
      // Recorded as one line of the change list, so the reviewer sees where this content came from.
      await transaction.repository.appendJournalEntry({
        changeSetId: created.changeSet.id,
        commandType: "SEED_FROM_LEGACY",
        payload: { source: "ORG-002" },
        summary: { ...seeded.summary },
        actorAccountId: principal.id,
      });
      return { changeSet: created.changeSet, summary: seeded.summary };
    });
    return reply.status(201).send({ ...outcome.changeSet, summary: outcome.summary, proposal: true });
  });

  app.get("/admin/organization/designer/drafts/:draftId", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const parsed = draftParams.safeParse(request.params);
    if (!parsed.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid draft identifier.");
    const snapshot = await repository.loadChangeSetSnapshot(parsed.data.draftId);
    return snapshot ? reply.send(snapshot.changeSet) : reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
  });

  app.post("/admin/organization/designer/drafts/:draftId/nodes", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = nodeInput.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_ORGANIZATION_NODE", "Invalid organization group.");
    const item = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const created = { id: randomUUID(), stableKey: randomUUID(), ...body.data,
        integrationCode: body.data.integrationCode ?? null,
        legacyUnitId: body.data.legacyUnitId ?? null,
        active: true, effectiveFrom: snapshot.changeSet.effectiveOn, effectiveTo: null };
      snapshot.nodes.push(created); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.node.created", "organization_node", created.id, snapshot.changeSet.id, { stableKey: created.stableKey });
      return created;
    });
    if (!item) return;
    return reply.status(201).send({ ...item, memberCount: 0, leaderPositionKey: null });
  });

  app.patch("/admin/organization/designer/drafts/:draftId/nodes/:itemId", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = itemParams.safeParse(request.params); const body = nodePatch.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_ORGANIZATION_NODE", "Invalid organization group update.");
    const result = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const item = snapshot.nodes.find((entry) => entry.id === params.data.itemId);
      if (!item) { await reply.status(404).send({ code: "ORGANIZATION_NODE_NOT_FOUND" }); return null; }
      // ORG-008-4b: deactivating a unit that still holds members, positions, sub-units or an
      // authority binding would leave those pointing at something switched off, which only shows up
      // later as an unnamed validation failure. Refuse it and say what still points at it.
      if (body.data.active === false && item.active) {
        const uses = findNodeUses(snapshot, item.stableKey, snapshot.changeSet.effectiveOn);
        if (uses.length > 0) { await replyItemInUse(reply, "unit", uses); return null; }
      }
      Object.assign(item, body.data); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.node.updated", "organization_node", item.id, snapshot.changeSet.id, { fields: Object.keys(body.data) });
      return { item, snapshot };
    });
    if (!result) return;
    const { item, snapshot } = result;
    return reply.send({ ...item, memberCount: snapshot.memberships.filter((member) => member.nodeKey === item.stableKey).length,
      leaderPositionKey: snapshot.authorityBindings.find((binding) => binding.subjectKind === "NODE" && binding.subjectKey === item.stableKey && binding.bindingType === "LEADER")?.targetPositionKey ?? null });
  });

  app.post("/admin/organization/designer/drafts/:draftId/positions", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = positionInput.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_ORGANIZATION_POSITION", "Invalid organization position.");
    const item = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const created = { id: randomUUID(), stableKey: randomUUID(), ...body.data, active: true,
        effectiveFrom: snapshot.changeSet.effectiveOn, effectiveTo: null };
      snapshot.positions.push(created); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.position.created", "organization_position", created.id, snapshot.changeSet.id, { stableKey: created.stableKey });
      return created;
    });
    if (!item) return;
    return reply.status(201).send({ ...item, primaryIncumbent: null, actingIncumbent: null });
  });

  app.patch("/admin/organization/designer/drafts/:draftId/positions/:itemId", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = itemParams.safeParse(request.params); const body = positionPatch.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_ORGANIZATION_POSITION", "Invalid position update.");
    const item = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const updated = snapshot.positions.find((entry) => entry.id === params.data.itemId);
      if (!updated) { await reply.status(404).send({ code: "ORGANIZATION_POSITION_NOT_FOUND" }); return null; }
      // ORG-008-4b: same rule for a position still held, still an authority target, still a parent,
      // or still named by a reporting exception.
      if (body.data.active === false && updated.active) {
        const uses = findPositionUses(snapshot, updated.stableKey, snapshot.changeSet.effectiveOn);
        if (uses.length > 0) { await replyItemInUse(reply, "jabatan", uses); return null; }
      }
      Object.assign(updated, body.data); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.position.updated", "organization_position", updated.id, snapshot.changeSet.id, { fields: Object.keys(body.data) });
      return updated;
    });
    if (!item) return;
    return reply.send({ ...item, primaryIncumbent: null, actingIncumbent: null });
  });

  app.put("/admin/organization/designer/drafts/:draftId/memberships", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = membershipInput.safeParse(request.body);
    if (!params.success || !body.success || (body.data.effectiveTo && body.data.effectiveTo < body.data.effectiveFrom))
      return invalid(reply, "INVALID_ORGANIZATION_MEMBERSHIP", "Invalid membership assignment.");
    const mutated = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return false;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return false;
      snapshot.memberships = snapshot.memberships.filter((item) => item.nodeKey !== body.data.nodeKey);
      snapshot.memberships.push(...body.data.employeeIds.map((employeeId) => ({ id: randomUUID(), employeeId,
        nodeKey: body.data.nodeKey, jobProfileKey: null, isPrimary: true,
        effectiveFrom: body.data.effectiveFrom, effectiveTo: body.data.effectiveTo ?? null })));
      await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.memberships.replaced", "organization_node", null, snapshot.changeSet.id,
        { nodeKey: body.data.nodeKey, memberCount: body.data.employeeIds.length });
      return true;
    });
    if (!mutated) return;
    return reply.status(204).send();
  });

  app.put("/admin/organization/designer/drafts/:draftId/incumbencies", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = incumbencyInput.safeParse(request.body);
    if (!params.success || !body.success || (body.data.actingEmployeeId && (!body.data.actingFrom || !body.data.actingTo))
      || (body.data.actingFrom && body.data.actingTo && body.data.actingTo < body.data.actingFrom))
      return invalid(reply, "INVALID_ORGANIZATION_INCUMBENCY", "Invalid primary or acting assignment.");
    const mutated = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return false;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return false;
      const position = snapshot.positions.find((item) => item.stableKey === body.data.positionKey);
      const existingForPosition = snapshot.incumbencies.filter(
        (item) => item.positionKey === body.data.positionKey,
      );
      if ((position?.holderSource ?? "EMPLOYEE") === "ACCOUNT"
          || existingForPosition.some((item) => item.accountId)) {
        await reply.status(409).send({
          code: "ACCOUNT_HELD_POSITION_EDIT_REQUIRES_REVIEW",
          message: "Account-held position is preserved read-only until its authoring contract is separately accepted.",
        });
        return false;
      }
      if (existingForPosition.some((item) => item.isPrimaryStructural)) {
        await reply.status(409).send({
          code: "PRIMARY_STRUCTURAL_EDIT_REQUIRES_REVIEW",
          message: "Primary structural assignment requires an explicit compatible authoring flow.",
        });
        return false;
      }
      snapshot.incumbencies = snapshot.incumbencies.filter((item) => item.positionKey !== body.data.positionKey);
      if (body.data.primaryEmployeeId) snapshot.incumbencies.push({ id: randomUUID(), positionKey: body.data.positionKey,
        employeeId: body.data.primaryEmployeeId, kind: "PRIMARY", effectiveFrom: body.data.effectiveFrom,
        effectiveTo: null, reason: null });
      if (body.data.actingEmployeeId) snapshot.incumbencies.push({ id: randomUUID(), positionKey: body.data.positionKey,
        employeeId: body.data.actingEmployeeId, kind: "ACTING", effectiveFrom: body.data.actingFrom!,
        effectiveTo: body.data.actingTo!, reason: "Explicit acting mandate" });
      await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.incumbencies.replaced", "organization_position", null, snapshot.changeSet.id,
        { positionKey: body.data.positionKey, vacant: !body.data.primaryEmployeeId, hasActing: Boolean(body.data.actingEmployeeId) });
      return true;
    });
    if (!mutated) return;
    return reply.status(204).send();
  });

  app.post("/admin/organization/designer/drafts/:draftId/authority-bindings", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = bindingInput.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_AUTHORITY_BINDING", "Invalid authority relationship.");
    const item = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const created = { id: randomUUID(), subjectKind: body.data.sourceType, subjectKey: body.data.sourceKey,
        bindingType: body.data.authorityType as AuthorityBindingType, targetPositionKey: body.data.targetPositionKey,
        vacancyPolicy: body.data.vacancyPolicy, effectiveFrom: body.data.effectiveFrom, effectiveTo: body.data.effectiveTo ?? null };
      snapshot.authorityBindings.push(created); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.authority_binding.created", "organization_authority_binding", created.id,
        snapshot.changeSet.id, { subjectKind: created.subjectKind, subjectKey: created.subjectKey, bindingType: created.bindingType, targetPositionKey: created.targetPositionKey });
      return created;
    });
    if (!item) return;
    return reply.status(201).send({ id: item.id, sourceType: item.subjectKind, sourceKey: item.subjectKey,
      authorityType: item.bindingType, targetPositionKey: item.targetPositionKey, vacancyPolicy: item.vacancyPolicy,
      effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo });
  });

  app.post("/admin/organization/designer/drafts/:draftId/reporting-overrides", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); const body = overrideInput.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_REPORTING_OVERRIDE", "Invalid reporting override.");
    const item = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository); if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const created = { id: randomUUID(), ...body.data, managerEmployeeId: null, effectiveTo: body.data.effectiveTo ?? null };
      snapshot.reportingOverrides.push(created); await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.reporting_override.created", "organization_reporting_override", created.id,
        snapshot.changeSet.id, { employeeId: created.employeeId, managerPositionKey: created.managerPositionKey, reason: created.reason,
          effectiveFrom: created.effectiveFrom, effectiveTo: created.effectiveTo });
      return created;
    });
    if (!item) return;
    return reply.status(201).send(item);
  });

  const commandInput = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("ADD_UNIT"),
      name: z.string().trim().min(1).max(160),
      nodeType: z.string().trim().min(1).max(80),
      parentNodeKey: uuid.nullable().default(null),
      leader: z.object({
        title: z.string().trim().min(1).max(160),
        employeeId: uuid.nullable().optional(),
        vacancyPolicy: vacancyPolicy.optional(),
        alsoUnitApprover: z.boolean().optional(),
      }).optional(),
    }),
    z.object({
      type: z.literal("PLACE_EMPLOYEES"),
      nodeKey: uuid,
      employeeIds: z.array(uuid).min(1).max(500),
      move: z.boolean().optional(),
    }),
    z.object({
      type: z.literal("APPOINT_ACTING"),
      positionKey: uuid,
      employeeId: uuid,
      effectiveFrom: date,
      effectiveTo: date,
      reason: z.string().trim().min(1).max(500),
      mandateNumber: z.string().trim().min(1).max(120).nullable().optional(),
    }),
    z.object({
      type: z.literal("SET_REPORTS_TO"),
      positionKey: uuid,
      parentPositionKey: uuid.nullable(),
    }),
    z.object({ type: z.literal("SET_UNIT_LEADER"), nodeKey: uuid, positionKey: uuid }),
    z.object({ type: z.literal("SET_UNIT_APPROVER"), nodeKey: uuid, positionKey: uuid }),
    z.object({
      type: z.literal("SET_OVERRIDE"),
      employeeId: uuid,
      managerPositionKey: uuid,
      reason: z.string().trim().min(1).max(500),
      effectiveFrom: date.optional(),
      effectiveTo: date.nullable().optional(),
    }),
  ]);

  app.post("/admin/organization/designer/drafts/:draftId/commands", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params);
    const body = commandInput.safeParse(request.body);
    if (!params.success || !body.success) {
      return invalid(reply, "INVALID_ORGANIZATION_COMMAND", "Invalid organization command.");
    }
    // ORG-008-8 (O-1): every command composes inside an unpublished change set, so organization.manage
    // is enough — the same as each primitive endpoint it combines. Nothing takes effect until a holder
    // of approvals.policy.manage publishes, which is what keeps this from being self-elevation.
    const command = body.data as OrganizationCommand;

    const outcome = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository);
      if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;

      let result;
      try {
        result = applyOrganizationCommand(snapshot, command);
      } catch (error) {
        if (error instanceof OrganizationCommandError) {
          await reply.status(error.statusCode).send({
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          });
          return null;
        }
        throw error;
      }

      await transaction.repository.replaceDraftSnapshot(result.snapshot);
      // One audit event per primitive record, as ORG-004 requires, plus one summary event naming the
      // command. They share this transaction with the write, so they roll back together (I-10).
      for (const event of result.events) {
        await transaction.audit(event.action, event.entityType, event.entityId, snapshot.changeSet.id, event.payload);
      }
      const seq = await transaction.repository.appendJournalEntry({
        changeSetId: snapshot.changeSet.id,
        commandType: command.type,
        payload: command as unknown as Record<string, unknown>,
        summary: result.summary,
        actorAccountId: principal.id,
      });
      await transaction.audit("organization.command.applied", "organization_change_set",
        snapshot.changeSet.id, snapshot.changeSet.id,
        { commandType: command.type, primitives: result.events.length, seq });
      return { seq, summary: result.summary, primitives: result.events.length };
    });
    if (!outcome) return;
    return reply.status(201).send({ commandType: command.type, ...outcome });
  });

  app.delete("/admin/organization/designer/drafts/:draftId/nodes/:itemId", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = itemParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid identifier.");
    const removed = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository);
      if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const item = snapshot.nodes.find((entry) => entry.id === params.data.itemId);
      if (!item) { await reply.status(404).send({ code: "ORGANIZATION_NODE_NOT_FOUND" }); return null; }
      if (await transaction.repository.isStableKeyPublished("node", item.stableKey)) {
        await replyPublishedItem(reply, "unit"); return null;
      }
      const uses = findNodeUses(snapshot, item.stableKey, snapshot.changeSet.effectiveOn);
      if (uses.length > 0) { await replyItemInUse(reply, "unit", uses); return null; }
      snapshot.nodes = snapshot.nodes.filter((entry) => entry.id !== item.id);
      await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.node.deleted", "organization_node", item.id,
        snapshot.changeSet.id, { stableKey: item.stableKey });
      return true;
    });
    if (!removed) return;
    return reply.status(204).send();
  });

  app.delete("/admin/organization/designer/drafts/:draftId/positions/:itemId", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = itemParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid identifier.");
    const removed = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository);
      if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const item = snapshot.positions.find((entry) => entry.id === params.data.itemId);
      if (!item) { await reply.status(404).send({ code: "ORGANIZATION_POSITION_NOT_FOUND" }); return null; }
      if (await transaction.repository.isStableKeyPublished("position", item.stableKey)) {
        await replyPublishedItem(reply, "jabatan"); return null;
      }
      const uses = findPositionUses(snapshot, item.stableKey, snapshot.changeSet.effectiveOn);
      if (uses.length > 0) { await replyItemInUse(reply, "jabatan", uses); return null; }
      snapshot.positions = snapshot.positions.filter((entry) => entry.id !== item.id);
      await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.position.deleted", "organization_position", item.id,
        snapshot.changeSet.id, { stableKey: item.stableKey });
      return true;
    });
    if (!removed) return;
    return reply.status(204).send();
  });

  app.delete("/admin/organization/designer/drafts/:draftId/authority-bindings/:itemId", async (request, reply) => {
    // ORG-008-8 (O-1): composing inside an unpublished change set; publishing stays separate.
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = itemParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid identifier.");
    const removed = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository);
      if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const binding = snapshot.authorityBindings.find((entry) => entry.id === params.data.itemId);
      if (!binding) { await reply.status(404).send({ code: "ORGANIZATION_BINDING_NOT_FOUND" }); return null; }
      if (bindingIsFromPublishedStructure(binding, snapshot.changeSet.effectiveOn)) {
        await reply.status(409).send({
          code: "ORGANIZATION_ITEM_PUBLISHED",
          message: "This authority came from published structure; end it instead of deleting it.",
          details: { bindingId: binding.id, endInstead: true },
        });
        return null;
      }
      snapshot.authorityBindings = snapshot.authorityBindings.filter((entry) => entry.id !== binding.id);
      await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.authority_binding.deleted", "organization_authority_binding",
        binding.id, snapshot.changeSet.id,
        { subjectKey: binding.subjectKey, bindingType: binding.bindingType });
      return true;
    });
    if (!removed) return;
    return reply.status(204).send();
  });

  app.patch("/admin/organization/designer/drafts/:draftId/authority-bindings/:itemId", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = itemParams.safeParse(request.params);
    const body = z.object({ effectiveTo: date }).safeParse(request.body);
    if (!params.success || !body.success) {
      return invalid(reply, "INVALID_ORGANIZATION_BINDING", "An end date is required.");
    }
    const updated = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(params.data.draftId, reply, transaction.repository);
      if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const binding = snapshot.authorityBindings.find((entry) => entry.id === params.data.itemId);
      if (!binding) { await reply.status(404).send({ code: "ORGANIZATION_BINDING_NOT_FOUND" }); return null; }
      if (body.data.effectiveTo < binding.effectiveFrom) {
        await reply.status(400).send({
          code: "ORGANIZATION_BINDING_PERIOD_INVALID",
          message: "The authority would end before it started.",
        });
        return null;
      }
      binding.effectiveTo = body.data.effectiveTo;
      await transaction.repository.replaceDraftSnapshot(snapshot);
      await transaction.audit("organization.authority_binding.ended", "organization_authority_binding",
        binding.id, snapshot.changeSet.id,
        { subjectKey: binding.subjectKey, bindingType: binding.bindingType, effectiveTo: binding.effectiveTo });
      return binding;
    });
    if (!updated) return;
    return reply.send({
      id: updated.id, sourceType: updated.subjectKind, sourceKey: updated.subjectKey,
      authorityType: updated.bindingType, targetPositionKey: updated.targetPositionKey,
      vacancyPolicy: updated.vacancyPolicy,
      effectiveFrom: updated.effectiveFrom, effectiveTo: updated.effectiveTo,
    });
  });

  /**
   * ORG-008-4c: rebuild a change set from the newest published structure, or without one of its
   * lines, by replaying the journal.
   *
   * It previews by default. Only `apply: true` writes, and even then a line that no longer fits is
   * reported rather than resolved: the operator sees exactly what was dropped and can redo it.
   */
  async function replayDraft(
    request: FastifyRequest,
    reply: FastifyReply,
    input: { draftId: string; apply: boolean; skipSeq?: number | undefined; auditAction: string },
    principal: AuthPrincipal,
  ) {
    const preview = !input.apply;
    if (preview) {
      const snapshot = await repository.loadChangeSetSnapshot(input.draftId);
      if (!snapshot) return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
      if (snapshot.changeSet.status !== "DRAFT") {
        return reply.status(409).send({
          code: "ORGANIZATION_DRAFT_NOT_EDITABLE",
          message: "Only a change set that is still being composed can be rebuilt.",
        });
      }
      const base = await repository.loadEffectiveSnapshot(snapshot.changeSet.effectiveOn);
      const entries = await repository.loadJournalForReplay(input.draftId);
      const result = replayJournal({
        changeSet: snapshot.changeSet, base, entries, skipSeq: input.skipSeq,
      });
      return reply.send({
        applied: false,
        baseChangeSetId: base?.changeSet.id ?? null,
        kept: result.applied.map((entry) => ({ seq: entry.seq, commandType: entry.commandType, summary: entry.summary })),
        skipped: result.skipped,
      });
    }

    const outcome = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await editableSnapshot(input.draftId, reply, transaction.repository);
      if (!snapshot) return null;
      if (!(await claimDraftRevision(request, reply, snapshot, transaction.repository))) return null;
      const base = await transaction.repository.loadEffectiveSnapshot(snapshot.changeSet.effectiveOn);
      const entries = await transaction.repository.loadJournalForReplay(input.draftId);
      const result = replayJournal({
        changeSet: snapshot.changeSet, base, entries, skipSeq: input.skipSeq,
      });

      await transaction.repository.replaceDraftSnapshot(result.snapshot);
      await transaction.repository.setBaseChangeSet(input.draftId, base?.changeSet.id ?? null);
      await transaction.repository.replaceJournal(
        input.draftId,
        result.applied.map((entry) => ({
          seq: entry.seq, commandType: entry.commandType, payload: entry.payload, summary: entry.summary,
        })),
        principal.id,
      );
      for (const event of result.events) {
        await transaction.audit(event.action, event.entityType, event.entityId, snapshot.changeSet.id, event.payload);
      }
      await transaction.audit(input.auditAction, "organization_change_set", input.draftId, input.draftId, {
        baseChangeSetId: base?.changeSet.id ?? null,
        kept: result.applied.length,
        skipped: result.skipped.map((item) => ({ seq: item.seq, code: item.code })),
        ...(input.skipSeq === undefined ? {} : { undoneSeq: input.skipSeq }),
      });
      return {
        applied: true,
        baseChangeSetId: base?.changeSet.id ?? null,
        kept: result.applied.map((entry) => ({ seq: entry.seq, commandType: entry.commandType, summary: entry.summary })),
        skipped: result.skipped,
      };
    });
    if (!outcome) return;
    return reply.send(outcome);
  }

  app.post("/admin/organization/designer/drafts/:draftId/rebase", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params);
    const body = z.object({ apply: z.boolean().default(false) }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid rebase request.");
    return replayDraft(request, reply, {
      draftId: params.data.draftId,
      apply: body.data.apply,
      auditAction: "organization.draft.rebased",
    }, principal);
  });

  app.post("/admin/organization/designer/drafts/:draftId/journal/:seq/undo", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = z.object({ draftId: uuid, seq: z.coerce.number().int().min(1) }).safeParse(request.params);
    const body = z.object({ apply: z.boolean().default(false) }).safeParse(request.body ?? {});
    if (!params.success || !body.success) return invalid(reply, "INVALID_JOURNAL_ENTRY", "Invalid undo request.");
    const entries = await repository.loadJournalForReplay(params.data.draftId);
    if (!entries.some((entry) => entry.seq === params.data.seq)) {
      return reply.status(404).send({ code: "ORGANIZATION_JOURNAL_ENTRY_NOT_FOUND" });
    }
    return replayDraft(request, reply, {
      draftId: params.data.draftId,
      apply: body.data.apply,
      skipSeq: params.data.seq,
      auditAction: "organization.draft.journal_undone",
    }, principal);
  });

  app.get("/admin/organization/designer/drafts/:draftId/journal", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const params = draftParams.safeParse(request.params);
    if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid draft identifier.");
    const snapshot = await repository.loadChangeSetSnapshot(params.data.draftId);
    if (!snapshot) return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
    return reply.send({ items: await repository.listJournal(params.data.draftId) });
  });

  app.post("/admin/organization/designer/drafts/:draftId/validate", async (request, reply) => {
    const principal = await authenticate(request, reply, "organization.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid draft identifier.");
    const report = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await transaction.repository.loadChangeSetSnapshot(params.data.draftId);
      if (!snapshot || snapshot.changeSet.status === "PUBLISHED") {
        await reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
        return null;
      }
      const result = await transaction.draftService.validateDraft(snapshot.changeSet.id, principal.id);
      await transaction.audit("organization.draft.validated", "organization_change_set", snapshot.changeSet.id,
        snapshot.changeSet.id, { valid: result.valid, issueCodes: result.issues.map((issue) => issue.code) });
      return result;
    });
    if (!report) return;
    return reply.send({ valid: report.valid, issues: report.issues.map((issue) => ({ ...issue, severity: "ERROR", itemKey: issue.entityId ?? null })) });
  });

  app.get("/admin/organization/designer/drafts/:draftId/impact", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const params = draftParams.safeParse(request.params); if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid draft identifier.");
    const snapshot = await repository.loadChangeSetSnapshot(params.data.draftId);
    if (!snapshot) return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
    const impact = await draftService.previewImpact(snapshot.changeSet.id);
    const pureVisual = impact.visualOnly;
    return reply.send({ directManagerChanges: impact.directManagerChanges, unitApproverChanges: impact.unitApproverChanges,
      authorityPathsAffected: impact.affectedAuthorityPaths.map((path) => ({ path })),
      vacantAuthorities: impact.vacantPositionKeys.map((positionKey) => ({ positionKey })),
      unresolvedEmployees: impact.unresolvedEmployeeIds.map((employeeId) => ({ employeeId })),
      visualOnlyChanges: pureVisual ? [{ change: "VISUAL_RANK_ONLY", approvalRoutingImpact: "NONE" }] : [],
      noApprovalRoutingImpact: pureVisual });
  });

  app.post("/admin/organization/designer/drafts/:draftId/resolution-preview", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const params = draftParams.safeParse(request.params); const body = resolutionInput.safeParse(request.body);
    if (!params.success || !body.success) return invalid(reply, "INVALID_RESOLUTION_PREVIEW", "Invalid resolution preview input.");
    const snapshot = await repository.loadChangeSetSnapshot(params.data.draftId);
    if (!snapshot) return reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" });
    const resolver = new OrganizationAuthorityResolver({ loadEffectiveSnapshot: async () => snapshot }, { eligibilityValidator: repository });
    try {
      const result = await resolver.resolveLineAuthorities({ requesterEmployeeId: body.data.employeeId,
        effectiveDate: body.data.effectiveDate, workflowKey: body.data.workflowKey, requiredCapability: "leave.approve" });
      const ids = [...new Set([body.data.employeeId, ...result.authorities.map((item) => item.employeeId)])];
      const employees = await pool.query<{ id: string; employeeNumber: string; fullName: string }>(
        `SELECT id, employee_number AS "employeeNumber", full_name AS "fullName" FROM employees WHERE id = ANY($1::uuid[])`, [ids]);
      const byId = new Map(employees.rows.map((item) => [item.id, item]));
      return reply.send({ employee: byId.get(body.data.employeeId) ?? { id: body.data.employeeId, fullName: "Unknown employee" },
        effectiveDate: result.effectiveDate, workflowKey: body.data.workflowKey,
        steps: result.authorities.map((item) => ({ authorityType: (item.sources ?? [item.source]).join(" + "), employeeId: item.employeeId,
          employeeName: byId.get(item.employeeId)?.fullName ?? "Unknown employee",
          positionTitle: snapshot.positions.find((position) => position.stableKey === item.positionKey)?.title ?? null,
          source: item.incumbentKind })), oversight: null, warnings: [] });
    } catch (error) {
      const item = error as { code?: string; message?: string };
      return reply.status(409).send({ code: item.code ?? "ORGANIZATION_RESOLUTION_FAILED", message: item.message ?? "Authority cannot be resolved." });
    }
  });

  app.post("/admin/organization/designer/drafts/:draftId/publish", async (request, reply) => {
    const principal = await authenticate(request, reply, "approvals.policy.manage"); if (!principal) return;
    const params = draftParams.safeParse(request.params); if (!params.success) return invalid(reply, "INVALID_DRAFT_ID", "Invalid draft identifier.");
    const changeSet = await atomicOrganizationMutation(pool, principal, async (transaction) => {
      const snapshot = await transaction.repository.loadChangeSetSnapshot(params.data.draftId);
      if (!snapshot) { await reply.status(404).send({ code: "ORGANIZATION_DRAFT_NOT_FOUND" }); return null; }
      if (snapshot.changeSet.status !== "VALIDATED") {
        await reply.status(409).send({ code: "ORGANIZATION_DRAFT_NOT_VALIDATED", message: "Validate the draft before publishing." });
        return null;
      }
      // ORG-008-3a: refuse a draft whose base another publication has already replaced, so publishing
      // cannot silently drop that publication's content on the draft's effective date.
      const stale = await transaction.draftService.findStaleBaseConflict(snapshot.changeSet);
      if (stale) {
        await reply.status(409).send({
          code: "ORGANIZATION_DRAFT_BASE_STALE",
          message: "Structure was changed by another publication after this draft was created.",
          details: stale,
        });
        return null;
      }
      await transaction.draftService.publish(snapshot.changeSet.id, principal.id);
      await transaction.audit("organization.draft.published", "organization_change_set", snapshot.changeSet.id,
        snapshot.changeSet.id, { effectiveOn: snapshot.changeSet.effectiveOn });
      return (await transaction.repository.loadChangeSetSnapshot(snapshot.changeSet.id))!.changeSet;
    });
    if (!changeSet) return;
    return reply.send(changeSet);
  });

  app.get("/admin/organization/rollout", async (request, reply) => {
    if (!(await authenticate(request, reply, "organization.manage"))) return;
    const latest = await pool.query(
      `SELECT mode, workflow_key AS "workflowKey", node_key AS "organizationalNodeKey",
        effective_from AS "effectiveFrom", effective_to AS "effectiveTo", reason, updated_at AS "updatedAt"
       FROM organization_rollout_settings ORDER BY created_at DESC LIMIT 1`,
    );
    // ORG-008-2: the single newest row cannot say which mode applies, because the resolver picks the
    // row effective for that workflow and that unit. So the effective rows travel with the answer,
    // and the count lets a screen state LEGACY as a fact exactly when there is no configuration at
    // all. The top-level fields are unchanged for clients already reading them.
    const today = jakartaBusinessDate();
    const effective = await pool.query(
      `SELECT workflow_key AS "workflowKey", node_key AS "organizationalNodeKey", mode,
        effective_from AS "effectiveFrom", effective_to AS "effectiveTo"
       FROM organization_rollout_settings
       WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to >= $1::date)
       ORDER BY workflow_key, node_key NULLS FIRST, effective_from DESC`,
      [today],
    );
    const total = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM organization_rollout_settings",
    );
    const configuredRowCount = Number(total.rows[0]?.count ?? "0");
    return reply.send({
      ...(latest.rows[0] ?? { mode: "LEGACY", workflowKey: "LEAVE", organizationalNodeKey: null }),
      asOf: today,
      configuredRowCount,
      settings: effective.rows,
    });
  });

  app.patch("/admin/organization/rollout", async (request, reply) => {
    const principal = await authenticate(request, reply, "approvals.policy.manage"); if (!principal) return;
    const body = rolloutInput.safeParse(request.body);
    if (!body.success) return invalid(reply, "INVALID_ORGANIZATION_ROLLOUT", "Invalid rollout configuration.");
    const item = { id: randomUUID(), ...body.data, organizationalNodeKey: body.data.organizationalNodeKey ?? null,
      effectiveFrom: body.data.effectiveFrom ?? jakartaBusinessDate(), effectiveTo: body.data.effectiveTo ?? null,
      reason: body.data.reason ?? "Organization Designer rollout update" };
    await atomicOrganizationMutation(pool, principal, async (transaction) => {
      await transaction.client.query(
        `INSERT INTO organization_rollout_settings
          (id, workflow_key, node_key, mode, effective_from, effective_to, reason, changed_by_account_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [item.id, item.workflowKey, item.organizationalNodeKey, item.mode, item.effectiveFrom, item.effectiveTo, item.reason, principal.id],
      );
      await transaction.audit("organization.rollout.changed", "organization_rollout_setting", item.id, null,
        { workflowKey: item.workflowKey, organizationalNodeKey: item.organizationalNodeKey, mode: item.mode,
          effectiveFrom: item.effectiveFrom, effectiveTo: item.effectiveTo, reason: item.reason });
    });
    return reply.send({ ...item, updatedAt: new Date().toISOString() });
  });
}
